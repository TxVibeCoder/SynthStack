/**
 * SamplerBridge (G5 pop-out) — the DEPENDENCY-INJECTION seam between SamplerPanel /
 * DrumMachinePanel and the audio engine. It is the EXACT action + snapshot surface those
 * two panels consume from `engineBridge`, narrowed to a pure-TS interface that carries NO
 * Web Audio types.
 *
 * Why this exists: SamplerPanel currently TOP-LEVEL imports the eager `engineBridge`
 * singleton (`export const engineBridge = new EngineBridge()`), which transitively reaches
 * `src/engine` and would construct a SECOND AudioContext if it were ever imported by the
 * pop-out window. By routing every `engineBridge.*` call + the store-subscription source
 * through an INJECTED bridge:
 *   - the MAIN window passes `realSamplerBridge` (forwards 1:1 to engineBridge) — byte-
 *     identical to today's behavior;
 *   - the POP-OUT window passes a `proxySamplerBridge` (actions → BroadcastChannel; snapshots
 *     ← the last received mirror) that imports ZERO engine code, so it owns no AudioContext.
 *
 * The interface is deliberately the SUBSET of engineBridge that the two sampler panels touch
 * — it is NOT the whole engineBridge surface.
 */

import type { PadState, QuantizeDivision } from '../../state/studioState';

/**
 * The store-subscription seam the panels need. Both panels subscribe to `engineBridge.store`
 * and read snapshot getters; the pop-out serves the same shape from a tiny local store fed by
 * the BroadcastChannel mirror, so `useSyncExternalStore` works unchanged in either window.
 */
export interface SamplerBridge {
  /** Subscribe to store changes; returns an unsubscribe fn (engineBridge.store.subscribe). */
  subscribe(onChange: () => void): () => void;

  // ---- snapshot getters (must return reference-STABLE values across unchanged reads) ----
  /** One pad's meta (SamplerPanel usePad / DrumMachinePanel row labels). */
  getPadState(padIndex: number): PadState;
  /** Global launch-quantize division (SamplerPanel useQuantize). */
  getQuantize(): QuantizeDivision;
  /** Selected kit id (SamplerPanel useKitId). */
  getKitId(): string;
  /** Whole 8×16 drum pattern (DrumMachinePanel). */
  getPattern(): boolean[][];
  /** Drum wrap length 1..16 (DrumMachinePanel). */
  getDrumNumSteps(): number;
  /** Drum swing 0..100 (DrumMachinePanel). */
  getDrumSwing(): number;
  /** Live RUN/STOP flag for the drum grid (DrumMachinePanel RUN/STOP latch). */
  getDrumRunning(): boolean;
  /** Live Monarch-master running flag (DrumMachinePanel WAITING-FOR-MASTER hint). */
  getMonarchRunning(): boolean;
  /**
   * Live drum step-chase position (−1 = none). In-console this is the rAF chase; the pop-out
   * proxy returns −1 (control-only v1 — no live chase column. EARS/DECISION: the operator can
   * confirm whether the chase is wanted in the pop-out on day one; a follow-up if so).
   */
  getDrumStepPosition(): number;
  /** Subscribe to drum step-chase changes (in-console: the rAF chase; proxy: store changes). */
  subscribeDrumStep(onChange: () => void): () => void;

  // ---- actions (forwarded to the ONE engineBridge singleton) ----
  auditionPad(padIndex: number): void;
  setPadControl(padIndex: number, control: 'level' | 'tuneSemis', value: number): void;
  commitPadControl(padIndex: number, control: 'level' | 'tuneSemis', value: number): void;
  /** Load a user sample onto a pad (the panel catches the rejection for its error label). */
  loadPadSample(padIndex: number, file: File): Promise<void>;
  setPadLoop(padIndex: number, on: boolean): void;
  assignFactoryToPad(padIndex: number, factoryId: string): void;
  selectKit(kitId: string): void;
  setQuantize(division: QuantizeDivision): void;
  toggleStep(track: number, step: number): void;
  drumRun(): void;
  drumStop(): void;
  clearDrumPattern(): void;
  setDrumNumSteps(n: number): void;
  setDrumSwing(pct: number): void;
}

/**
 * The MAIN-window bridge: forwards every method 1:1 to the `engineBridge` singleton. This is
 * the DEFAULT `bridge` prop for both panels, so the in-console panels behave byte-identically
 * to before the DI refactor.
 *
 * NOTE the lazy `import('../engineBridge')` is deliberately AVOIDED — engineBridge is a normal
 * top-level import here. `realSamplerBridge` is only ever referenced from the MAIN window
 * (App.tsx mounts the panels with the default bridge); the pop-out app NEVER imports this
 * module's `realSamplerBridge` (it builds its own proxy), so the engine import stays out of the
 * pop-out chunk.
 */
import { engineBridge } from '../engineBridge';

export const realSamplerBridge: SamplerBridge = {
  subscribe: (onChange) => engineBridge.store.subscribe(onChange),
  getPadState: (i) => engineBridge.getPadState(i),
  getQuantize: () => engineBridge.getQuantize(),
  getKitId: () => engineBridge.getKitId(),
  getPattern: () => engineBridge.getPattern(),
  getDrumNumSteps: () => engineBridge.getDrumNumSteps(),
  getDrumSwing: () => engineBridge.getDrumSwing(),
  getDrumRunning: () => engineBridge.getTransportFlags().drumRunning,
  getMonarchRunning: () => engineBridge.getTransportFlags().monarchRunning,
  getDrumStepPosition: () => engineBridge.getStepPosition('drum'),
  subscribeDrumStep: (onChange) => engineBridge.subscribeStepPositions(onChange),
  auditionPad: (i) => engineBridge.auditionPad(i),
  setPadControl: (i, c, v) => engineBridge.setPadControl(i, c, v),
  commitPadControl: (i, c, v) => engineBridge.commitPadControl(i, c, v),
  loadPadSample: (i, f) => engineBridge.loadPadSample(i, f),
  setPadLoop: (i, on) => engineBridge.setPadLoop(i, on),
  assignFactoryToPad: (i, id) => engineBridge.assignFactoryToPad(i, id),
  selectKit: (id) => engineBridge.selectKit(id),
  setQuantize: (d) => engineBridge.setQuantize(d),
  toggleStep: (t, s) => engineBridge.toggleStep(t, s),
  drumRun: () => engineBridge.drumRun(),
  drumStop: () => engineBridge.drumStop(),
  clearDrumPattern: () => engineBridge.clearDrumPattern(),
  setDrumNumSteps: (n) => engineBridge.setDrumNumSteps(n),
  setDrumSwing: (p) => engineBridge.setDrumSwing(p),
};
