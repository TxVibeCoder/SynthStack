/**
 * Master FX chain (Wave 2) — the three master effects wired in series and dropped into the
 * reserved insertSlot of the master bus (context.ts): insertSlot → flanger → delay → reverb
 * → fold → masterVolume. Built ONCE on power-on; toggles/knobs only change param values (FxUnit
 * does true dry-only bypass when off), so there are no reconnect clicks and the recorder
 * (which taps softClip downstream) captures the wet master.
 *
 * The chain mirrors the master-volume surface: StudioContext owns it, Studio forwards
 * setMasterFx*, the bridge writes the `effects.master` store slice. applyMasterEffects()
 * pushes a whole state slice on load/INIT/preset so the graph matches the store.
 *
 * The class is GENERIC (the FxUnit builders take any BaseAudioContext): Studio also
 * instantiates one per voice, inserted on each voice→mixer edge, fed the matching
 * `effects.voices[id]` slice. `MasterFxId`/`MasterEffectsState`/`applyMasterEffects` keep
 * their names but are the shared 3-effect shape used by both master and per-voice chains.
 */

import { buildDelay, buildFlanger, buildFold, buildReverb, type FxUnit } from './effects';
import type { MasterEffectsState } from '../../state/studioState';

/** The master effects, in signal order. */
export type MasterFxId = 'flanger' | 'delay' | 'reverb' | 'fold';

/**
 * Where this chain sits in the signal path — sets the FOLD WaveShaper's operating point.
 *  - 'voice': per-voice insert, fed the raw ±5 vv voice tap (pre-mixer) → fold ioScale 0.2.
 *  - 'master': the master chain, fed the post-mixer signal (already ~±1 after vvScale) → ~1.0.
 * The single generic chain class serves both targets, so the FOLD io scale must vary per target
 * or the master fold would see a ~5× too-small signal and barely fold.
 */
export type FxChainTarget = 'voice' | 'master';

const FOLD_IO_SCALE: Record<FxChainTarget, number> = {
  voice: 0.2, // ±5vv → ±1
  master: 1.0, // already ~±1 post-mixer
};

export class MasterFxChain {
  private readonly units: Record<MasterFxId, FxUnit>;
  readonly input: GainNode;
  readonly output: GainNode;

  constructor(ctx: BaseAudioContext, target: FxChainTarget = 'voice') {
    const flanger = buildFlanger(ctx);
    const delay = buildDelay(ctx);
    const reverb = buildReverb(ctx);
    const fold = buildFold(ctx, { ioScale: FOLD_IO_SCALE[target] });
    this.units = { flanger, delay, reverb, fold };
    // series: flanger → delay → reverb → fold
    flanger.output.connect(delay.input);
    delay.output.connect(reverb.input);
    reverb.output.connect(fold.input);
    this.input = flanger.input;
    this.output = fold.output;
  }

  setOn(id: MasterFxId, on: boolean): void {
    this.units[id].setOn(on);
  }

  setParam(id: MasterFxId, param: string, value: number): void {
    this.units[id].setParam(param, value);
  }

  /** Push a whole `effects.master` slice into the graph (load / INIT / preset). */
  applyMasterEffects(state: MasterEffectsState): void {
    for (const id of ['flanger', 'delay', 'reverb', 'fold'] as const) {
      const fx = state[id];
      const unit = this.units[id];
      for (const [k, v] of Object.entries(fx)) {
        if (k === 'on') continue;
        if (typeof v === 'number') unit.setParam(k, v);
      }
      unit.setOn(fx.on);
    }
  }
}
