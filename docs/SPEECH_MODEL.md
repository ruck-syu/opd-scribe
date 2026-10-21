# Speech recognition on the clinic laptop

OPD Scribe transcribes with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running as a local
`whisper-cli` process. No audio leaves the computer and no network port is opened. This guide covers the
Windows target (Ryzen CPU, 16 GB RAM, integrated Radeon GPU); the same files work on macOS with the
Mac binary.

Two independent pieces are needed:

1. `whisper-cli.exe` plus the DLLs that ship with it (the engine).
2. A `ggml-*.bin` model (the weights, including the multilingual tokenizer).

## How the app finds the engine

`Settings > Speech recognition` has explicit paths for both files. If a path is empty, the main process
fills it from these folders, in this order:

1. `%APPDATA%\OPD Scribe\whisper\` (Electron `userData`)
2. The bundled `resources\whisper\` folder (in a packaged build, next to the app's resources)

Auto-discovery is deliberately simple:

- It looks for a file named exactly `whisper-cli.exe` (or `whisper-cli` on macOS) at the **top level** of
  those folders. It does not recurse into subfolders.
- It picks the **first** file matching `ggml-*.bin` in that folder. If several models are present, the
  choice depends on directory order - keep one model in the auto-detected folder, or set the model path
  explicitly.
- Auto-discovery only fills empty paths. An explicitly configured but wrong path is not silently
  replaced.

After saving, press **Check**. It reports either `Speech engine ready — model <name>` or one of:

- `whisper-cli executable not found — set it in Settings › Speech engine`
- `Speech model (ggml .bin) not found — set it in Settings › Speech engine`

The error text uses the older name "Speech engine"; the tab itself is labelled **Speech recognition**.
The app keeps recordings when the engine is missing so they can be retried after setup.

## Option A: prebuilt whisper.cpp for Windows (recommended first)

1. Open the releases page: <https://github.com/ggml-org/whisper.cpp/releases>.
2. Pick a release or nightly build that has Windows x64 assets. Asset names look like
   `whisper-bin-x64.zip`, `whisper-blas-bin-x64.zip`, and CUDA variants.
3. Choose the zip:
   - **A Vulkan x64 build, if that release publishes one.** Vulkan is what puts the Radeon integrated GPU
     to work.
   - Otherwise use **`whisper-blas-bin-x64.zip`** (CPU with BLAS) or **`whisper-bin-x64.zip`** (plain
     CPU). This is the honest current state: whisper.cpp's published Windows zips are usually CPU, BLAS,
     CUDA, and ARM64/OpenCL builds, and a Windows Vulkan x64 zip is not present in every release. If you
     want Vulkan and there is no zip, use Option B.
   - Do **not** use `whisper-bin-Win32.zip` (32-bit), the ARM64 zips, or the CUDA zips on this laptop
     (it has no NVIDIA GPU).
4. Extract the zip to a temporary folder. Copy **`whisper-cli.exe` and every `.dll` next to it** into
   `%APPDATA%\OPD Scribe\whisper\`. Keep them together; the executable will not start if a DLL is left
   behind. Do not copy the samples or the whole folder tree unless you want them there.
5. Put the model in the same folder (see [Models](#models)), then open
   **Settings > Speech recognition**, leave the paths empty if the files are in that folder, and press
   **Save** then **Check**.

The Vulkan **runtime** is part of the AMD Radeon driver; you do not need the Vulkan SDK just to run a
Vulkan build. Update the GPU driver through AMD Adrenalin (or the laptop manufacturer's version of it)
if Vulkan initialisation fails. The SDK is only needed to compile Option B.

If Windows blocks the downloaded executable or DLLs, open the file's Properties and choose **Unblock**,
or unblock them all in PowerShell:

```powershell
Get-ChildItem -File | Where-Object { $_.Extension -in '.exe', '.dll' } | Unblock-File
```

An antivirus quarantine is also worth checking if `Could not start speech engine` appears immediately.

## Option B: build from source with Vulkan

Prerequisites:

- Git and CMake (the "Desktop development with C++" workload in Visual Studio 2022 Build Tools includes
  the compiler; select its CMake tools component if the installer did not already).
- The [LunarG Vulkan SDK](https://vulkan.lunarg.com/sdk/home) for Windows, installed with its
  `VULKAN_SDK` environment variable set.

In PowerShell:

```powershell
cd C:\src          # or any working folder
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_VULKAN=1
cmake --build build -j --config Release
```

With the Visual Studio generator the binary is at `build\bin\Release\whisper-cli.exe`; `quantize.exe` is
in the same folder. Copy `whisper-cli.exe` and every `.dll` beside it (including the Vulkan backend DLL,
if the build produced one) into `%APPDATA%\OPD Scribe\whisper\`.

If CMake cannot find Vulkan, open a new terminal after installing the SDK so `VULKAN_SDK` is visible, or
pass `-DVulkan_INCLUDE_DIR=...`/`-DVulkan_LIBRARY=...` explicitly. Keep the build tree: you will use
`quantize.exe` from it for a custom model.

To confirm whether the GPU is actually being used, run the manual test below once and watch Task Manager
(Performance > GPU). `--no-gpu` (`-ng`) forces CPU and is useful for comparison.

## Models

The app auto-detects whisper.cpp GGML `.bin` files; the documented and tested path here is a GGML `.bin`,
not a Hugging Face `.safetensors` file. Settings can point at another file if your whisper.cpp build
supports it, but keep the auto-detected folder to `.bin` models.

### Baseline fallback: large-v3-turbo q5_0

This is the model to get working first. It is multilingual, reasonably fast, and small enough for a
16 GB laptop.

- Model card and file list: <https://huggingface.co/ggerganov/whisper.cpp>
- Direct file: <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin>
  (about 550 MB)

Save it as `ggml-large-v3-turbo-q5_0.bin` in `%APPDATA%\OPD Scribe\whisper\`. The q5_0 quantisation is a
good speed/memory compromise; q8_0 is larger and may be slightly more accurate, at the cost of speed and
RAM.

Parrotlet-a is **not** a runtime option on this laptop. The roadmap keeps it as a Mac-side accuracy
reference because its weights are about 10 GB and it is PyTorch/GPU only; the clinic laptop runs a
quantised whisper.cpp model.

### Apex (Hindi/Hinglish medical fine-tune)

The roadmap selects **Oriserve Whisper-Hindi2Hinglish-Apex**, a fine-tune of Whisper large-v3-turbo
intended to output Hinglish in Roman script. The roadmap records it as Apache-2.0, but **check the model
card and licence file yourself** before clinical deployment or redistribution - this guide is not legal
advice.

No download URL is given here on purpose. Use the model's own Hugging Face page and its **Files** tab;
organisations move and rename repositories, and an invented link would be worse than none.

Conversion only works **if the model is a standard Whisper architecture fine-tune** (the same encoder and
decoder shapes, with a Whisper tokenizer). A model that adds layers, changes the vocabulary, or uses a
different architecture will fail to convert or will produce a file whisper.cpp cannot load. Check
`config.json` (`model_type: "whisper"`) and the model card before spending time on it.

Prerequisites on the machine doing the conversion (it does not have to be the clinic laptop):

- Python 3.10 or 3.11 in a virtual environment.
- `pip install torch transformers numpy`.
- A checkout of <https://github.com/openai/whisper> (the conversion script reads
  `whisper/assets/mel_filters.npz` from it).
- The Hugging Face model directory, containing at least `config.json`, `vocab.json`,
  `added_tokens.json`, and the weights.

From the whisper.cpp checkout:

```powershell
# dir_model = the downloaded HF model directory
# dir_whisper = the openai/whisper checkout
# dir_out = a scratch output directory
python models\convert-h5-to-ggml.py C:\models\apex C:\src\whisper C:\models\apex-ggml
```

The script writes `C:\models\apex-ggml\ggml-model.bin`. Quantise it with the `quantize` tool from the
Option B build (release zips do not always include it):

```powershell
C:\src\whisper.cpp\build\bin\Release\quantize.exe `
  C:\models\apex-ggml\ggml-model.bin `
  C:\models\apex-ggml\ggml-apex-q5_0.bin q5_0
