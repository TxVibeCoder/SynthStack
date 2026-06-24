/**
 * PCM capture tap: a thin shell that copies its input (the master softClip fan-out) and
 * posts one transferable Float32Array-per-channel block to the main thread every render
 * quantum. The MasterRecorder accumulates the posted blocks, then encodeWav()s them at stop
 * for a lossless WAV download — parallel to the webm/opus MediaRecorder path.
 *
 * Thin-shell discipline (mirrors edge.worklet.ts): NO allocation or logging in the steady
 * state of process(). One message per block. The transfer detaches the posted buffers, so a
 * FRESH Float32Array is allocated for the NEXT block (the unavoidable reallocation) — done ONCE
 * outside the per-sample copy loop, never per sample.
 *
 * 1 input / 0 outputs (a pure sink). Returns true to stay alive while the node is connected;
 * the shell disconnects it on stop().
 */

const MAX_TAP_CHANNELS = 2;
const BLOCK = 128;

class PcmTapProcessor extends AudioWorkletProcessor {
  // Preallocated per-channel scratch buffers, reused across blocks; each one is REPLACED only
  // after it has been transferred away (postMessage detaches it). The msg envelope object is
  // reused too — only its `channels` array contents are swapped, never the wrapper.
  private slots: Float32Array[] = [
    new Float32Array(BLOCK),
    new Float32Array(BLOCK),
  ];
  private readonly msg: { type: 'pcm'; channelCount: number; channels: Float32Array[] } = {
    type: 'pcm',
    channelCount: 0,
    channels: [],
  };

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const nCh = input.length < MAX_TAP_CHANNELS ? input.length : MAX_TAP_CHANNELS;
    const transfer: Transferable[] = [];
    const out: Float32Array[] = [];
    for (let c = 0; c < nCh; c++) {
      const src = input[c];
      const slot = this.slots[c]!;
      if (src) {
        const n = src.length < BLOCK ? src.length : BLOCK;
        for (let i = 0; i < n; i++) slot[i] = src[i]!;
        for (let i = n; i < BLOCK; i++) slot[i] = 0;
      } else {
        for (let i = 0; i < BLOCK; i++) slot[i] = 0;
      }
      out.push(slot);
      transfer.push(slot.buffer as ArrayBuffer);
      // Reallocate THIS slot for the next block (the buffer about to be transferred detaches).
      // Done here, outside the sample-copy loop above — one alloc per channel per block, the
      // minimum the transfer model allows.
      this.slots[c] = new Float32Array(BLOCK);
    }
    this.msg.channelCount = nCh;
    this.msg.channels = out;
    this.port.postMessage(this.msg, transfer);
    return true;
  }
}

registerProcessor('synthstack-pcm-tap', PcmTapProcessor);
