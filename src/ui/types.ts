/**
 * UI type contracts (design-agent owned — see CONVENTIONS.md).
 * All x/y/w/h coordinates are SVG viewBox units inside the owning panel's
 * viewBox. Since the 16:9 redesign every panel viewBox maps 1:1 to stage px
 * (region sizes in src/ui/stage16x9.ts). Coordinates locate element CENTERS
 * for controls/jacks/LEDs and the top-left corner for sections.
 */

import type { ControlDef, JackDef } from '../../data/schema';

export interface Pt {
  x: number;
  y: number;
}

export type KnobSize = 's' | 'm' | 'l';

/** A silkscreen section box (e.g. "OSCILLATOR", "FILTER") with its label. */
export interface PanelSection {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Per-module layout, authored by the panels agent, keyed by ControlDef/JackDef ids
 * from data/*.json. Panel components iterate this — never hard-code positions inline.
 */
export interface PanelLayout {
  /** Panel viewBox width = its stage region width (stage16x9.ts REGIONS). */
  width: number;
  /** Panel viewBox height = its stage region height. */
  height: number;
  /** Plain-text functional title (ModuleDef.displayName) — no trade dress. */
  title: string;
  sections: PanelSection[];
  /** controlId -> position, optional knob size (default 'm') and label placement. */
  controls: Record<string, Pt & { size?: KnobSize; labelBelow?: boolean }>;
  /** jackId -> position. */
  jacks: Record<string, Pt>;
}

/**
 * Knob (and stepKnob). Value lives in ControlDef [min, max] space; the engine's
 * param adapter (src/engine/units.ts) applies the taper — not the UI.
 */
export interface KnobProps {
  def: ControlDef;
  value: number;
  /**
   * Fires continuously during drag → IMMEDIATE imperative engine write via the
   * bridge. Must NOT write the store or trigger React renders outside this knob.
   */
  onInput: (v: number) => void;
  /** Fires once on pointer release / double-click reset → single store commit. */
  onCommit: (v: number) => void;
  size?: KnobSize;
  /** Optional machine-accent color (GROUP_BORDER) for the knob skirt — per-panel color coding. */
  accent?: string;
  /** Optional dim second line under the panel label (e.g. a live "≈ 120 BPM" tempo readout). */
  subLabel?: string;
  x: number;
  y: number;
}

export interface SwitchProps {
  def: ControlDef;
  /** Current position — one of def.positions. */
  value: string;
  /** New position → engine write + store commit (switch changes are discrete; no debounce). */
  onChange: (pos: string) => void;
  x: number;
  y: number;
}

export interface ButtonProps extends SwitchProps {
  /** Drives the button's LED lamp (e.g. RUN lit while transport runs). */
  lit?: boolean;
  /**
   * Momentary buttons (e.g. HOLD): onChange(active pos) on pointerdown,
   * onChange(idle pos) on pointerup/pointercancel. Latching otherwise.
   */
  momentary?: boolean;
}

/**
 * Static jack socket (stage 1 — cables land in stage 2).
 * REQUIREMENT: the rendered hit-area element (r = JACK_RADIUS.hit) must carry
 * `data-jack-id={def.id}`; the stage-2 CableLayer hit-tests jacks through that
 * attribute. Tooltip content rule is in CONVENTIONS.md (panelLabel, direction,
 * signal, "normalled from X" when def.normalledTo is set).
 */
export interface JackProps {
  def: JackDef;
  x: number;
  y: number;
}

/** Sequencer step LED. `dim` = page-visible-but-not-current ghosting. */
export interface StepLedProps {
  x: number;
  y: number;
  on: boolean;
  dim?: boolean;
}
