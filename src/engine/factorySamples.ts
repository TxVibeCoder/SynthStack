/**
 * Factory one-shots (feature: sampler pads / factory kit). So the pads aren't
 * empty on first run, render a COHERENT 8-piece drum kit offline — one per pad —
 * as original sounds (no licensing). Two render families coexist:
 *
 *   - Anvil voices (kick, tom): the existing AnvilModule path in its own
 *     OfflineAudioContext (worklet modules never transfer between contexts).
 *   - native voices (snare, clap, hats, rim, perc): stock OscillatorNode bodies +
 *     GainNode pitch/amp envelopes + BiquadFilter HP/BP + filtered white noise
 *     (fillWhiteNoise from noise.ts). A native graph uses only stock nodes, so it
 *     needs no worklets.
 *
 * CRITICAL vv FIX: both families ship ±5 vv internally (ANV_VCA_OUT is ±5 vv post-
 * VOLUME — see anvil.json rangeVv; fillWhiteNoise multiplies by 5). The SamplerModule
 * re-applies ×5, so a raw render fed to a pad would be ×25 and slam the master
 * soft-clip. We therefore PEAK-NORMALIZE every render to ±1.0 — matching the decoded-
 * user-sample convention the ×5 chain expects — before returning it as a pad buffer.
 * Because every render normalizes, the absolute vv level inside a recipe is irrelevant.
 */

import type { ModuleDef } from '../../data/schema';
import { loadWorklets } from './context';
import { AnvilModule } from './modules/anvil';
import { StudioEndpointRegistry } from './modules/registry';
import { buildJackIndex, RouterBinding } from './router';
import { fillWhiteNoise } from './noise';
import anvilDef from '../../data/anvil.json';

const SR = 48000; // match the audio battery

export interface FactorySample {
  id: string;
  name: string;
  buffer: AudioBuffer;
}

/**
 * THE per-pad manifest entry — the single source of truth the state core (g2), the engine
 * spine (g3) and the UI picker (g4) all import. Index = pad index = render order = picker
 * order. Stable ids; display names are free to change (the id is the contract).
 */
export interface FactoryKitEntry {
  id: string;
  name: string;
}

/**
 * G6 — a selectable kit is a NAMED 8-piece manifest plus its render recipes. The DEFAULT
 * kit keeps the legacy bare ids (`factory-kick`, …) so every preset/slot/test ref + the
 * `factory-hat`→`factory-hat-closed` alias still resolves. New kits use globally-unique
 * `factory-`-prefixed ids. `pads[t]` is the {id,name} the pad-t picker shows; `anvSpecs`
 * (kick/tom) + `nativeSpecs` (the other 6) are the per-kit render recipes (same families,
 * new recipe VALUES). The recipe timbres are STARTING POINTS for the operator's ears.
 */
export interface FactoryKit {
  id: string; // globally-unique kit id (selector value + coalesce membership key)
  name: string; // display label in the KIT-SELECT dropdown
  pads: FactoryKitEntry[]; // exactly 8 — pad index = render/picker order
  anvSpecs: AnvilSpec[]; // the 2 Anvil voices (kick, tom)
  nativeSpecs: NativeSpec[]; // the 6 native voices (snare, clap, hats, rim, perc)
}

/** The default kit's 8-pad manifest — kept as `FACTORY_KIT` for back-compat (every legacy
 *  import, preset/slot ref + the alias depends on these exact bare ids). */
export const FACTORY_KIT: FactoryKitEntry[] = [
  { id: 'factory-kick', name: 'Kick' }, // [0]
  { id: 'factory-snare', name: 'Snare' }, // [1]
  { id: 'factory-clap', name: 'Clap' }, // [2]
  { id: 'factory-hat-closed', name: 'Closed Hat' }, // [3]
  { id: 'factory-hat-open', name: 'Open Hat' }, // [4]
  { id: 'factory-tom', name: 'Low Tom' }, // [5]
  { id: 'factory-rim', name: 'Rim' }, // [6]
  { id: 'factory-perc', name: 'Perc' }, // [7]
];

