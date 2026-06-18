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
import type { MasterFxId } from './fx/masterFxChain';
import { MonarchModule } from './modules/monarch';
import { AnvilModule } from './modules/anvil';
import { CascadeModule } from './modules/cascade';
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
import { SamplerLoopClock } from './sequencers/samplerLoops';
import { SamplerStepSeq } from './sequencers/samplerSeq';
import { nextBoundary, type QuantDivision, type PhaseRef } from './quantGrid';
import { renderFactorySamples } from './factorySamples';
import type { SampleBackend } from './sampleStore';
import {
  StudioStore,
  coalesceEffectsState,
  coalesceSamplerState,
  defaultSamplerState,
  defaultPad,
  type StudioState,
  type SamplerState,
  type QuantizeDivision,
} from '../state/studioState';
import { anvilStepRateHz, expKnob01 } from './units';

export const CABLE_COUNT = 12; // D5
export const CABLE_COLORS = ['#d4a017', '#b0413e', '#3e6fb0', '#3e8e5a', '#7a4fa3', '#c2c2c2'];

/** Internal clock outputs whose pulses exist in the scheduled event stream. */
const INTERNAL_CLOCK_EVENTS: Record<string, { transport: string; type: string; seq?: number }> = {
  MON_ASSIGN_OUT: { transport: 'monarchseq', type: 'assignPulse' },
  CAS_CLOCK_OUT: { transport: 'cascadeclock', type: 'clockOutPulse' },
  CAS_SEQ1_CLK_OUT: { transport: 'cascadeclock', type: 'seqClkPulse', seq: 0 },
  CAS_SEQ2_CLK_OUT: { transport: 'cascadeclock', type: 'seqClkPulse', seq: 1 },
  ANV_TRIGGER_OUT: { transport: 'anvilseq', type: 'trigger' },
};

export class Studio {
  readonly context = new StudioContext();
  readonly store = new StudioStore();
  monarch!: MonarchModule;
  anvil!: AnvilModule;
  cascade!: CascadeModule;
  sampler!: SamplerModule;
  mixer!: MixerModule;
  router!: RouterBinding;
  scheduler!: Scheduler;
  readonly monarchSeq = new MonarchSequencer();
  readonly anvilSeq = new AnvilSequencer();
  readonly cascadeClock = new CascadeClock();
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

  /** Rendered factory one-shot buffers (peak-normalised ±1.0), keyed by 'factory-*'
   *  id. In-memory only — never serialized (D10); state stores only the sampleId ref. */
  private readonly factoryBuffers = new Map<string, AudioBuffer>();

