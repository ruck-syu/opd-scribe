# OPD Scribe

Offline documentation assistant for a single-clinic outpatient workflow. It helps a doctor capture a
consultation, review it, and produce a printable record. Everything runs locally on the clinic laptop.

**Stack:** Electron, React, TypeScript, local speech recognition (whisper.cpp), encrypted local storage.

## Development

```bash
npm install
npm run dev
```

If your macOS shell exports `ELECTRON_RUN_AS_NODE=1` (some editors do), launch with
`env -u ELECTRON_RUN_AS_NODE npm run dev`.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript check |
| `npm test` | Tests (vitest) |
| `npm run build` | Compile to `out/` |
| `npm run icons` | Regenerate app icons from `build/icon.svg` |
| `npm run dist:win` | Windows installer in `release/` (unsigned) |
| `npm run dist:mac` | macOS DMG (development only) |

Requires Node.js 22 or newer.

## Documentation

- [docs/CLINIC_GUIDE.md](docs/CLINIC_GUIDE.md) - setup, data location, backup and recovery.
- [docs/SPEECH_MODEL.md](docs/SPEECH_MODEL.md) - installing the speech engine and models.
- [docs/AI_EXTRACTION.md](docs/AI_EXTRACTION.md) - optional local AI suggestions, installing the model.
- [ROADMAP.md](ROADMAP.md) - plan and design rules.
- [docs/TASKS.md](docs/TASKS.md) - open tasks.

## Status

MVP. Not a substitute for clinical judgement; every clinical field needs the doctor's review.
