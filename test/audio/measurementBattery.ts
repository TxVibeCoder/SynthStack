/**
 * Browser offline-audio MEASUREMENT battery — the recording-free fidelity scorecard (Tier B).
 *
 * Renders each ASSEMBLED voice (real OfflineAudioContext + worklet graph) and measures pitch,
 * waveshape harmonic fingerprints, the anti-aliasing floor, and filter behavior against
 * math/spec targets. This complements the Tier-A pure-core gates (test/unit/oscCore.test.ts and
 * ladderCore.test.ts): Tier A proves the DSP on the deterministic cores; THIS proves the WIRING
 * — that the panel controls reach the cores and the osc → filter → VCA chain is assembled right.
 *
 * Runs in the dev harness (#/dev/measure); `npm run test:measure` drives it headlessly on a
 * dedicated Vite port (so it never collides with a sibling project squatting on 5173).
 *
 * Pitch tolerances are LOOSE here on purpose: every voice runs a live ±3-cent DriftSource that
 * cannot be disabled through the module API, so sub-cent pitch lives in Tier A (no drift) and
 * here we assert absolute pitch within ~±20 cents and drift-proof 2:1 octave ratios. Waveshape
 * fingerprints use magAtHz peak-search (±2 bins), which tracks the drifted harmonic, and a
 * near-bin-aligned f0 to keep Hann scalloping low; tolerances are end-to-end (±3 dB) not the
 * Tier-A ±1 dB. Analog CHARACTER (fold voicing, overdrive timbre) is NOT gated here.
 */

import { MonarchModule } from '../../src/engine/modules/monarch';
import { AnvilModule } from '../../src/engine/modules/anvil';
import { CascadeModule } from '../../src/engine/modules/cascade';
import { CourierModule } from '../../src/engine/modules/courier';
import { WS_SAW, WS_SQUARE, WS_TRI } from '../../src/engine/dsp/oscCore';
import monarchDef from '../../data/monarch.json';
import anvilDef from '../../data/anvil.json';
import cascadeDef from '../../data/cascade.json';
import courierDef from '../../data/courier.json';
import {
  db,
  fftMag,
  harmonicAmpsDb,
  magAtHz,
  peakFreqHz,
  rms,
  spectralCentroidHz,
} from '../helpers/spectral';
import { SR, buildModule, type AudioTestResult } from './harness';

export type { AudioTestResult } from './harness';

const PITCH_REF = 261.63; // units.ts PITCH_REF_HZ — C4 at 0 vv
const FFT = 16384;
const OFFSET = SR; // analyze from 1 s in (startup/attack transient settled)
const TONE_S = 1.5; // render length for fingerprint/centroid renders (OFFSET + FFT fits)
const ALIAS_S = 2; // a touch longer for the alias render
// f0 aligned to the FFT grid → near-zero Hann scalloping → clean harmonic ratios end-to-end.
const ALIGNED_75 = 75 * (SR / FFT); // ≈ 219.73 Hz (in range for Monarch/Anvil/Courier)
const ALIGNED_90 = 90 * (SR / FFT); // ≈ 263.67 Hz (above the Cascade knob's 261.63 floor)

// ---- analysis helpers ----------------------------------------------------------------

const vvForHz = (hz: number): number => Math.log2(hz / PITCH_REF); // exponential pitch CV in vv
const centsErr = (measured: number, expected: number): number => 1200 * Math.log2(measured / expected);

/** H1-normalized harmonic vector (H1..H8 dB) at a settled point. */
const fingerprint = (buf: Float32Array, f0: number): number[] =>
  harmonicAmpsDb(fftMag(buf, SR, FFT, OFFSET), f0, 8);

/** Sub-bin fundamental near the expected frequency. */
const measuredF0 = (buf: Float32Array, expected: number): number =>
  peakFreqHz(fftMag(buf, SR, FFT, OFFSET), expected * 0.5, expected * 1.5);