```

Use `q8_0` instead of `q5_0` if accuracy matters more than speed and memory. Copy the result into
`%APPDATA%\OPD Scribe\whisper\` and keep only the model you actually use there, or set the full model path
in Settings.

Expectations: the roadmap notes that Apex was tuned on general noisy Indian-accented Hindi, **not on
medical speech**. Drug names and numbers will still contain errors. The vocabulary hint and a close-talk
microphone help; nothing replaces the doctor's review.

## Settings to try

Open **Settings > Speech recognition** after the files are in place.

- **Language.** The app default is `hi` (Hindi with English terms). This is the right starting point for
  Hinglish conversation.
  - With the **baseline** Whisper model, `hi` normally produces Devanagari script, not Roman Hinglish.
    Apex is the model that is trained to produce Roman Hinglish.
  - `en` forces English output. It may transcribe English drug names well but can translate or drop Hindi
    speech.
  - `auto` lets whisper detect the language, which can switch scripts mid-recording on Hinglish.
  - Try all three on the same short recording and choose what the doctor can review fastest. Changing the
    language does not change what was said; it changes how the model writes it.
- **CPU threads.** Set this to the number of **physical** cores, not logical threads: typically 6 on a
  Ryzen 5 and 8 on a Ryzen 7. The default is 6. More threads than physical cores usually makes things
  slower, and Windows still needs CPU time.
- **Vocabulary hint.** A short line of clinic drug and regimen names, for example:

  `FOLFOX, capecitabine, pembrolizumab, ondansetron, paclitaxel, carboplatin, 5-FU, leucovorin, filgrastim`

  The app passes this to whisper as `--prompt`. It biases spelling and vocabulary; it **cannot add
  clinical content** to the note. Keep it to a line or two, use no patient data, and do not paste a whole
  formulary. A very long prompt can occasionally leak into output on silence; the app flags suspicious
  segments, but short is safer.
- Press **Save**, then **Check**.

Each **Stop & transcribe** starts a fresh `whisper-cli` process, so the first result includes model load
time. A fast SSD helps; a 16 GB laptop should not keep two large models in memory at once.

## Quick manual test from PowerShell

Record 10-20 seconds of Hinglish speech with a voice recorder on the laptop or a phone, and make sure the
WAV is **16 kHz, mono, 16-bit PCM**. The app records in that format automatically. If you only have a
compressed recording, convert it with ffmpeg (not bundled with the app):

```powershell
ffmpeg -i sample.m4a -ar 16000 -ac 1 -c:a pcm_s16le "$env:APPDATA\OPD Scribe\whisper\test.wav"
```

That puts the test file where the next command expects it. Then run the engine exactly as the app does:

```powershell
cd "$env:APPDATA\OPD Scribe\whisper"
.\whisper-cli.exe -m .\ggml-large-v3-turbo-q5_0.bin -f .\test.wav -l hi -oj -of test -t 6 -pp --prompt "FOLFOX, capecitabine, pembrolizumab, ondansetron"
```

`-oj` writes `test.json` (the `-of test` base name) next to the WAV. Without `-of`, whisper.cpp appends
`.json` to the full input name, giving `test.wav.json`. The app passes its own `-of` base and reads that
JSON. Try `-l en` and `-l auto` for comparison, and add `-ng` to force CPU when comparing against Vulkan.

There is no reliable published speed number for this laptop. The roadmap cites an older Ryzen 4750U at
roughly 0.8x realtime on CPU (slower than realtime) and 3.4x on its integrated GPU, but those numbers are
indicative only. Time a two-minute sample on the actual machine before promising a workflow.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `whisper-cli executable not found` | Empty/wrong path, file in a subfolder, or renamed | Put `whisper-cli.exe` at the top level of `%APPDATA%\OPD Scribe\whisper\`, or browse to it in Settings. Press Save, then Check. |
| `Speech model (ggml .bin) not found` | No `ggml-*.bin` at the top level, or a file format whisper.cpp cannot load | Put a `ggml-*.bin` model at the top level of the folder (not a subfolder), or set the model path explicitly. |
| `Speech engine exited with code …` and a DLL error | A DLL was not copied, or the VC++ runtime is missing | Read the last stderr line in the message; keep every DLL beside the executable, and install the Microsoft Visual C++ Redistributable (x64) if Windows reports a missing runtime. |
| `Could not start speech engine` | Antivirus/SmartScreen blocked the exe, or the path has gone | Unblock the file, check the path, try running the exe manually from PowerShell to see the error. |
| Vulkan device/instance errors | Outdated Radeon driver, or the build has no Vulkan backend | Update AMD Adrenalin (or the laptop maker's driver). If it still fails, use the BLAS/CPU build to confirm the model works, then rebuild Vulkan with Option B. |
| Very slow (minutes for one minute of audio) | CPU build, a too-large model, or too many threads | Use `large-v3-turbo` q5_0, set threads to physical cores, close other heavy apps, check Task Manager for GPU use, and plug in the laptop. |
| Fans loud / app sluggish / low memory | 16 GB is shared by Electron, the model, PDF rendering, and Windows | Use q5_0 rather than q8_0 or a full large model; close browser tabs; do not load two models at once. |
| Repeated words, loops, "thank you for watching" | Whisper hallucination on silence, noise, or music | The app flags the segment with `Repeated words`, `Possible non-speech / hallucinated text`, or `Same text as previous segment`. It never deletes or rewrites it - review the audio and correct the text. Try a quieter room/closer mic. |
| `Too much text for segment duration` | Model produced far more text than the audio supports | Treat that segment as suspect, listen, and correct it. |
| Microphone not captured | Windows privacy setting or wrong input device | Settings > Privacy & security > Microphone (Windows 10: Settings > Privacy > Microphone): turn on microphone access and **Let desktop apps access your microphone**. Check Sound > Input, and watch the app's level meter while recording. |
| Output is Devanagari but the clinic wants Roman Hinglish | Baseline model behaviour, not a bug | Use the Apex fine-tune if it is available and validated; otherwise test `-l en` and review carefully, or accept Devanagari and correct. |
| Converted model will not load | Architecture or quantisation mismatch | Confirm it is a standard Whisper fine-tune; re-run conversion and quantisation with the **same** whisper.cpp version that built `whisper-cli.exe`. Do not mix a new model with an old binary. |

## What happens to the audio

- The app records 16 kHz mono WAV in the renderer and writes it encrypted under
  `%APPDATA%\OPD Scribe\audio\` for transcription.
- `whisper-cli` receives a temporary WAV in `%APPDATA%\OPD Scribe\tmp\`; the temporary WAV and JSON are
  removed after the run, and the whole `tmp\` folder is cleared at startup if a crash left files behind.
- After the transcript is marked reviewed, the stored audio is deleted by default. If "Keep raw audio" is
  enabled in Settings, it stays encrypted until deleted or restored from a backup.
- Nothing is sent over the network. The app blocks outbound requests; whisper.cpp itself makes no network
  calls during inference.

## Before the first clinic day

1. Put the engine and model in `%APPDATA%\OPD Scribe\whisper\`, press Save, then **Check**.
2. Record a two-minute Hinglish sample with the real microphone in the real room; time it and read the
   transcript.
3. Try `hi`, `en`, and `auto`, and pick the setting the doctor prefers.
4. Add the clinic's common regimens and drug names to the vocabulary hint (no patient data).
5. Review the flagged-segment behaviour with the doctor: warnings are prompts for review, not deletions.
6. Create an encrypted backup before importing real patients.