/** Trigger lead — every render fires its sources at t0 so onset detectors line up. */
const T0 = 0.1;
/** Frames of leading silence to strip from each PAD buffer (the T0 render lead). The render
 *  KEEPS T0 (the offline onset detectors in the audio battery rely on it), but the buffer a
 *  pad receives must begin AT the transient — otherwise every factory hit plays T0 (100 ms,
 *  ~0.8 of a 16th @120 BPM) late on the grid, and the gap repeats every loop cycle. */
const LEAD_FRAMES = Math.round(T0 * SR);

// ---- shared peak-normalize ----------------------------------------------------------

/**
 * Copy `raw` into a fresh ±1.0 mono buffer, scaled by 1/peak. The ONE convention
 * every factory render ends in (Anvil ±5 vv and native ±5 noise both land here, so a
 * pad always receives ±1.0). Guards divide-by-zero on silence.
 */
function normalizeToBuffer(ctx: BaseAudioContext, raw: Float32Array, startFrame = 0): AudioBuffer {
  // startFrame trims the render's leading T0 silence (sources fire at T0, so [0, startFrame)
  // is exactly zero): the pad buffer then begins AT the transient, so triggerPad's
  // src.start(time) lands on the grid instead of T0 late — for one-shots AND loops.
  const start = Math.min(Math.max(0, startFrame), raw.length);
  let peak = 0;
  for (let i = start; i < raw.length; i++) {
    const a = Math.abs(raw[i]!);
    if (a > peak) peak = a;
  }
  const norm = peak > 0 ? 1 / peak : 1;
  const len = Math.max(1, raw.length - start);
  const buffer = ctx.createBuffer(1, len, SR);
  const out = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) out[i] = (raw[start + i] ?? 0) * norm;
  return buffer;
}

// ---- Anvil family (kick / tom) -------------------------------------------------------

/** Per-pad Anvil control settings; mirrors battery.ts anvilKick verbatim. */
type ControlSet = Record<string, number | string>;

/** Default-kit anvilKick settings (battery.ts) — a downward-sweeping kick body. */
const KICK: ControlSet = {
  ANV_VCO1_FREQUENCY: -2,
  ANV_VCO1_LEVEL: 0.8,
  ANV_VCO2_LEVEL: 0,
  ANV_VCO1_EG_AMOUNT: 0.8,
  ANV_VCO_DECAY: 0.08,
  ANV_VCA_DECAY: 0.3,
  ANV_CUTOFF: 900,
  ANV_VOLUME: 0.8,
};

/** 'tom' = kick settings, one octave up (VCO1 FREQUENCY −1 instead of −2). */
const TOM: ControlSet = { ...KICK, ANV_VCO1_FREQUENCY: -1 };

interface AnvilSpec {
  id: string;
  name: string;
  durS: number;
  controls: ControlSet;
}

/** Default-kit Anvil voices (the legacy bare ids). */
const ANV_SPECS: AnvilSpec[] = [
  { id: 'factory-kick', name: 'Kick', durS: 0.9, controls: KICK },
  { id: 'factory-tom', name: 'Low Tom', durS: 0.9, controls: TOM },
];

/** Render one Anvil one-shot and peak-normalize it to a ±1.0 mono AudioBuffer. */
async function renderAnvil(spec: AnvilSpec): Promise<FactorySample> {
  // Trigger fires at T0, so span T0 + durS to capture the full voice + decay tail.
  const ctx = new OfflineAudioContext(1, Math.ceil((T0 + spec.durS) * SR), SR);
  await loadWorklets(ctx); // Anvil uses worklets
  const def = anvilDef as unknown as ModuleDef;
  const mod = new AnvilModule(ctx, def);
  // Wire the Anvil's normalled inputs (TRIGGER_IN <- SEQ_CLOCK, VELOCITY_IN, etc.) just
  // like the anvilKick battery test does — without this the trigger never reaches the EGs,
  // so the VCA envelope AND the VCO pitch-EG downward sweep are dead (kick has no sweep).
  const binding = new RouterBinding(buildJackIndex([def]), new StudioEndpointRegistry([mod]));
  binding.applyAllNormals();
  for (const [id, value] of Object.entries(spec.controls)) mod.setControl(id, value);
  mod.setStepCvAt(0, 4, 0.05); // velocity 4 just before the trigger
  mod.triggerAt(T0);
  mod.outputTap('ANV_VCA_OUT').connect(ctx.destination);

  const rendered = await ctx.startRendering();
  const buffer = normalizeToBuffer(ctx, rendered.getChannelData(0), LEAD_FRAMES);
  return { id: spec.id, name: spec.name, buffer };
}

