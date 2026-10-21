# OPD Scribe

Offline oncology OPD documentation for a single clinic laptop. The doctor records or dictates a
consultation, reviews the transcript, fills the structured note, and prints or saves a PDF only after
verifying it. Everything runs on the machine: no server, no telemetry, no auto-update, and no network
code in the shipped app.

Stack: Electron + React + TypeScript (electron-vite), `sql.js` with AES-256-GCM, Electron
`safeStorage`, whisper.cpp (`whisper-cli`) as a local speech sidecar, Chromium `printToPDF` + `pdf-lib`
for PDFs.

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
- **Data is encrypted at rest.** The database, retained audio, the letterhead, and uploaded print-format
  samples are encrypted with AES-256-GCM. The data key is wrapped by the OS keystore through Electron
  `safeStorage` (DPAPI on Windows, Keychain on macOS). The only short-lived exception is the plain WAV
  that `whisper-cli` reads from `tmp/` while a transcription runs; it is deleted when the run ends.
- **No PHI in logs.** IPC failures log only the channel and error class, never arguments. The audit log
  records actions, IDs, and counts, not clinical text.
- **Audio is deleted after review by default.** Once a transcript is marked reviewed, its audio file is
  removed unless "Keep raw audio" is enabled in Settings.

## Requirements

- Windows 10/11 x64 on the clinic laptop (developed on macOS).
- Node.js 22 or newer for development. `package.json` has no `engines` field, so this is a practical
  minimum, not an enforced one.
- Allow about 500 MB for the app (the installer itself is around 120 MB), plus roughly 550 MB for the
  baseline speech model. Allow 1-1.5 GB of RAM for a quantised model; 16 GB total is the target.
- A microphone the doctor is comfortable speaking into.

## Install and run (development)

```bash
cd /path/to/opd
npm install
npm run dev
```

`npm run dev` starts electron-vite with the renderer dev server. If your macOS shell exports
`ELECTRON_RUN_AS_NODE=1` (some editors do), Electron starts as plain Node and the window never opens.
Launch with:

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev
```

Checks:

```bash
npm run typecheck
npm test
```

`npm run build` produces the compiled app in `out/` without packaging an installer.

## Build the Windows installer (from a Mac)

```bash
npm run dist:win
```

This runs `electron-vite build` and then `electron-builder --win --x64`. The NSIS installer is written to
`release/` (for example `release/OPD Scribe Setup 0.1.0.exe`). It is per-user, lets the user choose the
install directory, and creates a desktop shortcut.

The installer is **unsigned**, so Windows SmartScreen will warn on first launch: choose
**More info -> Run anyway**. If you distribute the file, publish a SHA-256 checksum alongside it so the
clinic can confirm it was not altered.

Speech files are only bundled if they are present in `resources/whisper/` at build time
(electron-builder copies that folder as an extra resource). Otherwise install them after setup as
described in [docs/SPEECH_MODEL.md](docs/SPEECH_MODEL.md). Models are gitignored.

`npm run dist:mac` builds a DMG for development on macOS; macOS is not the clinic target.

## First run on the clinic laptop

1. Install and launch the app. Windows may ask for microphone access; allow it (see the troubleshooting
   section in `docs/SPEECH_MODEL.md`).
2. Complete the setup wizard: clinic name and address, then the doctor's name, qualifications,
   registration number, and a 4-8 digit PIN. This first doctor is the administrator and can verify
   visits and change settings.
3. Open **Settings** (visible to doctors) and walk through the sections:
   - **Clinic & checklists** - clinic name/address/footer, toxicity and symptom checklists (one item per
     line; every item starts as *Not assessed*), auto-lock minutes, and audio retention.
   - **Letterhead & printing** - upload the printed letterhead as PDF, PNG, or JPG; set content margins
     and X/Y calibration offsets; choose letterhead on every page or first page only, and one combined
     PDF or two files. Use **Save & test print** and print the calibration page at 100% on the real
     letterhead paper before the first clinic day.
   - **OPD print format (custom format)** - the new feature: upload one of the clinic's existing note or
     prescription samples (PDF, PNG, or JPG), then map patient fields and section blocks so output follows
     that format. Preview it, then save. If no custom format is saved, the built-in format is used. Empty
     or unmapped fields still print "Not documented"; verified revisions keep the format version they were
     rendered with.
   - **Speech recognition** - paths for `whisper-cli` and a `ggml-*.bin` model, language, CPU threads, and
     a vocabulary hint. Press **Check** to confirm both files are found.
   - **Users** - add Staff accounts for registration and drafting, and additional Doctor accounts. Each
     user gets a PIN. Doctors can reset PINs and deactivate users.
   - **Backup & restore** - create a passphrase-encrypted `.opdbackup` file and restore from one.
   - **Audit log** - the latest 300 actions (logins, patient and summary changes, verification, export,
     backup, settings).
4. Set up speech following [docs/SPEECH_MODEL.md](docs/SPEECH_MODEL.md), then record a short test.
5. Create the first encrypted backup and store it on a USB drive kept away from the laptop.

## Where the data lives

Electron's `userData` folder is `%APPDATA%\OPD Scribe` on Windows (typically
`C:\Users\<user>\AppData\Roaming\OPD Scribe`). On macOS it is
`~/Library/Application Support/OPD Scribe`.

```text
%APPDATA%\OPD Scribe\
  opd.db.enc      encrypted SQLite database (patients, visits, revisions, audit, settings, blobs)
  data.key        data key, encrypted with Windows DPAPI via Electron safeStorage
  audio\          one encrypted WAV per transcript; deleted after review unless retention is on
  tmp\            scratch files for speech recognition; recreated at startup
  whisper\        optional whisper-cli.exe + DLLs + ggml model (not patient data)
