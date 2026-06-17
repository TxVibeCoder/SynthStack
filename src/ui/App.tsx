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
 * PER-TAB FILL-ZOOM MODEL (Wave-1 split → per-voice tabs). A <TabBar> + a dynamic
 * <MasterRibbon> render as OUT-OF-STAGE chrome — siblings ABOVE .stage-viewport, sized
 * in SCREEN pixels (NOT inside the transform:scale <main>) — so they never touch the
 * stage16x9 geometry. `tab` (cascade | anvil | monarch | patchbay | sampler — UI_TABS)
 * gates which stage Regions mount AND picks the per-tab CONTENT BBOX the stage zooms to
 * fill:
 *   - 'cascade' : the Cascade voice controls.
 *   - 'anvil'   : the Anvil voice controls.
 *   - 'monarch' : the Monarch controls + the 32-step seq strip + the docked keyboard.
 *   - 'patchbay': the consolidated 88-jack field + the 16 sampler pad jacks + the group
 *                 borders + the CableLayer. This is the ONLY tab cables render on.
 *   - 'sampler' : the SAMPLER pad-control section + the DRUM MACHINE grid (no jacks).
 * The 3 voices each get their OWN control tab, but all 104 jacks (88 voice + 16 sampler)
 * still co-mount together on 'patchbay' (HARD CONSTRAINT: every jack a cable touches must
 * be in the DOM together or the cable vanishes — CableLayer renders null for an unmounted
 * jack), so splitting the CONTROLS into per-voice tabs is safe. The cable ROUTING
 * persists across tabs (it lives in the engine store, not the DOM); only the visible
 * cable OVERLAY is patchbay-only. The four mixer channel faders + the MASTER knob live on
 * the MasterRibbon chrome (visible on every tab), not in a stage Region.
 *
 * PER-TAB BBOX (computed FROM the existing region boxes — NO geometry constant moves):
 * each tab's content bounding box is the union of the region boxes that mount on it
 * (see BBOX below). The stage is then translated so that bbox's top-left maps to the
 * viewport origin and uniformly scaled so the bbox fills the window beneath the chrome
 * (computeScale(box)). The PATCHBAY + SAMPLER bboxes keep width === STAGE.w, so on the
 * patchbay tab the rendered <main> width is STAGE.w·scale and the CableLayer's
 * width÷STAGE.w scale anchor recovers exactly `scale` — so cables land on their jacks.
 * The three VOICE bboxes are narrower than STAGE.w (a single control column), which is
 * fine: no cables render on a voice tab (CableLayer mounts on patchbay only), so the
 * width anchor is irrelevant there. The translate is composed OUTSIDE the scale
 * (`translate(-bx·s,-by·s) scale(s)`) and is cancelled by CableLayer's crect.left/top
 * subtraction, so jacks still measure in pure stage units. The full-size <main> is
 * clipped to the bbox window by the overflow:hidden .stage-sizer (which also handles
 * horizontal centering via flex).
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
 * utility-strip (now the ribbon) + tier-mixer (the ribbon's 4 channel faders) on EVERY
 * tab; tier-cascade on CASCADE; tier-anvil on ANVIL; tier-monarch + seq-strip +
 * future-strip on MONARCH; jack-field + sampler-jacks + group-borders + cable-chip on
 * PATCHBAY ONLY; sampler-section + drum-section on SAMPLER; plus the tab testids
 * (tab-cascade · tab-anvil · tab-monarch · tab-patchbay · tab-sampler). Elements moved
 * under a tab keep their testids.
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
import { CableLayer } from './cables/CableLayer';
import { SamplerPanel } from './panels/SamplerPanel';
import { SamplerJacks } from './panels/SamplerJacks';
import { DrumMachinePanel } from './panels/DrumMachinePanel';
import { SAMPLER_REGION, DRUM_REGION } from './panels/samplerLayout';
import { KeyboardPanel } from './keyboard/KeyboardPanel';
import { KB_W, KB_H } from './keyboard/keyboardLayout';
import { cascadeLayout } from './panels/cascadeLayout';
import { anvilLayout } from './panels/anvilLayout';
import { monarchLayout } from './panels/monarchLayout';
import { FIELD_H } from './panels/jackFieldLayout';
import { EffectsPanel, FX_W, FX_H } from './panels/EffectsPanel';
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
export const RIBBON_H = 85;
export const TABBAR_H = 26;
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
 *   - cascade  = REGIONS.cascadeControls — just the Cascade controls.
 *   - anvil    = REGIONS.anvilControls   — just the Anvil controls.
 *   - monarch  = union(monarchControls, seqStrip, MONARCH_KEYBOARD_BOX) — the Monarch
 *                controls + the 32-step seq strip + the docked keyboard (Monarch-column
 *                width, NOT full stage).
 *   - patchbay = union(jackField, SAMPLER_REGION) = {0, 644.78, 1805.19, 690.64}: the
 *                88-jack field + the 16 sampler pad jacks (which sit at y ≥ STAGE.h).
 *   - sampler  = union(SAMPLER_REGION, DRUM_REGION) = {0, 1015.42, 1805.19, 620}: the
 *                pad-control section + the drum grid.
 *
 * The three voice bboxes have width < STAGE.w (they're a single column, not the full
 * stage). That is SAFE for the CableLayer width÷STAGE.w scale anchor: CableLayer only
 * mounts on the PATCHBAY tab, whose bbox is still the full-width union(jackField,
 * SAMPLER_REGION) (w === STAGE.w) — so cables still land on their jacks. The patchbay +
 * sampler bboxes keep w === STAGE.w; only the voice tabs (no cables) are narrower.
 */
/**
 * VOICE-TAB CANVASES — the per-voice re-flow (hardware-panel match). Each voice tab now
 * frames its OWN landscape panel canvas, decoupled from the tiled stage16x9 REGIONS: the
 * canvas size IS the panel layout's own width/height (panels/{cascade,anvil,monarch}
 * Layout.ts), so widening a voice is a layout-file change with NO geometry move in
 * stage16x9.ts (its snap test stays green). The voice JACKS are unaffected — they live on
 * the PATCHBAY tab via the separate jackFieldLayout, which still uses the REGIONS tiling.
 * Patchbay + sampler bboxes keep w === STAGE.w (the CableLayer scale anchor); the voice
 * tabs carry no cables, so a narrower-than-STAGE bbox is safe (same as before).
 */
const CASCADE_BOX: RegionBox = { x: 0, y: 0, w: cascadeLayout.width, h: cascadeLayout.height };
const ANVIL_BOX: RegionBox = { x: 0, y: 0, w: anvilLayout.width, h: anvilLayout.height };
/** FX tab — its own landscape canvas (UI-only master effects), decoupled like the voices. */
const FX_BOX: RegionBox = { x: 0, y: 0, w: FX_W, h: FX_H };

/**
 * Monarch tab = three stacked, full-width-ish bands composed into one landscape canvas
 * (hardware spirit): the knob controls on top, the 32-step editor centered below, and a
 * FULL-WIDTH keyboard strip along the bottom. The step editor keeps its native seqStrip
 * aspect (centered, not stretched); the keyboard keeps its native 1805×141 aspect, so a
 * full-canvas-width box renders it with NO letterbox — the wide keyboard the hardware has.
 */
const MON_GAP = 16;
const MON_CONTROLS_BOX: RegionBox = { x: 0, y: 0, w: monarchLayout.width, h: monarchLayout.height };
const MON_SEQ_W = Math.min(monarchLayout.width, 1000);
const MON_SEQ_H = (MON_SEQ_W * REGIONS.seqStrip.h) / REGIONS.seqStrip.w;
const MON_SEQ_BOX: RegionBox = {
  x: (monarchLayout.width - MON_SEQ_W) / 2,
  y: monarchLayout.height + MON_GAP,
  w: MON_SEQ_W,
  h: MON_SEQ_H,
};
const MON_KB_H = (monarchLayout.width * KB_H) / KB_W;
const MON_KB_BOX: RegionBox = {
  x: 0,
  y: MON_SEQ_BOX.y + MON_SEQ_BOX.h + MON_GAP,
  w: monarchLayout.width,
  h: MON_KB_H,
};

/**
 * PATCHBAY composition. The voice jack field is now TALLER than its stage region
 * (FIELD_H, decoupled — jackFieldLayout.ts) so the 88 jacks spread out; it keeps the
 * full STAGE width so the CableLayer width÷STAGE.w scale anchor still holds (cables
 * measure correctly). The 16 sampler pad jacks render as a COMPACT cluster docked
 * directly below the field (no longer the full-width SAMPLER_REGION) — a quarter the
 * footprint, and the dead band between the field and the pads is gone.
 */
const JACKFIELD_BOX: RegionBox = { x: 0, y: REGIONS.jackField.y, w: REGIONS.jackField.w, h: FIELD_H };
const SAMPLER_JACKS_W = 660;
const SAMPLER_JACKS_H = 150;
const SAMPLER_PATCH_BOX: RegionBox = {
  x: (STAGE.w - SAMPLER_JACKS_W) / 2,
  y: JACKFIELD_BOX.y + FIELD_H + 18,
  w: SAMPLER_JACKS_W,
  h: SAMPLER_JACKS_H,
};

const BBOX: Record<ModuleTabId, RegionBox> = {
  // Each voice fill-zooms to its OWN landscape canvas (the panel layout's width/height).
  cascade: CASCADE_BOX,
  anvil: ANVIL_BOX,
  monarch: union(MON_CONTROLS_BOX, MON_SEQ_BOX, MON_KB_BOX),
  patchbay: union(JACKFIELD_BOX, SAMPLER_PATCH_BOX),
  sampler: union(SAMPLER_REGION, DRUM_REGION),
  fx: FX_BOX,
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
  // Default to the leftmost voice tab (cascade) so the console opens on a voice.
  const [tab, setTab] = useState<ModuleTabId>('cascade');
  // The active tab's content bbox + the scale that fills the window with it. `scale`
  // recomputes on resize AND on tab change (the bbox changes), so each tab fill-zooms.
  const box = BBOX[tab];
  const [scale, setScale] = useState(() => computeScale(BBOX.cascade));
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
  const isCascade = tab === 'cascade';
  const isAnvil = tab === 'anvil';
  const isMonarch = tab === 'monarch';
  const isPatchbay = tab === 'patchbay';
  const isSampler = tab === 'sampler';
  const isFx = tab === 'fx';

  // <main>'s inline (pre-scale) height = the BOTTOM of the active tab's bbox, so every
  // region/jack that mounts on this tab lies inside <main>'s box and is measurable by the
  // CableLayer (which insets to <main>): the voice tabs end at their bbox bottom (cascade
  // 644.78, anvil 509.98, monarch ~809.92), patchbay 1335.42 (so the sampler pad jacks at
  // y up to 1335.42 are inside), sampler 1635.42. transform:scale never contributes to
  // layout height — the .stage-sizer reserves the real scaled box instead.
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
            {/* ===== CASCADE TAB: the Cascade voice controls only (landscape canvas). ===== */}
            {isCascade && (
              <Region box={CASCADE_BOX} testId="tier-cascade" dimmed={dim}>
                <CascadePanel />
              </Region>
            )}

            {/* ===== ANVIL TAB: the Anvil voice controls only (landscape canvas). ===== */}
            {isAnvil && (
              <Region box={ANVIL_BOX} testId="tier-anvil" dimmed={dim}>
                <AnvilPanel />
              </Region>
            )}

            {/* ===== MONARCH TAB: the Monarch controls + the 32-step seq strip + the
             * docked on-screen keyboard (the keyboard plays the Monarch voice, so it
             * lives here). seqStrip keeps testId "seq-strip"; the keyboard keeps
             * "future-strip" (e2e contract). The keyboard box is the seq-strip width
             * under the seq strip — see MONARCH_KEYBOARD_BOX (a later widening pass gives
             * Monarch a full-width keyboard strip). ===== */}
            {isMonarch && (
              <>
                <Region box={MON_CONTROLS_BOX} testId="tier-monarch" dimmed={dim}>
                  <MonarchPanel />
                </Region>
                <Region box={MON_SEQ_BOX} testId="seq-strip" dimmed={dim}>
                  <MonarchStepEditor />
                </Region>
                <Region box={MON_KB_BOX} testId="future-strip" dimmed={dim}>
                  <KeyboardPanel />
                </Region>
              </>
            )}

            {/* The old in-stage utility strip Region (REGIONS.utilityStrip) and the in-
             * stage mixer Region (REGIONS.mixerKnobs / tier-mixer) are no longer rendered:
             * the utility controls moved to the MasterRibbon chrome (which now carries
             * data-testid="utility-strip") and the four channel faders moved to the ribbon
             * too (ChannelFaders carries data-testid="tier-mixer"). The REGIONS constants
             * are left untouched (stage16x9.ts unchanged). */}

            {/* ===== PATCHBAY TAB: ALL the jacks + the group borders + the cable overlay.
             * The consolidated 88-jack field AND the 16 sampler pad jacks co-mount here so
             * EVERY jack a cable can touch is in the DOM together (CableLayer renders null
             * for an unmounted jack, so cross-machine + voice<->sampler cables only stay
             * whole while their jacks co-mount). SAMPLER_REGION sits at y ≥ STAGE.h, inside
             * <main> (height = patchbay bbox bottom 1335.42), so its jacks measure. Cables
             * render ONLY here; the routing itself persists across tabs (engine store). */}
            {isPatchbay && (
              <>
                <Region box={JACKFIELD_BOX} testId="jack-field" dimmed={dim}>
                  <JackFieldPanel />
                </Region>
                <Region box={SAMPLER_PATCH_BOX} testId="sampler-jacks" dimmed={dim}>
                  <SamplerJacks />
                </Region>
                {/* CableLayer measures jack DOM positions live (÷ width/STAGE.w), so the
                 * taller field + relocated pad jacks patch correctly with no cable changes. */}
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

            {/* ===== FX TAB: the master effects panel (UI-only; writes the store `effects`
             * slice through the bridge). Its own landscape canvas, like the voice tabs. ===== */}
            {isFx && (
              <Region box={FX_BOX} testId="tier-fx" dimmed={dim}>
                <EffectsPanel />
              </Region>
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