// ---- native family (snare / clap / hats / rim / perc) -------------------------------
//
// Each native spec builds a stock-node graph into an OfflineAudioContext and renders.
// No worklets are needed — only OscillatorNode / GainNode / BiquadFilterNode /
// AudioBufferSourceNode are used. Sources are single-use: started at T0, stopped at
// T0+durS. ENVELOPE RULE (hard): exponentialRampToValueAtTime NEVER targets 0 (Web
// Audio throws and the offline render rejects) — ramp toward 0.001 from a nonzero
// setValueAtTime(peak, T0). Every source MUST be .start()-ed or it renders silent.

/** A built native graph: the spec wires nodes into `ctx`, returning its summed output. */
type NativeBuild = (ctx: OfflineAudioContext, durS: number) => AudioNode;

interface NativeSpec {
  id: string;
  name: string;
  durS: number;
  build: NativeBuild;
}

/** Fill a fresh noise buffer (±5 vv from fillWhiteNoise) and wrap it in a single-use source. */
function noiseSource(ctx: OfflineAudioContext, durS: number): AudioBufferSourceNode {
  const buffer = ctx.createBuffer(1, Math.ceil(durS * SR), SR);
  fillWhiteNoise(buffer.getChannelData(0));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.start(T0);
  src.stop(T0 + durS);
  return src;
}

/** A single-use oscillator at `type`/`freq`, started at T0, stopped at T0+durS. */
function osc(
  ctx: OfflineAudioContext,
  durS: number,
  type: OscillatorType,
  freq: number,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, T0);
  o.start(T0);
  o.stop(T0 + durS);
  return o;
}

/** A gain node with a percussive decay envelope: set(peak, T0) -> expRamp(0.001, T0+decayS). */
function decayGain(ctx: OfflineAudioContext, peak: number, decayS: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, T0);
  g.gain.exponentialRampToValueAtTime(0.001, T0 + decayS);
  return g;
}

/** Default-kit native voices (snare/clap/hats/rim/perc), in pad order. */
const NATIVE_SPECS: NativeSpec[] = [
  // [1] SNARE — triangle body (~180 Hz, short downward glide) + HP-filtered noise.
  {
    id: 'factory-snare',
    name: 'Snare',
    durS: 0.25,
    build: (ctx, durS) => {
      const sum = ctx.createGain();
      // tonal body
      const body = osc(ctx, durS, 'triangle', 200);
      body.frequency.exponentialRampToValueAtTime(170, T0 + 0.04);
      body.connect(decayGain(ctx, 0.9, 0.12)).connect(sum);
      // noise tail
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1500;
      hp.Q.value = 0.7;
      noiseSource(ctx, durS).connect(hp).connect(decayGain(ctx, 0.9, 0.18)).connect(sum);
      return sum;
    },
  },
  // [2] CLAP — bandpassed noise with a multi-burst attack then a longer tail.
  {
    id: 'factory-clap',
    name: 'Clap',
    durS: 0.35,
    build: (ctx, durS) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1100;
      bp.Q.value = 1.8;
      noiseSource(ctx, durS).connect(bp);
      // multi-burst amp envelope: three short spikes then a decaying tail
      const g = ctx.createGain();
      const p = g.gain;
      p.setValueAtTime(0.9, T0);
      p.exponentialRampToValueAtTime(0.05, T0 + 0.008);
      p.setValueAtTime(0.9, T0 + 0.01);
      p.exponentialRampToValueAtTime(0.05, T0 + 0.018);
      p.setValueAtTime(0.9, T0 + 0.02);
      p.exponentialRampToValueAtTime(0.05, T0 + 0.028);
      p.setValueAtTime(0.9, T0 + 0.03);
      p.exponentialRampToValueAtTime(0.001, T0 + 0.2);
      bp.connect(g);
      return g;
    },
  },
  // [3] CLOSED HAT — bright HP noise, very short decay. Centroid > 6 kHz.
  {
    id: 'factory-hat-closed',
    name: 'Closed Hat',
    durS: 0.12,
    build: (ctx, durS) => buildHat(ctx, durS, 0.05),
  },
  // [4] OPEN HAT — same HP band as closed, long decay (~300-400 ms).
  {
    id: 'factory-hat-open',
    name: 'Open Hat',
    durS: 0.5,
    build: (ctx, durS) => buildHat(ctx, durS, 0.4),
  },
  // [6] RIM — short square click around 1.7 kHz + a tiny HP-noise tick.
  {
    id: 'factory-rim',
    name: 'Rim',
    durS: 0.08,
    build: (ctx, durS) => {
      const sum = ctx.createGain();
      osc(ctx, durS, 'square', 1700).connect(decayGain(ctx, 0.9, 0.03)).connect(sum);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3500;
      noiseSource(ctx, durS).connect(hp).connect(decayGain(ctx, 0.5, 0.005)).connect(sum);
      return sum;
    },
  },
  // [7] PERC — a tonal blip: sine 660->440 Hz (short downward glide) + an octave-up (880 Hz) sine.
  {
    id: 'factory-perc',
    name: 'Perc',
    durS: 0.3,
    build: (ctx, durS) => {
      const sum = ctx.createGain();
      const lo = osc(ctx, durS, 'sine', 660);
      lo.frequency.exponentialRampToValueAtTime(440, T0 + 0.03);
      lo.connect(decayGain(ctx, 0.9, 0.25)).connect(sum);
      osc(ctx, durS, 'sine', 880).connect(decayGain(ctx, 0.35, 0.18)).connect(sum);
      return sum;
    },
  },
];

