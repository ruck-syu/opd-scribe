# OPD Scribe — open tasks (post-MVP)

Status: MVP built, `release/OPD Scribe Setup 0.1.0.exe` produced. Typecheck clean, 39/39 tests, E2E smoke passed on macOS.

## Needs the user / the Ryzen laptop
- [ ] Install `release/OPD Scribe Setup 0.1.0.exe` on the Ryzen laptop (unsigned → SmartScreen: "More info → Run anyway").
- [ ] Real speech: put Vulkan `whisper-cli.exe` + DLLs and a `ggml-*.bin` model in `%APPDATA%\OPD Scribe\whisper\` (auto-detected) or set paths in Settings › Speech engine. Test a real Hindi/English recording + Windows mic permission.
- [ ] Letterhead calibration print on real paper (Settings › Print › Save & test print).

## Features
- [ ] **Use the clinic's own OPD format from an uploaded sample PDF.** Today only the letterhead is reproduced exactly (page background + margin/offset calibration); the note/prescription body (section order, headings, styling) comes from the fixed templates in `src/shared/pdfTemplates.ts`. Goal: the doctor uploads an existing OPD note/prescription PDF once and output follows that exact format.
  - Proposed approach: upload sample → render it in a template editor (pdfjs) → doctor draws/maps regions to fields/sections (patient name, date, history, vitals, Rx table, advice, follow-up, signature…) → save as a versioned template → render content into those regions with pdf-lib, with overflow continuing on extra pages ("continued").
  - Simpler fallback: configurable section order, headings, visibility and fonts per document, picked to match the sample.
  - Guardrails stay: unmapped/empty fields print "Not documented", nothing is dropped silently, verified revisions keep the template version they were rendered with.

## Docs / housekeeping
- [ ] `docs/SPEECH_MODEL.md`: Windows whisper.cpp Vulkan build, Apex → ggml conversion, large-v3-turbo fallback.
- [ ] README: run / build / install.
- [ ] App icon.
- [ ] `git init` + first commit.

## Optional hardening
- [ ] Services integration test using `Store.memory()` + a fake Platform.
- [ ] Reset `acknowledgedFlags` when the flagged content changes.
