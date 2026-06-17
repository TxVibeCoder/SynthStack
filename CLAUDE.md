# CLAUDE.md — SynthStack conventions

Browser modular synth: Monarch/Anvil/Cascade voices + an 8-pad sampler/drum machine + on-screen keyboard/MIDI (with Monarch step-record) + patchable cables + a software mixer + master effects (flanger/delay/reverb). A ribbon GUIDE button opens an in-app Patchbook (patchbay how-to, sound recipes, glossary) in its own window from `public/guide.html`.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — typecheck + production build
- `npm run preview` — serve the built app locally
- `npm test` — Vitest unit suite
- `npm run typecheck` — `tsc -b`
- `npm run test:e2e` — Playwright end-to-end suites
- `npm run test:audio` — browser audio battery against real OfflineAudioContext graphs

## Conventions

- **vv ("virtual volts") everywhere.** All signal units are virtual volts; conversion to Hz/seconds/gain is centralized in `src/engine/units.ts` — the only place vv is converted.
- **CV is audio — one router.** Every patchable signal is an audio-rate connection routed through a single router.
- **Pure cores + thin shells.** DSP lives in `src/engine/dsp/*Core.ts` (no Web Audio types, fully unit-tested in Node); AudioWorklet wrappers are thin shells that only marshal buffers/params.
- **Sequencer/clock engines are pure state machines** in `src/engine/sequencers/`; only the scheduler binding touches `AudioContext.currentTime`.
- **No allocations or logging inside worklet `process()`** — preallocate in constructors.
- **Never `setInterval`/`setTimeout` for audio events** — lookahead scheduler only.
- **Single serializable state tree** in `src/state/studioState.ts`; the `getState`/`setState` JSON round-trip is enforced by tests.