const centroid = (buf: Float32Array): number => spectralCentroidHz(fftMag(buf, SR, FFT, OFFSET));

/** Worst non-harmonic alias relative to the strongest true partial, audible band only (dB). */
function worstAliasDb(buf: Float32Array, f0: number): number {
  const spec = fftMag(buf, SR, FFT, OFFSET);
  const binHz = spec.binHz;
  const trueBins = new Set<number>();
  for (let k = 1; k * f0 < SR / 2; k++) {
    const bin = Math.round((k * f0) / binHz);
    for (let d = -10; d <= 10; d++) trueBins.add(bin + d);
  }
  let strongestTrue = 0;
  for (let k = 1; k * f0 < SR / 2; k++) strongestTrue = Math.max(strongestTrue, magAtHz(spec, k * f0));
  let worst = 0;
  const lowGuard = Math.round(50 / binHz);
  const highGuard = Math.round(23400 / binHz);
  for (let i = lowGuard; i < highGuard; i++) {
    if (trueBins.has(i)) continue;
    if (spec.mags[i]! > worst) worst = spec.mags[i]!;
  }
  return db(worst / strongestTrue);
}

// ---- per-voice isolated-tone builders (one osc, filter open unless overridden, VCA held) ----

interface ToneOpts {
  cutoffHz?: number;
  seconds?: number;
}

/** Monarch: VCA ON drone; pitch via the 1 V/oct jack (kbCv stub is −1 vv, so f = 261.63·2^(jack−1)). */
async function monarchTone(wave: 'SAW' | 'PULSE', pw: number, hz: number, o: ToneOpts = {}): Promise<Float32Array> {
  const { mod, ctx, render } = await buildModule(o.seconds ?? TONE_S, MonarchModule, monarchDef);
  mod.setControl('MON_VCA_MODE', 'ON');
  mod.setControl('MON_VOLUME', 0.8);
  mod.setControl('MON_VCO_WAVE', wave);
  if (wave === 'PULSE') mod.setControl('MON_PULSE_WIDTH', pw);
  mod.setControl('MON_MIX', 0);
  mod.setControl('MON_VCF_MODE', 'LP');
  mod.setControl('MON_VCF_CUTOFF', o.cutoffHz ?? 20000);
  mod.setControl('MON_VCF_RESONANCE', 0);
  mod.setControl('MON_VCO_MOD_AMOUNT', 0);
  mod.setControl('MON_VCF_MOD_AMOUNT', 0);
  mod.setControl('MON_GLIDE', 0);
  mod.setControl('MON_FREQUENCY', 0);
  const pitch = ctx.createConstantSource();
  pitch.offset.value = vvForHz(hz) + 1; // cancel the −1 vv kbCv stub
  pitch.connect(mod.inputBus('MON_VCO_1VOCT_IN'));
  pitch.start();
  mod.outputTap('MON_VCA_OUT').connect(ctx.destination);
  return render();
}

/** Anvil: VCO1 only, VCA held open by a steady +8 vv into ANV_VCA_CV_IN (no trigger → no EG motion). */
async function anvilTone(wave: 'TRI' | 'SQ', hz: number, o: ToneOpts = {}): Promise<Float32Array> {
  const { mod, ctx, render } = await buildModule(o.seconds ?? TONE_S, AnvilModule, anvilDef);
  mod.setControl('ANV_VCO1_LEVEL', 0.8);
  mod.setControl('ANV_VCO2_LEVEL', 0);
  mod.setControl('ANV_NOISE_EXT_LEVEL', 0);
  mod.setControl('ANV_NOISE_VCF_MOD', 0);
  mod.setControl('ANV_HARD_SYNC', 'OFF');
  mod.setControl('ANV_FM_AMOUNT', 0);
  mod.setControl('ANV_CUTOFF', o.cutoffHz ?? 20000);
  mod.setControl('ANV_RESONANCE', 0);
  mod.setControl('ANV_VCF_MODE', 'LP');
  mod.setControl('ANV_VCF_EG_AMOUNT', 0);
  mod.setControl('ANV_VCO1_EG_AMOUNT', 0);
  mod.setControl('ANV_VCO2_EG_AMOUNT', 0);
  mod.setControl('ANV_VCO1_WAVE', wave);
  mod.setControl('ANV_VCO1_FREQUENCY', vvForHz(hz));
  mod.setControl('ANV_VOLUME', 0.8);
  const vcaHold = ctx.createConstantSource();
  vcaHold.offset.value = 8; // 0..8 vv jack → VCA gain 1.0 continuously
  vcaHold.connect(mod.inputBus('ANV_VCA_CV_IN'));
  vcaHold.start();
  mod.outputTap('ANV_VCA_OUT').connect(ctx.destination);
  return render();
}

