/**
 * Studio assembly: three modules + mixer + router + scheduler,
 * the singleton the UI talks to. The audio graph lives here, OUTSIDE React.
 *
 * Cross-module clocking: cables landing on a clock-follower input
 * (Anvil ADV/CLOCK, Cascade CLOCK in) flip that transport to external-clock
 * mode. If the source is one of our *internal* clock outputs, the follower fires
 * from the source's scheduled event stream — sample-accurate, zero latency. Any
 * other patched signal goes through the edge-detector worklet (≤1 block latency).
 */

import { StudioContext } from './context';
import type { RecordFormat } from './recordHelpers';
import { MasterFxChain, type MasterFxId } from './fx/masterFxChain';
import { MonarchModule } from './modules/monarch';
import { AnvilModule } from './modules/anvil';
import { CascadeModule } from './modules/cascade';
import { CourierModule } from './modules/courier';
import { MixerModule } from './modules/mixer';
import { SamplerModule } from './modules/sampler';
import type { ModuleBase } from './modules/moduleBase';
import { MODULES, mixedModules, moduleConfig } from './modules/moduleConfig';
import { StudioEndpointRegistry } from './modules/registry';
import { buildJackIndex, RouterBinding, type Cable, type PatchState } from './router';
import { Scheduler, type TransportEvent } from './scheduler';
import { MonarchSequencer } from './sequencers/monarchseq';
import { AnvilSequencer } from './sequencers/anvilseq';
import { CascadeClock } from './sequencers/cascadeClock';
import { CourierSequencer } from './sequencers/courierSeq';
import { MidiClock } from './sequencers/midiClock';
import { SamplerLoopClock } from './sequencers/samplerLoops';
import { SamplerStepSeq } from './sequencers/samplerSeq';
import { nextBoundary, type QuantDivision, type PhaseRef } from './quantGrid';
import { renderAllKits } from './factorySamples';
import type { SampleBackend } from './sampleStore';
import {
  StudioStore,
  coalesceCourierModAssignState,
  coalesceEffectsState,
  coalesceSamplerState,
  defaultSamplerState,
  defaultPad,
  VOICE_FX_IDS,
  type CourierModSource,
  type StudioState,
  type SamplerState,
  type QuantizeDivision,
  type VoiceFxId,
} from '../state/studioState';
import { anvilStepRateHz, expKnob01 } from './units';
import { assignSourceValue } from './assign';
import { diffParamLock } from './modRouter';

export const CABLE_COUNT = 12; // D5
export const CABLE_COLORS = ['#d4a017', '#b0413e', '#3e6fb0', '#3e8e5a', '#7a4fa3', '#c2c2c2'];

/** Internal clock outputs whose pulses exist in the scheduled event stream. */
const INTERNAL_CLOCK_EVENTS: Record<string, { transport: string; type: string; seq?: number }> = {
  // 'assignEdge' (not the per-step 'assignPulse') so a divider/accent/step-1 ASSIGN source that
  // SKIPS steps doesn't over-trigger a downstream follower, and a level source never advances one.
  MON_ASSIGN_OUT: { transport: 'monarchseq', type: 'assignEdge' },
  CAS_CLOCK_OUT: { transport: 'cascadeclock', type: 'clockOutPulse' },
  CAS_SEQ1_CLK_OUT: { transport: 'cascadeclock', type: 'seqClkPulse', seq: 0 },
  CAS_SEQ2_CLK_OUT: { transport: 'cascadeclock', type: 'seqClkPulse', seq: 1 },
  ANV_TRIGGER_OUT: { transport: 'anvilseq', type: 'trigger' },
};

/** Lazily-built map of the COU_ control defaults from data/courier.json — the round-trip-safe
 *  fallback base for a param-lock restore when the store has no value for that control yet. */
let courierDefaultCache: Record<string, number> | null = null;
function courierJsonDefault(id: string): number {
  if (!courierDefaultCache) {
    courierDefaultCache = {};
    for (const c of moduleConfig('courier')?.def.controls ?? []) {
      if (typeof c.default === 'number') courierDefaultCache[c.id] = c.default;
    }
  }
  return courierDefaultCache[id] ?? 0;
}

export class Studio {
  readonly context = new StudioContext();
  readonly store = new StudioStore();
  monarch!: MonarchModule;
  anvil!: AnvilModule;
  cascade!: CascadeModule;
  sampler!: SamplerModule;
  courier!: CourierModule;
  mixer!: MixerModule;
  router!: RouterBinding;
  scheduler!: Scheduler;
  readonly monarchSeq = new MonarchSequencer();
  readonly anvilSeq = new AnvilSequencer();
  readonly cascadeClock = new CascadeClock();
  /** Courier step sequencer / minimal arp (6th scheduler citizen, Phase C MVP). Pure
   *  internal-clock state machine; mirrored from state.courier.seq by syncTransportConfig.
   *  tempoBpm follows LINK (applyTempoLink) like the Monarch clock. */
  readonly courierSeq = new CourierSequencer();
  /** Per-step PARAM-LOCK shell state (Phase C-Full). NEVER serialized, never in the store —
   *  the binder owns base-capture + restore so the pure seq only forwards step.lock.
   *  courierLockBase: controlId -> the panel base value to restore to (captured lazily from the
   *  STORE on first override). courierActiveLocks: controlIds currently overridden by a lock and
   *  not yet restored. See applyCourierParamLock / flushCourierParamLocks. */
  private readonly courierLockBase = new Map<string, number>();
  private readonly courierActiveLocks = new Set<string>();
  /** External MIDI transport clock (24-PPQN ÷6 → 16ths). When running it is the studio master:
   *  it clocks the Cascade (4 PPQN, manual priority MIDI > analog) and the Monarch (unless
   *  its analog TEMPO IN is patched — Monarch priority analog > MIDI). Fed by the bridge from Web MIDI. */
  readonly midiClock = new MidiClock();
  private midiClockMaster = false;
  /** Sampler loop-quantize transport (4th scheduler citizen): emits the bar-grid
   *  loopStart/loopStop/loopRelaunch events; holds no audio nodes. running stays
   *  permanently true (idles at nextEventTime=Infinity). */
  readonly samplerLoops = new SamplerLoopClock();
  /** Drum step sequencer (5th scheduler citizen): an 8x16 on/off pattern stepped one
   *  column per master 16th; emits 'drumHit' one-shots (bound to sampler.triggerPad) +
   *  a 'drumStep' UI marker for the LED chase. Holds no audio nodes; running stays
   *  permanently true (idles at nextEventTime=Infinity until RUN with a running master). */
  readonly samplerSeq = new SamplerStepSeq();
  /** Engine-side mirror of SAMP_QUANTIZE — the manual-launch alignment grid. */
  private samplerQuantize: QuantDivision = '1 BAR';
  tempoLink = false;

  /** Per-voice insert-FX chains (flanger→delay→reverb), one per synth voice, sitting on
   *  each voice→mixer edge. Built once at power-on (see the mixer-wiring loop). */
  private readonly voiceFx = new Map<VoiceFxId, MasterFxChain>();

  /** Rendered factory one-shot buffers (peak-normalised ±1.0), keyed by 'factory-*'
   *  id. In-memory only — never serialized (D10); state stores only the sampleId ref. */
  private readonly factoryBuffers = new Map<string, AudioBuffer>();

  /** follower hooks recomputed on every patch change: source event -> follower call */
  private followers: ((e: TransportEvent) => void)[] = [];
  /** live edge-detector taps for arbitrary-signal followers (stage 3) */
  private edgeFollowers: { tap: AudioNode; node: AudioWorkletNode }[] = [];
  /** Live CV sample-and-hold taps (U2): a synthstack-cv-sample sink on a resolved source bus that
   *  posts its latest value to `latest`, read every pump by sampleCvTaps. Distinct lifecycle from
   *  edgeFollowers (value-sampling, not edge-detection) — rebuilt fresh each rebuildFollowers so
   *  taps never leak across rebuilds. `apply` folds the sampled vv into the target (Anvil rate /
   *  Cascade divider CV). */
  private cvTaps: {
    tap: AudioNode;
    node: AudioWorkletNode;
    latest: { v: number };
    apply: (v: number) => void;
  }[] = [];
  /** Was a cable in MON_HOLD_IN last rebuild? Used to RELEASE hold when it is unplugged
   *  (the edge follower that would deliver the gate-low is torn down with the cable). */
  private monarchHoldPatched = false;
  /** The `from` source feeding MON_HOLD_IN last rebuild (null = unpatched). A SWAP (one patch
   *  update replaces the HOLD cable's source — e.g. a preset load — from a HIGH source to a LOW
   *  one) re-adds the follower while findCable stays truthy, so the pure-remove release never runs
   *  and holdActive strands true. Comparing the source id detects the swap and re-releases at
   *  re-add time; an unrelated patch edit (same source) leaves a live hold untouched. */
  private monarchHoldSource: string | null = null;
  /** Was a cable in MON_TEMPO_IN last rebuild? Used to RESUME the internal clock when it is
   *  unplugged while running (the external-clock branch left nextEventTime=Infinity). */
  private monarchTempoPatched = false;
  /** The `from` source feeding MON_TEMPO_IN last rebuild (null = unpatched). The measured
   *  external-clock interval (monarchTempoLastEdge) is reset to -1 ONLY when this changes (cable
   *  added / removed / swapped), NOT on every rebuild — an unrelated patch edit must not glitch the
   *  tick interval for one step. */
  private monarchTempoSource: string | null = null;
  /** Persisted measured-edge timestamp for the Monarch external clock (MON_TEMPO_IN). Survives
   *  rebuilds so an unrelated patch edit while externally clocked keeps the measured interval;
   *  reset to -1 only when the clock SOURCE changes (see monarchTempoSource). */
  private monarchTempoLastEdge = -1;
  /** Was a cable in COU_CLOCK_IN last rebuild? Same unplug-resume role as monarchTempoPatched. */
  private courierClockPatched = false;
  /** The `from` source feeding COU_CLOCK_IN last rebuild (null = unpatched). Gates the reset of
   *  courierClockLastEdge, exactly as monarchTempoSource does for the Monarch clock. */
  private courierClockSource: string | null = null;
  /** Persisted measured-edge timestamp for the Courier external clock (COU_CLOCK_IN). Survives
   *  rebuilds; reset to -1 only when the clock SOURCE changes (see courierClockSource). */
  private courierClockLastEdge = -1;
  /** Was a cable in CAS_RESET_IN last rebuild? Used to CLEAR a sustained-high reset hold when the
   *  cable is unplugged (the falling-edge follower that would release resetHeld is torn down with
   *  the cable, mirroring the MON_HOLD release-on-teardown). */
  private cascadeResetPatched = false;
  private registry: StudioEndpointRegistry | null = null;
  private built = false;

