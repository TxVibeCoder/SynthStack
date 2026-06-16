# SynthStack

SynthStack is a local, browser-based modular synthesizer. Everything runs client-side in
your browser — no account, no cloud, no audio leaves your machine. It bundles three
analog-style synth voices, an 8-pad sampler with a step drum machine, an on-screen
keyboard with Web MIDI input, and a virtual patchbay that lets you wire the whole rack
together and record the result.

The synthesis is **analog-style and behaviorally inspired** — the voices aim to *sound and
behave* like classic analog hardware, not to be circuit-accurate emulations.

## What's inside

- **Monarch** — a monophonic synth voice with a 32-step sequencer and a patchbay for
  routing modulation and control signals.
- **Anvil** — a percussion synth voice driven by its own 8-step sequencer.
- **Cascade** — a subharmonic, polyrhythmic synth voice.
- **Sampler** — eight assignable sample pads (4×2) with per-pad level and tune.
- **Drum machine** — a TR-style step sequencer that triggers the eight sampler pads.
- **Keyboard** — an on-screen virtual piano with **Web MIDI** input for live playing.
- **Patchbay** — drag patchable virtual cables between any modules; all signals are summed
  through a software mixer.
- **Recording** — capture the master output to a downloadable audio file.
- **Presets** — save and load full setups, including factory and user presets.

Every patchable signal — audio, gates, and control voltages alike — is a real cable you can
drag, and the whole rack sums through one mixer to the master output.

## Requirements

- **Node.js 20 or newer**
- A modern Chromium-based browser. **Chrome or Edge is the reference browser** — SynthStack
  relies on the Web Audio API, AudioWorklets, and (optionally) Web MIDI, which are most
  reliably supported there.

## Running it

### Windows

Double-click **`start-windows.bat`**. On first run it installs dependencies and builds the
app, then serves it locally and opens your browser automatically.

### macOS

Double-click **`start-mac.command`**. The first time you launch it, macOS Gatekeeper will
block it — **right-click the file and choose Open**, then confirm. After that, a normal
double-click works. Like the Windows launcher, it installs, builds, serves, and opens your
browser on first run.

### Development

```bash
npm install
npm run dev
```

This starts the Vite dev server with hot reloading for local development.

### Production build

```bash
npm run build
```

This produces a static bundle in `dist/`.

### Tests

```bash
npm test           # unit tests (pure logic + DSP cores, run in Node)
npm run test:e2e   # end-to-end browser tests
npm run test:audio # audio battery (renders real audio graphs and checks output)
```

## Serving the production build

The `dist/` directory is **100% static** and can be served by any static file server.

> **Important:** never open `dist/index.html` directly via `file://`. Browsers refuse to
> load ES modules and AudioWorklets over the `file://` protocol, so the app will not run.
> Always serve `dist/` over HTTP (for example with `npm run preview`, or any static web
> server of your choice).
