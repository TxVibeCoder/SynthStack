/**
 * The 16:9 console — ONE 1805.19 × 1015.42 stage of regions, all absolutely positioned
 * from stage16x9.REGIONS (+ the sampler-owned SAMPLER_REGION/DRUM_REGION below it):
 *
 *   Cascade controls | Anvil controls          | (master ribbon — now chrome)
 *                 | mixer knobs | Monarch step strip / Monarch controls
 *   ─────────────── consolidated jack field (all 88 voice jacks) ──────────────
 *   ──────────── keyboard strip (on-screen piano + Web MIDI) ──────────────
 *   ──────────── SAMPLER pad section · DRUM MACHINE grid (below the fold) ──────
 *
 * 3-TAB PER-TAB FILL-ZOOM MODEL (Wave-1 split). A <TabBar> + a dynamic <MasterRibbon>
 * render as OUT-OF-STAGE chrome — siblings ABOVE .stage-viewport, sized in SCREEN pixels
 * (NOT inside the transform:scale <main>) — so they never touch the stage16x9 geometry.
 * `tab` (studio | patchbay | sampler — UI_TABS) gates which stage Regions mount AND
 * picks the per-tab CONTENT BBOX the stage zooms to fill:
 *   - 'studio'  : Cascade/Anvil/Monarch controls + mixer + seq strip + keyboard.
 *   - 'patchbay': the consolidated 88-jack field + the 16 sampler pad jacks + the group
 *                 borders + the CableLayer. This is the ONLY tab cables render on.
 *   - 'sampler' : the SAMPLER pad-control section + the DRUM MACHINE grid (no jacks).
 * The 3 voices share the ONE 'studio' tab AND all 104 jacks (88 voice + 16 sampler)
 * co-mount on 'patchbay' (HARD CONSTRAINT: every jack a cable touches must be in the DOM
 * together or the cable vanishes — CableLayer renders null for an unmounted jack). The
 * cable ROUTING persists across tabs (it lives in the engine store, not the DOM); only
 * the visible cable OVERLAY is patchbay-only.
 *
 * PER-TAB BBOX (computed FROM the existing region boxes — NO geometry constant moves):
 * each tab's content bounding box is the union of the region boxes that mount on it
 * (see BBOX below). The stage is then translated so that bbox's top-left maps to the
 * viewport origin and uniformly scaled so the bbox fills the window beneath the chrome
 * (computeScale(box)). Because EVERY tab's bbox width === STAGE.w, the rendered <main>
 * width is always STAGE.w·scale and the CableLayer's width÷STAGE.w scale anchor still
 * recovers exactly `scale` — so cables land on their jacks on the patchbay tab. The
 * translate is composed OUTSIDE the scale (`translate(-bx·s,-by·s) scale(s)`) and is
 * cancelled by CableLayer's crect.left/top subtraction, so jacks still measure in pure
 * stage units. The full-size <main> is clipped to the bbox window by the
 * overflow:hidden .stage-sizer (which also handles horizontal centering via flex).
 *
 * The master ribbon (POWER, START/STOP ALL, TEMPO LINK, RECORD, FULL SCREEN, INIT,
 * PRESETS/SAVE, MASTER, + the active-tab name) replaces the old in-stage utility strip;
 * the REGIONS.utilityStrip slot is left empty (the constant is untouched). The master
 * ribbon carries data-testid="utility-strip" so e2e still finds the cluster.
 *
 * CHROME_H (the ribbon + tab-bar screen-pixel height) is subtracted from computeScale's
 * innerHeight term so the active tab's bbox still fits beneath the chrome.
 *
 * POWER (in the ribbon) is the AudioContext user-gesture unlock: nothing sounds before
 * it. Un-powered regions are dimmed (CSS .unpowered); controls stay editable — the
 * engine just isn't running. The ribbon itself never dims.
 *
 * On the patchbay tab the CableLayer overlay spans the stage; group borders render
 * beneath it. Its remaining-cable chip (CABLES n/12) is pinned within the jack band
 * (styles.css .cable-chip top).
 *
 * data-testid contract (e2e): power · init · presets · save · record · record-elapsed ·
 * utility-strip (now the ribbon) on EVERY tab; tier-cascade/anvil/monarch/mixer +
 * seq-strip + future-strip on STUDIO; jack-field + sampler-jacks + group-borders +
 * cable-chip on PATCHBAY ONLY; sampler-section + drum-section on SAMPLER; plus the tab
 * testids (tab-studio · tab-patchbay · tab-sampler). Elements moved under a tab keep
 * their testids.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './styles.css';
import { usePower } from './useStudio';
import { REGIONS, STAGE, type RegionBox } from './stage16x9';
import { MonarchPanel } from './panels/MonarchPanel';
import { AnvilPanel } from './panels/AnvilPanel';
import { CascadePanel } from './panels/CascadePanel';
import { JackFieldPanel } from './panels/JackFieldPanel';
import { MonarchStepEditor } from './sequencer/MonarchStepEditor';
import { MixerKnobs } from './MixerKnobs';
import { GroupBorders } from './GroupBorders';
import { CableLayer } from './cables/CableLayer';
import { SamplerPanel } from './panels/SamplerPanel';
import { SamplerJacks } from './panels/SamplerJacks';
import { DrumMachinePanel } from './panels/DrumMachinePanel';
import { SAMPLER_REGION, DRUM_REGION } from './panels/samplerLayout';
import { KeyboardPanel } from './keyboard/KeyboardPanel';
import { PresetPicker } from './PresetPicker';
import { OrientationHint } from './OrientationHint';
import { TabBar } from './TabBar';
import { MasterRibbon } from './MasterRibbon';
import type { ModuleTabId } from '../engine/modules/moduleConfig';

/**
 * Combined screen-pixel height of the out-of-stage chrome (master ribbon + tab bar),
 * subtracted from the window height before the stage is scaled to fit. Fixed-height
 * chrome (see styles.css .master-ribbon / .tab-bar) so the budget is deterministic and
 * there is no first-paint layout-shift; keep this in lockstep with those CSS heights.
 *   RIBBON_H 96 + TABBAR_H 40 + 1px borders/seam ≈ CHROME_H.
 */
