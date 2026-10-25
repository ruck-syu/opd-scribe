# AI extraction on the clinic laptop (optional)

OPD Scribe can run a small local language model over a finished transcript to propose suggestions for the
visit: symptoms, vitals, medicines, ECOG, and note sections. It is optional and off by default. It uses
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-completion` program, started as a local process
the same way whisper-cli is started for speech recognition. No server is started, no port is opened, and
nothing is sent over the network.

## What it does and does not do

It does:

- Reads the numbered lines of a ready transcript and returns candidate suggestions, each with the words
  it came from.
- Passes every candidate through the same check as the rules engine. The quote must be copied exactly from
  the cited line, and every number in a value must have been said in that quote.
- Lists anything that fails the check under "candidates rejected", with the reason. Nothing is dropped
  silently.
- Chooses which note section each line belongs to (history, examination, investigations reviewed, plan,
  advice, return precautions…) and names medicines, including ones outside the clinic formulary.
- Always puts the speaker's own words into the note, never the model's rewording. In testing, a 4B model
  rendered "ulti" (vomiting) as "Urticaria", so the model is not allowed to translate.
- Reads medication details (strength, dose, route, frequency, duration) from that medicine's own words with
  the same rules as the non-AI engine; where the model read them differently, the row says so.
- Ignores questions ("Bukhar hai kya?").

It does not:

- Enter anything into the note. Only **Accept** does that, as with the rules.
- Compute doses, complete a missing frequency or duration, or fill a field that was not said.
- Run on verified visits.
- Send anything off the computer, or write transcript text to the log or the audit trail.

The model can make mistakes. Read every AI row against its quote before you accept it. Rows marked AI are
never included in "Accept all without warnings"; accept them one at a time.

## Install (once)

The app never downloads a model. The clinic installs these files by hand.

1. **The engine.** From the llama.cpp releases page (<https://github.com/ggml-org/llama.cpp/releases>), take
   the Windows x64 zip with the Vulkan build, the same kind of build used for whisper on the Ryzen laptop.
   Extract it to a temporary folder and copy **`llama-completion.exe` and every `.dll` next to it** into
   `%APPDATA%\OPD Scribe\llm\`. Keep them together. On macOS, use the `llama-completion` binary from the
   macOS build.
2. **The model.** Use a 4B-class instruct model in GGUF **Q4_K_M** format. The recommended model is
   **Qwen3-4B-Instruct-2507** (about 2.5 GB, chat template **chatml**). Download a `.gguf` file once and
   copy it into the same `%APPDATA%\OPD Scribe\llm\` folder. Keep one `.gguf` file there, or set the path
   explicitly in Settings.
3. **Settings.** Open **Settings › AI extraction**. Tick *Run AI extraction on each finished transcript*.
   Leave the paths empty if the files are in the folder above, or use **Browse…** to point at them. Choose
   the prompt format that matches the model (ChatML for Qwen). Press **Save**, then **Check**.

**Check** reports `AI extraction ready — model <name>` when both files are found. Otherwise it names the
missing file.

## Using it

- With the option on, extraction starts by itself when a conversation or dictation transcript becomes
  ready. The suggestions panel shows *AI extraction running…* while it works. The visit cannot be verified
  until the run finishes.
- If it has not run yet, the panel offers **Run AI extraction**. A failed run shows the reason and a
  **Retry** button. The rules suggestions are unaffected by a failure.
- Re-running replaces AI suggestions you have not yet decided. Decisions you already made are kept.

## Speed and limits

- On a CPU laptop, expect tens of seconds to a couple of minutes for one consultation, depending on its
  length and the processor. Only one run happens at a time across the app.
- The run uses an 8,192-token context. A very long consultation can exceed it, and that run then fails
  with an error. The rules suggestions still work. Split long recordings or enter the rest by hand.

## Privacy

- The prompt contains the transcript, so it is patient data. It is written to the app's temporary folder
  only while the model runs, and deleted afterwards whether the run succeeds or fails.
- Logs and the audit trail record only that a run started, finished or failed, and the counts. They never
  contain transcript text, names or the error output of the engine.

## Troubleshooting

- **`llama-completion not found`**: the executable is not in the folder, or the Settings path is wrong.
- **`Model file (.gguf) not found`**: the model file is missing from the folder or the Settings path.
- **`AI extraction exited with code N`**: the engine started but failed. Make sure every `.dll` came with
  `llama-completion.exe`, and that the model is a GGUF file. The engine's own text is not shown in the app,
  so run it from a Command Prompt to see its message while testing.
- **`AI extraction timed out`**: the run took more than five minutes. Try a shorter recording or a smaller
  model.
