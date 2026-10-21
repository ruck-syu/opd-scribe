# OPD Scribe

Offline oncology OPD documentation for a single clinic laptop. The doctor records or dictates a
consultation, reviews the transcript, fills the structured note, and prints or saves a PDF only after
verifying it. Everything runs on the machine: no server, no telemetry, no auto-update, and no network
code in the shipped app.

**Stack:** Electron + React + TypeScript (electron-vite), `sql.js` with AES-256-GCM, Electron
`safeStorage`, whisper.cpp (`whisper-cli`) as a local speech sidecar, Chromium `printToPDF` + `pdf-lib`
for PDFs.

## Features

- Patient records and visits, with a structured oncology note and prescription.
- Consent-gated recording and dictation, transcribed locally; transcripts are reviewed before use.
- Review flags that block verification (incomplete prescriptions, missing identity) or need an
  acknowledgement (uncertain speech, unlabelled speakers, medicines outside the clinic formulary).
  Acknowledgements are tied to the flagged content, so editing it raises the warning again.
- Speech the transcriber missed is marked as `[untranscribed audio mm:ss-mm:ss]`, never dropped silently.
- PIN-verified, revision-locked output; amendments create a new revision.
- Built-in print layout with letterhead and calibration, or the clinic's own OPD format from an uploaded
  sample.
- Encrypted backup and restore, and an in-app audit log.

## Hard guardrails

These are product rules, not preferences. Keep them intact when changing code.

- **Offline only.** The renderer may load only local files; outbound network requests are blocked in
  the main process. Speech recognition runs in a local process; audio is never uploaded.
- **Never invents clinical content and never computes a dose.** Compilation is deterministic and
  source-based. Suggestions are shown as suggestions and require review. The app does not calculate
  doses, frequencies, or cycles.
- **"Not assessed" is never shown as "absent".** Symptoms and toxicities are tri-state
  (`present` / `absent` / `not_assessed`, default *not assessed*). Empty fields render as
  "Not documented", never as a negative finding.
- **Printing or exporting a clinical document requires doctor verification.** A doctor re-enters their
  PIN, resolves blocking flags, acknowledges warnings, and verifies the current content. The export gate
  then checks that the content hash still matches the verified revision; editing after verification
  revokes export.
- **Flag, don't auto-correct.** Suspicious speech and unknown medicine names are flagged for the doctor;
  text is never rewritten or silently deleted.
- **Data is encrypted at rest.** The database, retained audio, the letterhead, and uploaded print-format
  samples are encrypted with AES-256-GCM. The data key is wrapped by the OS keystore through Electron
  `safeStorage` (DPAPI on Windows, Keychain on macOS). The only short-lived exception is the plain WAV
  that `whisper-cli` reads from `tmp/` while a transcription runs; it is deleted when the run ends.
- **No PHI in logs.** IPC failures log only the channel and error class, never arguments. The audit log
  records actions, IDs, and counts, not clinical text.
- **Audio is deleted after review by default.** Once a transcript is marked reviewed, its audio file is
  removed unless "Keep raw audio" is enabled in Settings.

## Requirements

- Windows 10/11 x64 on the clinic laptop (developed on macOS, which also runs the app).
- Node.js 22 or newer for development (a practical minimum; `package.json` has no `engines` field).
- About 500 MB for the app plus roughly 550 MB for the baseline speech model, and 1-1.5 GB of RAM for a
  quantised model; 16 GB total is the target.
- A microphone the doctor is comfortable speaking into.

## Development

```bash
npm install
npm run dev
```

If your macOS shell exports `ELECTRON_RUN_AS_NODE=1` (some editors do), Electron starts as plain Node and
the window never opens. Launch with `env -u ELECTRON_RUN_AS_NODE npm run dev`.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit and integration tests (vitest) |
| `npm run build` | Compile to `out/` without packaging |
| `npm run icons` | Regenerate `build/icon.png` and `icon.ico` from `build/icon.svg` |
| `npm run dist:win` | Windows NSIS installer in `release/` |
| `npm run dist:mac` | macOS DMG (development only; not the clinic target) |

## Windows installer

`npm run dist:win` runs `electron-vite build` and then `electron-builder --win --x64`. The installer
(for example `release/OPD Scribe Setup 0.1.0.exe`) is per-user, lets the user choose the install
directory, and creates a desktop shortcut.

It is **unsigned**, so Windows SmartScreen warns on first launch: choose **More info -> Run anyway**. If
you distribute the file, publish a SHA-256 checksum alongside it.

Speech files are bundled only if present in `resources/whisper/` at build time; otherwise install them
after setup as described in [docs/SPEECH_MODEL.md](docs/SPEECH_MODEL.md). Models are gitignored.

## Project layout

- `src/main/` - Electron main process: window and IPC allow-list, encrypted store, speech runner,
  verification/export gate, PDF composition, backup.
- `src/preload/` - the typed, context-isolated bridge exposed to the renderer.
- `src/renderer/` - React UI: patients, visits, conversation/transcript review, note and prescription
  editors, verification, settings.
- `src/shared/` - shared domain types, defaults, review flags, print/format templates, and pure helpers
  used by both sides.

## Documentation

- [docs/CLINIC_GUIDE.md](docs/CLINIC_GUIDE.md) - first-run setup, recording consent, where data lives, backup and recovery.
- [docs/SPEECH_MODEL.md](docs/SPEECH_MODEL.md) - whisper.cpp, the Windows Vulkan build, and the speech models.
- [ROADMAP.md](ROADMAP.md) - delivery plan, clinical safety rules, and speech-engine decisions.
- [docs/TASKS.md](docs/TASKS.md) - open tasks and what has been refined.

## Status and limitations

This is an MVP. The Windows installer is unsigned, there is no sync or network integration, and there
is no automatic update path. Speech accuracy depends on the model, microphone, and room; the app flags
suspicious segments but never rewrites or silently deletes them. Every clinical field still needs the
doctor's review, and the app is not a substitute for clinical judgement.