export const RIBBON_H = 96;
export const TABBAR_H = 40;
export const CHROME_H = RIBBON_H + TABBAR_H;

/** Absolutely-positioned stage region (sizes in stage px — the stage scales). */
function Region({
  box,
  testId,
  dimmed,
  children,
}: {
  box: RegionBox;
  testId: string;
  dimmed?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={dimmed ? 'region unpowered' : 'region'}
      data-testid={testId}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      {children}
    </div>
  );
}

/**
 * Axis-aligned union of region boxes → the tightest box containing them all. Used to
 * compute each tab's CONTENT BBOX from the EXISTING region boxes (NOT by moving any
 * geometry constant). min-x/min-y of the corners to max-(x+w)/max-(y+h).
 */
function union(...bs: RegionBox[]): RegionBox {
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  const r = Math.max(...bs.map((b) => b.x + b.w));
  const btm = Math.max(...bs.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: btm - y };
}

/**
 * Per-tab content bounding box — the stage zooms to FILL this box on each tab. Computed
 * FROM the existing region boxes (no geometry moves):
 *   - studio   = the full STAGE box {0,0,STAGE.w,STAGE.h}. (The controls + keyboard
 *                already span it; the empty jack band y 644.78..874.28 is left honest
 *                this wave rather than collapsed — see the SHARED CONTRACT §B.)
 *   - patchbay = union(jackField, SAMPLER_REGION) = {0, 644.78, 1805.19, 690.64}: the
 *                88-jack field + the 16 sampler pad jacks (which sit at y ≥ STAGE.h).
 *   - sampler  = union(SAMPLER_REGION, DRUM_REGION) = {0, 1015.42, 1805.19, 620}: the
 *                pad-control section + the drum grid.
 * EVERY bbox has w === STAGE.w (load-bearing: keeps the CableLayer width÷STAGE.w scale
 * anchor exact, so cables land on their jacks — SHARED CONTRACT Group-3 invariant).
 */
/**
 * On the STUDIO tab the jacks live on the Patchbay tab, so the empty jack-field band
 * (y 644.78..874.28) is COLLAPSED by docking the keyboard directly beneath the voice/seq
 * cluster (the seqStrip seam bottom, y 668.78) instead of its default y 874.28. This
 * shrinks the studio bbox from the full 1015.42-tall stage to ~810, so the fill-zoom
 * makes the voices noticeably bigger (~0.75 → ~0.89 at 1080p — width-bound max — and a
 * larger gain on a height-constrained landscape phone). The shared REGIONS constant is
 * NOT moved (stage16x9.test.ts stays green); this is a per-tab RENDER position only.
 */
const STUDIO_KEYBOARD_BOX: RegionBox = {
  ...REGIONS.futureStrip,
  y: REGIONS.seqStrip.y + REGIONS.seqStrip.h, // 668.78 — directly under the seq strip
};

