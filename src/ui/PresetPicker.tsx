/**
 * Preset-picker overlay (PRESETS + SAVE). A modal rendered as
 * plain HTML (NOT SVG): it is window chrome and must live OUTSIDE the transform:
 * scale <main>, so it is screen-pixel sized rather than stage-scaled (App
 * mounts it as a sibling of the scaled stage). Opened from the utility strip's
 * two now-live caps; `mode` only decides the initial focus / emphasis:
 *
 *   'browse'  -> opened from PRESETS (focus the card so Esc has a target)
 *   'save'    -> opened from SAVE    (autofocus the name input)
 *
 * The overlay talks ONLY to engineBridge (the single React→engine seam) plus the
 * static listFactoryPresets() read (imported directly from factoryPresets — it is
 * compile-time data, not a bridge round-trip). Three sections:
 *
 *   A FACTORY     — the 4 curated recipes; click loads one and closes.
 *   B YOUR SETUPS — localStorage slots (engineBridge.listSlots()); click loads +
 *                   closes; an inline two-step-confirm delete (NO window.confirm,
 *                   mirroring the INIT double-click safety) removes a slot in place.
 *   C SAVE/SHARE  — name a slot + SAVE; EXPORT the portable .json; IMPORT a .json.
 *
 * Slots live in localStorage, NOT the store, so useSyncExternalStore would never
 * fire for them — we hold a local `slots` array and re-read listSlots() manually
 * after every save / delete / import. Loads route through the bridge (which drives
 * the store + engine), so the stage panels update reactively with no extra wiring;
 * we just close after a load. Status text ("Saved" / "Imported" / an error) renders
 * inline (no window.alert); importSetup resolves {ok,error?} so the UI never sees a
 * raw throw.
 *
 * The hidden-file-input idiom (input.value='' BEFORE click, or re-importing the
 * same file no-ops onChange) is copied verbatim from SamplerPanel.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { engineBridge } from './engineBridge';
import { listFactoryPresets } from '../state/factoryPresets';

export interface PresetPickerProps {
  mode: 'browse' | 'save';
  onClose: () => void;
}

/** Static factory list (compile-time data — no bridge round-trip). */
const FACTORY = listFactoryPresets();

