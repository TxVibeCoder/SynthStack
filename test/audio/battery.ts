/**
 * Browser offline-audio battery — runs in the dev harness
 * (#/dev/audio-tests) against REAL OfflineAudioContext + worklet graphs, i.e. the
 * assembled engine, not the Node-tested cores. `npm run test:audio` drives it
 * headlessly via Playwright.
 *
 * Every test builds its own OfflineAudioContext and calls loadWorklets(ctx) —
 * worklet modules never transfer between contexts.
 */

import { loadWorklets } from '../../src/engine/context';
import { renderFactorySamples, FACTORY_KIT } from '../../src/engine/factorySamples';
import { MonarchModule } from '../../src/engine/modules/monarch';
import { AnvilModule } from '../../src/engine/modules/anvil';
import { CascadeModule } from '../../src/engine/modules/cascade';
import { SamplerModule } from '../../src/engine/modules/sampler';
import { StudioEndpointRegistry } from '../../src/engine/modules/registry';
import { buildJackIndex, RouterBinding } from '../../src/engine/router';
import { CascadeClock } from '../../src/engine/sequencers/cascadeClock';
import { MonarchSequencer } from '../../src/engine/sequencers/monarchseq';
import { AnvilSequencer } from '../../src/engine/sequencers/anvilseq';
import { Scheduler, type TransportEvent } from '../../src/engine/scheduler';
import type { ModuleDef } from '../../data/schema';
import monarchDef from '../../data/monarch.json';
import anvilDef from '../../data/anvil.json';
import cascadeDef from '../../data/cascade.json';
import samplerDef from '../../data/sampler.json';
import {
  detectOnsets,
  rms,
  spectralCentroidHz,
  spectralCentroidSeries,
  fftMag,
  zeroCrossFreq,
} from '../helpers/spectral';

const SR = 48000;

export interface AudioTestResult {
  name: string;
  pass: boolean;
  detail: string;
}

type Builder<M> = new (ctx: BaseAudioContext, def: ModuleDef) => M;

async function buildModule<M extends MonarchModule | AnvilModule | CascadeModule>(
  seconds: number,
  Ctor: Builder<M>,
  def: unknown,
): Promise<{ ctx: OfflineAudioContext; mod: M; render: () => Promise<Float32Array> }> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
  await loadWorklets(ctx);
  const moduleDef = def as ModuleDef;
  const mod = new Ctor(ctx, moduleDef);
  const binding = new RouterBinding(buildJackIndex([moduleDef]), new StudioEndpointRegistry([mod]));
  binding.applyAllNormals();
  return {
    ctx,
    mod,
    render: async () => (await ctx.startRendering()).getChannelData(0),
  };
}

/** RMS envelope in winS windows. */
function envelope(buf: Float32Array, winS = 0.005): number[] {
  const win = Math.floor(winS * SR);
  const out: number[] = [];
  for (let off = 0; off + win <= buf.length; off += win) out.push(rms(buf, off, off + win));
  return out;
}

// ---- tests --------------------------------------------------------------------------

async function monarchVoiceBasics(): Promise<AudioTestResult> {
  const { mod, render } = await buildModule(2, MonarchModule, monarchDef);
  mod.setControl('MON_VCA_MODE', 'ON');
  mod.setControl('MON_VCF_CUTOFF', 8000);
  mod.setControl('MON_VOLUME', 0.8);
  mod.outputTap('MON_VCA_OUT').connect((mod.ctx as OfflineAudioContext).destination);
  const buf = await render();
  const level = rms(buf, SR);
  // KB CV stub = −1 vv -> saw at C3 ≈ 130.8 Hz
  const f = zeroCrossFreq(buf, SR, SR);
  const pass = level > 0.3 && Math.abs(f - 130.8) / 130.8 < 0.05;
  return {
    name: 'Monarch voice: audible saw at KB-CV pitch (zero cables)',
    pass,
    detail: `rms=${level.toFixed(2)}vv f=${f.toFixed(1)}Hz (expect ~130.8)`,
  };
}

