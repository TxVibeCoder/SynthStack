/**
 * SampleProcessor (feature: sample processor) — a plain-HTML modal, portaled to document.body
 * so it sits OUTSIDE the transform:scale stage (screen-pixel sized, like KitMenu / PresetPicker).
 *
 * Drop or LOAD an audio file → it decodes (engineBridge.decodeAudioFile) and draws a waveform →
 * drag the two handles to pick a region → set a short FADE for a click-free loop seam → PREVIEW
 * loops the result (engineBridge.previewSample) → pick a pad and ASSIGN. Assign encodes the edited
 * region to a WAV File (pure sampleEdit.encodeWav) and routes through the SAME bridge.loadPadSample
 * path as any user sample, so the loop persists / exports / round-trips for free.
 *
 * All trim/fade/peak/WAV math is the PURE sampleEdit core (Node-tested); this file is the thin shell.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent as ReactChangeEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { COLORS } from './theme';
import { engineBridge } from './engineBridge';
import { SampleTooLargeError } from '../engine/sampleStore';
import { encodeWav, peaks, trimAndFade } from '../engine/sampleEdit';

const WAVE_W = 680;
const WAVE_H = 160;
const PAD_INDICES = [0, 1, 2, 3, 4, 5, 6, 7];
const Z = 60; // above KitMenu (45) and PresetPicker (50)

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const baseName = (n: string): string => n.replace(/\.[^./\\]+$/, '');

function loadErrorMessage(err: unknown): string {
  if (err instanceof SampleTooLargeError) return 'File too large (max 4 MB)';
  if (err instanceof Error && err.message.includes('power')) return 'Power on the studio first';
  return 'Could not decode that file';
}

export function SampleProcessor({ onClose }: { onClose: () => void }) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [name, setName] = useState('');
  const [startFrac, setStartFrac] = useState(0);
  const [endFrac, setEndFrac] = useState(1);
  const [fadeMs, setFadeMs] = useState(8);
  const [targetPad, setTargetPad] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<'start' | 'end' | null>(null);

  // Focus the panel on open (Escape target); stop any preview on unmount.
  useEffect(() => {
    panelRef.current?.focus();
    return () => engineBridge.stopPreview();
  }, []);

  // Draw the waveform whenever the decoded buffer changes.
  useEffect(() => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    ctx.clearRect(0, 0, WAVE_W, WAVE_H);
    ctx.strokeStyle = COLORS.panelEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, WAVE_H / 2);
    ctx.lineTo(WAVE_W, WAVE_H / 2);
    ctx.stroke();
    if (!buffer) return;
    const { min, max } = peaks(buffer.getChannelData(0), WAVE_W);
    ctx.strokeStyle = COLORS.legend;
    ctx.beginPath();
    for (let x = 0; x < WAVE_W; x++) {
      const yTop = (1 - (max[x] ?? 0)) * (WAVE_H / 2);
      const yBot = (1 - (min[x] ?? 0)) * (WAVE_H / 2);
      ctx.moveTo(x + 0.5, yTop);
      ctx.lineTo(x + 0.5, yBot);
    }
    ctx.stroke();
  }, [buffer]);

  const loadFile = useCallback(async (file: File) => {
    setError(null);
    setBusy(true);
    engineBridge.stopPreview();
    setPlaying(false);
    try {
      const buf = await engineBridge.decodeAudioFile(file);
      setBuffer(buf);
      setName(baseName(file.name));
      setStartFrac(0);
      setEndFrac(1);
    } catch (err) {
      setError(loadErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const onPick = useCallback(() => {
    setError(null);
    const inp = fileInputRef.current;
    if (inp) {
      inp.value = ''; // allow re-picking the same file
      inp.click();
    }
  }, []);

  const onFileChange = useCallback(
    (e: ReactChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) void loadFile(f);
    },
    [loadFile],
  );

  const onDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) void loadFile(f);
    },
    [loadFile],
  );

  // ---- trim-handle dragging --------------------------------------------------------------
  const fracFromClientX = (clientX: number): number => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return clamp01((clientX - r.left) / r.width);
  };
  const onHandleDown = (which: 'start' | 'end') => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = which;
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const f = fracFromClientX(e.clientX);
    if (dragRef.current === 'start') setStartFrac(Math.min(f, endFrac));
    else setEndFrac(Math.max(f, startFrac));
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };

  // ---- process / preview / assign --------------------------------------------------------
  const processedChannels = (): Float32Array[] | null => {
    if (!buffer) return null;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    return trimAndFade(channels, buffer.sampleRate, startFrac, endFrac, fadeMs);
  };

  const onPreview = () => {
    const ch = processedChannels();
    if (!ch || !buffer) return;
    engineBridge.previewSample(ch, buffer.sampleRate);
    setPlaying(true);
  };
  const onStop = () => {
    engineBridge.stopPreview();
    setPlaying(false);
  };

  const onAssign = async () => {
    const ch = processedChannels();
    if (!ch || !buffer) return;
    setBusy(true);
    setError(null);
    try {
      const wav = encodeWav(ch, buffer.sampleRate);
      const file = new File([wav], `${name || 'sample'} loop.wav`, { type: 'audio/wav' });
      await engineBridge.loadPadSample(targetPad, file);
      engineBridge.stopPreview();
      onClose();
    } catch (err) {
      setError(
        err instanceof SampleTooLargeError ? 'Loop too long (max 4 MB) — trim it shorter' : 'Assign failed',
      );
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    engineBridge.stopPreview();
    onClose();
  };

  const regionSec = buffer ? Math.max(0, endFrac - startFrac) * buffer.duration : 0;

  // ---- styles (reuse the :root CSS custom properties, like KitMenu) -----------------------
  const btn = (active = false): CSSProperties => ({
    fontFamily: 'var(--font-condensed)',
    fontSize: 13,
    letterSpacing: 1,
    padding: '7px 14px',
    borderRadius: 5,
    cursor: 'pointer',
    color: active ? 'var(--color-panel)' : 'var(--color-legend)',
    background: active ? 'var(--color-focus)' : 'var(--color-panel-raised)',
    border: `1px solid ${active ? 'var(--color-focus)' : 'var(--color-panel-edge)'}`,
  });

  return createPortal(
    <div
      className="sample-processor-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: Z,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={close}
    >
      <div
        ref={panelRef}
        className="sample-processor"
        role="dialog"
        aria-label="Sample processor"
        data-testid="sample-processor"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        style={{
          width: WAVE_W + 40,
          maxWidth: '94vw',
          maxHeight: '92dvh',
          overflowY: 'auto',
          background: 'var(--color-panel)',
          border: '1px solid var(--color-panel-edge)',
          borderRadius: 10,
          boxShadow: '0 14px 48px rgba(0,0,0,0.6)',
          padding: 20,
          fontFamily: 'var(--font-condensed)',
          color: 'var(--color-legend)',
        }}
      >
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontSize: 18, letterSpacing: 2 }}>SAMPLE PROCESSOR</span>
          <button type="button" aria-label="Close" onClick={close} style={{ ...btn(), padding: '4px 10px' }}>
            ✕
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          data-testid="sample-processor-file"
          style={{ display: 'none' }}
          onChange={onFileChange}
        />

        {/* waveform + trim region (drop target) */}
        <div
          ref={wrapRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          style={{
            position: 'relative',
            width: WAVE_W,
            maxWidth: '100%',
            height: WAVE_H,
            background: 'var(--color-panel-raised)',
            border: '1px solid var(--color-panel-edge)',
            borderRadius: 6,
            overflow: 'hidden',
            userSelect: 'none',
            touchAction: 'none',
          }}
        >
          <canvas ref={canvasRef} width={WAVE_W} height={WAVE_H} style={{ width: '100%', height: '100%', display: 'block' }} />

          {!buffer && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                color: 'var(--color-legend-dim)',
                fontSize: 13,
                letterSpacing: 1,
              }}
            >
              <span>Drop an audio file here, or</span>
              <button type="button" onClick={onPick} style={btn()} disabled={busy}>
                LOAD FILE
              </button>
            </div>
          )}

          {buffer && (
            <>
              {/* dim the regions outside the selection */}
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${startFrac * 100}%`, background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: `${(1 - endFrac) * 100}%`, background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
              {/* handles */}
              {(['start', 'end'] as const).map((which) => {
                const frac = which === 'start' ? startFrac : endFrac;
                return (
                  <div
                    key={which}
                    role="slider"
                    aria-label={`${which} of loop`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(frac * 100)}
                    onPointerDown={onHandleDown(which)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                    data-testid={`sample-handle-${which}`}
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: `calc(${frac * 100}% - 6px)`,
                      width: 12,
                      cursor: 'ew-resize',
                      touchAction: 'none',
                    }}
                  >
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: 5, width: 2, background: 'var(--color-focus)' }} />
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* readout + controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 14 }}>
          <span style={{ fontSize: 12, color: 'var(--color-legend-dim)', minWidth: 150 }}>
            {buffer ? `${name} — ${regionSec.toFixed(2)} s loop` : 'No file loaded'}
          </span>
          {buffer && (
            <button type="button" onClick={onPick} style={btn()} disabled={busy}>
              REPLACE
            </button>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, letterSpacing: 1 }}>
            FADE
            <input
              type="range"
              min={0}
              max={200}
              value={fadeMs}
              onChange={(e) => setFadeMs(Number(e.target.value))}
              aria-label="loop fade milliseconds"
              style={{ width: 130 }}
              disabled={!buffer}
            />
            <span style={{ width: 48, color: 'var(--color-legend-dim)' }}>{fadeMs} ms</span>
          </label>
          <button
            type="button"
            onClick={playing ? onStop : onPreview}
            style={btn(playing)}
            disabled={!buffer}
            data-testid="sample-preview"
          >
            {playing ? 'STOP' : 'PREVIEW'}
          </button>
        </div>

        {/* pad target + assign */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
          <span style={{ fontSize: 12, letterSpacing: 1, color: 'var(--color-legend-dim)' }}>ASSIGN TO PAD</span>
          {PAD_INDICES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setTargetPad(p)}
              aria-pressed={targetPad === p}
              data-testid={`sample-pad-${p}`}
              style={{ ...btn(targetPad === p), padding: '6px 11px', minWidth: 34 }}
            >
              {p + 1}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void onAssign()}
            disabled={!buffer || busy}
            data-testid="sample-assign"
            style={{ ...btn(true), marginLeft: 'auto', opacity: !buffer || busy ? 0.5 : 1 }}
          >
            ASSIGN
          </button>
        </div>

        {error && (
          <div role="alert" style={{ marginTop: 12, color: 'var(--color-led-red)', fontSize: 12, letterSpacing: 0.5 }}>
            {error.toUpperCase()}
          </div>
        )}
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-legend-dim)', letterSpacing: 0.5 }}>
          Tip: a short FADE removes the click at the loop seam. The processed loop is saved to the pad
          like any sample (it persists and exports).
        </div>
      </div>
    </div>,
    document.body,
  );
}