const BBOX: Record<ModuleTabId, RegionBox> = {
  studio: { x: 0, y: 0, w: STAGE.w, h: STUDIO_KEYBOARD_BOX.y + STUDIO_KEYBOARD_BOX.h },
  patchbay: union(REGIONS.jackField, SAMPLER_REGION),
  sampler: union(SAMPLER_REGION, DRUM_REGION),
};

/**
 * Uniform scale so the active tab's content bbox fits (and fills) the window BENEATH the
 * chrome. The chrome (ribbon + tab bar) eats CHROME_H of vertical budget, so the bbox is
 * fit into (innerHeight − CHROME_H). Because every bbox width === STAGE.w, this is the
 * uniform scale the rendered <main> (always STAGE.w wide) is drawn at.
 */
function computeScale(box: RegionBox): number {
  return Math.min(
    window.innerWidth / box.w,
    Math.max(0, window.innerHeight - CHROME_H) / box.h,
  );
}

export function App() {
  const { powered, powerOn, powerOff } = usePower();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<ModuleTabId>('studio');
  // The active tab's content bbox + the scale that fills the window with it. `scale`
  // recomputes on resize AND on tab change (the bbox changes), so each tab fill-zooms.
  const box = BBOX[tab];
  const [scale, setScale] = useState(() => computeScale(BBOX.studio));
  const stageRef = useRef<HTMLElement | null>(null);
  // Preset picker open-state: null = closed; 'browse' opens on the factory/slots
  // list (the PRESETS cap), 'save' opens with the name input focused (the SAVE cap).
  // The ribbon's two caps call onOpenPicker; the overlay is UNMOUNTED until opened.
  const [picker, setPicker] = useState<null | 'browse' | 'save'>(null);

  const togglePower = useCallback(() => {
    if (busy) return;
    setBusy(true);
    const op = powered ? powerOff() : powerOn();
    void op.finally(() => setBusy(false));
  }, [busy, powered, powerOn, powerOff]);

  // Recompute the fill-zoom on window resize AGAINST the active tab's bbox. (`box` is a
  // dep so the closure always reads the current bbox; the effect re-subscribes on tab
  // change, which is also when the dedicated effect below fires the initial recompute.)
  useEffect(() => {
    const onResize = () => setScale(computeScale(box));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [box]);

  // Refit when the active tab (hence its bbox) changes: each tab fill-zooms to its own
  // content. No scrolling — the per-tab fill-zoom replaces the old below-the-fold scroll
  // model entirely (the sampler panels are now zoomed to fill the window on their tab).
  useEffect(() => setScale(computeScale(box)), [box]);

  const dim = !powered;
  const isStudio = tab === 'studio';
  const isPatchbay = tab === 'patchbay';
  const isSampler = tab === 'sampler';

  // <main>'s inline (pre-scale) height = the BOTTOM of the active tab's bbox, so every
  // region/jack that mounts on this tab lies inside <main>'s box and is measurable by the
  // CableLayer (which insets to <main>): studio 1015.42, patchbay 1335.42 (so the sampler
  // pad jacks at y up to 1335.42 are inside), sampler 1635.42. transform:scale never
  // contributes to layout height — the .stage-sizer reserves the real scaled box instead.
  const mainH = box.y + box.h;

  return (
    <>
      {/* OUT-OF-STAGE CHROME — siblings ABOVE .stage-viewport, screen-pixel sized (NOT
       * inside the scaled <main>). The ribbon owns the master cluster (data-testid=
       * "utility-strip"); the tab bar gates which stage Regions mount. CHROME_H is
       * subtracted from computeScale so the stage still fits below them. */}
      <MasterRibbon
        tab={tab}
        powered={powered}
        busy={busy}
        onTogglePower={togglePower}
        onOpenPicker={(mode) => setPicker(mode)}
      />
      <TabBar tab={tab} onTab={setTab} />

      <div className="stage-viewport">
        {/* .stage-sizer is the per-tab WINDOW: sized to the active bbox at scale
         * (box.w·scale × box.h·scale) and overflow:hidden, so it clips the always-
         * STAGE.w-wide <main> down to just the bbox content (e.g. the studio control
         * regions are clipped away on the patchbay/sampler tabs). The .stage-viewport
         * flex centers this sizer horizontally; <main> is shifted INSIDE it by the
         * translate so the bbox top-left lands at the sizer's origin. */}
        <div
          className="stage-sizer"
          style={{ width: box.w * scale, height: box.h * scale, overflow: 'hidden' }}
        >
          <main
            className="rack stage"
            ref={stageRef}
            // translate (in SCREEN px, composed OUTSIDE the scale) shifts the bbox
            // top-left to the sizer origin; then scale. CableLayer's crect.left/top
            // subtraction cancels the translate, so jacks measure in pure stage units and
            // crect.width stays STAGE.w·scale (the width÷STAGE.w anchor === scale).
            style={{
              transform: `translate(${-box.x * scale}px, ${-box.y * scale}px) scale(${scale})`,
              height: mainH,
            }}
            aria-label="Semi-modular studio console"
          >
            {/* ===== STUDIO TAB: the 3 voices + mixer + seq strip + keyboard ===== */}
            {isStudio && (
              <>
                <Region box={REGIONS.cascadeControls} testId="tier-cascade" dimmed={dim}>
                  <CascadePanel />
                </Region>
                <Region box={REGIONS.anvilControls} testId="tier-anvil" dimmed={dim}>
                  <AnvilPanel />
                </Region>
                <Region box={REGIONS.monarchControls} testId="tier-monarch" dimmed={dim}>
                  <MonarchPanel />
                </Region>
                <Region box={REGIONS.mixerKnobs} testId="tier-mixer" dimmed={dim}>
                  <MixerKnobs />
                </Region>
                <Region box={REGIONS.seqStrip} testId="seq-strip" dimmed={dim}>
                  <MonarchStepEditor />
                </Region>
                {/* The reserved bottom band is the keyboard's home: the on-screen virtual
                 * piano + Web MIDI controls. testId stays "future-strip" (e2e contract). */}
                <Region box={STUDIO_KEYBOARD_BOX} testId="future-strip" dimmed={dim}>
                  <KeyboardPanel />
                </Region>
              </>
            )}

            {/* The old in-stage utility strip Region (REGIONS.utilityStrip) is no longer
             * rendered — its controls moved to the MasterRibbon chrome (which now carries
             * data-testid="utility-strip"). The REGIONS.utilityStrip constant is left
             * untouched (stage16x9.ts unchanged). */}

            {/* ===== PATCHBAY TAB: ALL the jacks + the group borders + the cable overlay.
             * The consolidated 88-jack field AND the 16 sampler pad jacks co-mount here so
             * EVERY jack a cable can touch is in the DOM together (CableLayer renders null
             * for an unmounted jack, so cross-machine + voice<->sampler cables only stay
             * whole while their jacks co-mount). SAMPLER_REGION sits at y ≥ STAGE.h, inside
             * <main> (height = patchbay bbox bottom 1335.42), so its jacks measure. Cables
             * render ONLY here; the routing itself persists across tabs (engine store). */}
            {isPatchbay && (
              <>
                <Region box={REGIONS.jackField} testId="jack-field" dimmed={dim}>
                  <JackFieldPanel />
                </Region>
                <Region box={SAMPLER_REGION} testId="sampler-jacks" dimmed={dim}>
                  <SamplerJacks />
                </Region>
                {/* overlays: borders under cables; both pointer-transparent. The bbox-clipping
                 * .stage-sizer (overflow:hidden) trims the GroupBorders control-half strokes
                 * that fall in the empty band above the jack field (y < 644.78). */}
                <GroupBorders />
                <CableLayer container={stageRef} />
              </>
            )}

            {/* ===== SAMPLER TAB: the pad-control section + the drum machine grid =====
             * SAMPLER_REGION/DRUM_REGION sit at y ≥ STAGE.h, inside the scaled <main> (height
             * = sampler bbox bottom 1635.42). NO jacks render here (the pad OUT/TRIG jacks
             * live on the patchbay tab via SamplerJacks); these are the controls only. NOT
             * stage16x9.REGIONS entries — SAMPLER_REGION/DRUM_REGION are sampler-owned. */}
            {isSampler && (
              <>
                <Region box={SAMPLER_REGION} testId="sampler-section" dimmed={dim}>
                  <SamplerPanel />
                </Region>
                <Region box={DRUM_REGION} testId="drum-section" dimmed={dim}>
                  <DrumMachinePanel />
                </Region>
              </>
            )}
          </main>
        </div>
      </div>
      {/* ORIENTATION HINT — a "rotate to landscape" steer, rendered as a SIBLING of
       * .stage-viewport so the stylesheet can pin it at fixed/inset:0. Always mounted;
       * revealed ONLY for portrait + coarse-pointer + narrow. */}
      <OrientationHint />
      {/* PRESET PICKER overlay — a SIBLING of .stage-viewport, OUTSIDE the transform:scale
       * <main>, screen-pixel sized. UNMOUNTED until a ribbon cap opens it (picker !== null). */}
      {picker && <PresetPicker mode={picker} onClose={() => setPicker(null)} />}
    </>
  );
}
