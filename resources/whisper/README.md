# Not packaged

The installer does not read this folder. The speech and AI engines are fetched by
`npm run engines -- --platform win --arch x64` (or `mac --arch arm64` / `mac --arch x64`) into
`resources/engines/<os>-<arch>/`, and electron-builder copies them into the app as `engines/`.
See `docs/SPEECH_MODEL.md`. Model files (`ggml-*.bin`, `*.gguf`) are not bundled.
