/**
 * PresetPicker component test (g4-ui).
 *
 * The project has NO browser-test harness (vitest runs in the `node` environment;
 * there is no jsdom / @testing-library / react-test-renderer and we may add no npm
 * deps — see package.json). The full LIVE overlay is exercised in a real browser by
 * test/e2e/presets.spec.ts. This unit test pins the component's React-side wiring in
 * pure Node: it renders PresetPicker with a tiny self-contained hook host (built on
 * React's dispatcher, the same primitive a renderer installs), walks the returned
 * element tree by data-testid, fires the handler props, and asserts the right
 * engineBridge methods are called (stubbed via vi.spyOn) + the local re-read / status
 * / two-step-confirm behaviour. No DOM is touched.
 *
 * NOTE (deviation from the contract's `presetPicker.test.tsx` filename): the vitest
 * include glob is the `test/unit` `.test.ts` pattern (vite.config.ts) — a `.tsx` test
 * would typecheck but never RUN. Named `.test.ts` (and using React.createElement-free
 * tree walking rather than JSX literals) so `npm test` actually executes it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import * as React from 'react';
import { PresetPicker } from '../../src/ui/PresetPicker';
import { engineBridge } from '../../src/ui/engineBridge';
import { listFactoryPresets } from '../../src/state/factoryPresets';

// ---------------------------------------------------------------------------------------
// Minimal hook host — renders a function component to a React element tree in Node with
// working useState/useRef/useCallback/useEffect, and re-renders on a state update so the
// asserted tree reflects the latest state. Enough for PresetPicker's hook surface only.
// ---------------------------------------------------------------------------------------

interface HookCell {
  value: unknown;
}

interface RenderHandle {
  /** The current rendered tree (refreshed after every act()). */
  tree: ReactElement;
  /** Run a mutation (a fired handler) then re-render + flush effects, like a renderer. */
  act: (fn: () => void) => void;
}

const internals = (
  React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown };
    };
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

function renderComponent<P>(Component: (props: P) => ReactElement, props: P): RenderHandle {
  const hooks: HookCell[] = [];
  const effects: Array<() => void> = [];
  let cursor = 0;
  let scheduleRerender: () => void = () => undefined;

  const dispatcher = {
    useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
      const i = cursor++;
      if (hooks[i] === undefined) {
        hooks[i] = { value: typeof initial === 'function' ? (initial as () => S)() : initial };
      }
      const cell = hooks[i]!;
      const setState = (next: S | ((prev: S) => S)) => {
        const prev = cell.value as S;
        cell.value = typeof next === 'function' ? (next as (p: S) => S)(prev) : next;
        scheduleRerender();
      };
      return [cell.value as S, setState];
    },
    useRef<T>(initial: T): { current: T } {
      const i = cursor++;
      if (hooks[i] === undefined) hooks[i] = { value: { current: initial } };
      return hooks[i]!.value as { current: T };
    },
    useCallback<T>(cb: T): T {
      const i = cursor++;
      hooks[i] = { value: cb };
      return cb;
    },
    useMemo<T>(factory: () => T): T {
      const i = cursor++;
      hooks[i] = { value: factory() };
      return hooks[i]!.value as T;
    },
    useEffect(effect: () => void): void {
      cursor++;
      effects.push(effect);
    },
    useLayoutEffect(effect: () => void): void {
      cursor++;
      effects.push(effect);
    },
  };

  let current!: ReactElement;
  const renderOnce = () => {
    cursor = 0;
    effects.length = 0;
    const prevDispatcher = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcher;
    try {
      current = Component(props);
    } finally {
      internals.ReactCurrentDispatcher.current = prevDispatcher;
    }
    for (const e of effects) e();
  };

  scheduleRerender = renderOnce;
  renderOnce();

  return {
    get tree() {
      return current;
    },
    act(fn: () => void) {
      fn();
      // a state setter already calls scheduleRerender (synchronously re-rendering); ensure
      // at least one render so handlers that set no state still flush effects.
      renderOnce();
    },
  };
}

