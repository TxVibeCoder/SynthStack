/**
 * Global error surface. The app shipped with NO error flagging — a throw in the rAF chase,
 * an unhandled promise rejection, or any window error vanished silently (the classic
 * symptom: a frozen sequencer with an empty console). This is the minimal fix:
 *
 *   - installGlobalErrorHandlers(): wire window 'error' + 'unhandledrejection' ONCE
 *     (call from the UI entry, main.tsx).
 *   - reportError(err): let caught-error sites hand us an error directly (the rAF chase
 *     try/catch in engineBridge does this).
 *   - subscribeErrors / getErrors: the ErrorOverlay reads the most-recent few.
 *
 * Repeats of the SAME message coalesce (a per-frame rAF throw bumps a count instead of
 * spawning a new entry + a re-render storm). UI-only; no engine coupling, no audio types.
 */

export interface LoggedError {
  /** Monotonic id (stable React key). */
  id: number;
  message: string;
  stack?: string;
  /** How many times this same message has fired in a row (coalesced repeats). */
  count: number;
}

type Listener = () => void;

/** Keep only the most recent few — this is a "something broke" surface, not a log file. */
const MAX = 5;

let seq = 0;
let errors: LoggedError[] = [];
const listeners = new Set<Listener>();
let installed = false;

function notify(): void {
  for (const l of listeners) l();
}

function push(message: string, stack?: string): void {
  const top = errors[0];
  if (top && top.message === message) {
    // Coalesce a repeat (e.g. drainUi throwing every animation frame): bump the count in
    // place WITHOUT a new array ref, so useSyncExternalStore does not re-render per frame.
    top.count += 1;
    return;
  }
  seq += 1;
  errors = [{ id: seq, message, stack, count: 1 }, ...errors].slice(0, MAX);
  notify();
}

/** Hand a caught error to the surface (engine/UI catch sites). */
export function reportError(err: unknown): void {
  if (err instanceof Error) push(err.message, err.stack);
  else push(String(err));
}

export function subscribeErrors(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for useSyncExternalStore — the array ref changes only on a real change. */
export function getErrors(): LoggedError[] {
  return errors;
}

export function clearErrors(): void {
  if (errors.length === 0) return;
  errors = [];
  notify();
}

/** Wire the global handlers ONCE (idempotent). Call from the UI entry. */
export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e: ErrorEvent) => {
    push(e.message || 'Unknown error', e.error instanceof Error ? e.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r: unknown = e.reason;
    if (r instanceof Error) push(`Unhandled rejection: ${r.message}`, r.stack);
    else push(`Unhandled rejection: ${String(r)}`);
  });
}
