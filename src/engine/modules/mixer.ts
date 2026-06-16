/**
 * Master mixer: 4 channels (ch4 spare) with level knobs into the
 * master bus. Module audio arrives in vv (±5) and is scaled to Web Audio range here
 * (×0.2 — units.VV_TO_WEBAUDIO, conversion layer (a) of D8).
 */

import { VV_TO_WEBAUDIO } from '../units';

export class MixerModule {
  readonly channels: GainNode[] = [];
  private readonly vvScale: GainNode[] = [];

  constructor(ctx: BaseAudioContext, masterIn: AudioNode, channelCount = 4) {
    for (let i = 0; i < channelCount; i++) {
      const scale = ctx.createGain();
      scale.gain.value = VV_TO_WEBAUDIO;
      const level = ctx.createGain();
      level.gain.value = i < 3 ? 0.8 : 0;
      scale.connect(level).connect(masterIn);
      this.vvScale.push(scale);
      this.channels.push(level);
    }
  }

  /** Connect a module's voice output (vv) to a mixer channel. */
  connectInput(node: AudioNode, channel: number): void {
    node.connect(this.vvScale[channel]!);
  }

  setLevel(channel: number, level01: number): void {
    this.channels[channel]!.gain.value = level01;
  }
}