/** Cascade: VCO1 only, EG HELD pins the VCA open; pitch knob is in Hz directly. */
async function cascadeTone(wave: 'SAW' | 'SQUARE', hz: number, o: ToneOpts = {}): Promise<Float32Array> {
  const { mod, ctx, render } = await buildModule(o.seconds ?? TONE_S, CascadeModule, cascadeDef);
  mod.setControl('CAS_EG', 'HELD');
  mod.setControl('CAS_VCO1_LEVEL', 0.8);
  mod.setControl('CAS_VCO2_LEVEL', 0);
  mod.setControl('CAS_VCO1_SUB1_LEVEL', 0);
  mod.setControl('CAS_VCO1_SUB2_LEVEL', 0);
  mod.setControl('CAS_VCO2_SUB1_LEVEL', 0);
  mod.setControl('CAS_VCO2_SUB2_LEVEL', 0);
  mod.setControl('CAS_VCO1_WAVE', wave);
  mod.setControl('CAS_CUTOFF', o.cutoffHz ?? 20000);
  mod.setControl('CAS_RESONANCE', 0);
  mod.setControl('CAS_VCF_EG_AMOUNT', 0);
  mod.setControl('CAS_VCO1_FREQ', hz);
  mod.setControl('CAS_VOLUME', 0.8);
  mod.outputTap('CAS_VCA_OUT').connect(ctx.destination);
  return render();
}

/** Courier: OSC1 only, gate HELD open (gateHold EG pins peak); pitch via setPitchAt. */
async function courierTone(
  waveshape: number,
  hz: number,
  o: ToneOpts & { filterMode?: string; resonance?: number; mixOsc1?: number } = {},
): Promise<Float32Array> {
  const { mod, ctx, render } = await buildModule(o.seconds ?? TONE_S, CourierModule, courierDef);
  mod.setControl('COU_MIX_OSC1', o.mixOsc1 ?? 1);
  mod.setControl('COU_MIX_OSC2', 0);
  mod.setControl('COU_MIX_SUB', 0);
  mod.setControl('COU_MIX_NOISE', 0);
  mod.setControl('COU_MIX_FB_EXT', 0);
  mod.setControl('COU_OSC1_WAVESHAPE', waveshape);
  mod.setControl('COU_CUTOFF', o.cutoffHz ?? 20000);
  mod.setControl('COU_RESONANCE', o.resonance ?? 0);
  mod.setControl('COU_RES_BASS', 'OFF');
  mod.setControl('COU_FILTER_MODE', o.filterMode ?? 'LP4');
  mod.setControl('COU_EG_AMOUNT', 0);
  mod.setControl('COU_OSC2_CUTOFF', 0);
  mod.setControl('COU_KB_TRACKING', 'OFF');
  mod.setControl('COU_A_ATTACK', 0.001);
  mod.setControl('COU_A_DECAY', 10);
  mod.setControl('COU_VOLUME', 0.8);
  mod.setControl('COU_TUNE', 0);
  mod.setControl('COU_OSC1_OCTAVE', '8');
  mod.setControl('COU_LFO1_DEPTH', 0);
  mod.setControl('COU_MOD_AMOUNT', 0);
  mod.setControl('COU_SYNC', 'OFF');
  mod.setControl('COU_GLIDE', 0.001);
  mod.setPitchAt(vvForHz(hz), 0, false);
  mod.gateAt(true, 0);
  mod.outputTap('COU_AUDIO_OUT').connect(ctx.destination);
  return render();
}