// ---------------------------------------------------------------------------------------
// Element-tree walking by data-testid + handler firing.
// ---------------------------------------------------------------------------------------

interface ElementProps {
  [key: string]: unknown;
  children?: ReactNode;
  'data-testid'?: string;
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function childrenOf(el: ReactElement): ReactNode[] {
  const kids = (el.props as ElementProps).children;
  if (kids === undefined || kids === null) return [];
  return (Array.isArray(kids) ? kids : [kids]) as ReactNode[];
}

/** Depth-first collect every element whose data-testid === id. */
function findAllByTestId(root: ReactNode, id: string, out: ReactElement[] = []): ReactElement[] {
  if (!isElement(root)) return out;
  if ((root.props as ElementProps)['data-testid'] === id) out.push(root);
  for (const child of childrenOf(root)) findAllByTestId(child, id, out);
  return out;
}

function findByTestId(root: ReactNode, id: string): ReactElement | undefined {
  return findAllByTestId(root, id)[0];
}

/** Depth-first collect every element whose data-testid matches a prefix. */
function findByTestIdPrefix(root: ReactNode, prefix: string, out: ReactElement[] = []): ReactElement[] {
  if (!isElement(root)) return out;
  const tid = (root.props as ElementProps)['data-testid'];
  if (typeof tid === 'string' && tid.startsWith(prefix)) out.push(root);
  for (const child of childrenOf(root)) findByTestIdPrefix(child, prefix, out);
  return out;
}

/** Collect the text content under an element (string/number leaves only). */
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!isElement(node)) return '';
  return childrenOf(node).map(textOf).join('');
}

function prop<T = unknown>(el: ReactElement, name: string): T {
  return (el.props as ElementProps)[name] as T;
}

// ---------------------------------------------------------------------------------------

const FACTORY = listFactoryPresets();

