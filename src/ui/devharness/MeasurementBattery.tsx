/**
 * Dev harness: browser offline-audio MEASUREMENT battery page (#/dev/measure).
 * Renders the recording-free fidelity scorecard — pitch / waveshape / filter measured against
 * math/spec on the assembled worklet graphs. Runs on mount and prints PASS/FAIL + a
 * machine-readable JSON; `npm run test:measure` (Playwright) reads [data-status] / [data-testid].
 */

import { useEffect, useState } from 'react';
import { runMeasurementBattery, MEASUREMENT_BATTERY, type AudioTestResult } from '../../../test/audio/measurementBattery';
import '../styles.css';

export function MeasurementBattery() {
  const [results, setResults] = useState<AudioTestResult[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void runMeasurementBattery((_n, _total, last) => {
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
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto' }} data-status={done ? 'done' : 'running'}>
      <h1 style={{ fontSize: 18, letterSpacing: 3 }}>FIDELITY MEASUREMENT BATTERY</h1>
      <p style={{ color: 'var(--color-legend-dim)' }}>
        {done
          ? `done — ${passed}/${results.length} passed`
          : `running ${results.length + 1}/${MEASUREMENT_BATTERY.length}…`}
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
        <pre data-testid="measure-results" style={{ fontSize: 11, color: 'var(--color-legend-dim)' }}>
          {JSON.stringify(results, null, 1)}
        </pre>
      )}
    </div>
  );
}
