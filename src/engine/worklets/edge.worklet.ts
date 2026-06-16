/**
 * Edge detector: watches an arbitrary patched
 * signal and posts edge timestamps via the port — at most one message per block.
 * Used by follower transports when their clock/gate source is NOT an internal
 * scheduled stream (internal sources use the event stream instead: zero latency).
 * Detection latency is one render quantum (≈2.7 ms) — accepted.
 *
 * Reports BOTH polarities: rising edges drive clock/trigger followers; falling
 * edges complete gate semantics (Monarch RUN/STOP high=run low=stop, HOLD held).
 */

const THRESHOLD = 2.5;
const MAX_EDGES = 4;

class EdgeDetectorProcessor extends AudioWorkletProcessor {
  private wasHigh = false;
  private readonly msg = {
    type: 'edges',
    rising: [0, 0, 0, 0],
    risingCount: 0,
    falling: [0, 0, 0, 0],
    fallingCount: 0,
  };

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const m = this.msg;
    let nr = 0;
    let nf = 0;
    for (let i = 0; i < input.length; i++) {
      const high = input[i]! >= THRESHOLD;
      if (high !== this.wasHigh) {
        if (high && nr < MAX_EDGES) m.rising[nr++] = currentTime + i / sampleRate;
        else if (!high && nf < MAX_EDGES) m.falling[nf++] = currentTime + i / sampleRate;
        this.wasHigh = high;
      }
    }
    if (nr > 0 || nf > 0) {
      m.risingCount = nr;
      m.fallingCount = nf;
      this.port.postMessage(m); // one message per block max
    }
    return true;
  }
}

registerProcessor('synthstack-edge', EdgeDetectorProcessor);
