/**
 * samplerHost (G5 pop-out) — MAIN-WINDOW ONLY. It is the bridge between the ONE `engineBridge`
 * singleton and the pop-out window over the sampler channel:
 *
 *   - subscribes `engineBridge.store` and broadcasts a serializable {@link SamplerMirror} on
 *     EVERY store change (so the pop-out re-renders live), AND immediately on a child `'hello'`
 *     (so a freshly-opened pop-out gets the current state without waiting for the next change);
 *   - on each ACTION message from the pop-out, calls the matching `engineBridge` method —
 *     reconstructing `new File([bytes], name, {type:mime})` for a `'load'`.
 *
 * It is mounted ONCE from App.tsx behind a main-window guard (`window.opener == null`), so it
 * NEVER runs inside the pop-out (which owns no engine). It imports `engineBridge`, which is fine
 * here — App.tsx already pulls in the engine; only the POP-OUT entry must stay engine-free.
 *
 * Returns a teardown fn (unsubscribe store + channel) so React's effect can clean it up.
 */

import { engineBridge } from '../engineBridge';
import { assertSampleSize } from '../../engine/sampleStore';
import { reportError } from '../errorLog';
import { createSamplerChannel, type Msg, type SamplerChannel, type SamplerMirror } from './samplerChannel';

/** Read the current serializable mirror from engineBridge (snapshot getters only). */
export function readMirror(): SamplerMirror {
  return {
    pads: Array.from({ length: 8 }, (_, i) => engineBridge.getPadState(i)),
    quantize: engineBridge.getQuantize(),
    kitId: engineBridge.getKitId(),
    pattern: engineBridge.getPattern(),
    drumNumSteps: engineBridge.getDrumNumSteps(),
    drumSwingPct: engineBridge.getDrumSwing(),
    drumRunning: engineBridge.getTransportFlags().drumRunning,
    monarchRunning: engineBridge.getTransportFlags().monarchRunning,
  };
}

/**
 * Apply ONE action message to engineBridge. `mirror` messages + lifecycle (`hello`/`bye`) are
 * the host's INPUT, not actions — they're handled in startSamplerHost; this only dispatches the
 * pop-out's action verbs. Unknown verbs are ignored (the channel already narrowed `t`).
 */
export function applyMsg(msg: Msg): void {
  switch (msg.t) {
    case 'audition':
      engineBridge.auditionPad(msg.pad);
      return;
    case 'setPadControl':
      engineBridge.setPadControl(msg.pad, msg.control, msg.value);
      return;
    case 'commitPadControl':
      engineBridge.commitPadControl(msg.pad, msg.control, msg.value);
      return;
    case 'setPadLoop':
      engineBridge.setPadLoop(msg.pad, msg.on);
      return;
    case 'load': {
      // The 4 MB cap still applies host-side (the pop-out also checks before posting, but the
      // host is the single source of truth for the engine write). assertSampleSize throws
      // SampleTooLargeError; loadPadSample rejects — both are swallowed here (the pop-out has
      // no error channel back yet; the in-console panel keeps its own error label).
      try {
        assertSampleSize(msg.bytes.byteLength);
      } catch (err) {
        reportError(err);
        return;
      }
      const file = new File([msg.bytes], msg.name, { type: msg.mime });
      void engineBridge.loadPadSample(msg.pad, file).catch(reportError);
      return;
    }
    case 'assignFactoryToPad':
      engineBridge.assignFactoryToPad(msg.pad, msg.factoryId);
      return;
    case 'selectKit':
      engineBridge.selectKit(msg.kitId);
      return;
    case 'setQuantize':
      engineBridge.setQuantize(msg.division);
      return;
    case 'toggleStep':
      engineBridge.toggleStep(msg.track, msg.step);
      return;
    case 'drumRun':
      engineBridge.drumRun();
      return;
    case 'drumStop':
      engineBridge.drumStop();
      return;
    case 'clearDrumPattern':
      engineBridge.clearDrumPattern();
      return;
    case 'setDrumNumSteps':
      engineBridge.setDrumNumSteps(msg.n);
      return;
    case 'setDrumSwing':
      engineBridge.setDrumSwing(msg.pct);
      return;
    // host INPUT, not actions — handled in startSamplerHost / ignored here:
    case 'mirror':
    case 'hello':
    case 'bye':
      return;
  }
}

/**
 * Start the host. Idempotent-by-caller (App mounts it once). Returns a teardown that
 * unsubscribes the store + closes the channel. Guard the call site with `window.opener == null`
 * so it never runs in the pop-out.
 */
export function startSamplerHost(channel: SamplerChannel = createSamplerChannel()): () => void {
  // Broadcast on EVERY store change. The pop-out keeps the last mirror; a redundant identical
  // mirror is harmless (its local store only notifies React on a JSON-key change).
  const unsubStore = engineBridge.store.subscribe(() => {
    try {
      channel.post({ t: 'mirror', mirror: readMirror() });
    } catch (err) {
      reportError(err);
    }
  });

  const unsubChannel = channel.subscribe((msg) => {
    if (msg.t === 'hello') {
      // A child just mounted — push the current state immediately so it doesn't wait for the
      // next store change. ('bye' needs no host action; the host owns no per-child state.)
      channel.post({ t: 'mirror', mirror: readMirror() });
      return;
    }
    applyMsg(msg);
  });

  return () => {
    unsubStore();
    unsubChannel();
    channel.close();
  };
}
