# OPD Scribe — open tasks (post-MVP)

Status: MVP built, `release/OPD Scribe Setup 0.1.0.exe` produced. Typecheck clean, 58/58 tests, E2E smoke + custom-format E2E passed on macOS.

## Needs the user / the Ryzen laptop
- [ ] Install `release/OPD Scribe Setup 0.1.0.exe` on the Ryzen laptop (unsigned → SmartScreen: "More info → Run anyway").
- [ ] Real speech: put Vulkan `whisper-cli.exe` + DLLs and a `ggml-*.bin` model in `%APPDATA%\OPD Scribe\whisper\` (auto-detected) or set paths in Settings › Speech engine. Test a real Hindi/English recording + Windows mic permission.
- [ ] Letterhead calibration print on real paper (Settings › Print › Save & test print).

## Features
- [x] **Use the clinic's own OPD format from an uploaded sample.** Settings › OPD print format: upload a blank/sample PDF, PNG or JPG, place fixed fields (name, UHID, date…) and the content areas on it, order/rename/hide sections, preview with a sample patient, save. Content is still rendered from structured data; hidden sections that have content still print; verified revisions keep the format they were verified with.
  - [ ] Print a custom-format prescription on the clinic's real pre-printed paper and check alignment.

## Docs / housekeeping
- [x] `docs/SPEECH_MODEL.md`: Windows whisper.cpp Vulkan build, Apex → ggml conversion, large-v3-turbo fallback.
- [x] README: run / build / install.
- [ ] App icon.
- [x] Rebuild the Windows installer with the custom print format.
- [x] `git init` + first commit.

## Optional hardening
- [ ] Services integration test using `Store.memory()` + a fake Platform.
- [ ] Reset `acknowledgedFlags` when the flagged content changes.
