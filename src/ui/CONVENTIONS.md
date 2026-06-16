# UI conventions — stage 1 contracts (design-agent owned)

Source of truth: `theme.ts` (constants) + `types.ts` (prop/layout contracts) + `styles.css`
(global CSS; its `:root` vars mirror `theme.ts` — change both or neither, via the design
agent). Since the 16:9 redesign, all panel coordinates are SVG viewBox units that map 1:1
to stage px — every panel's viewBox equals its stage region (`stage16x9.ts` REGIONS; the
stage itself is 1805.19×1015.42, uniformly scaled to the window by App.tsx).

## Data flow (work order §14.8 — non-negotiable)

- The engine is a singleton OUTSIDE React (`src/engine/studio.ts`); React reads a store and
  calls imperative setters.
- Knob drag: `onInput(v)` → immediate imperative engine write via the bridge
  (`module.setControl(...)`-level). **No store write, no React state outside the knob.**
  Only the dragged control re-renders (its value is local state while dragging).
- Release / double-click reset: `onCommit(v)` → one `store.setControl` write. Anything that
  must mirror the store mid-drag is debounced ≥ 100 ms.
- `useControl(moduleId, controlId)`: subscribes to the store, selects that one control's
  value, bails out (`Object.is`) when unchanged → a store write re-renders only the control
  it changed. Never subscribe a panel component to the whole store.
- Step LED chasing comes from the scheduler's uiQueue via rAF (§9.1), never store writes.

## Knob ergonomics (Appendix D Tier 3: webaudio-controls behavior, our visuals)

- Vertical **relative** drag with pointer capture; up = increase; 150 px travel = full
  min→max sweep (`DRAG_FULL_SWEEP_PX`).
- Shift = ×0.1 fine (`FINE_DRAG_FACTOR`); re-baseline when Shift toggles mid-drag (no jumps).
- Double-click = reset to `ControlDef.default` (fires `onInput` then `onCommit`).
- Drag maps linearly across `[min, max]`; `exp` taper is the engine adapter's job
  (`src/engine/units.ts`), not the UI's. Detents come only from `taper: "stepped"` /
  a `steps` count; `type: "stepKnob"` (sequencer step rows) is continuous.
- Rotation: 270° sweep, −135° (min) → +135° (max), 0° up (`KNOB_SWEEP_DEG`).
- Value readout (value + `ControlDef.unit`, ≤ 4 significant digits) visible while dragging,
  hidden on release.
- Keyboard: focusable; ↑/↓ = 1% of range (Shift = 0.1%); Home/End = min/max; commit on key up.

## Switches & buttons

- Switch: 2-position click toggles; ≥ 3 positions click cycles forward, Shift-click backward.
  Positions come from `ControlDef.positions`; lever/indicator drawn at the active one.
- Button (latching): click cycles positions; `lit` drives its LED lamp.
- Button (`momentary: true`, e.g. HOLD): `onChange(active)` on pointerdown, `onChange(idle)`
  on pointerup/pointercancel (active/idle = last/first of `positions`).
- Discrete changes: engine write + store commit together in `onChange` (no debounce).
- All focusable; Space/Enter activates.

## Jacks (stage 1: static sockets — cables are stage 2)

- Hit area: invisible circle `r = JACK_RADIUS.hit` carrying `data-jack-id={def.id}`.
  REQUIRED — the stage-2 CableLayer hit-tests jacks through that attribute.
- Tooltip (cheap hover, e.g. SVG `<title>`): `panelLabel · IN|OUT · signal`, plus
  `normalled from X` when `JackDef.normalledTo` is set — X is the source jack's panelLabel,
  or `<name> (internal)` for `INTERNAL:<name>` refs.
- Normalled-but-unpatched inputs get a subtle ring (§8.2) so users can learn the normals.

## Sections & legends

- Section: 1-unit `panelEdge` stroke rounded rect; label in `FONT_CONDENSED`, uppercase,
  ~13 units, letter-spacing ~1.5, `legend` fill, sitting in a gap in the top border.
- Control labels: condensed uppercase ~11 units, `legend` (use `legendDim` for units/ticks);
  above the control by default, below when `labelBelow: true`.
- Panel title: plain text (`ModuleDef.displayName`), condensed uppercase, top-left.

## File ownership (this stage)

| Files | Owner |
|---|---|
| `src/ui/theme.ts`, `types.ts`, `styles.css`, `CONVENTIONS.md` | design agent — FROZEN for others |
| `src/ui/controls/*` (Knob, Switch, Button, Jack, StepLed) | controls agent |
| `src/ui/panels/*` (per-module `PanelLayout` + panel components) | panels agent |
| `src/ui/hooks/*` (useControl, engine bridge), `App.tsx`, rack shell, mixer column | integration agent |
| `src/ui/cables/*` | cables agent (stage 2) |
| `src/engine/*`, `src/state/*`, `data/*`, configs | FROZEN for all UI agents |

## §12.3 — no trade dress

Dark panels, cream legends, gold-ish knobs *in the spirit of* the hardware — original work.
NO SynthStack logos, wordmarks, lookalike badges, or copied silkscreen artwork. Module titles are
plain-text functional names in our own typography. Cable colors come from the engine's
`CABLE_COLORS` (re-exported by `theme.ts`).