/** Hat body: HP-filtered noise with a bandpass sheen, percussive decay. `hpHz`/`bpHz`
 *  default to the original default-kit band; new kits pass brighter/darker corners to
 *  shift the hat colour. The default args keep the default kit byte-identical. */
function buildHat(
  ctx: OfflineAudioContext,
  durS: number,
  decayS: number,
  hpHz = 7000,
  bpHz = 9500,
): AudioNode {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = hpHz;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = bpHz;
  bp.Q.value = 0.8;
  noiseSource(ctx, durS).connect(hp).connect(bp);
  return bp.connect(decayGain(ctx, 0.9, decayS));
}

/** Render one native voice and peak-normalize it to a ±1.0 mono AudioBuffer. */
async function renderNative(spec: NativeSpec): Promise<FactorySample> {
  // Sources fire at T0 and last durS, so the render must span T0 + durS — otherwise a
  // voice whose durS <= T0 (e.g. the 0.08 s rim) plays entirely past the buffer end and
  // renders silent. Sizing to T0 + durS also keeps every voice's full decay tail.
  const ctx = new OfflineAudioContext(1, Math.ceil((T0 + spec.durS) * SR), SR);
  // No worklets needed for a stock-node graph; the build wires straight to destination.
  spec.build(ctx, spec.durS).connect(ctx.destination);
  const rendered = await ctx.startRendering();
  const buffer = normalizeToBuffer(ctx, rendered.getChannelData(0), LEAD_FRAMES);
  return { id: spec.id, name: spec.name, buffer };
}

// ---- new kits (G6) -------------------------------------------------------------------
//
// EARS / DECISION: the two new kits below are TIMBRE STARTING POINTS for the operator's
// ears, not final tuned sounds. They reuse the SAME render families (Anvil kick/tom +
// the native snare/clap/hat/rim/perc graphs) with shifted recipe VALUES — deeper/dubbier
// for "Cellar", brighter/FM-ier for "Glass". The objective render properties (8 voices,
// non-silent, ±1.0, onset-at-frame-0) are what the audio battery + guard test pin; the
// final character (exact filter corners, decays, FM ratios) is the operator's taste call.

/** CELLAR — a deep / dub kit: subbier kick + tom, softer darker noise voices. */
const CELLAR_KICK: ControlSet = {
  ...KICK,
  ANV_VCO1_FREQUENCY: -3, // an octave below the default kick body — sub weight
  ANV_VCO_DECAY: 0.12, // a longer pitch sweep
  ANV_VCA_DECAY: 0.5, // a longer, dubbier tail
  ANV_CUTOFF: 600, // darker — roll off the click
};
const CELLAR_TOM: ControlSet = { ...CELLAR_KICK, ANV_VCO1_FREQUENCY: -2 };