async function monarchWobble(): Promise<AudioTestResult> {
  // §8.3: LFO TRI -> VCF CUTOFF makes the spectral centroid oscillate at the LFO rate
  const run = async (patched: boolean): Promise<number[]> => {
    const { mod, render } = await buildModule(3, MonarchModule, monarchDef);
    mod.setControl('MON_VCA_MODE', 'ON');
    mod.setControl('MON_VCF_CUTOFF', 800);
    mod.setControl('MON_LFO_RATE', 2);
    mod.setControl('MON_VOLUME', 0.8);
    if (patched) mod.outputTap('MON_LFO_TRI_OUT').connect(mod.inputBus('MON_VCF_CUTOFF_IN'));
    mod.outputTap('MON_VCA_OUT').connect((mod.ctx as OfflineAudioContext).destination);
    return spectralCentroidSeries(await render(), SR, 0.05).slice(4);
  };
  const base = await run(false);
  const wob = await run(true);
  const spread = (s: number[]) => Math.max(...s) - Math.min(...s);
  // count mean-crossings of the wobbling centroid: 2 Hz over ~2.8 s -> ~11 crossings
  const mean = wob.reduce((a, b) => a + b, 0) / wob.length;
  let crossings = 0;
  for (let i = 1; i < wob.length; i++) {
    if ((wob[i - 1]! - mean) * (wob[i]! - mean) < 0) crossings++;
  }
  const pass = spread(wob) > 2 * spread(base) && crossings >= 7 && crossings <= 16;
  return {
    name: 'Monarch patch: LFO→cutoff wobbles the centroid at ~2 Hz (§8.3)',
    pass,
    detail: `spread ${spread(base).toFixed(0)}→${spread(wob).toFixed(0)}Hz, crossings=${crossings} (expect ~11)`,
  };
}

async function monarchGateNoClick(): Promise<AudioTestResult> {
  const { mod, render } = await buildModule(2, MonarchModule, monarchDef);
  mod.setControl('MON_VCA_MODE', 'EG');
  // A=50 ms (τ=12.5 ms): a CORRECT one-pole changes ≤ ~18% of peak per 2.5 ms
  // window; an instantaneous click shows ~100%. A faster attack would make the
  // legitimate envelope itself exceed any click threshold.
  mod.setControl('MON_ATTACK', 0.05);
  mod.setControl('MON_DECAY', 0.3);
  mod.setControl('MON_SUSTAIN', 'ON');
  mod.setControl('MON_VCF_CUTOFF', 8000);
  mod.gateAt(true, 0.5);
  mod.gateAt(false, 1.2);
  mod.outputTap('MON_VCA_OUT').connect((mod.ctx as OfflineAudioContext).destination);
  const buf = await render();
  const onsets = detectOnsets(buf, SR, 0.1);
  // Compare the measured RMS envelope against the EXPECTED one-pole profile —
  // raw window-to-window deltas are dominated by partial-period saw ripple
  // (130 Hz period ≫ small windows), not by the envelope. A click or stuck
  // gate shows up as a profile deviation; a clean envelope tracks it.
  const winS = 0.025; // ≥3 saw periods per window
  const env = envelope(buf, winS);
  const peak = Math.max(...env);
  const tauA = 0.05 / 4;
  const tauD = 0.3 / 4;
  let maxDev = 0;
  let devAt = 0;
  for (let i = 0; i < env.length; i++) {
    const t = (i + 0.5) * winS;
    let eg = 0;
    if (t >= 0.5 && t < 1.2) eg = Math.min(1, 1 - Math.exp(-(t - 0.5) / tauA));
    else if (t >= 1.2) eg = Math.exp(-(t - 1.2) / tauD);
    const expectedAmp = Math.pow(eg, 1.3); // VCA perceptual curve (units.ts)
    const dev = Math.abs(env[i]! / peak - expectedAmp);
    if (dev > maxDev) {
      maxDev = dev;
      devAt = t;
    }
  }
  const pass = onsets.length === 1 && maxDev < 0.18;
  return {
    name: 'Monarch EG gate: one onset, envelope tracks the one-pole profile (no clicks)',
    pass,
    detail: `onsets=${onsets.length} maxProfileDev=${(maxDev * 100).toFixed(0)}% at t=${devAt.toFixed(3)}s`,
  };
}

