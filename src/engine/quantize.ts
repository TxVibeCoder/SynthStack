/**
 * Cascade quantizer — pure.
 * Five states cycled by the QUANTIZE button: Off, 12-ET, 8-ET, 12-JI, 8-JI.
 * Applies to the VCO FREQ knobs and sequencer step pitches. Root = nearest C of the
 * unquantized value (integer vv = C, since 0 vv = C4 = 261.63 Hz).
 * SynthStack doesn't publish its JI tables; standard 5-limit sets are the
 * "in the spirit of" choice.
 */

export type QuantizeMode = 'OFF' | 'ET12' | 'ET8' | 'JI12' | 'JI8';

export const QUANTIZE_CYCLE: QuantizeMode[] = ['OFF', 'ET12', 'ET8', 'JI12', 'JI8'];

// 5-limit chromatic ratios per octave
const JI12_RATIOS = [1 / 1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8];
// 5-limit major + octave handled by octave fold
const JI8_RATIOS = [1 / 1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8];
// equal-tempered major-scale degrees in semitones
const ET8_DEGREES = [0, 2, 4, 5, 7, 9, 11];

const JI12_LOG2 = JI12_RATIOS.map((r) => Math.log2(r));
const JI8_LOG2 = JI8_RATIOS.map((r) => Math.log2(r));
const ET8_LOG2 = ET8_DEGREES.map((s) => s / 12);

function snapToSet(vv: number, candidatesLog2: number[]): number {
  const octave = Math.floor(vv);
  const frac = vv - octave;
  let best = 0;
  let bestDist = Infinity;
  // consider this octave's degrees plus the next octave's root
  for (const c of candidatesLog2) {
    const d = Math.abs(frac - c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (Math.abs(frac - 1) < bestDist) {
    return octave + 1;
  }
  return octave + best;
}

/** Quantize a pitch in vv (1 vv = 1 octave, integer vv = C). */
export function quantizeVv(vv: number, mode: QuantizeMode): number {
  switch (mode) {
    case 'OFF':
      return vv;
    case 'ET12':
      return Math.round(vv * 12) / 12;
    case 'ET8':
      return snapToSet(vv, ET8_LOG2);
    case 'JI12':
      return snapToSet(vv, JI12_LOG2);
    case 'JI8':
      return snapToSet(vv, JI8_LOG2);
  }
}

/** Quantize a frequency in Hz against the C-rooted grid (knob quantization). */
export function quantizeHz(hz: number, mode: QuantizeMode, refHz = 261.63): number {
  if (mode === 'OFF') return hz;
  const vv = Math.log2(hz / refHz);
  return refHz * Math.pow(2, quantizeVv(vv, mode));
}

export function nextQuantizeMode(mode: QuantizeMode): QuantizeMode {
  const i = QUANTIZE_CYCLE.indexOf(mode);
  return QUANTIZE_CYCLE[(i + 1) % QUANTIZE_CYCLE.length]!;
}