// ---- generic assertions over a voice -------------------------------------------------

type ToneFn = (hz: number, o?: ToneOpts) => Promise<Float32Array>;

/**
 * Pitch: absolute (±20¢) at the grid midpoint + drift-proof 2:1 octave tracking over a 3-point
 * grid [mid/2, mid, mid·2]. `midHz` stays in each voice's reachable knob range (e.g. Cascade
 * floors at 261.63 Hz, so it uses 523.26 so the low octave doesn't clamp).
 */
async function pitchResult(name: string, tone: ToneFn, midHz = PITCH_REF): Promise<AudioTestResult> {
  const grid = [midHz / 2, midHz, midHz * 2];
  const fs: number[] = [];
  for (const hz of grid) fs.push(measuredF0(await tone(hz), hz));
  const absErr = Math.abs(centsErr(fs[1]!, midHz));
  const oct1 = Math.abs(centsErr(fs[1]! / fs[0]!, 2));
  const oct2 = Math.abs(centsErr(fs[2]! / fs[1]!, 2));
  const pass = absErr < 20 && oct1 < 20 && oct2 < 20;
  return {
    name: `${name} — pitch 1 V/oct + clean 2:1 octaves`,
    pass,
    detail: `f=[${fs.map((f) => f.toFixed(1)).join(', ')}]Hz absErr=${absErr.toFixed(1)}¢ oct=${oct1.toFixed(1)}/${oct2.toFixed(1)}¢`,
  };
}

/** Brightness tracks the cutoff control: the saw centroid rises strongly when the filter opens. */
async function filterResult(name: string, tone: ToneFn, lowCut = 400, highCut = 8000): Promise<AudioTestResult> {
  // Base pitch = C4 (in every voice's reachable range, incl. the Cascade knob's 261.63 Hz floor).
  const lo = centroid(await tone(PITCH_REF, { cutoffHz: lowCut }));
  const hi = centroid(await tone(PITCH_REF, { cutoffHz: highCut }));
  const ratio = hi / Math.max(lo, 1);
  const pass = ratio > 2.5;
  return {
    name: `${name} — filter brightness tracks cutoff`,
    pass,
    detail: `centroid ${lo.toFixed(0)}→${hi.toFixed(0)}Hz (×${ratio.toFixed(1)}) cutoff ${lowCut}→${highCut}Hz`,
  };
}

// ---- the battery ---------------------------------------------------------------------

async function monarchSawAlias(): Promise<AudioTestResult> {
  const saw = fingerprint(await monarchTone('SAW', 0.5, ALIGNED_75), ALIGNED_75);
  const pulse = fingerprint(await monarchTone('PULSE', 0.25, ALIGNED_75), ALIGNED_75);
  const aliasDb = worstAliasDb(await monarchTone('SAW', 0.5, 2001, { seconds: ALIAS_S }), 2001);
  const sawOk = Math.abs(saw[1]! - -6.02) < 3; // H2 ≈ −6 (all harmonics present)
  const pulseNotch = pulse[3]! < -22; // 25% pulse → H4 notch
  const aliasOk = aliasDb <= -38;
  return {
    name: 'Monarch — waveshape fingerprints + alias floor',
    pass: sawOk && pulseNotch && aliasOk,
    detail: `saw H2=${saw[1]!.toFixed(1)}dB pulse H4(notch)=${pulse[3]!.toFixed(1)}dB alias=${aliasDb.toFixed(1)}dB`,
  };
}