  /** follower hooks recomputed on every patch change: source event -> follower call */
  private followers: ((e: TransportEvent) => void)[] = [];
  /** live edge-detector taps for arbitrary-signal followers (stage 3) */
  private edgeFollowers: { tap: AudioNode; node: AudioWorkletNode }[] = [];
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
      return;
    }
    this.built = true;

    // Build every module from the MODULES registry (single source of truth). Construction
    // order == registry order [monarch, anvil, cascade, sampler]; each entry's factory is
    // exactly the old `new *Module(ctx, def)`. Keep the typed named fields the rest of the
    // class + binders read — each factory returns the concrete subclass, so the downcast is
    // sound (every module id is a registry entry).
    const instances = new Map<string, ModuleBase>();
    for (const m of MODULES) instances.set(m.id, m.factory(ctx, m.def));
    this.monarch = instances.get('monarch') as MonarchModule;
    this.anvil = instances.get('anvil') as AnvilModule;
    this.cascade = instances.get('cascade') as CascadeModule;
    this.sampler = instances.get('sampler') as SamplerModule;
    this.mixer = new MixerModule(ctx, this.context.masterIn);
    // bundle arrangement: ch1 Cascade, ch2 Anvil, ch3 Monarch, ch4 sampler mix — each
    // (mainOutJack, mixerChannel) is read per-entry, reproducing the explicit connectInput
    // calls: (CAS_VCA_OUT,0) (ANV_VCA_OUT,1) (MON_VCA_OUT,2) (SAMP_MIX_OUT,3).
    for (const m of mixedModules) {
      this.mixer.connectInput(instances.get(m.id)!.outputTap(m.mainOutJack!), m.mixerChannel!);
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
    this.scheduler.start();

    this.store.subscribe(() => this.syncTransportConfig());
  }

  async powerOff(): Promise<void> {
    this.scheduler?.stop();
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
      case 'assignPulse':
        this.monarch.assignPulseAt(e.time);
        break;
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

  private feedFollowers(transportId: string, e: TransportEvent): void {
    for (const f of this.followers) f({ ...e, data: { ...e.data, __transport: transportId } });
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

  /** Recompute external-clock flags + follower hooks from the cable list. */
  private rebuildFollowers(patch: PatchState): void {
    this.followers = [];
    this.clearEdgeFollowers();
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
    this.cascadeClock.externalClock = !!cascadeClockIn;
    if (cascadeClockIn) {
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
      this.addEdgeFollower(
        monarchHold.from,
        () => {
          this.monarchSeq.holdActive = true;
        },
        () => {
          this.monarchSeq.holdActive = false;
        },
      );
    }

    // Sampler pad triggers: a rising edge on SAMP_PAD{n}_TRIG_IN fires that pad
    // (same edge-follower path as the Monarch gate inputs — gate semantics via the
    // synthstack-edge worklet). Pads only RECEIVE edges; they emit nothing schedulable,
    // so there is no INTERNAL_CLOCK_EVENTS entry.
    for (let n = 1; n <= 8; n++) {
      const c = findCable(`SAMP_PAD${n}_TRIG_IN`);
      if (c) this.addEdgeFollower(c.from, (t) => this.sampler.triggerPad(n - 1, t));
    }
  }

  // ---- transport conveniences -----------------------------------------------------------

  runAll(): void {
    const now = this.context.audioContext.currentTime + 0.05;
    this.monarchSeq.start(now);
    this.anvilSeq.start(now);
    this.cascadeClock.start(now);
    // The drum step sequencer is an INDEPENDENT machine — intentionally NOT
    // started here in v1. this.samplerSeq.start(now) could be added if a single master
    // transport is later wanted (and this.samplerSeq.stop() in stopAll).
  }

  stopAll(): void {
    this.monarchSeq.stop();
    this.anvilSeq.stop();
    this.cascadeClock.stop();
    const t = this.context.audioContext.currentTime;
    this.monarch.gateAt(false, t);
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
    this.samplerLoops.panicAll(); // clear the loop SCHEDULE so nothing re-launches...
    for (let i = 0; i < 8; i++) this.sampler.stopLoop(i, t); // ...and stop the sounding voices
    this.monarch.gateAt(false, t);
  }

  /** TEMPO LINK: slave Anvil step rate and Cascade tick rate to Monarch BPM. */
  applyTempoLink(): void {
    if (!this.tempoLink) return;
    const bpm = this.monarchSeq.tempoBpm;
    this.anvilSeq.rateHz = (bpm / 60) * 4; // 16th steps
    this.cascadeClock.tempoHz = bpm / 60; // 1 PPQ
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
  monarchNoteOn(noteVv: number, retrigger: boolean): void {
    const t = this.context.audioContext.currentTime + 0.03;
    this.monarch.setPitchAt(noteVv, t, true);
    if (retrigger) this.monarch.gateAt(true, t);
  }

  /** Keyboard / MIDI live-play NOTE OFF: drop the gate (same gateAt call as gateOff). */
  monarchNoteOff(): void {
    this.monarch.gateAt(false, this.context.audioContext.currentTime + 0.03);
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

  // ---- master-output recording passthroughs (ADDITIVE; called by src/ui/engineBridge.ts)
  // The recorder is owned by StudioContext (it taps the private softClip); these only
  // delegate. powerOff (above) already routes through context.powerOff, which auto-stops
  // and flushes a recording in progress before suspend — no extra stop is needed here.

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

  /** Live read for the RUN/STOP latch lamp (user playing flag, mirrored into the store). */
  drumSeqPlaying(): boolean {
    return this.samplerSeq.isPlaying();
  }

  /** The one AudioContext — the bridge needs it for decodeAudioData. */
  audioContextForDecode(): AudioContext {
    return this.context.audioContext;
  }

  /**
   * Render the factory one-shots and register their ±1.0 buffers in factoryBuffers.
   * The audible bytes are NEVER persisted — playback resolves the buffer from the
   * in-memory factoryBuffers map (a 'factory-' id; see reloadPadBuffers), and the pad's
   * display name lives in state.sampler.pads. Awaited at power-on.
   */
  async loadFactorySamples(): Promise<void> {
    const fs = await renderFactorySamples();
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
  }

  /** Resolve a control-bearing module instance by id (the named voice fields). Mirrors the
   *  old monarch/anvil/cascade ternary; called only after an ownsControlDefaults gate, so the
   *  three control modules are the only inputs (sampler never reaches here). */
  private controlModule(id: string): MonarchModule | AnvilModule | CascadeModule {
    return id === 'monarch' ? this.monarch : id === 'anvil' ? this.anvil : this.cascade;
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
    this.tempoLink = state.mixer.tempoLink;
    this.applyTempoLink();
    // Master FX: push the whole effects.master slice into the graph (coalesce fills an
    // older tree's missing `effects` -> all off). Effects are dry-only when off, so this
    // is silent for a default tree; INIT/preset restores the exact wet/param state.
    this.context.applyMasterEffects(coalesceEffectsState(state.effects).master);
  }

  getState(): StudioState {
    return this.store.getState();
  }
}
