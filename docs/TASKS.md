# OPD Scribe — open tasks (post-MVP)

Status: MVP built, `release/OPD Scribe Setup 0.1.0.exe` produced. Typecheck clean, 96/96 tests, E2E smoke, custom-format, ASR-coverage, consent and PDF stress E2E passed on macOS.

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
- [x] App icon (`build/icon.svg` is the source; regenerate PNG/ICO with `npm run icons`).
- [x] Rebuild the Windows installer with the custom print format.
- [x] `git init` + first commit.

- [ ] Rebuild the Windows installer (the refinements below landed after the last build).

## Refinements (done)
- [x] Services integration test using `Store.memory()` + a fake Platform (verify / export / amendment gates).
- [x] Acknowledgements are bound to the flagged content (`ackKey`); editing it re-raises the warning. Drafts acknowledged before this change need re-acknowledging.
- [x] Speech coverage: audio with detected speech but no transcript is inserted as an `[untranscribed audio mm:ss–mm:ss]` segment with a warning.
- [x] Clinic formulary (Settings › Clinic): medications not in it are flagged with the closest entry; nothing is auto-corrected.
- [x] Recording consent: consultation recording requires an audited consent confirmation, enforced in the service.
- [x] Microphone unplugged mid-recording: stops, keeps and submits what was captured.
- [x] PDF stress test (25 medications, 14-paragraph HPI, Indic scripts, unbroken tokens): no text lost. Fixed: long tokens shrank the whole page; page stamp wrapped below the margin and turned accented names into `?`.

## Record-first workflow
- [x] Rule-based suggestions from the transcript (vitals, ECOG, cycle/day, regimen, checklist findings, formulary medicines, note sections), each with its verbatim quote; anything not backed by the quote is rejected and listed, never applied.
- [x] Suggestion review panel: accept / dismiss, accept-all for rows without warnings, never overwrites a field, "Not mentioned — fill manually" list; pending suggestions are a review warning.
- [x] P0 flags: ambiguous medication numbers, relative dates, mixed laterality, finding/text contradictions, double negatives, transcript contradictions; clinic-required sections (Settings › Clinic).
- [ ] Local LLM extractor (llama.cpp sidecar, one-time model download) behind the same quote gate, for history, assessment and full prescription lines.
- [ ] "Today's patients" list for one-click start.
- [ ] Laterality check against the oncology summary (needs the summary passed into the flag check).

## Later
- [ ] Chunked live transcription during the visit (today: transcribe after stopping).
- [ ] Speaker diarisation (today: segments are unlabelled until the doctor labels them).
- [ ] Schema migration test harness for future `VisitDocument` versions.
- [ ] "Insert all into HPI" also copies `[untranscribed audio …]` markers; the doctor deletes them by hand.