async function anvilKick(): Promise<AudioTestResult> {
  const { mod, render } = await buildModule(0.9, AnvilModule, anvilDef);
  mod.setControl('ANV_VCO1_FREQUENCY', -2);
  mod.setControl('ANV_VCO1_LEVEL', 0.8);
  mod.setControl('ANV_VCO2_LEVEL', 0);
  mod.setControl('ANV_VCO1_EG_AMOUNT', 0.8);
  mod.setControl('ANV_VCO_DECAY', 0.08);
  mod.setControl('ANV_VCA_DECAY', 0.3);
  mod.setControl('ANV_CUTOFF', 900);
  mod.setControl('ANV_VOLUME', 0.8);
  mod.setStepCvAt(0, 4, 0.05);
  mod.triggerAt(0.1);
  mod.outputTap('ANV_VCA_OUT').connect((mod.ctx as OfflineAudioContext).destination);
  const buf = await render();
  const onsets = detectOnsets(buf, SR, 0.1);
  const early = zeroCrossFreq(buf, SR, Math.floor(0.105 * SR), Math.floor(0.135 * SR));
  const late = zeroCrossFreq(buf, SR, Math.floor(0.2 * SR), Math.floor(0.3 * SR));
  const decayed = rms(buf, Math.floor(0.6 * SR), Math.floor(0.8 * SR)) <
    0.25 * rms(buf, Math.floor(0.1 * SR), Math.floor(0.3 * SR));
  const pass = onsets.length === 1 && early / Math.max(late, 1) >= 2 && decayed;
  return {
    name: 'Anvil kick: ≥1-octave downward sweep + decaying body (§10.3)',
    pass,
    detail: `onset=${onsets.length} sweep ${early.toFixed(0)}→${late.toFixed(0)}Hz decayed=${decayed}`,
  };
}

async function anvilHat(): Promise<AudioTestResult> {
  const { mod, render } = await buildModule(0.6, AnvilModule, anvilDef);
  mod.setControl('ANV_VCO1_LEVEL', 0);
  mod.setControl('ANV_VCO2_LEVEL', 0);
  mod.setControl('ANV_NOISE_EXT_LEVEL', 0.9);
  mod.setControl('ANV_VCF_MODE', 'HP');
  mod.setControl('ANV_CUTOFF', 6000);
  mod.setControl('ANV_VCA_DECAY', 0.05);
  mod.setControl('ANV_VOLUME', 0.8);
  mod.setStepCvAt(0, 4, 0.05);
  mod.triggerAt(0.1);
  mod.outputTap('ANV_VCA_OUT').connect((mod.ctx as OfflineAudioContext).destination);
  const buf = await render();
  const spec = fftMag(buf, SR, 8192, Math.floor(0.1 * SR));
  const centroid = spectralCentroidHz(spec);
  const env = envelope(buf);
  const peakIdx = env.indexOf(Math.max(...env));
  let durMs = 0;
  for (let i = peakIdx; i < env.length; i++) {
    if (env[i]! < 0.1 * env[peakIdx]!) {
      durMs = (i - peakIdx) * 5;
      break;
    }
  }
  const pass = centroid > 5000 && durMs > 0 && durMs < 150;
  return {
    name: 'Anvil hat: centroid > 5 kHz, duration < 150 ms (§10.3)',
    pass,
    detail: `centroid=${centroid.toFixed(0)}Hz duration=${durMs}ms`,
  };
}

async function cascade2v3(): Promise<AudioTestResult> {
  const { mod, render } = await buildModule(4.3, CascadeModule, cascadeDef);
  mod.setControl('CAS_VCO1_LEVEL', 0.8);
  mod.setControl('CAS_CUTOFF', 6000);
  mod.setControl('CAS_VCA_ATTACK', 0.002);
  mod.setControl('CAS_VCA_DECAY', 0.08);
  mod.setControl('CAS_VOLUME', 0.8);
  // pure clock engine, d=[2,3], seq1<-RG1, seq2<-RG2, 4 Hz ticks from t=0.1
  const clock = new CascadeClock();
  clock.reset();
  clock.divisions = [2, 3, 16, 16];
  clock.assign = [
    [true, false],
    [false, true],
    [false, false],
    [false, false],
  ];
  clock.tempoHz = 4;
  const expected: number[] = [];
  for (let i = 0; i < 16; i++) {
    const t = 0.1 + i * 0.25;
    const events = clock.pullEventsAt(t);
    for (const e of events) {
      if (e.type === 'egTrigger') {
        mod.egTriggerAt(t);
        expected.push(t);
      }
      if (e.type === 'pitchUpdate') {
        mod.applySeqStep(e.data!['seq'] as 0 | 1, e.data!['stepIndex'] as number, t);
      }
    }
    clock.advance();
  }
  mod.outputTap('CAS_VCA_OUT').connect((mod.ctx as OfflineAudioContext).destination);
  const buf = await render();
  const onsets = detectOnsets(buf, SR, 0.08).map((s) => s / SR);
  const matched =
    onsets.length === expected.length &&
    onsets.every((t, i) => Math.abs(t - expected[i]!) < 0.02);
  return {
    name: 'Cascade 2-vs-3 polyrhythm: onsets land on the OR-combined tick grid (§11.4)',
    pass: matched,
    detail: `expected ${expected.length} onsets, got ${onsets.length}${matched ? '' : ` at [${onsets.map((t) => t.toFixed(2)).join(',')}]`}`,
  };
}

