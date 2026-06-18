import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reportError,
  getErrors,
  clearErrors,
  subscribeErrors,
} from '../../src/ui/errorLog';

// errorLog is a module singleton, so reset between tests. (installGlobalErrorHandlers is
// NOT exercised here — it touches `window`, absent in the node test environment; the bus
// logic below is pure.)
beforeEach(() => clearErrors());

describe('errorLog (global error surface)', () => {
  it('reportError records message + stack as the newest entry', () => {
    reportError(new Error('boom'));
    const [top] = getErrors();
    expect(top?.message).toBe('boom');
    expect(top?.stack).toContain('boom'); // Error.stack starts with the message
    expect(top?.count).toBe(1);
  });

  it('stringifies a non-Error reason', () => {
    reportError('plain string failure');
    expect(getErrors()[0]?.message).toBe('plain string failure');
  });

  it('coalesces consecutive identical messages into one entry with a bumped count', () => {
    reportError(new Error('same'));
    reportError(new Error('same'));
    reportError(new Error('same'));
    const errs = getErrors();
    expect(errs).toHaveLength(1);
    expect(errs[0]?.count).toBe(3);
  });

  it('a different message breaks the coalescing run (newest-first)', () => {
    reportError(new Error('a'));
    reportError(new Error('b'));
    const errs = getErrors();
    expect(errs.map((e) => e.message)).toEqual(['b', 'a']);
  });

  it('keeps at most the 5 most recent distinct entries', () => {
    for (let i = 0; i < 8; i++) reportError(new Error(`e${i}`));
    const errs = getErrors();
    expect(errs).toHaveLength(5);
    expect(errs[0]?.message).toBe('e7'); // newest kept
    expect(errs.at(-1)?.message).toBe('e3'); // oldest of the kept window
  });

  it('notifies subscribers on a new error but NOT on a coalesced repeat (no re-render storm)', () => {
    const listener = vi.fn();
    const unsub = subscribeErrors(listener);
    reportError(new Error('x')); // new -> notify
    reportError(new Error('x')); // coalesced repeat -> silent
    reportError(new Error('x')); // coalesced repeat -> silent
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    reportError(new Error('y')); // after unsub -> no call
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clearErrors empties the surface and notifies once', () => {
    const listener = vi.fn();
    subscribeErrors(listener);
    reportError(new Error('z'));
    listener.mockClear();
    clearErrors();
    expect(getErrors()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();
    clearErrors(); // already empty -> no-op, no notify
    expect(listener).not.toHaveBeenCalled();
  });
});