async function anvilShapesAlias(): Promise<AudioTestResult> {
  const tri = fingerprint(await anvilTone('TRI', ALIGNED_75), ALIGNED_75);
  const sq = fingerprint(await anvilTone('SQ', ALIGNED_75), ALIGNED_75);
  const aliasDb = worstAliasDb(await anvilTone('SQ', 2001, { seconds: ALIAS_S }), 2001);
  const triOk = tri[1]! < -22 && tri[2]! < -14; // evens suppressed + H3 weak (1/k²)
  const sqOk = sq[1]! < -22 && sq[2]! > -13; // evens suppressed + H3 strong (1/k, ≈ −9.5)
  const aliasOk = aliasDb <= -38;
  return {
    name: 'Anvil — triangle/square fingerprints + alias floor',
    pass: triOk && sqOk && aliasOk,
    detail: `tri H2=${tri[1]!.toFixed(1)} H3=${tri[2]!.toFixed(1)} | sq H2=${sq[1]!.toFixed(1)} H3=${sq[2]!.toFixed(1)} | alias=${aliasDb.toFixed(1)}dB`,
  };
}

async function cascadeShapesAlias(): Promise<AudioTestResult> {
  const saw = fingerprint(await cascadeTone('SAW', ALIGNED_90), ALIGNED_90);
  const sq = fingerprint(await cascadeTone('SQUARE', ALIGNED_90), ALIGNED_90);
  const aliasDb = worstAliasDb(await cascadeTone('SAW', 2001, { seconds: ALIAS_S }), 2001);
  const sawOk = Math.abs(saw[1]! - -6.02) < 3;
  const sqOk = sq[1]! < -20 && sq[2]! > -13;
  const aliasOk = aliasDb <= -38;
  return {
    name: 'Cascade — saw/square fingerprints + alias floor',
    pass: sawOk && sqOk && aliasOk,
    detail: `saw H2=${saw[1]!.toFixed(1)} | sq H2=${sq[1]!.toFixed(1)} H3=${sq[2]!.toFixed(1)} | alias=${aliasDb.toFixed(1)}dB`,
  };
}

async function courierShapesAlias(): Promise<AudioTestResult> {
  const saw = fingerprint(await courierTone(WS_SAW, ALIGNED_75), ALIGNED_75);
  const sq = fingerprint(await courierTone(WS_SQUARE, ALIGNED_75), ALIGNED_75);
  const aliasDb = worstAliasDb(await courierTone(WS_SAW, 2001, { seconds: ALIAS_S }), 2001);
  const sawOk = Math.abs(saw[1]! - -6.02) < 3;
  const sqOk = sq[1]! < -20 && sq[2]! > -13;
  const aliasOk = aliasDb <= -38;
  return {
    name: 'Courier — morph saw/square fingerprints + alias floor',
    pass: sawOk && sqOk && aliasOk,
    detail: `saw H2=${saw[1]!.toFixed(1)} | sq H2=${sq[1]!.toFixed(1)} H3=${sq[2]!.toFixed(1)} | alias=${aliasDb.toFixed(1)}dB`,
  };
}

async function courierMultimode(): Promise<AudioTestResult> {
  // LP2 (12 dB/oct) passes more high harmonics than LP4 (24 dB/oct) at the same cutoff → brighter.
  const lp4 = centroid(await courierTone(WS_SAW, PITCH_REF / 2, { cutoffHz: 1200, filterMode: 'LP4' }));
  const lp2 = centroid(await courierTone(WS_SAW, PITCH_REF / 2, { cutoffHz: 1200, filterMode: 'LP2' }));
  const pass = lp2 > lp4 * 1.15;
  return {
    name: 'Courier — multimode LP2 brighter than LP4 (mode switch wired)',
    pass,
    detail: `centroid LP4=${lp4.toFixed(0)}Hz LP2=${lp2.toFixed(0)}Hz (×${(lp2 / Math.max(lp4, 1)).toFixed(2)})`,
  };
}