  /** Power on (user gesture) and build the graph once. */
  async powerOn(): Promise<void> {
    const ctx = await this.context.powerOn();
    if (this.built) {
      // Power CYCLE (off -> on): powerOff() stopped the lookahead pump (scheduler.stop()),
      // but the graph is already built so we must NOT rebuild — just restart the pump.
      // Without this the AudioContext resumes yet the scheduler stays dead: every sequencer
      // and the LED chase freeze until a full page reload. start() is idempotent (it guards
      // on its own timer), so a redundant call here is harmless.
      this.scheduler.start();
      // powerOff() also stopped the per-VCO drift top-up timers; re-arm them (start() is
      // idempotent) so analog drift resumes after a power-cycle.
      this.monarch.drift.start();
      this.anvil.drift1.start();
      this.anvil.drift2.start();
      this.cascade.drift1.start();
      this.cascade.drift2.start();
      return;
    }
    this.built = true;

    // Build every module from the MODULES registry (single source of truth). Construction
    // order == registry order [monarch, anvil, cascade, sampler, courier]; each entry's factory is
    // exactly the old `new *Module(ctx, def)`. Keep the typed named fields the rest of the
    // class + binders read — each factory returns the concrete subclass, so the downcast is
    // sound (every module id is a registry entry).
    const instances = new Map<string, ModuleBase>();
    for (const m of MODULES) instances.set(m.id, m.factory(ctx, m.def));
    this.monarch = instances.get('monarch') as MonarchModule;
    this.anvil = instances.get('anvil') as AnvilModule;
    this.cascade = instances.get('cascade') as CascadeModule;
    this.sampler = instances.get('sampler') as SamplerModule;
    this.courier = instances.get('courier') as CourierModule;
    this.mixer = new MixerModule(ctx, this.context.masterIn);
    // bundle arrangement: ch1 Cascade, ch2 Anvil, ch3 Monarch, ch4 sampler mix, ch5 Courier —
    // each (mainOutJack, mixerChannel) is read per-entry, reproducing the explicit connectInput
    // calls: (CAS_VCA_OUT,0) (ANV_VCA_OUT,1) (MON_VCA_OUT,2) (SAMP_MIX_OUT,3) (COU_*_OUT,4).
    for (const m of mixedModules) {
      const tap = instances.get(m.id)!.outputTap(m.mainOutJack!);
      if ((VOICE_FX_IDS as string[]).includes(m.id)) {
        // Per-voice insert FX: voice out → [flanger→delay→reverb] → mixer channel. The
        // patchbay VCA-OUT jack is a SEPARATE fan-out off `tap`, so cables stay dry (pre-FX).
        // 'voice' target: `tap` is the raw ±5 vv voice out (pre-mixer), so the FOLD shaper
        // uses ioScale 0.2 (±5vv→±1). The master chain instead uses ~1.0 (post-mixer signal).
        const fx = new MasterFxChain(ctx, 'voice');
        tap.connect(fx.input);
        this.mixer.connectInput(fx.output, m.mixerChannel!);
        this.voiceFx.set(m.id as VoiceFxId, fx);
      } else {
        this.mixer.connectInput(tap, m.mixerChannel!);
      }
    }

    // Registry membership == registry order; the def list (incl. samplerDef) makes all 17
    // SAMP_* jacks patchable for free.
    this.registry = new StudioEndpointRegistry(MODULES.map((m) => instances.get(m.id)!));
    this.router = new RouterBinding(buildJackIndex(MODULES.map((m) => m.def)), this.registry);
    this.router.applyAllNormals();

    this.scheduler = new Scheduler(() => ctx.currentTime);
    this.scheduler.add(this.monarchSeq, (e) => this.bindMonarchEvent(e));
    this.scheduler.add(this.anvilSeq, (e) => this.bindAnvilEvent(e));
    this.scheduler.add(this.cascadeClock, (e) => this.bindCascadeEvent(e));
    // 4th citizen: the sampler bar-grid clock (loop-quantize). Permanently running,
    // so it is always pumped; it idles at nextEventTime=Infinity until a loop launches.
    // Wire the LIVE master phase so every pump re-reads the current tempo/run state (a
    // TEMPO-knob turn or RUN/STOP with no pad tap): the clock self-refreshes (no drift on
    // a live tempo change, no re-launch on a stopped master) and self-reseeds a sounding
    // loop onto the bar grid on a stopped→running edge — see SamplerLoopClock.onPump.
    this.samplerLoops.setPhaseProvider(() => this.monarchSeq.phaseRef());
    this.scheduler.add(this.samplerLoops, (e) => this.bindSamplerLoopEvent(e));
    // 5th citizen: the drum step sequencer. Same master-synced shape as the loop clock —
    // permanently running, idles at nextEventTime=Infinity until RUN with a running master;
    // it reads the LIVE master phase each pump (() => monarchSeq.phaseRef()) so it advances one
    // column per master 16th and re-seats onto the live grid on a stopped→running edge.
    this.samplerSeq.setPhaseProvider(() => this.monarchSeq.phaseRef());
    this.scheduler.add(this.samplerSeq, (e) => this.bindSamplerStepEvent(e));
    // 6th citizen: the Courier step sequencer / arp. Internal clock (like the Monarch),
    // so unlike the sampler clocks it idles at nextEventTime=Infinity until start() and
    // needs no phase provider. The binder drives the Courier voice's pitch/gate surface.
    this.scheduler.add(this.courierSeq, (e) => this.bindCourierEvent(e));
    // External-MIDI-clock watchdog rides the one lookahead pump (no setInterval/setTimeout): if a
    // stalled/unplugged upstream clock leaves us master with no fresh ticks, auto-release master.
    this.scheduler.beforePump = (now) => {
      this.checkMidiClockWatchdog(now); // MUST keep running (auto-releases a stalled MIDI master)
      this.sampleCvTaps(); // U2: fold sampled CV (ANV_TEMPO_IN / CAS_RHYTHM_n_IN) into rate/divider
    };
    this.scheduler.start();

    this.store.subscribe(() => this.syncTransportConfig());
  }

  async powerOff(): Promise<void> {
    this.scheduler?.stop();
    // Stop the per-VCO drift top-up setInterval timers so they do not leak/spin after power-off
    // (modules are built once and never torn down; powerOn's power-cycle branch re-arms them).
    if (this.built) {
      this.monarch.stopDrift();
      this.anvil.stopDrift();
      this.cascade.stopDrift();
    }
    await this.context.powerOff();
  }

  // ---- event binders ---------------------------------------------------------------

  private bindMonarchEvent(e: TransportEvent): void {
    switch (e.type) {
      case 'pitch':
        this.monarch.setPitchAt(e.data!['noteVv'] as number, e.time, e.data!['glide'] as boolean);
        break;
      case 'gateOn':
        this.monarch.gateAt(true, e.time);
        break;
      case 'gateOff':
        this.monarch.gateAt(false, e.time);
        break;
      case 'accentOn':
        this.monarch.accentAt(true, e.time);
        break;
      case 'accentOff':
        this.monarch.accentAt(false, e.time);
        break;
      case 'assignPulse': {
        // Realize the selected ASSIGN source (Setup-mode page 1). Randomness for STEP RANDOM lives
        // here in the shell (never the pure seq). Only a real pulse emits 'assignEdge' to followers.
        const d = e.data!;
        const action = assignSourceValue(
          this.monarch.assignSource,
          {
            stepIndex: d['stepIndex'] as number,
            endStep: d['endStep'] as number,
            tickCount: d['tickCount'] as number,
            accent: d['accent'] as boolean,
            isStep1: d['isStep1'] as boolean,
          },
          Math.random(),
        );
        if (action.kind === 'pulse') {
          this.monarch.assignPulseAt(e.time);
          this.feedFollowers('monarchseq', { time: e.time, type: 'assignEdge' });
        } else if (action.kind === 'level') {
          this.monarch.assignLevelAt(action.vv, e.time);
        }
        return; // do NOT feed the raw per-step assignPulse — downstream followers key on assignEdge
      }
    }
    this.feedFollowers('monarchseq', e);
  }

  private bindAnvilEvent(e: TransportEvent): void {
    switch (e.type) {
      case 'step':
        this.anvil.setStepCvAt(e.data!['pitchVv'] as number, e.data!['velocityVv'] as number, e.time);
        break;
      case 'trigger':
        this.anvil.triggerAt(e.time);
        break;
    }
    this.feedFollowers('anvilseq', e);
  }

  private bindCascadeEvent(e: TransportEvent): void {
    switch (e.type) {
      case 'pitchUpdate':
        this.cascade.applySeqStep(e.data!['seq'] as 0 | 1, e.data!['stepIndex'] as number, e.time);
        break;
      case 'seqClkPulse':
        this.cascade.seqClkPulseAt(e.data!['seq'] as 0 | 1, e.time);
        break;
      case 'egTrigger':
        this.cascade.egTriggerAt(e.time);
        break;
      case 'clockOutPulse':
        this.cascade.clockPulseAt(e.time);
        break;
    }
    this.feedFollowers('cascadeclock', e);
  }

