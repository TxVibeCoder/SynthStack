/**
 * SamplerPopoutApp (G5 pop-out) — the POP-OUT WINDOW root. It renders the SAMPLER pads +
 * the drum grid in a SECOND browser window beside the console, owning NO AudioContext / engine:
 *
 *   - it builds a `proxySamplerBridge` whose ACTIONS post a typed Msg over the sampler channel
 *     to the main window (which forwards them to the ONE engineBridge), and whose SNAPSHOTS read
 *     the last received mirror from a tiny LOCAL external store — so `useSyncExternalStore`
 *     inside SamplerPanel / DrumMachinePanel works UNCHANGED;
 *   - it posts `'hello'` on mount (the host replies with the current mirror) and `'bye'` on
 *     pagehide; closing the pop-out owns no audio, so it must NOT stop sound.
 *
 * THE BIG GOTCHA (no second AudioContext): this module imports `SamplerPanel`,
 * `DrumMachinePanel`, theme + the channel ONLY — NEVER `engineBridge`. The panels accept an
 * injected `bridge`, so the engine import stays out of the pop-out chunk; the e2e single-
 * AudioContext assertion is the backstop.
 *
 * Lazy-loaded by main.tsx on `#/sampler-popout` (a dynamic import keeps engine code out of the
 * pop-out chunk).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { COLORS, FONT_CONDENSED } from '../theme';
import { SamplerPanel } from '../panels/SamplerPanel';
import { DrumMachinePanel } from '../panels/DrumMachinePanel';
import type { SamplerBridge } from './samplerBridge';
import { createSamplerChannel, type Msg, type SamplerChannel } from './samplerChannel';
import { createProxySamplerBridge, MirrorStore } from './proxySamplerBridge';

/** Time (ms) to wait after `'hello'` for the first mirror before showing the stale-channel state. */
const STALE_MS = 2000;

export function SamplerPopoutApp() {
  // One store + channel + proxy for the window's lifetime.
  const storeRef = useRef<MirrorStore | null>(null);
  if (!storeRef.current) storeRef.current = new MirrorStore();
  const store = storeRef.current;

  const channelRef = useRef<SamplerChannel | null>(null);
  if (!channelRef.current) channelRef.current = createSamplerChannel(window.opener);
  const channel = channelRef.current;

  const bridgeRef = useRef<SamplerBridge | null>(null);
  if (!bridgeRef.current) bridgeRef.current = createProxySamplerBridge(store, channel);
  const bridge = bridgeRef.current;

  // 'connecting' until the first mirror lands; 'live' after; 'stale' if none arrives within
  // STALE_MS of 'hello' (main window closed / never opened the host).
  const [conn, setConn] = useState<'connecting' | 'live' | 'stale'>('connecting');

  useEffect(() => {
    const unsub = channel.subscribe((msg: Msg) => {
      if (msg.t === 'mirror') {
        store.set(msg.mirror);
        setConn('live');
      }
    });
    // Announce ourselves; the host replies with the current mirror.
    channel.post({ t: 'hello' });
    const staleTimer = window.setTimeout(() => {
      setConn((c) => (c === 'live' ? c : 'stale'));
    }, STALE_MS);
    // Closing the pop-out owns NO audio, so this must NOT stop sound — it just tells the host
    // the child is gone (the host has no per-child state, so it's purely informational).
    const onPageHide = () => channel.post({ t: 'bye' });
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.clearTimeout(staleTimer);
      window.removeEventListener('pagehide', onPageHide);
      unsub();
      channel.post({ t: 'bye' });
      channel.close();
    };
  }, [channel, store]);

  // Re-derive a "live" flag if a mirror ever lands after going stale (host reopened).
  useSyncExternalStore(store.subscribe, () => store.current);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: COLORS.bg,
        color: COLORS.legend,
        fontFamily: FONT_CONDENSED,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 8,
        boxSizing: 'border-box',
      }}
    >
      <div
        data-testid="popout-status"
        style={{ fontSize: 12, letterSpacing: 1, color: COLORS.legendDim, flex: '0 0 auto' }}
      >
        {conn === 'stale'
          ? 'MAIN WINDOW CLOSED — REOPEN SYNTHSTACK TO RECONNECT'
          : 'SAMPLER — POP-OUT (mirrors the main console)'}
      </div>
      {/* The two panels, fed the PROXY bridge (no engine import). They are SVG `.panel`s sized
          to their own viewBox; let them scale to the window width. */}
      <div style={{ flex: '0 0 auto' }}>
        <SamplerPanel bridge={bridge} mainWindow={false} />
      </div>
      <div style={{ flex: '0 0 auto' }}>
        <DrumMachinePanel bridge={bridge} />
      </div>
    </div>
  );
}
