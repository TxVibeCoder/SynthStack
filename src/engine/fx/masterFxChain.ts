/**
 * Master FX chain (Wave 2) — the three master effects wired in series and dropped into the
 * reserved insertSlot of the master bus (context.ts): insertSlot → flanger → delay → reverb
 * → masterVolume. Built ONCE on power-on; toggles/knobs only change param values (FxUnit
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

import { buildDelay, buildFlanger, buildReverb, type FxUnit } from './effects';
import type { MasterEffectsState } from '../../state/studioState';

/** The three master effects, in signal order. */
export type MasterFxId = 'flanger' | 'delay' | 'reverb';

export class MasterFxChain {
  private readonly units: Record<MasterFxId, FxUnit>;
  readonly input: GainNode;
  readonly output: GainNode;

  constructor(ctx: BaseAudioContext) {
    const flanger = buildFlanger(ctx);
    const delay = buildDelay(ctx);
    const reverb = buildReverb(ctx);
    this.units = { flanger, delay, reverb };
    // series: flanger → delay → reverb
    flanger.output.connect(delay.input);
    delay.output.connect(reverb.input);
    this.input = flanger.input;
    this.output = reverb.output;
  }

  setOn(id: MasterFxId, on: boolean): void {
    this.units[id].setOn(on);
  }

  setParam(id: MasterFxId, param: string, value: number): void {
    this.units[id].setParam(param, value);
  }

  /** Push a whole `effects.master` slice into the graph (load / INIT / preset). */
  applyMasterEffects(state: MasterEffectsState): void {
    for (const id of ['flanger', 'delay', 'reverb'] as const) {
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
