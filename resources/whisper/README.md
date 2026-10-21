# Speech engine files (not committed)

The app transcribes offline with [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
Put the files here (or anywhere, and set the paths in **Settings → Speech engine**):

- `whisper-cli` (macOS) / `whisper-cli.exe` (Windows) and the DLLs it ships with.
  For the Ryzen laptop use a **Vulkan** build so the Radeon iGPU is used.
- A ggml model file, e.g. `ggml-apex-q5_0.bin` (see `docs/SPEECH_MODEL.md`).
