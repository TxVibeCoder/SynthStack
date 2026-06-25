/**
 * UI entry point. No StrictMode: the engine is a singleton with intervals and an
 * AudioContext; dev double-invocation buys nothing here and risks double pumps.
 */

import { createRoot } from 'react-dom/client';
import { installGlobalErrorHandlers } from './errorLog';

// Wire window 'error' + 'unhandledrejection' to the visible ErrorOverlay BEFORE first
// render, so a startup throw or a silent rAF/audio failure surfaces instead of vanishing.
installGlobalErrorHandlers();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
const reactRoot = createRoot(root);

// dev harness routes — dynamically imported so the battery (and its
// test-only fft.js dependency) stays out of the normal startup path
if (window.location.hash.startsWith('#/dev/audio-tests')) {
  void import('./devharness/AudioTests').then(({ AudioTests }) => reactRoot.render(<AudioTests />));
} else if (window.location.hash.startsWith('#/dev/measure')) {
  void import('./devharness/MeasurementBattery').then(({ MeasurementBattery }) =>
    reactRoot.render(<MeasurementBattery />),
  );
} else if (window.location.hash.startsWith('#/sampler-popout')) {
  // G5 SAMPLER POP-OUT — the SECOND-window root. A DYNAMIC import keeps the engine code out of
  // the pop-out chunk (SamplerPopoutApp imports SamplerPanel + theme + the channel ONLY, never
  // engineBridge), so this window owns no AudioContext: it mirrors the main console over a
  // BroadcastChannel and forwards every action back to the ONE engineBridge singleton. App (which
  // statically imports engineBridge — the eager singleton that also sets window.__synthstackStudio)
  // is itself a DYNAMIC import below, so the pop-out window NEVER loads engineBridge: the
  // single-AudioContext / no-engine-in-the-pop-out invariant holds at the module-graph level.
  void import('./sampler/SamplerPopoutApp').then(({ SamplerPopoutApp }) =>
    reactRoot.render(<SamplerPopoutApp />),
  );
} else {
  // App is dynamically imported so the engine module graph (engineBridge + Studio) is pulled in
  // ONLY for the main console window, never for the pop-out / dev-harness routes above.
  void import('./App').then(({ App }) => reactRoot.render(<App />));
}
