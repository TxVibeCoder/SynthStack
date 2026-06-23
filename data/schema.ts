/**
 * Module definition schema.
 * The three data/*.json files are authored against this schema
 * and validated in test/unit/moduleData.test.ts.
 */

export type SignalType = 'audio' | 'cv' | 'gate' | 'clock' | 'midi';
export type Direction = 'in' | 'out';
export type Taper = 'lin' | 'exp' | 'stepped';

export interface ControlDef {
  id: string; // 'MON_CUTOFF'
  panelLabel: string; // 'CUTOFF'
  type: 'knob' | 'switch' | 'button' | 'stepKnob';
  // knobs:
  min?: number;
  max?: number;
  default?: number | string;
  taper?: Taper;
  steps?: number; // stepped knobs (e.g. SUB FREQ 1..16)
  unit?: string; // 'Hz' | 'vv' | 'BPM' | 's' | '%' | 'div' ...
  // switches/buttons:
  positions?: string[]; // ['LP','HP'], ['OFF','ON','HELD'] ...
  manualRef?: string; // 'Monarch p.14'
  notes?: string;
}

export interface JackDef {
  id: string; // 'MON_VCF_CUTOFF_IN'
  panelLabel: string;
  direction: Direction;
  signal: SignalType;
  rangeVv?: [number, number]; // informational, from manual
  normalledTo?: string | null; // for INPUTS: jack id or 'INTERNAL:<sourceId>' broken by patching
  feedsInternal?: string; // what this input modulates (free text, from manual)
  manualRef?: string;
  notes?: string;
}

export interface ModuleDef {
  id: 'monarch' | 'anvil' | 'cascade' | 'sampler' | 'courier';
  displayName: string;
  /** Internal (non-jack) signal sources that normals may reference via 'INTERNAL:<id>'. */
  internalSources: string[];
  controls: ControlDef[];
  jacks: JackDef[];
  sequencer?: Record<string, unknown>; // module-specific block, shapes given in §10–§11
}

const SIGNAL_TYPES: SignalType[] = ['audio', 'cv', 'gate', 'clock', 'midi'];
const DIRECTIONS: Direction[] = ['in', 'out'];
const TAPERS: Taper[] = ['lin', 'exp', 'stepped'];
const CONTROL_TYPES = ['knob', 'switch', 'button', 'stepKnob'];

/** Returns a list of human-readable validation errors (empty = valid). */
export function validateModuleDef(def: ModuleDef): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(`[${def.id}] ${msg}`);

  if (!['monarch', 'anvil', 'cascade', 'sampler', 'courier'].includes(def.id)) err(`bad module id`);
  if (!def.displayName) err('missing displayName');

  // --- controls ---
  const controlIds = new Set<string>();
  for (const c of def.controls) {
    if (controlIds.has(c.id)) err(`duplicate control id ${c.id}`);
    controlIds.add(c.id);
    if (!CONTROL_TYPES.includes(c.type)) err(`${c.id}: bad control type ${c.type}`);
    if (!c.panelLabel) err(`${c.id}: missing panelLabel`);
    if (c.type === 'knob' || c.type === 'stepKnob') {
      if (typeof c.min !== 'number' || typeof c.max !== 'number') {
        err(`${c.id}: knob needs numeric min/max`);
      } else {
        if (!(c.min < c.max)) err(`${c.id}: min (${c.min}) must be < max (${c.max})`);
        if (typeof c.default !== 'number') err(`${c.id}: knob needs numeric default`);
        else if (c.default < c.min || c.default > c.max) {
          err(`${c.id}: default ${c.default} out of range [${c.min}, ${c.max}]`);
        }
      }
      if (c.taper !== undefined && !TAPERS.includes(c.taper)) err(`${c.id}: bad taper ${c.taper}`);
      if (c.steps !== undefined && (!Number.isInteger(c.steps) || c.steps < 2)) {
        err(`${c.id}: steps must be an integer >= 2`);
      }
    }
    if (c.type === 'switch') {
      if (!c.positions || c.positions.length < 2) err(`${c.id}: switch needs >= 2 positions`);
      else if (typeof c.default === 'string' && !c.positions.includes(c.default)) {
        err(`${c.id}: default '${c.default}' not in positions`);
      }
    }
    if (c.type === 'button' && c.positions && typeof c.default === 'string') {
      if (!c.positions.includes(c.default)) err(`${c.id}: default '${c.default}' not in positions`);
    }
  }

  // --- jacks ---
  const jackIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const j of def.jacks) {
    if (jackIds.has(j.id)) err(`duplicate jack id ${j.id}`);
    jackIds.add(j.id);
    if (j.direction === 'out') outputIds.add(j.id);
    if (!DIRECTIONS.includes(j.direction)) err(`${j.id}: bad direction`);
    if (!SIGNAL_TYPES.includes(j.signal)) err(`${j.id}: bad signal type ${j.signal}`);
    if (!j.panelLabel) err(`${j.id}: missing panelLabel`);
    if (!j.manualRef) err(`${j.id}: missing manualRef`);
    if (j.rangeVv && !(j.rangeVv.length === 2 && j.rangeVv[0] <= j.rangeVv[1])) {
      err(`${j.id}: bad rangeVv`);
    }
    if (j.normalledTo != null && j.direction === 'out') {
      err(`${j.id}: outputs cannot have normals`);
    }
  }

  // --- normal referential integrity ---
  const internal = new Set(def.internalSources);
  for (const j of def.jacks) {
    if (j.normalledTo == null) continue;
    if (j.normalledTo.startsWith('INTERNAL:')) {
      const src = j.normalledTo.slice('INTERNAL:'.length);
      if (!internal.has(src)) err(`${j.id}: normalledTo unknown internal source '${src}'`);
    } else if (!outputIds.has(j.normalledTo)) {
      err(`${j.id}: normalledTo unknown output jack '${j.normalledTo}'`);
    }
  }

  return errors;
}
