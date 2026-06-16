/**
 * The 16:9 console — ONE 1805.19 × 1015.42 stage,
 * uniformly scaled to fit the window (a 1080p viewport is
 * exactly scale 1). Regions, all absolutely positioned from stage16x9.REGIONS:
 *
 *   Cascade controls | Anvil controls          | utility strip (POWER…)
 *                 | mixer knobs | Monarch step strip / Monarch controls
 *   ─────────────── consolidated jack field (all 88 jacks) ───────────────
 *   ──────────── keyboard strip (on-screen piano + Web MIDI) ──────────────
 *
 * POWER (in the utility strip) is the AudioContext user-gesture unlock:
 * nothing sounds before it. Un-powered regions are dimmed (CSS
 * .unpowered); controls stay editable — the engine just isn't running. The
 * utility strip itself never dims.
 *
 * The CableLayer overlay spans the stage; group borders render beneath it. Its
 * remaining-cable chip (CABLES n/12) is pinned to the CONSOLE band (top: STAGE.h −
 * chip height in styles.css), so it reads against the 88-jack patch field and does
 * NOT sink to the bottom of the sampler/drum scroll the .stage box now spans.
 * data-testid contract (e2e): power · init · cable-chip · tier-cascade ·
 * tier-anvil · tier-monarch · tier-mixer (now the mixer-knob block) + the new
 * region testids (seq-strip · jack-field · utility-strip · future-strip) + the
 * RECORD button (record · record-elapsed — the latter present only while recording).
 *
 * Sampler scroll model (feature-sampler-pads): the 16:9 console stays
 * PIXEL-IDENTICAL at a 1080p window (computeScale fits ONLY the
 * STAGE block, so scale==1 at exactly 1080p). The SAMPLER section (the 8 pads +
 * the DRUM MACHINE step grid below them) lives BELOW the fold, rendered INSIDE
 * the same scaled <main> so the CableLayer reaches its jacks for free.
 * transform:scale doesn't contribute layout height, so a JS-sized .stage-sizer
 * reserves real (unscaled) height = (STAGE.h + SAMPLER_TOTAL_H) · scale
 * (SAMPLER_TOTAL_H = PAD_SECTION_H + DRUM_SECTION_H) and the viewport
 * top-aligns + scrolls vertically (styles.css). transform-origin:top left pins
 * the console to the top-left.
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
import { UtilityStrip } from './UtilityStrip';
import { GroupBorders } from './GroupBorders';
import { CableLayer } from './cables/CableLayer';
import { SamplerPanel } from './panels/SamplerPanel';
import { DrumMachinePanel } from './panels/DrumMachinePanel';
import { SAMPLER_REGION, DRUM_REGION, SAMPLER_TOTAL_H } from './panels/samplerLayout';
import { KeyboardPanel } from './keyboard/KeyboardPanel';
import { PresetPicker } from './PresetPicker';

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

/** Uniform scale so the fixed-size stage fits (and fills) the window. */
function computeScale(): number {
  return Math.min(window.innerWidth / STAGE.w, window.innerHeight / STAGE.h);
}

export function App() {
  const { powered, powerOn, powerOff } = usePower();
  const [busy, setBusy] = useState(false);
  const [scale, setScale] = useState(computeScale);
  const stageRef = useRef<HTMLElement | null>(null);
  // Preset picker open-state: null = closed; 'browse' opens on the factory/slots
  // list (the PRESETS cap), 'save' opens with the name input focused (the SAVE
  // cap). The UtilityStrip's two now-live caps call onOpenPicker; the overlay is
  // UNMOUNTED until opened, so the 16:9 console stays pixel-identical at rest.
  const [picker, setPicker] = useState<null | 'browse' | 'save'>(null);

  const togglePower = useCallback(() => {
    if (busy) return;
    setBusy(true);
    const op = powered ? powerOff() : powerOn();
    void op.finally(() => setBusy(false));
  }, [busy, powered, powerOn, powerOff]);

  useEffect(() => {
    const onResize = () => setScale(computeScale());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const dim = !powered;

  return (
    <>
      <div className="stage-viewport">
      {/*
       * .stage-sizer reserves the REAL (unscaled) layout height of the scaled
       * console + sampler section (pads + drum grid), so the viewport gets a
       * scrollbar (transform:scale never contributes to layout height — see
       * styles.css). Width matches the scaled console so the horizontal letterbox
       * centering is unchanged. SAMPLER_TOTAL_H = PAD_SECTION_H + DRUM_SECTION_H.
       */}
      <div
        className="stage-sizer"
        style={{ width: STAGE.w * scale, height: (STAGE.h + SAMPLER_TOTAL_H) * scale }}
      >
        <main
          className="rack stage"
          ref={stageRef}
          style={{ transform: `scale(${scale})`, height: STAGE.h + SAMPLER_TOTAL_H }}
          aria-label="Semi-modular studio console"
        >
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
          <Region box={REGIONS.jackField} testId="jack-field" dimmed={dim}>
            <JackFieldPanel />
          </Region>
          <Region box={REGIONS.utilityStrip} testId="utility-strip">
            <UtilityStrip
              powered={powered}
              busy={busy}
              onTogglePower={togglePower}
              onOpenPicker={(mode) => setPicker(mode)}
            />
          </Region>
          {/* The reserved bottom band is now the keyboard's home: the
           * on-screen virtual piano + Web MIDI controls. It is
           * inside the 16:9 stage (always visible, no scroll) and is outside every
           * GROUP_OUTLINE and the jack field, so swapping the placeholder for the
           * keyboard leaves the rest of the stage pixel-identical and undisturbs
           * the cable coordinate space. testId stays "future-strip" (e2e contract). */}
          <Region box={REGIONS.futureStrip} testId="future-strip" dimmed={dim}>
            <KeyboardPanel />
          </Region>
          {/* SAMPLER pad section, BELOW the 16:9 fold — inside the scaled <main>
           * so the CableLayer measures its jacks and patches reach the SynthStack. NOT
           * a stage16x9.REGIONS entry (that map is pinned to the design vertices);
           * SAMPLER_REGION is a sampler-owned constant in samplerLayout.ts. */}
          <Region box={SAMPLER_REGION} testId="sampler-section" dimmed={dim}>
            <SamplerPanel />
          </Region>
          {/* DRUM MACHINE step grid — directly under the pads, same scaled <main>.
           * DRUM_REGION tiles below SAMPLER_REGION (y = STAGE.h + PAD_SECTION_H);
           * the panel has no jacks, so it adds nothing to the cable coordinate
           * space. Sampler-owned constants in samplerLayout.ts. */}
          <Region box={DRUM_REGION} testId="drum-section" dimmed={dim}>
            <DrumMachinePanel />
          </Region>

          {/* overlays: borders under cables; both pointer-transparent */}
          <GroupBorders />
          <CableLayer container={stageRef} />
        </main>
      </div>
      </div>
      {/* PRESET PICKER overlay — rendered as a SIBLING of .stage-viewport, OUTSIDE
       * the transform:scale <main>, so it is sized in SCREEN pixels (fixed,
       * full-viewport modal chrome) and never inherits the console's scale. It is
       * UNMOUNTED until a utility-strip cap opens it (picker !== null), so the
       * 16:9 console is pixel-identical at rest. 'browse' lists factory presets +
       * saved slots; 'save' opens with the name input focused. */}
      {picker && <PresetPicker mode={picker} onClose={() => setPicker(null)} />}
    </>
  );
}
