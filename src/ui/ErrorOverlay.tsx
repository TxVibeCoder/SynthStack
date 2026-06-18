/**
 * ErrorOverlay — the visible end of errorLog. Renders NOTHING when clean; on an error it
 * shows a dismissible banner (most-recent-first) with the message + stack, so a silent
 * failure (an rAF-chase throw, an unhandled rejection) becomes something the user can SEE
 * and report instead of a mystery freeze with an empty console.
 *
 * Mounted as a SIBLING of the stage chrome (App.tsx), screen-pixel positioned via
 * styles.css `.error-overlay` (fixed, bottom-left, above everything). Subscribes through
 * useSyncExternalStore; the snapshot ref is stable until an error actually changes.
 */

import { useSyncExternalStore } from 'react';
import { subscribeErrors, getErrors, clearErrors } from './errorLog';

export function ErrorOverlay() {
  const errors = useSyncExternalStore(subscribeErrors, getErrors);
  if (errors.length === 0) return null;
  return (
    <div className="error-overlay" role="alert" data-testid="error-overlay">
      <div className="error-overlay__head">
        <span className="error-overlay__title">
          ⚠ {errors.length} error{errors.length > 1 ? 's' : ''}
        </span>
        <button
          type="button"
          className="error-overlay__dismiss"
          onClick={() => clearErrors()}
          aria-label="Dismiss errors"
        >
          ✕
        </button>
      </div>
      <ul className="error-overlay__list">
        {errors.map((e) => (
          <li key={e.id} className="error-overlay__item">
            <div className="error-overlay__msg">
              {e.message}
              {e.count > 1 && <span className="error-overlay__count"> ×{e.count}</span>}
            </div>
            {e.stack && <pre className="error-overlay__stack">{e.stack}</pre>}
          </li>
        ))}
      </ul>
    </div>
  );
}
