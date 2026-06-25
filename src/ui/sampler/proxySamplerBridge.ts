/**
 * proxySamplerBridge (G5 pop-out) — the POP-OUT-side SamplerBridge implementation, factored out
 * of SamplerPopoutApp so it is PURE (no React, no SamplerPanel import) and Node-testable.
 *
 *   - ACTIONS post a typed Msg over the sampler channel to the main window (which forwards them
 *     to the ONE engineBridge);
 *   - SNAPSHOTS read the last received mirror from a tiny local external store, so
 *     `useSyncExternalStore` inside SamplerPanel / DrumMachinePanel works UNCHANGED.
 *
 * It imports NO engine code — only the channel types + the state TYPES (compiled away). A
 * `'load'` posts the raw transferable ArrayBuffer, NEVER a File; the host reconstructs the File.
 */

import type { PadState, QuantizeDivision } from '../../state/studioState';
import type { SamplerBridge } from './samplerBridge';
import type { Msg, SamplerChannel, SamplerMirror } from './samplerChannel';

/** No bytes can cross a File boundary; the pop-out caps the same 4 MB the host enforces. */
export const MAX_SAMPLE_BYTES = 4 * 1024 * 1024;

/** Local default PadState — a runtime literal so the pop-out never imports studioState's
 *  defaultPad (which would drag in factorySamples / engine code). Byte-equal to defaultPad(). */
export function emptyPad(): PadState {
  return { sampleId: null, sampleName: null, level: 0.8, tuneSemis: 0, loop: false };
}

/** Default mirror served until the first one arrives (an empty, NON-running grid). */
export function emptyMirror(): SamplerMirror {
  return {
    pads: Array.from({ length: 8 }, emptyPad),
    quantize: '1 BAR',
    kitId: '',
    pattern: Array.from({ length: 8 }, () => new Array(16).fill(false)),
    drumNumSteps: 16,
    drumSwingPct: 50,
    drumRunning: false,
    monarchRunning: false,
  };
}

/**
 * A tiny external store holding the last received mirror. The proxy's snapshot getters read from
 * it; React subscribes through it so `useSyncExternalStore` in the panels re-renders on each
 * mirror. Snapshot reads return reference-STABLE values across unchanged keys (the panels' own
 * snapshot caches depend on that stability) — so a slice's identity only changes when its JSON
 * does.
 */
export class MirrorStore {
  private mirror: SamplerMirror = emptyMirror();
  private readonly listeners = new Set<() => void>();
  private padJson: string[] = this.mirror.pads.map((p) => JSON.stringify(p));
  private patternJson = JSON.stringify(this.mirror.pattern);

  get current(): SamplerMirror {
    return this.mirror;
  }

  set(next: SamplerMirror): void {
    const stablePads = next.pads.map((p, i) => {
      const json = JSON.stringify(p);
      if (json === this.padJson[i]) return this.mirror.pads[i]!;
      this.padJson[i] = json;
      return p;
    });
    const patternJson = JSON.stringify(next.pattern);
    const stablePattern = patternJson === this.patternJson ? this.mirror.pattern : next.pattern;
    this.patternJson = patternJson;
    this.mirror = { ...next, pads: stablePads, pattern: stablePattern };
    for (const l of this.listeners) l();
  }

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  };
}

/**
 * Build the proxy bridge: actions → channel.post; snapshots ← the MirrorStore. A `'load'` reads
 * the File's bytes (capped) and posts the raw transferable ArrayBuffer. An over-cap file rejects
 * locally so the panel's catch surfaces an error without a round-trip.
 */
export function createProxySamplerBridge(store: MirrorStore, channel: SamplerChannel): SamplerBridge {
  const m = () => store.current;
  return {
    subscribe: store.subscribe,
    getPadState: (i) => m().pads[i] ?? emptyPad(),
    getQuantize: () => m().quantize,
    getKitId: () => m().kitId,
    getPattern: () => m().pattern,
    getDrumNumSteps: () => m().drumNumSteps,
    getDrumSwing: () => m().drumSwingPct,
    getDrumRunning: () => m().drumRunning,
    getMonarchRunning: () => m().monarchRunning,
    // Control-only v1: no live chase column in the pop-out (EARS/DECISION flagged in
    // SamplerBridge.getDrumStepPosition). Step changes still fall under the mirror subscription.
    getDrumStepPosition: () => -1,
    subscribeDrumStep: store.subscribe,
    auditionPad: (pad) => channel.post({ t: 'audition', pad }),
    setPadControl: (pad, control, value) => channel.post({ t: 'setPadControl', pad, control, value }),
    commitPadControl: (pad, control, value) =>
      channel.post({ t: 'commitPadControl', pad, control, value }),
    loadPadSample: async (pad, file) => {
      if (file.size > MAX_SAMPLE_BYTES) {
        // Reject so the panel still shows an error rather than silently dropping the over-cap
        // file. (A plain Error falls to the panel's generic "Load failed" — it cannot import the
        // engine's SampleTooLargeError class here; the host also enforces the cap.)
        throw new Error('Sample too large (max 4 MB)');
      }
      const bytes = await file.arrayBuffer();
      const msg: Msg = {
        t: 'load',
        pad,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        bytes,
      };
      channel.post(msg, [bytes]);
    },
    setPadLoop: (pad, on) => channel.post({ t: 'setPadLoop', pad, on }),
    assignFactoryToPad: (pad, factoryId) => channel.post({ t: 'assignFactoryToPad', pad, factoryId }),
    selectKit: (kitId) => channel.post({ t: 'selectKit', kitId }),
    setQuantize: (division: QuantizeDivision) => channel.post({ t: 'setQuantize', division }),
    toggleStep: (track, step) => channel.post({ t: 'toggleStep', track, step }),
    drumRun: () => channel.post({ t: 'drumRun' }),
    drumStop: () => channel.post({ t: 'drumStop' }),
    clearDrumPattern: () => channel.post({ t: 'clearDrumPattern' }),
    setDrumNumSteps: (n) => channel.post({ t: 'setDrumNumSteps', n }),
    setDrumSwing: (pct) => channel.post({ t: 'setDrumSwing', pct }),
  };
}
