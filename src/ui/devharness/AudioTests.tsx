/**
 * Dev harness: browser offline-audio battery page (#/dev/audio-tests).
 * Runs the battery on mount and prints PASS/FAIL plus machine-readable JSON;
 * `npm run test:audio` (Playwright) reads [data-status] / [data-testid].
 */

import { useEffect, useState } from 'react';
import { runBattery, BATTERY, type AudioTestResult } from '../../../test/audio/battery';
import '../styles.css';

export function AudioTests() {
  const [results, setResults] = useState<AudioTestResult[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void runBattery((_n, _total, last) => {
      if (!cancelled) setResults((r) => [...r, last]);
    }).then(() => {
      if (!cancelled) setDone(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const passed = results.filter((r) => r.pass).length;

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }} data-status={done ? 'done' : 'running'}>
      <h1 style={{ fontSize: 18, letterSpacing: 3 }}>OFFLINE AUDIO BATTERY</h1>
      <p style={{ color: 'var(--color-legend-dim)' }}>
        {done ? `done — ${passed}/${results.length} passed` : `running ${results.length + 1}/${BATTERY.length}…`}
      </p>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {results.map((r) => (
            <tr key={r.name} style={{ borderBottom: '1px solid var(--color-panel-edge)' }}>
              <td style={{ padding: '6px 10px', color: r.pass ? 'var(--color-led-green)' : 'var(--color-led-red)' }}>
                {r.pass ? 'PASS' : 'FAIL'}
              </td>
              <td style={{ padding: '6px 10px' }}>{r.name}</td>
              <td style={{ padding: '6px 10px', color: 'var(--color-legend-dim)', fontSize: 13 }}>{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {done && (
        <pre data-testid="audio-results" style={{ fontSize: 11, color: 'var(--color-legend-dim)' }}>
          {JSON.stringify(results, null, 1)}
        </pre>
      )}
    </div>
  );
}