async function cascadeSeq2DrivesVco2(): Promise<AudioTestResult> {
  // regression: SEQ 2 edits were inaudible because VCO 2
  // defaulted to level 0. Isolate VCO 2 and prove seq-2 step values move its pitch.
  const { mod, render } = await buildModule(2.4, CascadeModule, cascadeDef);
  mod.setControl('CAS_VCO1_LEVEL', 0);
  mod.setControl('CAS_VCO2_LEVEL', 0.8);
  mod.setControl('CAS_CUTOFF', 12000);
  mod.setControl('CAS_VCA_ATTACK', 0.002);
  mod.setControl('CAS_VCA_DECAY', 10); // hold the VCA open across the render
  mod.setControl('CAS_VOLUME', 0.8);
  mod.setControl('CAS_SEQ2_STEP_1', 0); // 0 vv -> knob pitch (261.63 Hz)
  mod.setControl('CAS_SEQ2_STEP_2', 1); // +1 octave at SEQ OCT ±1
  mod.egTriggerAt(0.05);
  mod.applySeqStep(1, 0, 0.1);
  mod.egTriggerAt(1.2);
  mod.applySeqStep(1, 1, 1.2);
  mod.outputTap('CAS_VCA_OUT').connect((mod.ctx as OfflineAudioContext).destination);
  const buf = await render();
  const f1 = zeroCrossFreq(buf, SR, Math.floor(0.4 * SR), Math.floor(1.0 * SR));
  const f2 = zeroCrossFreq(buf, SR, Math.floor(1.5 * SR), Math.floor(2.1 * SR));
  const level = rms(buf, Math.floor(0.4 * SR), Math.floor(1.0 * SR));
  const pass =
    level > 0.3 &&
    Math.abs(f1 - 261.63) / 261.63 < 0.05 &&
    Math.abs(f2 / f1 - 2) < 0.1;
  return {
    name: 'Cascade SEQ 2 drives VCO 2 audibly (step +1 = +1 octave)',
    pass,
    detail: `rms=${level.toFixed(2)}vv f1=${f1.toFixed(1)}Hz f2=${f2.toFixed(1)}Hz (expect ~262→~523)`,
  };
}

/** Sample indices of rising edges through the +2.5 vv gate threshold. */
function risingEdges(buf: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1]! < 2.5 && buf[i]! >= 2.5) out.push(i);
  }
  return out;
}

async function monarchClocksAnvilLockstep(): Promise<AudioTestResult> {
  // Acceptance: with Monarch ASSIGN (clock) patched into Anvil
  // ADV/CLOCK, Anvil triggers coincide with Monarch steps WITHIN 1 SAMPLE. This
  // renders both modules in one OfflineAudioContext, drives the real pure
  // transports through the real Scheduler (fake now), and wires the same
  // internal-follower path studio.ts uses: assignPulse -> anvilSeq.onExternalEdge.
  const seconds = 6;
  const ctx = new OfflineAudioContext(2, seconds * SR, SR);
  await loadWorklets(ctx);
  const monarch = new MonarchModule(ctx, monarchDef as unknown as ModuleDef);
  const anvil = new AnvilModule(ctx, anvilDef as unknown as ModuleDef);
  const binding = new RouterBinding(
    buildJackIndex([monarchDef, anvilDef] as unknown as ModuleDef[]),
    new StudioEndpointRegistry([monarch, anvil]),
  );
  binding.applyAllNormals();

  const monarchSeq = new MonarchSequencer();
  monarchSeq.tempoBpm = 120; // 8 steps/s
  monarchSeq.endStep = 16;
  const anvilSeq = new AnvilSequencer();
  anvilSeq.externalClock = true;

  const bindAnvil = (e: TransportEvent): void => {
    if (e.type === 'step') {
      anvil.setStepCvAt(e.data!['pitchVv'] as number, e.data!['velocityVv'] as number, e.time);
    } else if (e.type === 'trigger') {
      anvil.triggerAt(e.time);
    }
  };
  let simNow = 0;
  const sched = new Scheduler(() => simNow);
  sched.add(monarchSeq, (e) => {
    if (e.type === 'assignPulse') {
      monarch.assignPulseAt(e.time);
      for (const fe of anvilSeq.onExternalEdge(e.time)) bindAnvil(fe);
    }
  });
  monarchSeq.start(0.1);
  while (simNow < seconds) {
    sched.pump();
    simNow += 0.025;
  }

  const merger = ctx.createChannelMerger(2);
  monarch.outputTap('MON_ASSIGN_OUT').connect(merger, 0, 0);
  anvil.outputTap('ANV_TRIGGER_OUT').connect(merger, 0, 1);
  merger.connect(ctx.destination);
  const rendered = await ctx.startRendering();
  const assignEdges = risingEdges(rendered.getChannelData(0));
  const trigEdges = risingEdges(rendered.getChannelData(1));

  const countOk = assignEdges.length === trigEdges.length && assignEdges.length > 40;
  let maxSkew = -1;
  if (countOk) {
    maxSkew = Math.max(...assignEdges.map((s, i) => Math.abs(s - trigEdges[i]!)));
  }
  const pass = countOk && maxSkew <= 1;
  return {
    name: 'Monarch ASSIGN clocks Anvil in lockstep — within 1 sample (§12 acceptance)',
    pass,
    detail: `assign=${assignEdges.length} trig=${trigEdges.length} edges, maxSkew=${maxSkew} samples`,
  };
}