  /**
   * Courier step-sequencer binder: drives the Courier voice's pitch/gate surface from the
   * pure seq's events (the SAME setPitchAt/gateAt the keyboard live-play uses). Courier has
   * NO accent / ASSIGN / ratchet out, so only step/pitch/gateOn/gateOff are handled.
   *
   * The 'step' event is a UI-only LED-chase marker (no engine action). It rides
   * scheduler.uiQueue; its payload is just {stepIndex} — identical to the Monarch step event —
   * so we tag it `__courier:true` HERE (bind runs on the same object reference the scheduler
   * then pushes to uiQueue, see scheduler.pump) to let the rAF chase route it to the Courier
   * channel without a payload-sniff collision.
   */
  private bindCourierEvent(e: TransportEvent): void {
    switch (e.type) {
      case 'step':
        if (e.data) e.data['__courier'] = true; // UI-chase disambiguation only — no engine call
        break;
      case 'pitch':
        this.courier.setPitchAt(e.data!['noteVv'] as number, e.time, e.data!['glide'] as boolean);
        break;
      case 'gateOn':
        this.courier.gateAt(true, e.time);
        break;
      case 'gateOff':
        this.courier.gateAt(false, e.time);
        break;
      case 'paramLock':
        this.applyCourierParamLock(e.data!['lock'] as Record<string, number>, e.time);
        break;
    }
    // Courier has a COU_CLOCK_OUT jack — keep follower parity so a patched clock-out can drive
    // downstream followers (the feedingFollowers guard prevents loops). No INTERNAL_CLOCK_EVENTS
    // entry exists yet, so today this is inert; it costs nothing and mirrors the other binders.
    this.feedFollowers('courierseq', e);
  }

  /**
   * Per-step PARAM-LOCK realization (Phase C-Full) — the whole bind contract is this per-step
   * set-diff. `lock` is the FULL authoritative override-set for the step that fired at `time`
   * (emitted EVERY step, {} when nothing is locked). We diff it against courierActiveLocks:
   *   (1) APPLY pass — for each [id, value] in `lock`: allow-list via findModTarget (a stray /
   *       hand-edited id is a safe no-op; only the six MOD_TARGETS pass), lazily capture the base
   *       from the STORE on the first override (never from the live AudioParam, which may hold a
   *       prior step's locked value), then schedule the locked value at `time`.
   *   (2) RESTORE pass — for each currently-active id NOT present in `lock`: restore its captured
   *       base at `time` and clear it. Because every step emits a (possibly empty) lock map, a
   *       length-wrap or a RESET-jump that lands on a no-lock step restores everything for free —
   *       no wrap detection needed anywhere.
   * Writes ONLY the live engine (the AudioParam), NEVER this.store — so state.controls.courier
   * (the panel knob position / persistence / un-locked base) stays the single UI-owned source of
   * truth, and once all locks restore the live param is back exactly at the store base.
   */
  private applyCourierParamLock(lock: Record<string, number>, time: number): void {
    diffParamLock(
      lock,
      this.courierActiveLocks,
      this.courierLockBase,
      (id) => this.readCourierBase(id),
      (id, value) => this.courier.setControlAt(id, value, time),
    );
  }

  /**
   * The base (un-locked) value of a lockable control: the live STORE value coalesced to the
   * data/courier.json default. Read READ-ONLY from the store — NEVER from the live AudioParam,
   * which may currently hold a prior step's locked value. Lazy capture from here (per
   * applyCourierParamLock) means a user editing the knob mid-pattern is honored: an un-locked
   * step restores to the CURRENT panel value ("the knob is the base", hardware parity).
   */
  private readCourierBase(id: string): number {
    const v = this.store.getState().controls.courier?.[id];
    return typeof v === 'number' ? v : courierJsonDefault(id);
  }

  /** The live ANV_TEMPO knob value in Hz (store, coalesced to the data/anvil.json default 8). The
   *  CV-rate base for ANV_TEMPO_IN: rate = anvilStepRateHz(expKnob01(thisHz), cvVv). Re-read per
   *  pump so a knob turn while the CV cable is patched is honored ("the knob is the base"). */
  private anvilTempoKnobHz(): number {
    const v = this.store.getState().controls.anvil?.['ANV_TEMPO'];
    return typeof v === 'number' ? v : 8;
  }

  /**
   * STOP / PANIC flush — restore every active lock to its captured base, then clear both shell
   * structures. Without this a stopped sequence would freeze the last locked value onto the live
   * knob. Restores immediately at currentTime (the seq is no longer scheduling, so there is no
   * future step time to align to). Called from stopAll / panic / courierStop.
   */
  private flushCourierParamLocks(): void {
    if (this.courierActiveLocks.size === 0) return;
    const t = this.context.audioContext.currentTime;
    for (const id of this.courierActiveLocks) {
      this.courier.setControlAt(id, this.courierLockBase.get(id)!, t);
    }
    this.courierActiveLocks.clear();
    this.courierLockBase.clear();
  }

  /**
   * Sampler loop-quantize binder: the SamplerLoopClock emits scheduled bar-grid
   * boundaries; we mint/stop/re-launch the retained loop voice at the exact event
   * time. The clock holds no audio nodes — the SamplerModule owns the voices.
   * Not fed to followers (these are not patchable clock outputs).
   */
  private bindSamplerLoopEvent(e: TransportEvent): void {
    const pad = e.data!['pad'] as number;
    if (e.type === 'loopStart') this.sampler.startLoop(pad, e.time);
    else if (e.type === 'loopRelaunch') this.sampler.relaunchLoop(pad, e.time);
    else if (e.type === 'loopStop') this.sampler.stopLoop(pad, e.time);
  }

  /**
   * Drum step binder: the SamplerStepSeq emits one 'drumStep' UI marker per column
   * (data.stepIndex, for the LED chase only — no engine action) plus one 'drumHit' per
   * ON cell at the boundary. A hit is a fire-and-forget ONE-SHOT through the SAME
   * sampler.triggerPad path as the audition / external TRIG_IN follower — NOT re-quantized,
   * NOT routed through launchPad/samplerLoops, and NOT fed to followers (these are not
   * patchable clock outputs). An ON cell over an empty pad triggerPad-no-ops (silent).
   */
  private bindSamplerStepEvent(e: TransportEvent): void {
    if (e.type === 'drumHit') this.sampler.triggerPad(e.data!['pad'] as number, e.time);
    // 'drumStep' (the UI column marker) needs no engine action — it rides scheduler.uiQueue
    // for the LED chase only.
  }

  /** Guards feedFollowers against self/indirect clock-feedback loops (e.g. ANV_TRIGGER_OUT
   *  patched into ANV_ADV_CLOCK_IN): a follower that re-emits the same event type would
   *  otherwise recurse unbounded and overflow the stack. */
  private feedingFollowers = false;

  private feedFollowers(transportId: string, e: TransportEvent): void {
    if (this.feedingFollowers) return; // break self/indirect clock-feedback cycles
    this.feedingFollowers = true;
    try {
      for (const f of this.followers) f({ ...e, data: { ...e.data, __transport: transportId } });
    } finally {
      this.feedingFollowers = false;
    }
  }

  // ---- patching -----------------------------------------------------------------------

  patch(cables: Cable[]): void {
    const state: PatchState = { cables };
    this.router.applyPatch(state);
    this.rebuildFollowers(state);
  }

