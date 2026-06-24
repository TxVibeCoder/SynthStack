/**
 * UI entry point. No StrictMode: the engine is a singleton with intervals and an
 * AudioContext; dev double-invocation buys nothing here and risks double pumps.
 */

import { createRoot } from 'react-dom/client';
import { App } from './App';
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
} else {
  reactRoot.render(<App />);
}