function stubBridge() {
  vi.spyOn(engineBridge, 'listSlots').mockReturnValue([]);
  vi.spyOn(engineBridge, 'saveSlot').mockReturnValue(undefined);
  vi.spyOn(engineBridge, 'deleteSlot').mockReturnValue(undefined);
  vi.spyOn(engineBridge, 'loadSlot').mockResolvedValue(undefined);
  vi.spyOn(engineBridge, 'loadFactoryPreset').mockResolvedValue(undefined);
  vi.spyOn(engineBridge, 'exportSetup').mockResolvedValue(undefined);
  vi.spyOn(engineBridge, 'importSetup').mockResolvedValue({ ok: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PresetPicker', () => {
  it('renders the dialog shell with the close control', () => {
    stubBridge();
    const r = renderComponent(PresetPicker, { mode: 'browse', onClose: () => undefined });
    const root = r.tree;
    expect(prop(root, 'role')).toBe('dialog');
    expect(prop(root, 'aria-modal')).toBe('true');
    expect(findByTestId(root, 'preset-close')).toBeDefined();
  });

  it('renders a FACTORY row per listFactoryPresets() entry and loads + closes on click', () => {
    stubBridge();
    let closed = 0;
    const r = renderComponent(PresetPicker, { mode: 'browse', onClose: () => closed++ });

    const rows = findByTestIdPrefix(r.tree, 'factory-preset-');
    expect(rows.length).toBe(FACTORY.length);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // names + descriptions render
    expect(textOf(rows[0]!)).toContain(FACTORY[0]!.name);

    const target = findByTestId(r.tree, `factory-preset-${FACTORY[0]!.id}`)!;
    r.act(() => prop<() => void>(target, 'onClick')());
    expect(engineBridge.loadFactoryPreset).toHaveBeenCalledWith(FACTORY[0]!.id);
    expect(closed).toBe(1);
  });

  it('shows the empty-state when there are no saved slots', () => {
    stubBridge();
    const r = renderComponent(PresetPicker, { mode: 'browse', onClose: () => undefined });
    expect(textOf(r.tree)).toContain('No saved setups yet');
    expect(findByTestIdPrefix(r.tree, 'slot-').length).toBe(0);
  });

  it('renders saved slots and loads + closes on a slot click', () => {
    stubBridge();
    vi.spyOn(engineBridge, 'listSlots').mockReturnValue(['Alpha', 'Beta']);
    let closed = 0;
    const r = renderComponent(PresetPicker, { mode: 'browse', onClose: () => closed++ });

    // slot-{name} (the row) is distinct from slot-delete-{name} (the delete button);
    // match the row precisely.
    const alphaRow = findByTestId(r.tree, 'slot-Alpha')!;
    expect(alphaRow).toBeDefined();
    const loadBtn = childrenOf(alphaRow).find(
      (c) => isElement(c) && prop(c, 'className') === 'preset-row-main',
    ) as ReactElement;
    r.act(() => prop<() => void>(loadBtn, 'onClick')());
    expect(engineBridge.loadSlot).toHaveBeenCalledWith('Alpha');
    expect(closed).toBe(1);
  });

  it('two-step delete: first click arms (no delete), second click deletes + re-reads', () => {
    stubBridge();
    const listSlots = vi.spyOn(engineBridge, 'listSlots');
    listSlots.mockReturnValue(['Gamma']);
    const r = renderComponent(PresetPicker, { mode: 'browse', onClose: () => undefined });

    const delBtn = () => findByTestId(r.tree, 'slot-delete-Gamma')!;
    // armed state shows CONFIRM; before arming it shows DELETE.
    expect(textOf(delBtn())).toContain('DELETE');

    // first click ARMS only — deleteSlot NOT called.
    r.act(() => prop<() => void>(delBtn(), 'onClick')());
    expect(engineBridge.deleteSlot).not.toHaveBeenCalled();
    expect(textOf(delBtn())).toContain('CONFIRM');

    // after the (simulated) delete the list is empty.
    listSlots.mockReturnValue([]);
    // second click CONFIRMS — deletes + re-reads listSlots in place (overlay stays open).
    r.act(() => prop<() => void>(delBtn(), 'onClick')());
    expect(engineBridge.deleteSlot).toHaveBeenCalledWith('Gamma');
    expect(findByTestId(r.tree, 'slot-delete-Gamma')).toBeUndefined();
    expect(textOf(r.tree)).toContain('No saved setups yet');
  });

  it('SAVE: trims the name, calls saveSlot, re-reads, and reports status', () => {
    stubBridge();
    const listSlots = vi.spyOn(engineBridge, 'listSlots');
    listSlots.mockReturnValue([]);
    const r = renderComponent(PresetPicker, { mode: 'save', onClose: () => undefined });

    // type a (padded) name into the controlled input.
    const input = findByTestId(r.tree, 'preset-name-input')!;
    r.act(() =>
      prop<(e: { target: { value: string } }) => void>(input, 'onChange')({
        target: { value: '  My Setup  ' },
      }),
    );

    listSlots.mockReturnValue(['My Setup']);
    const saveBtn = findByTestId(r.tree, 'preset-save-confirm')!;
    r.act(() => prop<() => void>(saveBtn, 'onClick')());

    expect(engineBridge.saveSlot).toHaveBeenCalledWith('My Setup');
    expect(findByTestId(r.tree, 'slot-My Setup')).toBeDefined();
    expect(textOf(findByTestId(r.tree, 'preset-status')!).toLowerCase()).toContain('saved');
  });

  it('SAVE: a blank / whitespace-only name is a no-op', () => {
    stubBridge();
    const r = renderComponent(PresetPicker, { mode: 'save', onClose: () => undefined });
    const input = findByTestId(r.tree, 'preset-name-input')!;
    r.act(() =>
      prop<(e: { target: { value: string } }) => void>(input, 'onChange')({ target: { value: '   ' } }),
    );
    const saveBtn = findByTestId(r.tree, 'preset-save-confirm')!;
    r.act(() => prop<() => void>(saveBtn, 'onClick')());
    expect(engineBridge.saveSlot).not.toHaveBeenCalled();
  });

  it('EXPORT: calls exportSetup with the trimmed name (or undefined when blank)', () => {
    stubBridge();
    const r = renderComponent(PresetPicker, { mode: 'save', onClose: () => undefined });

    // blank -> undefined
    const exportBtn = () => findByTestId(r.tree, 'preset-export')!;
    r.act(() => prop<() => void>(exportBtn(), 'onClick')());
    expect(engineBridge.exportSetup).toHaveBeenLastCalledWith(undefined);

    // named -> trimmed string
    const input = findByTestId(r.tree, 'preset-name-input')!;
    r.act(() =>
      prop<(e: { target: { value: string } }) => void>(input, 'onChange')({ target: { value: ' Kit ' } }),
    );
    r.act(() => prop<() => void>(exportBtn(), 'onClick')());
    expect(engineBridge.exportSetup).toHaveBeenLastCalledWith('Kit');
  });

  it('IMPORT: a chosen file calls importSetup and renders "Imported" on ok', async () => {
    stubBridge();
    const importSetup = vi
      .spyOn(engineBridge, 'importSetup')
      .mockResolvedValue({ ok: true });
    const r = renderComponent(PresetPicker, { mode: 'save', onClose: () => undefined });

    const fakeFile = { name: 'kit.json' } as unknown as File;
    const input = findByTestId(r.tree, 'preset-import-input')!;
    const onChange = prop<(e: { target: { files: File[] } }) => void>(input, 'onChange');
    onChange({ target: { files: [fakeFile] } });
    expect(importSetup).toHaveBeenCalledWith(fakeFile);

    // let the resolved promise's .then() run, then re-render to read the status.
    await Promise.resolve();
    await Promise.resolve();
    r.act(() => undefined);
    expect(textOf(findByTestId(r.tree, 'preset-status')!).toLowerCase()).toContain('imported');
  });

  it('IMPORT: a failed import surfaces the bridge error string', async () => {
    stubBridge();
    vi.spyOn(engineBridge, 'importSetup').mockResolvedValue({
      ok: false,
      error: 'Could not read that file',
    });
    const r = renderComponent(PresetPicker, { mode: 'save', onClose: () => undefined });
    const input = findByTestId(r.tree, 'preset-import-input')!;
    const onChange = prop<(e: { target: { files: File[] } }) => void>(input, 'onChange');
    onChange({ target: { files: [{ name: 'bad.json' } as unknown as File] } });

    await Promise.resolve();
    await Promise.resolve();
    r.act(() => undefined);
    expect(textOf(findByTestId(r.tree, 'preset-status')!)).toContain('Could not read that file');
  });

  it('Esc on the overlay closes; the close button closes', () => {
    stubBridge();
    let closed = 0;
    const r = renderComponent(PresetPicker, { mode: 'browse', onClose: () => closed++ });

    const overlayKeyDown = prop<(e: { key: string; preventDefault: () => void }) => void>(
      r.tree,
      'onKeyDown',
    );
    overlayKeyDown({ key: 'Escape', preventDefault: () => undefined });
    expect(closed).toBe(1);

    // a non-Escape key does not close.
    overlayKeyDown({ key: 'a', preventDefault: () => undefined });
    expect(closed).toBe(1);

    const closeBtn = findByTestId(r.tree, 'preset-close')!;
    r.act(() => prop<() => void>(closeBtn, 'onClick')());
    expect(closed).toBe(2);
  });

  it('a backdrop click closes; an inside-card click stops propagation (does not close)', () => {
    stubBridge();
    let closed = 0;
    const r = renderComponent(PresetPicker, { mode: 'browse', onClose: () => closed++ });

    // overlay onClick === onClose
    const overlayClick = prop<() => void>(r.tree, 'onClick');
    overlayClick();
    expect(closed).toBe(1);

    // the card's onClick stops propagation (and is NOT onClose).
    const card = childrenOf(r.tree).find(
      (c) => isElement(c) && prop(c, 'className') === 'preset-card',
    ) as ReactElement;
    let stopped = false;
    prop<(e: { stopPropagation: () => void }) => void>(card, 'onClick')({
      stopPropagation: () => {
        stopped = true;
      },
    });
    expect(stopped).toBe(true);
    expect(closed).toBe(1); // unchanged — inside click did not close
  });
});
