/**
 * Studio integration (AudioContext-free): the drum grid's var-length (numSteps) + swing (swingPct)
 * reach the live SamplerStepSeq via BOTH paths the spec requires —
 *   1. syncTransportConfig (the method the powerOn store subscriber calls on every notification), and
 *   2. applyState (full setState restore).
 *
 * The Studio constructor builds `samplerSeq` + `store` audio-free (samplerSeq holds no audio nodes).
 * syncTransportConfig is itself audio-free, so we drive it DIRECTLY after a store mutation — exactly
 * what the powerOn subscriber does — and observe the pushed config through the seq's OBSERVABLE
 * behavior: the wrapped column cycle (numSteps) and the odd-column swing offset (swingPct) in the
 * emitted step times. applyState's remaining lines couple to the audio graph (router/mixer/modules,
 * built only at powerOn), so we exercise its audio-free drum-restore via the studio passthroughs
 * directly — the same setDrumNumSteps/setDrumSwing calls applyState makes from the coalesced slice.
 */

import { describe, expect, it } from 'vitest';
import { Studio } from '../../src/engine/studio';
import type { PhaseRef } from '../../src/engine/quantGrid';
import { monarchStepDurS, swingOffsetS } from '../../src/engine/units';

/** A running 120-BPM master phase anchored at 0 (16th = 0.125 s). */
function runningPhase(): PhaseRef {
  return { running: true, tempoBpm: 120, anchorTime: 0, sixteenthDurS: monarchStepDurS(120) };
}

interface StudioPrivates {
  syncTransportConfig(): void;
}

/** A Studio with the drum seq wired to a fixed running master phase (audio-free). */
function drumStudio(): Studio {
  const studio = new Studio();
  studio.samplerSeq.setPhaseProvider(() => runningPhase());
  return studio;
}

/** Pull the wrapped column + boundary time, then advance one step. */
function pullCol(seq: Studio['samplerSeq']): { col: number; t: number } {
  const t = seq.nextEventTime;
  const evs = seq.pullEventsAt(t);
  return { col: evs[0]!.data!['stepIndex'] as number, t };
}

describe('Studio drum config push (numSteps + swingPct)', () => {
  it('syncTransportConfig pushes numSteps + swingPct from the store to the live seq', () => {
    const studio = drumStudio();
    const seq = studio.samplerSeq;

    // Mutate the store sampler slice + commit, then drive syncTransportConfig (the powerOn
    // subscriber's callback) directly — it pushes numSteps/swingPct into the live seq.
    const s = studio.store.getState();
    s.sampler.numSteps = 4;
    s.sampler.swingPct = 75;
    studio.store.setState(s);
    (studio as unknown as StudioPrivates).syncTransportConfig();

    seq.start(0);
    const sixteenth = monarchStepDurS(120);
    const swing = swingOffsetS(75, sixteenth);
    const cols: number[] = [];
    for (let k = 0; k < 8; k++) {
      const { col, t } = pullCol(seq);
      cols.push(col);
      const expected = k * sixteenth + (col % 2 === 1 ? swing : 0);
      expect(t).toBeCloseTo(expected, 9);
      seq.advance();
    }
    // numSteps=4 wraps the column 0..3,0..3
    expect(cols).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it('a garbage stored slice coalesces (numSteps->16, swingPct->50) before reaching the seq', () => {
    const studio = drumStudio();
    const seq = studio.samplerSeq;

    const s = studio.store.getState();
    (s.sampler as unknown as Record<string, unknown>)['numSteps'] = 1e308;
    (s.sampler as unknown as Record<string, unknown>)['swingPct'] = 'x';
    studio.store.setState(s);
    (studio as unknown as StudioPrivates).syncTransportConfig(); // coalesces -> 16 / 50

    seq.start(0);
    const sixteenth = monarchStepDurS(120);
    const cols: number[] = [];
    for (let k = 0; k < 18; k++) {
      const { col, t } = pullCol(seq);
      cols.push(col);
      expect(t).toBeCloseTo(k * sixteenth, 9); // swing 50 = no offset
      seq.advance();
    }
    expect(cols.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(cols[16]).toBe(0);
    expect(cols[17]).toBe(1);
  });

  it('the studio drum passthroughs (the audio-free lines applyState runs) write the live seq', () => {
    // applyState's drum-restore is exactly setDrumNumSteps(samp.numSteps) + setDrumSwing(samp.swingPct)
    // from the coalesced slice; the rest of applyState couples to the audio graph (router/mixer/
    // modules, built only at powerOn). We exercise those two passthroughs directly — the same calls
    // applyState makes — to prove the slice reaches the live seq. The store-commit half of the
    // restore is covered by stateRoundTrip + the engineBridge surface tests.
    const studio = drumStudio();
    const seq = studio.samplerSeq;

    studio.setDrumNumSteps(2);
    studio.setDrumSwing(50); // no swing

    seq.start(0);
    const sixteenth = monarchStepDurS(120);
    const cols: number[] = [];
    for (let k = 0; k < 6; k++) {
      const { col, t } = pullCol(seq);
      cols.push(col);
      expect(t).toBeCloseTo(k * sixteenth, 9); // swing=50 -> plain lattice
      seq.advance();
    }
    expect(cols).toEqual([0, 1, 0, 1, 0, 1]);
  });
});
