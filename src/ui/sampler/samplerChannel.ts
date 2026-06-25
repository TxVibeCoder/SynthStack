/**
 * samplerChannel (G5 pop-out) — the typed message union + a tiny cross-window transport that
 * prefers `BroadcastChannel('synthstack-sampler')` and falls back to `window.postMessage` when
 * BroadcastChannel is unavailable (older / restricted contexts).
 *
 * It imports NO engine code (and no React) — it is a pure messaging seam, shared by the MAIN-
 * window host (`samplerHost`) and the POP-OUT app (`SamplerPopoutApp`). Everything that crosses
 * the boundary is structured-cloneable:
 *   - the MAIN→POP-OUT MIRROR carries the serializable sampler snapshot;
 *   - the POP-OUT→MAIN ACTIONS carry primitives (+ a raw ArrayBuffer for a sample load — the
 *     transferable bytes, NEVER a File: the host reconstructs the File).
 */

import type { PadState, QuantizeDivision } from '../../state/studioState';

/** The BroadcastChannel name (also the postMessage discriminator tag below). */
export const SAMPLER_CHANNEL = 'synthstack-sampler';

/** Serializable mirror of the sampler/drum state the pop-out renders. */
export interface SamplerMirror {
  pads: PadState[];
  quantize: QuantizeDivision;
  kitId: string;
  pattern: boolean[][];
  drumNumSteps: number;
  drumSwingPct: number;
  drumRunning: boolean;
  /** Monarch-master running flag — drives the pop-out's WAITING-FOR-MASTER drum hint. */
  monarchRunning: boolean;
}

// ---- message union ----------------------------------------------------------------------
// MAIN → POP-OUT
interface MirrorMsg {
  t: 'mirror';
  mirror: SamplerMirror;
}
// POP-OUT → MAIN (lifecycle)
interface HelloMsg {
  t: 'hello';
}
interface ByeMsg {
  t: 'bye';
}
// POP-OUT → MAIN (actions)
interface AuditionMsg {
  t: 'audition';
  pad: number;
}
interface SetPadCtrlMsg {
  t: 'setPadControl';
  pad: number;
  control: 'level' | 'tuneSemis';
  value: number;
}
interface CommitPadCtrlMsg {
  t: 'commitPadControl';
  pad: number;
  control: 'level' | 'tuneSemis';
  value: number;
}
interface SetPadLoopMsg {
  t: 'setPadLoop';
  pad: number;
  on: boolean;
}
interface LoadMsg {
  t: 'load';
  pad: number;
  name: string;
  mime: string;
  bytes: ArrayBuffer; // transferable raw bytes — the host reconstructs new File([bytes], name, {type:mime})
}
interface AssignFactoryMsg {
  t: 'assignFactoryToPad';
  pad: number;
  factoryId: string;
}
interface SelectKitMsg {
  t: 'selectKit';
  kitId: string;
}
interface SetQuantizeMsg {
  t: 'setQuantize';
  division: QuantizeDivision;
}
interface ToggleStepMsg {
  t: 'toggleStep';
  track: number;
  step: number;
}
interface DrumRunMsg {
  t: 'drumRun';
}
interface DrumStopMsg {
  t: 'drumStop';
}
interface ClearDrumMsg {
  t: 'clearDrumPattern';
}
interface SetDrumNumStepsMsg {
  t: 'setDrumNumSteps';
  n: number;
}
interface SetDrumSwingMsg {
  t: 'setDrumSwing';
  pct: number;
}

/** Every message that can cross the sampler channel (narrowed on `t`). */
export type Msg =
  | MirrorMsg
  | HelloMsg
  | ByeMsg
  | AuditionMsg
  | SetPadCtrlMsg
  | CommitPadCtrlMsg
  | SetPadLoopMsg
  | LoadMsg
  | AssignFactoryMsg
  | SelectKitMsg
  | SetQuantizeMsg
  | ToggleStepMsg
  | DrumRunMsg
  | DrumStopMsg
  | ClearDrumMsg
  | SetDrumNumStepsMsg
  | SetDrumSwingMsg;

/** The set of valid `t` discriminants — the runtime guard's allow-list. */
const MSG_TYPES = new Set<Msg['t']>([
  'mirror',
  'hello',
  'bye',
  'audition',
  'setPadControl',
  'commitPadControl',
  'setPadLoop',
  'load',
  'assignFactoryToPad',
  'selectKit',
  'setQuantize',
  'toggleStep',
  'drumRun',
  'drumStop',
  'clearDrumPattern',
  'setDrumNumSteps',
  'setDrumSwing',
]);

/**
 * Runtime narrow: is `data` one of our messages? A malformed / unknown payload (a stray
 * postMessage from another script, a future message type, a non-object) returns false so the
 * receiver ignores it rather than throwing. Only the discriminant is validated here — the
 * sender is our own code, so per-field validation would be redundant; the receiver still
 * coalesces/clamps any value it forwards into the store via the engine bridge.
 */
export function isSamplerMsg(data: unknown): data is Msg {
  if (typeof data !== 'object' || data === null) return false;
  const t = (data as { t?: unknown }).t;
  return typeof t === 'string' && MSG_TYPES.has(t as Msg['t']);
}

/** The cross-window transport: post a typed Msg + subscribe to incoming ones. */
export interface SamplerChannel {
  post(msg: Msg, transfer?: Transferable[]): void;
  subscribe(handler: (msg: Msg) => void): () => void;
  close(): void;
}

/**
 * Build a channel preferring BroadcastChannel; fall back to window.postMessage when
 * BroadcastChannel is absent. The fallback wraps each message in `{__synthstackSampler:true,
 * msg}` and posts to the OTHER window (passed in) so a same-origin postMessage round-trips,
 * filtering by origin + the wrapper tag so unrelated postMessages are ignored.
 *
 * `other` (the counterpart Window) is only consulted by the fallback. With BroadcastChannel
 * available it is unused — both windows just open the same named channel.
 */
const WRAP_TAG = '__synthstackSampler';

export function createSamplerChannel(other?: Window | null): SamplerChannel {
  // Prefer BroadcastChannel — same-origin, multi-listener, no need to hold a Window ref.
  if (typeof BroadcastChannel !== 'undefined') {
    const bc = new BroadcastChannel(SAMPLER_CHANNEL);
    return {
      post: (msg) => bc.postMessage(msg),
      subscribe: (handler) => {
        const listener = (e: MessageEvent) => {
          if (isSamplerMsg(e.data)) handler(e.data);
        };
        bc.addEventListener('message', listener);
        return () => bc.removeEventListener('message', listener);
      },
      close: () => bc.close(),
    };
  }

  // Fallback: window.postMessage to the counterpart window (same origin).
  const origin = typeof window !== 'undefined' ? window.location.origin : '*';
  return {
    post: (msg, transfer) => {
      const target = other ?? (typeof window !== 'undefined' ? window.opener : null) ?? null;
      target?.postMessage({ [WRAP_TAG]: true, msg }, origin, transfer ?? []);
    },
    subscribe: (handler) => {
      const listener = (e: MessageEvent) => {
        if (e.origin !== origin) return;
        const wrapped = e.data as { [WRAP_TAG]?: unknown; msg?: unknown } | null;
        if (!wrapped || wrapped[WRAP_TAG] !== true) return;
        if (isSamplerMsg(wrapped.msg)) handler(wrapped.msg);
      };
      if (typeof window !== 'undefined') window.addEventListener('message', listener);
      return () => {
        if (typeof window !== 'undefined') window.removeEventListener('message', listener);
      };
    },
    close: () => {
      /* postMessage transport holds no resource to release */
    },
  };
}
