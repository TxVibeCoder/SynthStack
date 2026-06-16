/**
 * Sampler launch grid (feature: loop-quantize) — pure boundary math, Web-Audio-free.
 * Distinct from quantize.ts (the Cascade PITCH quantizer): this snaps a manual
 * pad launch / loop re-launch to the Monarch master's bar/beat grid. QUANTIZE picks the
 * division; the Monarch supplies the phase via PhaseRef (anchor = the un-swung bar
 * downbeat, derived in monarchseq.phaseRef()).
 *
 * Semantics: division OFF or no running master => launches are
 * immediate (nextBoundary returns afterTime); only UI taps + loop re-launch/stop read
 * this grid, never the external TRIG_IN edge path.
 */

export type QuantDivision = 'OFF' | '1/16' | '1/8' | '1/4' | '1/2' | '1 BAR';

/** Selector positions in order — byte-identical to SAMP_QUANTIZE.positions (sampler.json)
 *  and QUANTIZE_DIVISIONS (studioState.ts); pinned lockstep by the state round-trip test. */
export const QUANT_CYCLE: QuantDivision[] = ['OFF', '1/16', '1/8', '1/4', '1/2', '1 BAR'];

/** A snapshot of the Monarch master's grid phase at a moment in audio-clock time. */
export interface PhaseRef {
  running: boolean;
  tempoBpm: number;
  /** Audio time of the current bar's downbeat (un-swung, invariant within a bar). */
  anchorTime: number;
  /** Duration of one 16th note at the current tempo. */
  sixteenthDurS: number;
}

/** A loop re-launches once per bar; the bar is 16 sixteenths (4/4 — locked scope). */
export const RELAUNCH_SIXTEENTHS = 16;

/** Division -> its length in 16th notes (OFF -> 0, i.e. no grid). */
export function divisionSixteenths(d: QuantDivision): number {
  switch (d) {
    case 'OFF':
      return 0;
    case '1/16':
      return 1;
    case '1/8':
      return 2;
    case '1/4':
      return 4;
    case '1/2':
      return 8;
    case '1 BAR':
      return 16;
  }
}

/** Seconds per bar at the phase's tempo (the loop re-launch period). */
export function barPeriodS(phase: PhaseRef): number {
  return RELAUNCH_SIXTEENTHS * phase.sixteenthDurS;
}

/**
 * The first grid boundary strictly at or after `afterTime`. OFF or a stopped master
 * degrades to immediate (returns `afterTime` unchanged). Otherwise the boundary is a
 * multiply from the bar anchor — anchor + k·gridS, k = ceil((afterTime − anchor)/gridS)
 * — so every sub-bar boundary stays phase-coherent with the bar downbeat and the
 * result never accumulates per-call error.
 */
export function nextBoundary(afterTime: number, division: QuantDivision, phase: PhaseRef): number {
  if (division === 'OFF' || !phase.running) return afterTime;
  const gridS = divisionSixteenths(division) * phase.sixteenthDurS;
  const EPS = 1e-9; // an afterTime already sitting on a boundary fires there, not a grid later
  const k = Math.ceil((afterTime - phase.anchorTime - EPS) / gridS);
  return phase.anchorTime + k * gridS;
}