const CELLAR_ANV: AnvilSpec[] = [
  { id: 'factory-deep-kick', name: 'Deep Kick', durS: 1.1, controls: CELLAR_KICK },
  { id: 'factory-deep-tom', name: 'Deep Tom', durS: 1.0, controls: CELLAR_TOM },
];

const CELLAR_NATIVE: NativeSpec[] = [
  // SNARE — lower body, darker noise tail (HP corner lowered), a touch longer.
  {
    id: 'factory-deep-snare',
    name: 'Deep Snare',
    durS: 0.3,
    build: (ctx, durS) => {
      const sum = ctx.createGain();
      const body = osc(ctx, durS, 'triangle', 165);
      body.frequency.exponentialRampToValueAtTime(140, T0 + 0.05);
      body.connect(decayGain(ctx, 0.9, 0.16)).connect(sum);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900; // darker than the default 1500 Hz
      hp.Q.value = 0.7;
      noiseSource(ctx, durS).connect(hp).connect(decayGain(ctx, 0.8, 0.22)).connect(sum);
      return sum;
    },
  },
  // CLAP — lower band, longer tail.
  {
    id: 'factory-deep-clap',
    name: 'Deep Clap',
    durS: 0.45,
    build: (ctx, durS) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 800; // lower than the default 1100 Hz
      bp.Q.value = 1.6;
      noiseSource(ctx, durS).connect(bp);
      const g = ctx.createGain();
      const p = g.gain;
      p.setValueAtTime(0.9, T0);
      p.exponentialRampToValueAtTime(0.05, T0 + 0.01);
      p.setValueAtTime(0.9, T0 + 0.012);
      p.exponentialRampToValueAtTime(0.05, T0 + 0.022);
      p.setValueAtTime(0.9, T0 + 0.024);
      p.exponentialRampToValueAtTime(0.001, T0 + 0.3);
      bp.connect(g);
      return g;
    },
  },
  // CLOSED HAT — darker band, short decay.
  {
    id: 'factory-deep-hat-closed',
    name: 'Deep CH',
    durS: 0.14,
    build: (ctx, durS) => buildHat(ctx, durS, 0.06, 5000, 7000),
  },
  // OPEN HAT — same darker band, long decay.
  {
    id: 'factory-deep-hat-open',
    name: 'Deep OH',
    durS: 0.55,
    build: (ctx, durS) => buildHat(ctx, durS, 0.45, 5000, 7000),
  },
  // RIM — lower click + a tiny tick.
  {
    id: 'factory-deep-rim',
    name: 'Deep Rim',
    durS: 0.09,
    build: (ctx, durS) => {
      const sum = ctx.createGain();
      osc(ctx, durS, 'square', 1200).connect(decayGain(ctx, 0.9, 0.035)).connect(sum);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2800;
      noiseSource(ctx, durS).connect(hp).connect(decayGain(ctx, 0.4, 0.006)).connect(sum);
      return sum;
    },
  },
  // PERC — a low dub blip.
  {
    id: 'factory-deep-perc',
    name: 'Deep Perc',
    durS: 0.35,
    build: (ctx, durS) => {
      const sum = ctx.createGain();
      const lo = osc(ctx, durS, 'sine', 440);
      lo.frequency.exponentialRampToValueAtTime(300, T0 + 0.04);
      lo.connect(decayGain(ctx, 0.9, 0.3)).connect(sum);
      osc(ctx, durS, 'sine', 660).connect(decayGain(ctx, 0.3, 0.2)).connect(sum);
      return sum;
    },
  },
];

/** GLASS — a bright / FM kit: tighter clicky kick/tom, brighter sparkly noise voices. */
const GLASS_KICK: ControlSet = {
  ...KICK,
  ANV_VCO1_FREQUENCY: -1.5, // tighter, higher body
  ANV_VCO_DECAY: 0.05, // a snappier pitch click
  ANV_VCA_DECAY: 0.18, // a tighter tail
  ANV_CUTOFF: 1600, // brighter — keep the click
};
const GLASS_TOM: ControlSet = { ...GLASS_KICK, ANV_VCO1_FREQUENCY: -0.5 };

