# Speech model benchmark

Compares speech-to-text models on your own clinic recordings before any of them goes into the app.
It reports accuracy (WER, CER), how many drug and clinical terms each model gets right, speed, and memory.

This is a developer tool. It runs outside the app and is not packaged.

## 1. Collect recordings (consent first)

Use only recordings where the patient has consented to their audio being used for testing.
Put them in `asr-bench-data/` at the repo root. Git ignores that folder; never commit it or copy it to a
shared drive.

```
asr-bench-data/
  visit-01.wav        audio: wav, mp3, m4a, flac, ogg, webm or opus (any sample rate)
  visit-01.txt        reference transcript: what was actually said, typed or corrected by hand
  visit-02.m4a
  visit-02.txt
  terms.txt           optional: drug and clinical terms to track (see terms.example.txt)
```

- **Reference transcripts:** Write them in **one script**: Roman Hinglish ("BP theek hai, paclitaxel
  continue karenge") or Devanagari. WER is only fair between models that write the same script, and the
  report flags files where they differ. Oriserve Apex writes Roman script. Parrotlet and stock Whisper
  with `language = "hi"` usually write Devanagari.
- **How many:** 10–20 recordings of real OPD consultations, covering several speakers and noisy moments.
  That tells you more than one long clean dictation.
- **Without a reference:** A recording with no `.txt` is still transcribed and timed, but gets no
  accuracy score. This is useful for checking speed on long files.
- **Fast start:** Correct the app's own transcript of a visit, then paste it in as the reference. That
  biases the reference slightly toward the current model, so fix it carefully.

## 2. Configure models

```bash
cp scripts/asr-bench/models.example.toml scripts/asr-bench/models.toml
cp scripts/asr-bench/terms.example.txt asr-bench-data/terms.txt   # then add your clinic's brands
```

Edit the paths in `models.toml`. The example config compares:

| Entry | Runs on | Notes |
| --- | --- | --- |
| large-v3-turbo q5_0 | whisper.cpp (the app's engine) | What ships today. Needs `npm run engines` and the downloaded model. |
| same + drug prompt | whisper.cpp | Same model with an initial prompt of drug names. Cheapest possible improvement. |
| Oriserve Apex | transformers | Hinglish fine-tune of large-v3-turbo. If it wins, it can be converted for whisper.cpp. |
| Eka Parrotlet-a 2.5 Pro | transformers (remote code) | Medical, Indian languages, ~5B params. Would need a Python runtime in the app. |

Models are downloaded from Hugging Face on first run: about 1.6 GB for Apex and about 10 GB for
Parrotlet. Parrotlet loads in float32 and is then cast to bfloat16. On a 32 GB Mac that works, but
expect it to use most of the RAM while loading.

## 3. Run

Install [uv](https://docs.astral.sh/uv/) if you don't have it. The first run installs Python 3.12,
PyTorch and the other dependencies into a cache.

```bash
uv run scripts/asr-bench/bench.py                      # all enabled models
uv run scripts/asr-bench/bench.py --only parrotlet     # one model
```

Each model runs in its own process, so its peak memory is measured on its own and freed afterwards.

## 4. Read the results

Results go to `asr-bench-data/results/<timestamp>/`:

- `summary.md`: the comparison table and the terms each model missed most often
- `results.json`: per-file numbers
- `transcripts/<model>/<file>.txt`: every model's output, for reading side by side

| Column | Meaning |
| --- | --- |
| WER / CER | Word / character error rate against your reference, weighted by length. Lower is better. CER is fairer for Hindi, where word boundaries vary. |
| Term recall | Share of terms in the references that the model also wrote down. For a prescription, this matters more than WER. |
| RTF | Processing time ÷ audio length. 0.25 means a 20-minute consultation takes 5 minutes. |
| Peak RAM | Peak memory of that model's process. |
| Script mismatch | Files where the output and the reference use different scripts. Ignore WER for those files. |

**Measure speed on the real clinic laptop**, not only on the development Mac. The numbers that
decide what ships are the ones from the computer the doctor will use.

Read the transcripts as well as the numbers. A model can score well on WER while getting the one
dose or drug name that matters wrong.