```

The database file is the whole encrypted database, not a plain SQLite file. Copying it without
`data.key` and the same Windows profile is not enough to read it.

## Backup and recovery

- Use **Settings > Backup & restore**. The passphrase must be at least 8 characters; without it the
  backup cannot be opened. The file contains the database and any retained audio.
- Restoring **replaces all data on the computer** and signs the user out. Restore is intended for a
  replacement laptop or disaster recovery, not for merging two machines.
- `data.key` is tied to the Windows user profile. Losing or recreating that profile (or deleting
  `data.key`) makes the existing database unreadable even if the files are still there. Encrypted
  backups are the recovery path, so take them regularly and test a restore before relying on them.
- Keep backups offline (USB drive in a locked drawer). Enable BitLocker/device encryption on the
  laptop, and keep the backup passphrase somewhere separate from the drive.
- The audit log is append-only inside the app; it is not a substitute for backups.

## Project layout

- `src/main/` - Electron main process: window and IPC allow-list, encrypted store, speech runner,
  verification/export gate, PDF composition, backup.
- `src/preload/` - the typed, context-isolated bridge exposed to the renderer.
- `src/renderer/` - React UI: patients, visits, conversation/transcript review, note and prescription
  editors, verification, settings.
- `src/shared/` - shared domain types, defaults, review flags, print/format templates, and pure helpers
  used by both sides.

## Documentation

- [docs/SPEECH_MODEL.md](docs/SPEECH_MODEL.md) - installing whisper.cpp, the Windows Vulkan build, and
  the speech models on the clinic laptop.
- [ROADMAP.md](ROADMAP.md) - delivery plan, clinical safety rules, and speech-engine decisions.
- [docs/TASKS.md](docs/TASKS.md) - current open tasks and the custom OPD-format feature notes.

## Status and limitations

This is an MVP. The Windows installer is unsigned, there is no sync or network integration, and there
is no automatic update path. Speech accuracy depends on the model, microphone, and room; the app flags
suspicious segments but never rewrites or silently deletes them. Every clinical field still needs the
doctor's review, and the app is not a substitute for clinical judgement.