async function edgeDetector(): Promise<AudioTestResult> {
  const ctx = new OfflineAudioContext(1, 2 * SR, SR);
  await loadWorklets(ctx);
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 4;
  const g = ctx.createGain();
  g.gain.value = 5; // ±5 vv
  const edge = new AudioWorkletNode(ctx, 'synthstack-edge', { numberOfInputs: 1, numberOfOutputs: 0 });
  osc.connect(g).connect(edge);
  osc.start();
  let rising = 0;
  let falling = 0;
  edge.port.onmessage = (e: MessageEvent) => {
    const d = e.data as { risingCount: number; fallingCount: number };
    rising += d.risingCount;
    falling += d.fallingCount;
  };
  await ctx.startRendering();
  await new Promise((r) => setTimeout(r, 150)); // let queued port messages deliver
  const pass = rising >= 7 && rising <= 9 && falling >= 7 && falling <= 9;
  return {
    name: 'Edge detector: 4 Hz square over 2 s → ~8 rising + ~8 falling edges',
    pass,
    detail: `rising=${rising} falling=${falling}`,
  };
}

async function sampTrigger(): Promise<AudioTestResult> {
  // Sampler pad acceptance: a ±1.0 buffer at LEVEL 1, triggered once, must read on
  // the pad OUT tap (PRE-mixer) as ±5 vv — proving the ×5 vv lift lands before the
  // mixer's ×0.2. SamplerModule needs no worklets; we hand-roll the context (it's
  // outside buildModule's Monarch|Anvil|Cascade generic). The realtime EDGE
  // (sequencer -> pad) path is proven only in the e2e; here we trigger directly.
  const ctx = new OfflineAudioContext(1, Math.ceil(0.5 * SR), SR);
  await loadWorklets(ctx); // harmless — SamplerModule uses only native nodes
  const mod = new SamplerModule(ctx, samplerDef as unknown as ModuleDef);

  // 0.05 s of ±1.0 noise — same convention as a decoded user sample
  const noise = ctx.createBuffer(1, Math.ceil(0.05 * SR), SR);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  mod.loadPadBuffer(0, noise);
  mod.setControl('SAMP_PAD1_LEVEL', 1);
  mod.outputTap('SAMP_PAD1_OUT').connect(ctx.destination);
  mod.triggerPad(0, 0.1);

  const buf = await ctx.startRendering().then((r) => r.getChannelData(0));
  const onsets = detectOnsets(buf, SR, 0.05);
  const active = rms(buf, Math.floor(0.1 * SR), Math.floor(0.15 * SR));
  // LEVEL 1, ±1.0 source, ×5 lift -> ~±5 vv on the pad OUT (white-noise rms ≈ 2.9 vv)
  const pass = onsets.length === 1 && active > 1;
  return {
    name: 'Sampler pad: one onset, pad-OUT rms > 1 vv (×5 vv lift lands pre-mixer)',
    pass,
    detail: `onsets=${onsets.length} padOutRms=${active.toFixed(2)}vv (expect ~2.9)`,
  };
}