  /**
   * Edge-detector follower (stage 3): watches an arbitrary patched signal's
   * output tap and fires callbacks on rising/falling edges (≤1 render quantum
   * latency). Used when the source is NOT an internal clock output, and
   * for the Monarch transport gate inputs (gate semantics need the real signal).
   */
  private addEdgeFollower(
    fromJack: string,
    onRising: (t: number) => void,
    onFalling?: (t: number) => void,
  ): void {
    const tap = this.registry?.sourceNode({ kind: 'jack', jackId: fromJack });
    if (!tap) return;
    const ctx = this.context.audioContext;
    const node = new AudioWorkletNode(ctx, 'synthstack-edge', { numberOfInputs: 1, numberOfOutputs: 0 });
    (tap as unknown as AudioNode).connect(node);
    node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { rising: number[]; risingCount: number; falling: number[]; fallingCount: number };
      const now = ctx.currentTime;
      for (let i = 0; i < d.risingCount; i++) onRising(Math.max(d.rising[i]!, now));
      if (onFalling) for (let i = 0; i < d.fallingCount; i++) onFalling(Math.max(d.falling[i]!, now));
    };
    this.edgeFollowers.push({ tap: tap as unknown as AudioNode, node });
  }

  private clearEdgeFollowers(): void {
    for (const { tap, node } of this.edgeFollowers) {
      try {
        tap.disconnect(node);
      } catch {
        // already disconnected
      }
      node.port.onmessage = null;
    }
    this.edgeFollowers = [];
  }

  /**
   * CV sample-and-hold tap (U2): attach a synthstack-cv-sample sink to a resolved source bus and
   * register a per-pump `apply` that folds the latest sampled vv into a control-rate target (Anvil
   * step rate / Cascade RG divider CV). DISTINCT from addEdgeFollower (edge-only) — this samples a
   * value, it does not detect edges. The worklet posts at most one message per render quantum into
   * a reused `latest.v`; sampleCvTaps reads it every scheduler pump (control-rate sample-and-hold).
   *
   * Control-rate limit: data/anvil.json describes ANV_TEMPO_IN as "up to audio rate", but this v1
   * is a per-pump sample-and-hold (control-rate, ≈ one value per lookahead pump). Documented +
   * flagged as an ears/fidelity checkpoint for the operator (stair-stepping feel vs a future
   * worklet-rate path) — see the U2 spec.
   */
  private addCvTap(fromJack: string, apply: (v: number) => void): void {
    const tap = this.registry?.sourceNode({ kind: 'jack', jackId: fromJack });
    if (!tap) return;
    const ctx = this.context.audioContext;
    const node = new AudioWorkletNode(ctx, 'synthstack-cv-sample', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    (tap as unknown as AudioNode).connect(node);
    const latest = { v: 0 };
    node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { value: number };
      latest.v = d.value;
    };
    this.cvTaps.push({ tap: tap as unknown as AudioNode, node, latest, apply });
  }

  private clearCvTaps(): void {
    for (const { tap, node } of this.cvTaps) {
      try {
        tap.disconnect(node);
      } catch {
        // already disconnected
      }
      node.port.onmessage = null;
    }
    this.cvTaps = [];
  }

  /**
   * Per-pump CV sample read (U2). Rides the lookahead scheduler via beforePump (NO
   * setInterval/setTimeout): fold each tap's latest sampled value into its control-rate target.
   * Cheap + allocation-free; runs after the MIDI-clock watchdog so the watchdog keeps its place.
   */
  private sampleCvTaps(): void {
    for (const { latest, apply } of this.cvTaps) apply(latest.v);
  }

  /** Recompute external-clock flags + follower hooks from the cable list. */
  private rebuildFollowers(patch: PatchState): void {
    this.followers = [];
    this.clearEdgeFollowers();
    this.clearCvTaps();
    const findCable = (to: string): Cable | undefined => patch.cables.find((c) => c.to === to);

    const anvilClock = findCable('ANV_ADV_CLOCK_IN');
    this.anvilSeq.externalClock = !!anvilClock;
    if (anvilClock) {
      const src = INTERNAL_CLOCK_EVENTS[anvilClock.from];
      if (src) {
        // internal source: follow the scheduled event stream — sample-accurate
        this.followers.push((e) => {
          if (
            e.data?.['__transport'] === src.transport &&
            e.type === src.type &&
            (src.seq === undefined || e.data?.['seq'] === src.seq)
          ) {
            for (const fe of this.anvilSeq.onExternalEdge(e.time)) this.bindAnvilEvent(fe);
          }
        });
      } else {
        // arbitrary signal: edge detector (≤1 block latency)
        this.addEdgeFollower(anvilClock.from, (t) => {
          for (const fe of this.anvilSeq.onExternalEdge(t)) this.bindAnvilEvent(fe);
        });
      }
    }

    const cascadeClockIn = findCable('CAS_CLOCK_IN');
    // Cascade priority: MIDI clock > analog CLOCK in > internal. While MIDI is master it
    // drives the Cascade via routeMidiEdge (4 PPQN) and the analog CLOCK-in cable is ignored.
    this.cascadeClock.externalClock = this.midiClockMaster || !!cascadeClockIn;
    if (cascadeClockIn && !this.midiClockMaster) {
      const src = INTERNAL_CLOCK_EVENTS[cascadeClockIn.from];
      if (src) {
        this.followers.push((e) => {
          if (e.data?.['__transport'] === src.transport && e.type === src.type) {
            for (const fe of this.cascadeClock.onExternalEdge(e.time)) this.bindCascadeEvent(fe);
          }
        });
      } else {
        this.addEdgeFollower(cascadeClockIn.from, (t) => {
          for (const fe of this.cascadeClock.onExternalEdge(t)) this.bindCascadeEvent(fe);
        });
      }
    }

    // Courier external CLOCK IN ("Rising edges replace the internal clock", Courier p.20): a cable in
    // COU_CLOCK_IN suppresses Courier's internal clock and steps its 64-step sequencer one step per
    // rising edge, gate spacing keyed to the measured interval — structurally identical to MON_TEMPO_IN.
    // Courier has no MIDI-clock priority (only Monarch/Cascade do), so the analog cable is the sole driver.
    const courierClock = findCable('COU_CLOCK_IN');
    const courierAnalog = !!courierClock;
    this.courierSeq.externalClock = courierAnalog;
    // Persist the measured-edge timestamp across rebuilds; reset it ONLY when the clock SOURCE
    // changes (cable added / removed / swapped). An unrelated patch edit while externally clocked
    // must NOT reset the interval — that fell back to the internal stepDur for one step's gate
    // spacing (a one-step timing glitch). null<->null is unchanged; a real swap clears it.
    const courierClockSrc = courierClock?.from ?? null;
    if (courierClockSrc !== this.courierClockSource) this.courierClockLastEdge = -1;
    this.courierClockSource = courierClockSrc;
    if (courierClock) {
      const onEdge = (t: number): void => {
        const interval = this.courierClockLastEdge >= 0 ? t - this.courierClockLastEdge : undefined;
        this.courierClockLastEdge = t;
        for (const fe of this.courierSeq.onExternalEdge(t, interval)) this.bindCourierEvent(fe);
      };
      const src = INTERNAL_CLOCK_EVENTS[courierClock.from];
      if (src) {
        this.followers.push((e) => {
          if (
            e.data?.['__transport'] === src.transport &&
            e.type === src.type &&
            (src.seq === undefined || e.data?.['seq'] === src.seq)
          ) {
            onEdge(e.time);
          }
        });
      } else {
        this.addEdgeFollower(courierClock.from, (t) => onEdge(t));
      }
    } else if (this.courierClockPatched && this.courierSeq.running) {
      // COU_CLOCK_IN cable just unplugged while running: the external-clock branch left
      // nextEventTime=Infinity, so re-anchor the internal clock to now or the sequence freezes
      // (mirrors the Monarch TEMPO unplug-resume below).
      this.courierSeq.resumeInternal(this.context.audioContext.currentTime + 0.03);
    }
    this.courierClockPatched = courierAnalog; // remembered for the next rebuild's unplug detection

    // Monarch external TEMPO clock (Single Clock Advance, the hardware default): a cable in
    // MON_TEMPO_IN suppresses the internal clock and steps the pattern one step per rising edge —
    // structurally identical to the Anvil ADV/CLOCK block above.
    const monarchTempo = findCable('MON_TEMPO_IN');
    const monarchAnalog = !!monarchTempo;
    // Monarch priority: analog TEMPO IN > MIDI clock > internal. The analog cable wins; otherwise
    // MIDI (when master) drives it via routeMidiEdge.
    this.monarchSeq.externalClock = monarchAnalog || this.midiClockMaster;
    // Persist the measured-edge timestamp across rebuilds; reset it ONLY on a SOURCE change (see the
    // Courier block above) so an unrelated patch edit while externally clocked keeps the measured
    // interval instead of glitching one step's gate spacing back to the internal stepDur.
    const monarchTempoSrc = monarchTempo?.from ?? null;
    if (monarchTempoSrc !== this.monarchTempoSource) this.monarchTempoLastEdge = -1;
    this.monarchTempoSource = monarchTempoSrc;
    if (monarchTempo) {
      const onEdge = (t: number): void => {
        const interval = this.monarchTempoLastEdge >= 0 ? t - this.monarchTempoLastEdge : undefined;
        this.monarchTempoLastEdge = t;
        for (const fe of this.monarchSeq.onExternalEdge(t, interval)) this.bindMonarchEvent(fe);
      };
      const src = INTERNAL_CLOCK_EVENTS[monarchTempo.from];
      if (src) {
        this.followers.push((e) => {
          if (
            e.data?.['__transport'] === src.transport &&
            e.type === src.type &&
            (src.seq === undefined || e.data?.['seq'] === src.seq)
          ) {
            onEdge(e.time);
          }
        });
      } else {
        this.addEdgeFollower(monarchTempo.from, (t) => onEdge(t));
      }
    } else if (this.monarchTempoPatched && !this.midiClockMaster && this.monarchSeq.running) {
      // TEMPO cable just unplugged (and MIDI not driving): the external-clock advance left
      // nextEventTime=Infinity, so re-anchor the internal clock to now or the sequence freezes.
      this.monarchSeq.resumeInternal(this.context.audioContext.currentTime + 0.03);
    }
    this.monarchTempoPatched = monarchAnalog; // remembered for the next rebuild's unplug detection / MIDI routing

    // Monarch transport gate inputs (gate semantics — always via the edge detector)
    const monarchRun = findCable('MON_RUN_STOP_IN');
    if (monarchRun) {
      this.addEdgeFollower(
        monarchRun.from,
        (t) => this.monarchSeq.start(t),
        () => this.monarchSeq.stop(),
      );
    }
    const monarchReset = findCable('MON_RESET_IN');
    if (monarchReset) {
      this.addEdgeFollower(monarchReset.from, () => this.monarchSeq.reset());
    }
    const monarchHold = findCable('MON_HOLD_IN');
    if (monarchHold) {
      this.monarchHoldPatched = true;
      // SWAP-vs-edit discrimination. A SWAP (the HOLD cable's source changes in one patch update —
      // e.g. a preset load — from a HIGH source to a LOW one) re-adds the follower while findCable
      // stays truthy, so the pure-remove release below never runs and holdActive strands true,
      // freezing the sequence on one step. When the source CHANGES (or there was no prior HOLD
      // cable), release holdActive=false at re-add time: the edge worklet emits a rising edge on
      // connect-to-an-already-high signal (its wasHigh seeds false, so a >=2.5 vv first block fires
      // a rising edge), so a swap to a HIGH source re-raises hold immediately and a swap to a LOW
      // source stays released — released, never frozen. When the source is the SAME (an unrelated
      // patch edit), do NOT touch holdActive — that would clobber a live hold.
      if (monarchHold.from !== this.monarchHoldSource) {
        this.monarchSeq.holdActive = false;
      }
      this.addEdgeFollower(
        monarchHold.from,
        () => {
          this.monarchSeq.holdActive = true;
        },
        () => {
          this.monarchSeq.holdActive = false;
        },
      );
    } else if (this.monarchHoldPatched) {
      // The HOLD cable was just UNPLUGGED. HOLD is a gate input (data/monarch.json), so no
      // cable = signal low = released. Without this, unplugging while the source was HIGH
      // strands holdActive=true: the falling-edge follower that releases it is torn down with
      // the cable (clearEdgeFollowers), so the sequence freezes repeating one step with no
      // obvious recovery (only the momentary panel HOLD clears it). Mirrors the Monarch voice
      // gate's release-on-teardown. Guarded by the prior-patched flag so an unrelated patch
      // edit never clobbers a live panel-HOLD press (that path leaves this flag false).
      this.monarchHoldPatched = false;
      this.monarchSeq.holdActive = false;
    }
    this.monarchHoldSource = monarchHold?.from ?? null; // remembered for the next rebuild's swap detection

    // ---- TASK 3 transport-gate inputs: Anvil RUN/STOP, Cascade PLAY + RESET --------------------
    // Wired exactly like the Monarch gate inputs above (gate semantics via the synthstack-edge
    // worklet), each reusing the existing sequencer transport methods.

    // ANV_RUN/STOP IN (gate, +5 run / 0 stop): rising starts, falling stops. Unlike the Monarch
    // HOLD gate, an UNPLUG must NOT toggle the transport — pulling the run-control cable should
    // leave the Anvil seq exactly as it was running/stopped. So there is no release-on-teardown
    // and no prior-patched flag to track: clearEdgeFollowers simply drops the follower and nothing
    // strands (the seq owns its own `running`).
    const anvilRun = findCable('ANV_RUN_STOP_IN');
    if (anvilRun) {
      this.addEdgeFollower(
        anvilRun.from,
        (t) => this.anvilSeq.start(t),
        () => this.anvilSeq.stop(),
      );
    }

    // CAS_PLAY IN (gate, rising = play / falling = stop): the patchbay parallel of the panel PLAY
    // button (cascadePlay / cascadeStop). Same edge-follower gate semantics as ANV_RUN/STOP.
    const cascadePlay = findCable('CAS_PLAY_IN');
    if (cascadePlay) {
      this.addEdgeFollower(
        cascadePlay.from,
        (t) => this.cascadeClock.start(t),
        () => this.cascadeClock.stop(),
      );
    }

    // CAS_RESET IN (level + edge, data/cascade.json): a RISING edge resets the sequencers to step 1
    // and the RG phases; a SUSTAINED HIGH pins step 1 via resetHeld (EGs keep triggering, NEXT still
    // advances); the release clears resetHeld. The rising-edge handler both reset()s AND sets
    // resetHeld=true so a held gate stays pinned; the falling edge clears resetHeld (mirrors the
    // panel cascadeReset(held) bracket). An UNPLUG while held would strand resetHeld=true (the
    // falling-edge follower is torn down with the cable), so clear it on teardown — exactly like the
    // MON_HOLD release-on-teardown, guarded by the prior-patched flag so an unrelated edit never
    // clobbers a live panel RESET-hold.
    const cascadeResetIn = findCable('CAS_RESET_IN');
    if (cascadeResetIn) {
      this.cascadeResetPatched = true;
      this.addEdgeFollower(
        cascadeResetIn.from,
        () => {
          this.cascadeClock.resetHeld = true;
          this.cascadeClock.reset();
        },
        () => {
          this.cascadeClock.resetHeld = false;
        },
      );
    } else if (this.cascadeResetPatched) {
      this.cascadeResetPatched = false;
      this.cascadeClock.resetHeld = false; // unplug = gate low = release the step-1 hold
    }

    // Sampler pad triggers: a rising edge on SAMP_PAD{n}_TRIG_IN fires that pad
    // (same edge-follower path as the Monarch gate inputs — gate semantics via the
    // synthstack-edge worklet). Pads only RECEIVE edges; they emit nothing schedulable,
    // so there is no INTERNAL_CLOCK_EVENTS entry.
    for (let n = 1; n <= 8; n++) {
      const c = findCable(`SAMP_PAD${n}_TRIG_IN`);
      if (c) this.addEdgeFollower(c.from, (t) => this.sampler.triggerPad(n - 1, t));
    }

    // ---- U2 CV-rate inputs: ANV_TEMPO_IN + CAS_RHYTHM_1..4_IN (control-rate sample-and-hold) ----
    // A cable here attaches a synthstack-cv-sample tap to the resolved source bus; sampleCvTaps
    // (chained after the MIDI-clock watchdog in beforePump) folds the latest value in every pump.
    // On UNPLUG (no cable this rebuild) the tap is gone (clearCvTaps) AND we restore the knob-only
    // target so no CV offset strands — mirroring the edge-follower release-on-teardown.

    // ANV_TEMPO_IN: CV over the Anvil step rate. The knob value (store ANV_TEMPO, Hz) is the base;
    // rate = anvilStepRateHz(knob01, cvVv). Re-reading the store each pump honors a live knob turn
    // while patched. TEMPO LINK also writes rateHz from the master BPM — when LINKED, ANV_TEMPO_IN
    // would fight the link, so the CV path defers to LINK (the operator's documented ears checkpoint
    // is the CV→rate feel, not the link arbitration; LINK wins as it does for the knob).
    const anvilTempoCv = findCable('ANV_TEMPO_IN');
    if (anvilTempoCv) {
      this.addCvTap(anvilTempoCv.from, (v) => {
        if (this.tempoLink) return; // LINK owns rateHz; CV defers (knob behaves the same way)
        this.anvilSeq.rateCvVv = v;
        this.anvilSeq.rateHz = anvilStepRateHz(expKnob01(this.anvilTempoKnobHz(), 0.7, 700), v);
      });
    } else if (this.anvilSeq.rateCvVv !== 0) {
      // UNPLUG: a CV offset was stranding the rate above knob-only. Zero it and restore the
      // knob-only rate (unless LINK owns rateHz — then leave it to applyTempoLink). Mirrors the
      // edge-follower release-on-teardown; no tap runs after teardown, so this must be active here.
      this.anvilSeq.rateCvVv = 0;
      if (!this.tempoLink) {
        this.anvilSeq.rateHz = anvilStepRateHz(expKnob01(this.anvilTempoKnobHz(), 0.7, 700), 0);
      }
    }

    // CAS_RHYTHM_1..4_IN: CV over each RG divider integer. cascadeClock.divisionCvVv[n] already
    // feeds effectiveDivision (clamped 1..16 — no divide-by-zero). Zero the offset on unplug.
    for (let n = 0; n < 4; n++) {
      const rcable = findCable(`CAS_RHYTHM_${n + 1}_IN`);
      this.cascadeClock.divisionCvVv[n] = 0; // default; restored per pump while patched
      if (rcable) {
        this.addCvTap(rcable.from, (v) => {
          this.cascadeClock.divisionCvVv[n as 0 | 1 | 2 | 3] = v;
        });
      }
    }
  }

  // ---- transport conveniences -----------------------------------------------------------

  runAll(): void {
    const now = this.context.audioContext.currentTime + 0.05;
    this.monarchSeq.start(now);
    this.anvilSeq.start(now);
    this.cascadeClock.start(now);
    // START ALL is the single master transport: it also runs the drum grid, started in the
    // SAME gesture as the Monarch (the drum grid slaves to the Monarch phase, so a simultaneous
    // start locks them with no "who started first" ambiguity). An empty grid is a silent no-op.
    this.samplerSeq.start(now);
    // 6th transport: the Courier step seq joins the master START ALL (its internal clock follows
    // LINK like the Monarch). An all-rest / empty pattern is a silent no-op.
    this.courierSeq.start(now);
  }

  stopAll(): void {
    this.monarchSeq.stop();
    this.anvilSeq.stop();
    this.cascadeClock.stop();
    this.samplerSeq.stop(); // STOP ALL halts the drum grid too (mirrors runAll)
    this.courierSeq.stop();
    this.flushCourierParamLocks(); // restore any active param-lock to its base (no frozen knob)
    const t = this.context.audioContext.currentTime;
    this.monarch.gateAt(false, t);
    this.courier.gateAt(false, t); // drop a possibly-hung Courier gate (mirrors the Monarch drop)
  }

  /**
   * PANIC / ALL SOUND OFF — the user-facing "make it stop" escape hatch. Halts EVERY sound
   * generator and releases the shared gate: all five transports (the three voices + the drum
   * step seq + the sampler loop clock), the held sampler-loop voices, and the Monarch gate.
   * Goes WIDER than stopAll(), which only stops the three voice transports.
   *
   * Non-destructive: the patch, cables, knob values and sequences are untouched — press RUN
   * to resume. NOTE: a voice deliberately held open by VCA MODE = ON is not "runaway" — it
   * ignores the gate — so panic() cannot silence it; that is the voice's VCA mode / its mixer
   * channel / the MASTER knob. The keyboard/MIDI held-note stack is cleared by the bridge
   * (engineBridge.panic -> releaseAllNotes) before this runs.
   */
  panic(): void {
    const t = this.context.audioContext.currentTime;
    this.monarchSeq.stop();
    this.anvilSeq.stop();
    this.cascadeClock.stop();
    this.samplerSeq.stop();
    this.courierSeq.stop();
    this.flushCourierParamLocks(); // restore any active param-lock to its base before silence
    this.samplerLoops.panicAll(); // clear the loop SCHEDULE so nothing re-launches...
    for (let i = 0; i < 8; i++) this.sampler.stopLoop(i, t); // ...and stop the sounding voices
    this.monarch.gateAt(false, t);
    this.courier.gateAt(false, t);
  }

  /** TEMPO LINK: slave Anvil step rate and Cascade tick rate to Monarch BPM. */
  applyTempoLink(): void {
    if (!this.tempoLink) return;
    const bpm = this.monarchSeq.tempoBpm;
    this.anvilSeq.rateHz = (bpm / 60) * 4; // 16th steps
    this.cascadeClock.tempoHz = bpm / 60; // 1 PPQ
    this.courierSeq.tempoBpm = bpm; // both are BPM — Courier follows Monarch exactly under LINK
  }

  // ---- external MIDI transport clock (fed by the bridge from Web MIDI) -----------------------
  // 24-PPQN clock ÷6 → 16ths. While running, MIDI is the studio master: it clocks the Cascade
  // (4 PPQN, priority MIDI > analog) and the Monarch (unless its analog TEMPO IN is patched —
  // priority analog > MIDI). The bridge guards on power; the studio time-stamps to currentTime + lead
  // (main-thread tick jitter is accepted — documented in DECISIONS.md). Real-device delivery is an
  // operator hardware checkpoint; the divider + routing are proven headlessly in the audio battery.

  /** 0xF8 clock tick. `time` defaults to the audio clock (currentTime + lead) for live Web MIDI. */
  onMidiClockTick(time?: number): void {
    if (!this.built) return;
    const t = time ?? this.context.audioContext.currentTime + 0.02;
    if (this.midiClock.onTick(t)) this.routeMidiEdge(t);
    if (this.tempoLink && this.midiClockMaster) {
      this.anvilSeq.rateHz = (this.midiClock.tempoBpm / 60) * 4; // Anvil has no MIDI clock in — follows via LINK
    }
  }

  /** 0xFA Start: become master, realign both clocked sequencers to their downbeat. */
  onMidiClockStart(): void {
    if (!this.built) return;
    this.midiClock.start();
    this.midiClockMaster = true;
    this.monarchSeq.reset();
    this.cascadeClock.reset();
    this.rebuildFollowers({ cables: this.store.getState().cables });
  }

  /** 0xFB Continue: become master, keep the current phase. */
  onMidiClockContinue(): void {
    if (!this.built) return;
    this.midiClock.continue();
    this.midiClockMaster = true;
    this.rebuildFollowers({ cables: this.store.getState().cables });
  }

  /** 0xFC Stop: release master; restore internal scheduling for anything MIDI was clocking. */
  onMidiClockStop(): void {
    if (!this.built) return;
    this.midiClock.stop();
    this.releaseMidiMaster();
  }

  /** True while external MIDI clock is the studio master (read-only status for the UI poll). */
  isMidiClockMaster(): boolean {
    return this.midiClockMaster;
  }

  /**
   * Watchdog gap (s). While master, if no 0xF8 has arrived for this long WITHOUT a 0xFC Stop, the
   * watchdog auto-releases master (a stalled / unplugged upstream clock). GENEROUS by design: at
   * 120 BPM a tick is ~20.8 ms, so 0.5 s ≈ 24 missed ticks — well past normal main-thread MIDI
   * jitter or a momentary tab throttle, so it never spuriously drops master mid-song.
   * EARS: the exact feel of this gap is a by-ear checkpoint for the operator (see report).
   */
  static readonly MIDI_CLOCK_WATCHDOG_GAP_S = 0.5;

  /**
   * Run once per scheduler pump (wired as scheduler.beforePump). When master, if the upstream clock
   * has gone silent past the watchdog gap (no Stop received), release master exactly like a Stop.
   * PURE-ish: only reads `now` + the clock's lastTickTime; no AudioContext reads beyond what the
   * release path already does. NO setInterval/setTimeout — this rides the existing lookahead pump.
   */
  checkMidiClockWatchdog(now: number): void {
    if (!this.built || !this.midiClockMaster) return;
    if (this.midiClock.staleSince(now, Studio.MIDI_CLOCK_WATCHDOG_GAP_S)) {
      this.midiClock.stop();
      this.releaseMidiMaster();
    }
  }

  /** Shared MIDI-master release (Stop + watchdog): clear master, recompute follower priority, and
   *  re-anchor the Monarch if it is now internal and running. */
  private releaseMidiMaster(): void {
    this.midiClockMaster = false;
    this.rebuildFollowers({ cables: this.store.getState().cables });
    // The Monarch's external-clock advance left nextEventTime=Infinity; if it is now internal and
    // running, re-anchor it (the Cascade self-recovers — its advance always bumps nextEventTime).
    if (!this.monarchSeq.externalClock && this.monarchSeq.running) {
      this.monarchSeq.resumeInternal(this.context.audioContext.currentTime + 0.03);
    }
  }

  private routeMidiEdge(t: number): void {
    // Cascade consumes the MIDI clock (every 6th tick = 4 PPQN = one 16th).
    for (const e of this.cascadeClock.onExternalEdge(t)) this.bindCascadeEvent(e);
    // Monarch follows MIDI only when its analog TEMPO IN is NOT patched (analog > MIDI).
    if (!this.monarchTempoPatched) {
      for (const e of this.monarchSeq.onExternalEdge(t)) this.bindMonarchEvent(e);
    }
  }

  // ---- UI bridge passthroughs (stage-1 interface pass; ADDITIVE ONLY) -------------------
  // Called exclusively by src/ui/engineBridge.ts, which guards on power state.
  // Manual transport actions land at currentTime + 0.03 s so scheduled param writes
  // stay ahead of the render quantum. Each method only delegates to the existing
  // transports / private event binders — no new behavior.

  monarchRun(): void {
    this.monarchSeq.start(this.context.audioContext.currentTime + 0.03);
  }

  monarchStop(): void {
    this.monarchSeq.stop();
    this.monarch.gateAt(false, this.context.audioContext.currentTime + 0.03); // no hung gate (mirrors stopAll)
  }

  monarchReset(): void {
    this.monarchSeq.reset();
  }

  /** HOLD button: true on pointerdown, false on release (sequencer stays on its step). */
  monarchHold(down: boolean): void {
    this.monarchSeq.holdActive = down;
  }

  // ---- Courier transport (Phase C) — exact parallel of monarchRun/Stop/Reset ----------------

  courierRun(): void {
    this.courierSeq.start(this.context.audioContext.currentTime + 0.03);
  }

  courierStop(): void {
    this.courierSeq.stop();
    this.flushCourierParamLocks(); // restore any active param-lock to its base (no frozen knob)
    this.courier.gateAt(false, this.context.audioContext.currentTime + 0.03); // no hung gate
  }

  courierReset(): void {
    this.courierSeq.reset();
  }

  /**
   * Keyboard / MIDI live-play NOTE ON (thin adapter). The SAME two
   * calls bindMonarchEvent makes for the sequencer (studio.ts pitch/gateOn cases), so the
   * on-screen keyboard / Web MIDI drive the Monarch mono voice exactly like the seq does —
   * sharing the one kbCv/kbGate voice (last write per AudioParam wins = hardware parity).
   *   glide=true: the module's setPitchAt reads glideTimeS (the GLIDE knob) and only
   *               actually glides when GLIDE is up — no new glide state here.
   *   retrigger=false (legato / held-note fall-back): pitch moves but the gate is already
   *               high, so do NOT re-raise it — no EG re-attack, matching classic SynthStack mono.
   */
  monarchNoteOn(noteVv: number, retrigger: boolean, velGain?: number, glideS?: number): void {
    const t = this.context.audioContext.currentTime + 0.03;
    // Keyboard glide (G1): pass the SEPARATE keyboard glideS as the setPitchAt override (undefined =>
    // the module's own glideTimeS, the sequencer value — preserves current behavior).
    this.monarch.setPitchAt(noteVv, t, true, glideS);
    // Velocity (G1): write velocity BEFORE raising the gate so the VCA sees it at attack. velGain is
    // a GAIN that SCALES the EG->VCA path (units.velocityToGain, unity at 100); undefined => leave
    // the velocity gain unchanged. No note-off reset needed — the EG returns the VCA to silence.
    if (velGain !== undefined) this.monarch.velocityAt(velGain, t);
    if (retrigger) this.monarch.gateAt(true, t);
  }

  /** Keyboard / MIDI live-play NOTE OFF: drop the gate (same gateAt call as gateOff). */
  monarchNoteOff(): void {
    this.monarch.gateAt(false, this.context.audioContext.currentTime + 0.03);
  }

  /**
   * Keyboard / MIDI live-play NOTE ON for the Courier voice — the exact parallel of
   * monarchNoteOn (Courier exposes the same setPitchAt/gateAt binding surface). Used when the
   * bridge's keyboard target is 'courier'.
   *   glide=true: setPitchAt reads the module's glideTimeS and only glides when GLIDE is up.
   *   retrigger=false (legato / held-note fall-back): pitch moves, gate stays high (no re-attack).
   */
  courierNoteOn(noteVv: number, retrigger: boolean, velGain?: number, glideS?: number): void {
    const t = this.context.audioContext.currentTime + 0.03;
    this.courier.setPitchAt(noteVv, t, true, glideS); // glideS => keyboard glide override (G1)
    if (velGain !== undefined) this.courier.velocityAt(velGain, t); // velocity BEFORE the gate (G1)
    if (retrigger) {
      this.courier.gateAt(true, t);
    } else if (this.courier.multiTrig) {
      // MULTI-TRIG: a legato keypress (gate already high) forces a discrete down→up edge so both
      // EGs restart their attack. The 1 ms gap spans render blocks so the worklet sees the edge.
      this.courier.gateAt(false, t);
      this.courier.gateAt(true, t + 0.001);
    }
  }

  /** Courier live-play NOTE OFF: drop the gate (mirrors monarchNoteOff). */
  courierNoteOff(): void {
    this.courier.gateAt(false, this.context.audioContext.currentTime + 0.03);
  }

  /** Courier PITCH WHEEL: live bend in semitones (all oscillators). */
  courierPitchBend(semitones: number): void {
    this.courier.setPitchBend(semitones);
  }

  /** Courier MOD WHEEL (0..1): scales LFO 2 depth into its selected destination. */
  courierModWheel(amount01: number): void {
    this.courier.setModWheel(amount01);
  }

  anvilRun(): void {
    this.anvilSeq.start(this.context.audioContext.currentTime + 0.03);
  }

  anvilStop(): void {
    this.anvilSeq.stop();
  }

  /** ADVANCE button: move one step WITHOUT triggering — events through the standard binder. */
  anvilManualAdvance(): void {
    for (const e of this.anvilSeq.manualAdvance(this.context.audioContext.currentTime + 0.03)) {
      this.bindAnvilEvent(e);
    }
  }

  /** TRIGGER button: fire the current step WITHOUT advancing. */
  anvilManualTrigger(): void {
    for (const e of this.anvilSeq.manualTrigger(this.context.audioContext.currentTime + 0.03)) {
      this.bindAnvilEvent(e);
    }
  }

  cascadePlay(): void {
    this.cascadeClock.start(this.context.audioContext.currentTime + 0.03);
  }

  cascadeStop(): void {
    this.cascadeClock.stop();
  }

  /**
   * RESET button. No argument = one-shot reset (simple click). With a boolean:
   * cascadeReset(true) on pointerdown resets AND pins step 1 (clock.resetHeld) until
   * cascadeReset(false) on release — NEXT still advances during the hold.
   */
  cascadeReset(held?: boolean): void {
    if (held === undefined) {
      this.cascadeClock.reset();
      return;
    }
    this.cascadeClock.resetHeld = held;
    if (held) this.cascadeClock.reset();
  }

  /** NEXT button: advance both sequencers WITHOUT an EG retrigger. */
  cascadeNext(): void {
    for (const e of this.cascadeClock.next(this.context.audioContext.currentTime + 0.03)) {
      this.bindCascadeEvent(e);
    }
  }

  /** TRIGGER button, behavior per the current EG mode. */
  cascadeTriggerButton(down: boolean): void {
    this.cascade.triggerButton(
      down,
      this.context.audioContext.currentTime + 0.03,
      this.cascadeClock.egMode,
    );
  }

  /** TEMPO LINK switch: engine-side flag + immediate re-slave when enabled. */
  setTempoLink(on: boolean): void {
    this.tempoLink = on;
    this.applyTempoLink();
  }

  setMixerLevel(channel: number, level01: number): void {
    this.mixer.setLevel(channel, level01);
  }

  setMasterVolume(v01: number): void {
    this.context.setMasterVolume(v01);
  }

  // ---- master effects (Wave 2) — forward to the FX chain at insertSlot ----------------------

  setMasterFxOn(id: MasterFxId, on: boolean): void {
    this.context.setMasterFxOn(id, on);
  }

  setMasterFxParam(id: MasterFxId, param: string, value: number): void {
    this.context.setMasterFxParam(id, param, value);
  }

  // ---- per-voice insert effects (the 3 voice→mixer edges) ----------------------------------

  setVoiceFxOn(voiceId: VoiceFxId, id: MasterFxId, on: boolean): void {
    this.voiceFx.get(voiceId)?.setOn(id, on);
  }

  setVoiceFxParam(voiceId: VoiceFxId, id: MasterFxId, param: string, value: number): void {
    this.voiceFx.get(voiceId)?.setParam(id, param, value);
  }

  // ---- master-output recording passthroughs (ADDITIVE; called by src/ui/engineBridge.ts)
  // The recorder is owned by StudioContext (it taps the private softClip); these only
  // delegate. powerOff (above) already routes through context.powerOff, which auto-stops
  // and flushes a recording in progress before suspend — no extra stop is needed here.

  setRecordFormat(format: RecordFormat): void {
    this.context.setRecordFormat(format);
  }

  startRecording(): boolean {
    return this.context.startRecording();
  }

  stopRecording(): Promise<Blob | null> {
    return this.context.stopRecording();
  }

  getRecordingState(): { recording: boolean; elapsedMs: number } {
    return this.context.getRecordingState();
  }

  // ---- sampler passthroughs (ADDITIVE; called by src/ui/engineBridge.ts) ----------------
  // Manual audition lands at currentTime + 0.03 s (mirrors anvilManualTrigger) so the
  // fresh AudioBufferSourceNode starts ahead of the render quantum. The rest delegate
  // straight to the SamplerModule — no new behavior.

  triggerPad(padIndex: number): void {
    this.sampler.triggerPad(padIndex, this.context.audioContext.currentTime + 0.03);
  }

  /**
   * LOOP-aware UI-tap entry (loop-quantize feature) — the only path auditionPad takes.
   * Reads the Monarch master phase, quantizes the launch to the SAMP_QUANTIZE grid, then
   * routes by pad state:
   *   LOOP off                  -> one aligned play (triggerPad), no repeat (spec item 5)
   *   LOOP on + sounding        -> tap-again STOPS, deferred to the grid (spec item 2)
   *   LOOP on + not sounding    -> start + per-bar re-launch on the grid
   * When the master is STOPPED, phase.running is false: nextBoundary returns afterTime
   * unchanged, so target == today's +0.03 audition feel (QUANT effectively OFF), and the
   * clock keeps nextEventTime=Infinity for re-launch (native source.loop covers continuity).
   * The external SAMP_PAD{n}_TRIG_IN edge path is untouched and stays immediate.
   */
  launchPad(padIndex: number): void {
    const phase: PhaseRef = this.monarchSeq.phaseRef();
    this.samplerLoops.setPhase(phase); // freshest tempo/run state before any effect
    const afterTime = this.context.audioContext.currentTime + 0.03; // preserve the audition lead
    const target = nextBoundary(afterTime, this.samplerQuantize, phase);
    if (!this.sampler.loopOn(padIndex)) {
      this.sampler.triggerPad(padIndex, target); // one aligned play, no repeat
      return;
    }
    if (this.sampler.isLoopSounding(padIndex)) {
      this.samplerLoops.requestStop(padIndex, target, phase); // tap-again stops
    } else {
      this.samplerLoops.requestLaunch(padIndex, target, phase); // start + per-bar re-launch
    }
  }

  loadPadBuffer(padIndex: number, buffer: AudioBuffer): void {
    this.sampler.loadPadBuffer(padIndex, buffer);
  }

  /**
   * Per-pad FACTORY picker support: resolve a 'factory-' id from the in-memory
   * factoryBuffers map (populated by loadFactorySamples) and write that ±1.0 buffer
   * onto the pad. No-op if the id is absent (buffers not yet rendered, or unknown id) —
   * mirrors loadPadBuffer; the audible bytes are never persisted (D10). The store ref
   * is committed by the bridge (engineBridge.assignFactoryToPad).
   */
  loadPadBufferFromFactory(padIndex: number, factoryId: string): void {
    const b = this.factoryBuffers.get(factoryId);
    if (b) this.sampler.loadPadBuffer(padIndex, b);
  }

  /** INIT support: drop every loaded pad buffer so an emptied UI stops sounding. */
  clearPadBuffers(): void {
    for (let i = 0; i < 8; i++) this.sampler.clearPadBuffer(i);
  }

  setPadLevel(padIndex: number, level01: number): void {
    this.sampler.setControl(`SAMP_PAD${padIndex + 1}_LEVEL`, level01);
  }

  setPadTune(padIndex: number, semis: number): void {
    this.sampler.setControl(`SAMP_PAD${padIndex + 1}_TUNE`, semis);
  }

  /**
   * LOOP toggle (declarative): set the module flag + mirror it on the loop clock. Does
   * NOT start/stop audio — it only changes which path the NEXT tap takes. A sounding
   * loop keeps going when LOOP flips OFF until the user taps to stop
   * ("tap launches, tap again stops").
   */
  setPadLoop(padIndex: number, on: boolean): void {
    this.sampler.setControl(`SAMP_PAD${padIndex + 1}_LOOP`, on ? 'ON' : 'OFF');
    this.samplerLoops.setLoopEnabled(padIndex, on);
  }

  /** Global QUANTIZE selector — the engine-side launch grid (QuantizeDivision and
   *  QuantDivision are the identical 6 string literals). */
  setSamplerQuantize(div: QuantizeDivision): void {
    this.samplerQuantize = div as unknown as QuantDivision;
  }

  /** Live read for the panel LOOP LED (runtime audio state, never serialized). */
  samplerLoopSounding(padIndex: number): boolean {
    return this.sampler.isLoopSounding(padIndex);
  }

  // ---- drum step sequencer passthroughs (ADDITIVE; called by src/ui/engineBridge.ts) ----
  // Independent of the SynthStack RUN ALL (DECISION 6) — runAll/stopAll do NOT touch samplerSeq in
  // v1. drumRun lands at currentTime + 0.03 s (mirrors the other manual transports / monarchRun /
  // launchPad) so the run-edge boundary capture stays ahead of the render quantum.

  drumRun(): void {
    this.samplerSeq.start(this.context.audioContext.currentTime + 0.03);
  }

  drumStop(): void {
    this.samplerSeq.stop();
  }

  /** Toggle one cell (track = pad 0..7, step 0..15). Read at the boundary, no recompute. */
  setDrumStep(track: number, step: number, on: boolean): void {
    this.samplerSeq.setStep(track, step, on);
  }

  /** CLEAR: rebuild the pattern as 8x16 all-false. */
  clearDrumPattern(): void {
    this.samplerSeq.clear();
  }

  /** applyState path: push the whole persisted 8x16 pattern (declarative; never auto-runs). */
  setDrumPattern(pattern: boolean[][]): void {
    this.samplerSeq.setPattern(pattern);
  }

  /** Wrap length 1..16 (engine clamps). Columns >= numSteps stay in the pattern but unplayed. */
  setDrumNumSteps(n: number): void {
    this.samplerSeq.setNumSteps(n);
  }

  /** Drum swing 0..100 (50 = none). Offsets odd columns; conversion via units.swingOffsetS. */
  setDrumSwing(pct: number): void {
    this.samplerSeq.setSwing(pct);
  }

  /** Live read for the RUN/STOP latch lamp (user playing flag, mirrored into the store). */
  drumSeqPlaying(): boolean {
    return this.samplerSeq.isPlaying();
  }

  /** The one AudioContext — the bridge needs it for decodeAudioData. */
  audioContextForDecode(): AudioContext {
    return this.context.audioContext;
  }

  /**
   * Render EVERY kit's factory one-shots (G6) and register their ±1.0 buffers in the flat
   * factoryBuffers map. The audible bytes are NEVER persisted — playback resolves the
   * buffer from this in-memory map (a 'factory-' id; see reloadPadBuffers / selectKit), and
   * the pad's display name lives in state.sampler.pads. Awaited at power-on. Registering
   * every kit up front makes a kit-select / per-pad pick a zero-render lookup; ids are
   * globally unique across kits, so the flat map never collides.
   */
  async loadFactorySamples(): Promise<void> {
    const fs = await renderAllKits();
    for (const f of fs) {
      this.factoryBuffers.set(f.id, f.buffer);
    }
  }

  /**
   * Resolve every pad's referenced buffer back into the SamplerModule (setState path).
   * Factory ids come from the in-memory factoryBuffers; user ids decode from the backend.
   * Fire-and-forget from the bridge — never blocks applyState. Pads stay silent (a
   * trigger is a no-op while hasSample is false) until their decode resolves.
   */
  async reloadPadBuffers(
    samplerState: SamplerState | undefined,
    backend: SampleBackend,
  ): Promise<void> {
    const samp = samplerState ?? defaultSamplerState();
    for (let i = 0; i < 8; i++) {
      const id = samp.pads[i]?.sampleId;
      if (!id) continue;
      if (id.startsWith('factory-')) {
        const b = this.factoryBuffers.get(id);
        if (b) this.sampler.loadPadBuffer(i, b);
      } else {
        // Guard each pad: a single corrupt/undecodable stored sample must not reject the
        // whole (fire-and-forget) reload and strand the remaining pads. That pad stays empty.
        try {
          const rec = await backend.get(id);
          if (rec && rec.bytes.byteLength) {
            // decodeAudioData detaches its buffer — pass a private slice (D10 byte-safety).
            const buf = await this.context.audioContext.decodeAudioData(rec.bytes.slice(0));
            this.sampler.loadPadBuffer(i, buf);
          }
        } catch {
          // unreadable record or undecodable bytes — leave the pad empty (silent no-op trigger)
        }
      }
    }
  }

  // ---- state <-> engine ---------------------------------------------------------------------

  private syncTransportConfig(): void {
    const s = this.store.getState();
    this.monarchSeq.endStep = s.transport.monarch.endStep;
    this.monarchSeq.swingPct = s.transport.monarch.swingPct;
    this.monarchSeq.steps = s.transport.monarch.steps.map((st) => ({ ...st }));
    this.anvilSeq.steps = s.transport.anvil.steps.map((st) => ({ ...st }));
    // Courier seq slice -> live sequencer (state.courier.seq, NOT state.transport). Coalesce
    // guarantees the slice exists on every load path. CourierStepState is structurally identical
    // to the engine's CourierStep, so a shallow per-step copy needs no translation.
    const c = s.courier.seq;
    // Deep-copy the param-lock map AND the per-step note pool so the engine seq never aliases the
    // store (the seq only reads them, so this is defensive — the rest of the step copies shallow).
    this.courierSeq.steps = c.steps.map((st) => ({
      ...st,
      lock: st.lock ? { ...st.lock } : null,
      notePool: st.notePool.slice(),
    }));
    this.courierSeq.endStep = c.endStep;
    this.courierSeq.swingPct = c.swingPct;
    this.courierSeq.gateLenScale = c.gateLenScale;
    this.courierSeq.clockDivIdx = c.clockDivIdx;
    this.courierSeq.seed = c.seed; // probability PRNG seed (reseeds on the next start/reset)
    this.courierSeq.arpOctave = c.arpOctave; // arp octave span 1..4
    this.courierSeq.arpRhythmIdx = c.arpRhythmIdx; // arp's own clock division
    // mode SEQ/ARP gates whether the arp runs: pass the whole widened arpMode through, but force
    // OFF unless mode is ARP (the engine CourierArpMode is the same widened union).
    this.courierSeq.arpMode = c.mode === 'ARP' ? c.arpMode : 'OFF';
    // Drum grid var-length + swing — pushed on every store notification (mirrors the monarch
    // endStep/swing mirror above). Coalesce guarantees the slice + both fields exist on every
    // load path; both are commit-only controls so there is no live-drag clobber to guard.
    const samp = coalesceSamplerState(s.sampler);
    this.samplerSeq.setNumSteps(samp.numSteps);
    this.samplerSeq.setSwing(samp.swingPct);
  }

  /** Resolve a control-bearing module instance by id (the named voice fields). Called only
   *  after an ownsControlDefaults gate, so the four control modules (monarch/anvil/cascade/
   *  courier) are the only inputs (sampler never reaches here). */
  private controlModule(id: string): MonarchModule | AnvilModule | CascadeModule | CourierModule {
    return id === 'monarch'
      ? this.monarch
      : id === 'anvil'
        ? this.anvil
        : id === 'courier'
          ? this.courier
          : this.cascade;
  }

  /** Apply a full state tree to the engine (setState path). */
  applyState(state: StudioState): void {
    this.store.setState(state);
    for (const [moduleId, controls] of Object.entries(state.controls)) {
      // Only control-bearing modules apply here. Sampler is excluded via its registry flag
      // (ownsControlDefaults:false) — its pad params live in state.sampler (NOT state.controls),
      // so state.controls.sampler is always {} and is skipped, exactly as the old
      // `if (moduleId === 'sampler') continue;` did. This also guards a stray future write to a
      // non-control module reaching the wrong setControl.
      if (!moduleConfig(moduleId)?.ownsControlDefaults) continue;
      const mod = this.controlModule(moduleId);
      for (const [controlId, value] of Object.entries(controls)) {
        mod.setControl(controlId, value);
        if (controlId === 'MON_TEMPO' && typeof value === 'number') {
          this.monarchSeq.tempoBpm = value;
        }
        if (controlId === 'COU_TEMPO' && typeof value === 'number') {
          this.courierSeq.tempoBpm = value; // independent Courier BPM when LINK is OFF
        }
        if (controlId === 'ANV_TEMPO' && typeof value === 'number') {
          this.anvilSeq.rateHz = anvilStepRateHz(expKnob01(value, 0.7, 700), 0);
        }
        if (controlId === 'CAS_TEMPO' && typeof value === 'number') {
          this.cascadeClock.tempoHz = value;
        }
      }
    }
    this.patch(state.cables);
    this.mixer.setLevel(0, state.mixer.channelLevels[0]);
    this.mixer.setLevel(1, state.mixer.channelLevels[1]);
    this.mixer.setLevel(2, state.mixer.channelLevels[2]);
    this.mixer.setLevel(3, state.mixer.channelLevels[3]);
    this.mixer.setLevel(4, state.mixer.channelLevels[4]);
    this.context.setMasterVolume(state.mixer.masterVolume);
    // Sampler pad LEVEL/TUNE/LOOP + global QUANTIZE -> module (synchronous). Buffer
    // (de)coding is async and lives in the bridge (powerOn calls reloadPadBuffers
    // fire-and-forget) — not here. coalesceSamplerState fills loop:false / quantize:'1 BAR'
    // on older saved trees. Pushing loop:true is a FLAG SET ONLY — it never calls
    // startLoop, so power-on / INIT never spontaneously launches a loop (a loop only
    // sounds on a user tap).
    const samp = coalesceSamplerState(state.sampler);
    for (let i = 0; i < 8; i++) {
      const pad = samp.pads[i] ?? defaultPad();
      this.sampler.setControl(`SAMP_PAD${i + 1}_LEVEL`, pad.level);
      this.sampler.setControl(`SAMP_PAD${i + 1}_TUNE`, pad.tuneSemis);
      this.sampler.setControl(`SAMP_PAD${i + 1}_LOOP`, pad.loop ? 'ON' : 'OFF');
      this.samplerLoops.setLoopEnabled(i, pad.loop);
    }
    this.setSamplerQuantize(samp.quantize);
    // Drum grid: push the persisted 8x16 pattern. seqRunning is a declarative FLAG ONLY —
    // applyState NEVER calls drumRun() (exactly like loop:true above never calls startLoop),
    // so power-on / INIT never spontaneously plays the grid. The persisted seqRunning boolean
    // was already restored to the store by this.store.setState(state) at the top; the live
    // samplerSeq boots STOPPED. INIT halts a running grid via the bridge's resetAll (drumStop).
    this.samplerSeq.setPattern(samp.pattern);
    // Drum var-length + swing from the coalesced slice (declarative restore; never auto-runs).
    this.samplerSeq.setNumSteps(samp.numSteps);
    this.samplerSeq.setSwing(samp.swingPct);
    this.tempoLink = state.mixer.tempoLink;
    this.applyTempoLink();
    // FX: push the whole effects slice into the graph (coalesce fills an older tree's missing
    // `effects` / `effects.voices` -> all off). Effects are dry-only when off, so this is silent
    // for a default tree; INIT/preset restores the exact wet/param state for master + each voice.
    const fx = coalesceEffectsState(state.effects);
    this.context.applyMasterEffects(fx.master);
    for (const v of VOICE_FX_IDS) this.voiceFx.get(v)?.applyMasterEffects(fx.voices[v]);
    // Courier mod-assign: push every route into the engine (coalesce heals an older/garbage tree
    // to all-null). Each setModAssign only mutates the pre-built scale-gain `.gain.value`, so this
    // is the FX-slice idiom — runs on every powerOn / INIT / preset-load / import.
    const cma = coalesceCourierModAssignState(state.courier?.modAssign);
    for (const [src, entry] of Object.entries(cma.routes)) {
      this.courier.setModAssign(src as CourierModSource, entry);
    }
  }

  getState(): StudioState {
    return this.store.getState();
  }
}
