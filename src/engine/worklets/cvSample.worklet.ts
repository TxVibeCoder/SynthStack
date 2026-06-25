/**
 * CV sample-and-hold tap: a thin sink that watches an arbitrary patched CV signal and
 * posts the LATEST input sample (channel 0, last frame of the block) to the main thread
 * once per render quantum. The main thread folds that value into a control-rate parameter
 * it cannot read directly off a live AudioParam — Anvil step rate (ANV_TEMPO_IN) and the
 * Cascade RG divider CV offsets (CAS_RHYTHM_n_IN).
 *
 * Thin-shell discipline (mirrors edge.worklet.ts): NO allocation or logging in the steady
 * state of process(). One message per block, posting a single reused envelope object whose
 * only field is the scalar value — nothing is allocated per sample or per block.
 *
 * CONTROL-RATE by design: one sample per ≈2.7 ms block is a sample-and-hold, NOT audio-rate
 * tracking. data/anvil.json calls ANV_TEMPO_IN "up to audio rate"; this v1 is control-rate
 * and that limit is documented at the call site + flagged as an ears/fidelity checkpoint for
 * the operator (stair-stepping feel vs. a future worklet-rate path).
 *
 * 1 input / 0 outputs (a pure sink). Returns true to stay alive while connected; the main
 * thread disconnects it on the next rebuildFollowers.
 */

class CvSampleProcessor extends AudioWorkletProcessor {
  // Single reused message envelope — never reallocated (no transfer, just a scalar).
  private readonly msg = { type: 'cv', value: 0 };

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;
    // Latest frame of the block = the sample-and-hold value for this quantum. An unconnected
    // input delivers a single zero-filled block; reading the last frame is correct there too.
    this.msg.value = input[input.length - 1]!;
    this.port.postMessage(this.msg); // one message per block max
    return true;
  }
}

registerProcessor('synthstack-cv-sample', CvSampleProcessor);