export function PresetPicker({ mode, onClose }: PresetPickerProps) {
  const [slots, setSlots] = useState<string[]>(() => engineBridge.listSlots());
  const [name, setName] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  /** Slot name currently armed for delete (first click arms, second confirms). */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Re-read the localStorage-backed slot list (no external-store subscription fires).
  const refreshSlots = useCallback(() => {
    setSlots(engineBridge.listSlots());
  }, []);

  // mode='save' -> autofocus the name input; mode='browse' -> focus the card so Esc
  // has a keyboard target. Runs once on mount.
  useEffect(() => {
    if (mode === 'save') nameInputRef.current?.focus();
    else cardRef.current?.focus();
  }, [mode]);

  // ---- factory ---------------------------------------------------------------------------

  const onLoadFactory = useCallback(
    (id: string) => {
      void engineBridge.loadFactoryPreset(id);
      onClose();
    },
    [onClose],
  );

  // ---- slots -----------------------------------------------------------------------------

  const onLoadSlot = useCallback(
    (slotName: string) => {
      void engineBridge.loadSlot(slotName);
      onClose();
    },
    [onClose],
  );

  // Export a SAVED slot (not the live setup) as a portable .json bundle — embeds the slot's
  // referenced user-sample bytes via the same export codec EXPORT uses. Fire-and-forget like the
  // other bridge actions; the bridge is no-throw on an absent/corrupt slot.
  const onBundleSlot = useCallback((slotName: string) => {
    void engineBridge.exportSlot(slotName);
    setStatus(`Bundled "${slotName}"`);
  }, []);

  const onDeleteSlot = useCallback(
    (slotName: string) => {
      if (confirmDelete === slotName) {
        engineBridge.deleteSlot(slotName);
        setConfirmDelete(null);
        setStatus(null);
        refreshSlots();
      } else {
        // First click only arms the confirm for THIS row.
        setConfirmDelete(slotName);
      }
    },
    [confirmDelete, refreshSlots],
  );

  // ---- save / export / import ------------------------------------------------------------

  const onSave = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    engineBridge.saveSlot(trimmed);
    refreshSlots();
    setStatus(`Saved "${trimmed}"`);
  }, [name, refreshSlots]);

  const onExport = useCallback(() => {
    void engineBridge.exportSetup(name.trim() || undefined);
    setStatus('Exported');
  }, [name]);

  const onImportClick = useCallback(() => {
    const input = fileInputRef.current;
    if (!input) return;
    input.value = ''; // re-importing the same file no-ops onChange otherwise
    input.click();
  }, []);

  const onImportChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      void engineBridge.importSetup(file).then((r) => {
        if (r.ok) {
          setStatus('Imported');
          refreshSlots();
        } else {
          setStatus(r.error ?? 'Import failed');
        }
      });
    },
    [refreshSlots],
  );

  // ---- overlay chrome --------------------------------------------------------------------

  const onOverlayKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  // Clicks on the backdrop (outside the card) close; clicks inside the card do not.
  const onCardClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
  }, []);

  return (
    <div
      className="preset-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Presets and save"
      onClick={onClose}
      onKeyDown={onOverlayKeyDown}
    >
      <div
        ref={cardRef}
        className="preset-card"
        tabIndex={-1}
        onClick={onCardClick}
      >
        <div className="preset-card-head">
          <h2 className="preset-title">PRESETS</h2>
          <button
            type="button"
            className="preset-x"
            aria-label="Close presets"
            data-testid="preset-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* SECTION A — FACTORY */}
        <section className="preset-section">
          <h3 className="preset-section-title">FACTORY</h3>
          <ul className="preset-list">
            {FACTORY.map((p) => (
              <li key={p.id} className="preset-row">
                <button
                  type="button"
                  className="preset-row-main"
                  data-testid={`factory-preset-${p.id}`}
                  onClick={() => onLoadFactory(p.id)}
                >
                  <span className="preset-row-name">{p.name}</span>
                  <span className="preset-row-desc">{p.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* SECTION B — YOUR SETUPS */}
        <section className="preset-section">
          <h3 className="preset-section-title">YOUR SETUPS</h3>
          {slots.length === 0 ? (
            <p className="preset-empty">No saved setups yet</p>
          ) : (
            <ul className="preset-list">
              {slots.map((slotName) => (
                <li key={slotName} className="preset-row" data-testid={`slot-${slotName}`}>
                  <button
                    type="button"
                    className="preset-row-main"
                    onClick={() => onLoadSlot(slotName)}
                  >
                    <span className="preset-row-name">{slotName}</span>
                  </button>
                  <button
                    type="button"
                    className="preset-del"
                    aria-label={`Export ${slotName} as bundle`}
                    data-testid={`slot-bundle-${slotName}`}
                    onClick={() => onBundleSlot(slotName)}
                  >
                    BUNDLE
                  </button>
                  <button
                    type="button"
                    className={
                      confirmDelete === slotName ? 'preset-del preset-del--armed' : 'preset-del'
                    }
                    aria-label={
                      confirmDelete === slotName
                        ? `Confirm delete ${slotName}`
                        : `Delete ${slotName}`
                    }
                    data-testid={`slot-delete-${slotName}`}
                    onClick={() => onDeleteSlot(slotName)}
                  >
                    {confirmDelete === slotName ? 'CONFIRM' : 'DELETE'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* SECTION C — SAVE / SHARE */}
        <section className="preset-section">
          <h3 className="preset-section-title">SAVE / SHARE</h3>
          <div className="preset-save-row">
            <input
              ref={nameInputRef}
              type="text"
              className="preset-input"
              placeholder="Name this setup"
              aria-label="Name this setup"
              data-testid="preset-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              className="preset-btn"
              data-testid="preset-save-confirm"
              onClick={onSave}
            >
              SAVE
            </button>
            <button
              type="button"
              className="preset-btn"
              data-testid="preset-export"
              onClick={onExport}
            >
              EXPORT
            </button>
            <button
              type="button"
              className="preset-btn"
              data-testid="preset-import"
              onClick={onImportClick}
            >
              IMPORT
            </button>
          </div>
          {/* hidden file input (SamplerPanel idiom — value='' set before click) */}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            data-testid="preset-import-input"
            style={{ display: 'none' }}
            onChange={onImportChange}
          />
          <p className="preset-status" data-testid="preset-status" aria-live="polite">
            {status ?? ''}
          </p>
        </section>
      </div>
    </div>
  );
}