const GLASS_ANV: AnvilSpec[] = [
  { id: 'factory-glass-kick', name: 'Glass Kick', durS: 0.7, controls: GLASS_KICK },
  { id: 'factory-glass-tom', name: 'Glass Tom', durS: 0.7, controls: GLASS_TOM },
];

const GLASS_NATIVE: NativeSpec[] = [
  // SNARE — higher body + FM sparkle (a fast modulator detuned partial) + bright noise.
  {
    id: 'factory-glass-snare',
    name: 'Glass Snare',
    durS: 0.22,
    build: (ctx, durS) => {
      const sum = ctx.createGain();
      const body = osc(ctx, durS, 'triangle', 260);
      body.frequency.exponentialRampToValueAtTime(220, T0 + 0.03);
      body.connect(decayGain(ctx, 0.8, 0.1)).connect(sum);
      // FM-ish sparkle partial (a detuned high sine, short)
      osc(ctx, durS, 'sine', 1320).connect(decayGain(ctx, 0.4, 0.06)).connect(sum);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2400; // brighter than the default 1500 Hz
      hp.Q.value = 0.7;
      noiseSource(ctx, durS).connect(hp).connect(decayGain(ctx, 0.9, 0.14)).connect(sum);
      return sum;
    },
  },
  // CLAP — higher band, crisp short tail.
  {
    id: 'factory-glass-clap',
    name: 'Glass Clap',
    durS: 0.3,
    build: (ctx, durS) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1600; // higher than the default 1100 Hz
      bp.Q.value = 2.0;
      noiseSource(ctx, durS).connect(bp);
      const g = ctx.createGain();
      const p = g.gain;
      p.setValueAtTime(0.9, T0);
      p.exponentialRampToValueAtTime(0.05, T0 + 0.006);
      p.setValueAtTime(0.9, T0 + 0.008);
      p.exponentialRampToValueAtTime(0.05, T0 + 0.014);
      p.setValueAtTime(0.9, T0 + 0.016);
      p.exponentialRampToValueAtTime(0.001, T0 + 0.16);
      bp.connect(g);
      return g;
    },
  },
  // CLOSED HAT — extra-bright band, very short decay.
  {
    id: 'factory-glass-hat-closed',
    name: 'Glass CH',
    durS: 0.1,
    build: (ctx, durS) => buildHat(ctx, durS, 0.04, 9000, 12000),
  },
  // OPEN HAT — same bright band, long shimmering decay.
  {
    id: 'factory-glass-hat-open',
    name: 'Glass OH',
    durS: 0.5,
    build: (ctx, durS) => buildHat(ctx, durS, 0.42, 9000, 12000),
  },
  // RIM — higher click + a bright tick.
  {
    id: 'factory-glass-rim',
    name: 'Glass Rim',
    durS: 0.07,
    build: (ctx, durS) => {
      const sum = ctx.createGain();
      osc(ctx, durS, 'square', 2200).connect(decayGain(ctx, 0.9, 0.025)).connect(sum);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5000;
      noiseSource(ctx, durS).connect(hp).connect(decayGain(ctx, 0.6, 0.005)).connect(sum);
      return sum;
    },
  },
  // PERC — a bright FM-ish bell blip (carrier + an octave-and-a-fifth partial).
  {
    id: 'factory-glass-perc',
    name: 'Glass Perc',
    durS: 0.28,
    build: (ctx, durS) => {
      const sum = ctx.createGain();
      const lo = osc(ctx, durS, 'sine', 990);
      lo.frequency.exponentialRampToValueAtTime(880, T0 + 0.02);
      lo.connect(decayGain(ctx, 0.85, 0.22)).connect(sum);
      osc(ctx, durS, 'sine', 1485).connect(decayGain(ctx, 0.45, 0.16)).connect(sum); // 1.5× partial
      return sum;
    },
  },
];

// ---- kit library --------------------------------------------------------------------

/** The DEFAULT kit — keeps the legacy bare ids (back-compat) + the exact FACTORY_KIT order. */
const DEFAULT_KIT: FactoryKit = {
  id: 'kit-default',
  name: 'Studio',
  // FACTORY_KIT is the contract pad order (kick, snare, clap, ch, oh, tom, rim, perc) — derive
  // the per-pad {id,name} from it so the manifest stays the single source of truth.
  pads: FACTORY_KIT.map((e) => ({ ...e })),
  anvSpecs: ANV_SPECS,
  nativeSpecs: NATIVE_SPECS,
};