async function courierSelfOsc(): Promise<AudioTestResult> {
  // Crank resonance with only a TINY excitation (mixOsc1 0.04 → ~±0.2 vv) at a NON-DEFAULT cutoff
  // (1500 Hz, distinct from the ladder worklet's 1000 Hz defaultValue) so the test proves BOTH things
  // its name claims: (1) the filter SELF-OSCILLATES — the measured energy is the ring, not osc
  // passthrough (a 65 Hz fundamental at 0.04 mix would read rms ≈ 0.1, far below the gate), and (2)
  // COU_CUTOFF reaches the core — the ring sits at the SET 1500 Hz, which a stuck-at-1000-default
  // param could not produce. Courier's resScale 1.43 puts self-osc onset ≈ knob 0.70, so res 1 rings.
  const fc = 1500;
  const ringing = await courierTone(WS_TRI, PITCH_REF / 4, { cutoffHz: fc, resonance: 1, mixOsc1: 0.04 });
  const level = rms(ringing, OFFSET, OFFSET + FFT);
  const f = peakFreqHz(fftMag(ringing, SR, FFT, OFFSET), fc * 0.6, fc * 1.4);
  const pass = level > 0.3 && Math.abs(f - fc) / fc < 0.15;
  return {
    name: 'Courier — resonance self-oscillates at the SET cutoff (filter + cutoff wired)',
    pass,
    detail: `rms=${level.toFixed(2)}vv peak=${f.toFixed(0)}Hz (expect ~${fc})`,
  };
}

export const MEASUREMENT_BATTERY: { name: string; run: () => Promise<AudioTestResult> }[] = [
  { name: 'monarch-pitch', run: () => pitchResult('Monarch', (hz, o) => monarchTone('SAW', 0.5, hz, o)) },
  { name: 'monarch-shapes', run: monarchSawAlias },
  { name: 'monarch-filter', run: () => filterResult('Monarch', (hz, o) => monarchTone('SAW', 0.5, hz, o)) },
  { name: 'anvil-pitch', run: () => pitchResult('Anvil', (hz, o) => anvilTone('SQ', hz, o)) },
  { name: 'anvil-shapes', run: anvilShapesAlias },
  { name: 'anvil-filter', run: () => filterResult('Anvil', (hz, o) => anvilTone('SQ', hz, o)) },
  { name: 'cascade-pitch', run: () => pitchResult('Cascade', (hz, o) => cascadeTone('SAW', hz, o), PITCH_REF * 2) },
  { name: 'cascade-shapes', run: cascadeShapesAlias },
  { name: 'cascade-filter', run: () => filterResult('Cascade', (hz, o) => cascadeTone('SAW', hz, o)) },
  { name: 'courier-pitch', run: () => pitchResult('Courier', (hz, o) => courierTone(WS_SAW, hz, o)) },
  { name: 'courier-shapes', run: courierShapesAlias },
  { name: 'courier-filter', run: () => filterResult('Courier', (hz, o) => courierTone(WS_SAW, hz, o)) },
  { name: 'courier-multimode', run: courierMultimode },
  { name: 'courier-selfosc', run: courierSelfOsc },
];

export async function runMeasurementBattery(
  onProgress?: (done: number, total: number, last: AudioTestResult) => void,
): Promise<AudioTestResult[]> {
  const results: AudioTestResult[] = [];
  for (const t of MEASUREMENT_BATTERY) {
    let result: AudioTestResult;
    try {
      result = await t.run();
    } catch (err) {
      result = { name: t.name, pass: false, detail: `threw: ${String(err)}` };
    }
    results.push(result);
    onProgress?.(results.length, MEASUREMENT_BATTERY.length, result);
  }
  return results;
}