async function factoryKit(): Promise<AudioTestResult> {
  // Factory kit acceptance: renderFactorySamples() must produce exactly the 8
  // FACTORY_KIT voices, in manifest order, each a NON-SILENT mono buffer
  // peak-normalized to ±1.0 (so the SamplerModule's ×5 lift is safe). Timbre
  // quality is a MANUAL LISTENING CHECKPOINT — only loose character spot-checks
  // are auto-asserted here.
  const kit = await renderFactorySamples();

  const countOk = kit.length === 8 && kit.length === FACTORY_KIT.length;
  const idsOk =
    kit.length === FACTORY_KIT.length &&
    kit.every((k, i) => k.id === FACTORY_KIT[i]!.id && k.name === FACTORY_KIT[i]!.name);

  // peak (proves normalize ran) + peak<=1.0 for every voice
  const peakOf = (buf: AudioBuffer): number => {
    const d = buf.getChannelData(0);
    let p = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]!);
      if (a > p) p = a;
    }
    return p;
  };
  const peaks = kit.map((k) => peakOf(k.buffer));
  const nonSilent = peaks.every((p) => p > 0.99);
  const normalized = peaks.every((p) => p <= 1.0 + 1e-6);

  // loose character spot-checks (kept loose so they don't flake)
  const find = (id: string): AudioBuffer => kit.find((k) => k.id === id)!.buffer;
  const closed = find('factory-hat-closed').getChannelData(0);
  const open = find('factory-hat-open').getChannelData(0);
  const kick = find('factory-kick').getChannelData(0);
  const closedCentroid = spectralCentroidHz(fftMag(closed, SR, 4096, Math.floor(0.1 * SR)));
  const closedEnv = envelope(closed);
  const openEnv = envelope(open);
  const closedDecay = closedEnv.length - closedEnv.indexOf(Math.max(...closedEnv));
  const openDecay = openEnv.length - openEnv.indexOf(Math.max(...openEnv));
  const kickEarly = zeroCrossFreq(kick, SR, Math.floor(0.105 * SR), Math.floor(0.135 * SR));
  const kickLate = zeroCrossFreq(kick, SR, Math.floor(0.2 * SR), Math.floor(0.3 * SR));
  const closedBright = closedCentroid > 6000;
  const openLonger = openDecay > closedDecay;
  const kickSweep = kickEarly / Math.max(kickLate, 1) >= 1.5;

  const pass = countOk && idsOk && nonSilent && normalized && closedBright && openLonger && kickSweep;
  return {
    name: 'Factory kit: 8 voices in FACTORY_KIT order, non-silent, peak ≤ 1.0',
    pass,
    detail:
      `count=${kit.length} ids=${idsOk} minPeak=${Math.min(...peaks).toFixed(3)} ` +
      `maxPeak=${Math.max(...peaks).toFixed(3)} closedCentroid=${closedCentroid.toFixed(0)}Hz ` +
      `closedDecay=${closedDecay} openDecay=${openDecay} kickSweep=${kickEarly.toFixed(0)}→${kickLate.toFixed(0)}Hz`,
  };
}

export const BATTERY: { name: string; run: () => Promise<AudioTestResult> }[] = [
  { name: 'monarch-voice', run: monarchVoiceBasics },
  { name: 'monarch-wobble', run: monarchWobble },
  { name: 'monarch-gate', run: monarchGateNoClick },
  { name: 'anvil-kick', run: anvilKick },
  { name: 'anvil-hat', run: anvilHat },
  { name: 'cascade-2v3', run: cascade2v3 },
  { name: 'cascade-seq2-vco2', run: cascadeSeq2DrivesVco2 },
  { name: 'monarch-clocks-anvil', run: monarchClocksAnvilLockstep },
  { name: 'edge-detector', run: edgeDetector },
  { name: 'samp-trigger', run: sampTrigger },
  { name: 'factory-kit', run: factoryKit },
];

export async function runBattery(
  onProgress?: (done: number, total: number, last: AudioTestResult) => void,
): Promise<AudioTestResult[]> {
  const results: AudioTestResult[] = [];
  for (const t of BATTERY) {
    let result: AudioTestResult;
    try {
      result = await t.run();
    } catch (err) {
      result = { name: t.name, pass: false, detail: `threw: ${String(err)}` };
    }
    results.push(result);
    onProgress?.(results.length, BATTERY.length, result);
  }
  return results;
}