const CELLAR_KIT: FactoryKit = {
  id: 'kit-cellar',
  name: 'Cellar',
  // pad order mirrors the default: kick, snare, clap, ch, oh, tom, rim, perc.
  pads: [
    { id: 'factory-deep-kick', name: 'Deep Kick' },
    { id: 'factory-deep-snare', name: 'Deep Snare' },
    { id: 'factory-deep-clap', name: 'Deep Clap' },
    { id: 'factory-deep-hat-closed', name: 'Deep CH' },
    { id: 'factory-deep-hat-open', name: 'Deep OH' },
    { id: 'factory-deep-tom', name: 'Deep Tom' },
    { id: 'factory-deep-rim', name: 'Deep Rim' },
    { id: 'factory-deep-perc', name: 'Deep Perc' },
  ],
  anvSpecs: CELLAR_ANV,
  nativeSpecs: CELLAR_NATIVE,
};

const GLASS_KIT: FactoryKit = {
  id: 'kit-glass',
  name: 'Glass',
  pads: [
    { id: 'factory-glass-kick', name: 'Glass Kick' },
    { id: 'factory-glass-snare', name: 'Glass Snare' },
    { id: 'factory-glass-clap', name: 'Glass Clap' },
    { id: 'factory-glass-hat-closed', name: 'Glass CH' },
    { id: 'factory-glass-hat-open', name: 'Glass OH' },
    { id: 'factory-glass-tom', name: 'Glass Tom' },
    { id: 'factory-glass-rim', name: 'Glass Rim' },
    { id: 'factory-glass-perc', name: 'Glass Perc' },
  ],
  anvSpecs: GLASS_ANV,
  nativeSpecs: GLASS_NATIVE,
};

/** The selectable kit library. Index 0 is the DEFAULT (legacy) kit. */
export const KIT_LIBRARY: FactoryKit[] = [DEFAULT_KIT, CELLAR_KIT, GLASS_KIT];

/** The default kit's id — the coalesce default + the seed selection. */
export const DEFAULT_KIT_ID = DEFAULT_KIT.id;

/** Resolve a kit by id (for the bridge selectKit guard + the panel picker). */
export function kitById(id: string): FactoryKit | undefined {
  return KIT_LIBRARY.find((k) => k.id === id);
}

// ---- assembly -----------------------------------------------------------------------

/**
 * Render ONE kit's 8 voices in its `pads` (= pad = picker) order. Each buffer is a mono
 * ±1.0 AudioBuffer that begins at its transient (LEAD_FRAMES trim). The render order
 * (anvil then native) is irrelevant — we sort by the kit's pad index before returning.
 */
async function renderKit(kit: FactoryKit): Promise<FactorySample[]> {
  const rendered: FactorySample[] = [];
  for (const spec of kit.anvSpecs) rendered.push(await renderAnvil(spec));
  for (const spec of kit.nativeSpecs) rendered.push(await renderNative(spec));
  const indexOf = (id: string): number => kit.pads.findIndex((e) => e.id === id);
  rendered.sort((a, b) => indexOf(a.id) - indexOf(b.id));
  return rendered;
}

/**
 * Render the DEFAULT kit's 8 factory one-shots, in FACTORY_KIT order (= pad order = the
 * contract). Kept as the stable single-kit entry point so the existing audio battery +
 * power-on signature is unchanged. Each buffer is a mono ±1.0 AudioBuffer.
 */
export async function renderFactorySamples(): Promise<FactorySample[]> {
  return renderKit(DEFAULT_KIT);
}

/**
 * Render EVERY kit's voices, flattened, for registration into the engine's flat
 * factoryBuffers map (the engine resolves any 'factory-' id from that one map, so
 * registering all kits up front makes a kit-select / per-pad pick a zero-render
 * lookup). Ids are globally unique across kits, so a flat list never collides.
 */
export async function renderAllKits(): Promise<FactorySample[]> {
  const all: FactorySample[] = [];
  for (const kit of KIT_LIBRARY) all.push(...(await renderKit(kit)));
  return all;
}
