# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "torch>=2.7",
#   "transformers>=4.52,<5",
#   "librosa>=0.10",
#   "soundfile>=0.12",
#   "jiwer>=3.0",
#   "rapidfuzz>=3.0",
# ]
# ///
"""
Speech-to-text benchmark for OPD Scribe.

Runs several speech models over the same consented clinic recordings and compares them on:
  - WER / CER against a hand-corrected reference transcript
  - drug / clinical term recall (the errors that matter most clinically)
  - speed (real-time factor) and peak memory, on the machine it runs on

Usage (from the repo root):
  uv run scripts/asr-bench/bench.py --config scripts/asr-bench/models.toml --data asr-bench-data

Each model runs in its own subprocess so peak memory is measured per model and freed in between.
See scripts/asr-bench/README.md for the data layout and model setup.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import resource
import subprocess
import sys
import tempfile
import time
import tomllib
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

SR = 16_000
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".webm", ".opus"}
REPO_ROOT = Path(__file__).resolve().parents[2]


# --------------------------------------------------------------------------- data


@dataclass
class Sample:
    id: str
    audio: Path
    reference: str | None


def find_samples(data_dir: Path) -> list[Sample]:
    """<name>.<audio ext> with an optional <name>.txt reference next to it."""
    out = []
    for p in sorted(data_dir.iterdir()):
        if p.suffix.lower() in AUDIO_EXTS:
            ref = p.with_suffix(".txt")
            out.append(Sample(p.stem, p, ref.read_text(encoding="utf-8").strip() if ref.exists() else None))
    return out


def load_audio(path: Path):
    import librosa

    audio, _ = librosa.load(str(path), sr=SR, mono=True)
    return audio


def split_at_pauses(audio, max_s: float = 28.0, min_s: float = 15.0) -> list:
    """
    Cut audio into chunks no longer than max_s, cutting at the quietest 100 ms between min_s and max_s.
    Parrotlet silently drops everything after 30 s of input, so long recordings must be chunked first.
    """
    import numpy as np

    hop = int(0.1 * SR)
    chunks, start, n = [], 0, len(audio)
    while n - start > max_s * SR:
        lo, hi = start + int(min_s * SR), start + int(max_s * SR)
        window = audio[lo:hi]
        frames = len(window) // hop
        rms = np.sqrt(np.mean(window[: frames * hop].reshape(frames, hop) ** 2, axis=1))
        cut = lo + int(np.argmin(rms)) * hop + hop // 2
        chunks.append(audio[start:cut])
        start = cut
    chunks.append(audio[start:])
    return chunks


# --------------------------------------------------------------------------- backends


def pick_device(requested: str) -> str:
    import torch

    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def torch_dtype(name: str):
    import torch

    return {"float32": torch.float32, "float16": torch.float16, "bfloat16": torch.bfloat16}[name]


class WhisperCpp:
    """The same whisper-cli invocation the app uses (src/main/asr.ts)."""

    def __init__(self, cfg: dict):
        self.binary = resolve(cfg["binary"])
        self.model = resolve(cfg["model"])
        for p in (self.binary, self.model):
            if not p.exists():
                raise SystemExit(f"not found: {p}")
        self.language = cfg.get("language", "hi")
        self.prompt = cfg.get("prompt", "").strip()
        self.threads = str(cfg.get("threads", max(1, (os.cpu_count() or 4) - 2)))

    def transcribe(self, audio) -> str:
        import soundfile as sf

        with tempfile.TemporaryDirectory() as tmp:
            wav, base = Path(tmp) / "in.wav", Path(tmp) / "out"
            sf.write(wav, audio, SR, subtype="PCM_16")
            args = [str(self.binary), "-m", str(self.model), "-f", str(wav), "-otxt", "-of", str(base),
                    "-t", self.threads, "-np", "-l", self.language]
            if self.prompt:
                args += ["--prompt", self.prompt]
            r = subprocess.run(args, capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(f"whisper-cli exited {r.returncode}: {r.stderr[-800:]}")
            return base.with_suffix(".txt").read_text(encoding="utf-8").strip()


class HfWhisper:
    """Any Whisper checkpoint on Hugging Face, run with the transformers pipeline (long-form chunking)."""

    def __init__(self, cfg: dict):
        import torch
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

        self.device = pick_device(cfg.get("device", "auto"))
        dtype = torch_dtype(cfg.get("dtype", "float16" if self.device != "cpu" else "float32"))
        model = AutoModelForSpeechSeq2Seq.from_pretrained(cfg["repo"], torch_dtype=dtype, low_cpu_mem_usage=True,
                                                          use_safetensors=True).to(self.device)
        proc = AutoProcessor.from_pretrained(cfg["repo"])
        self.pipe = pipeline("automatic-speech-recognition", model=model, tokenizer=proc.tokenizer,
                             feature_extractor=proc.feature_extractor, torch_dtype=dtype, device=self.device,
                             chunk_length_s=30, batch_size=cfg.get("batch_size", 4))
        self.generate_kwargs = cfg.get("generate_kwargs", {"task": "transcribe"})

    def transcribe(self, audio) -> str:
        return self.pipe({"raw": audio, "sampling_rate": SR}, generate_kwargs=self.generate_kwargs)["text"].strip()


class Parrotlet:
    """
    Eka Care Parrotlet-a (Whisper encoder + MedGemma decoder), via its own remote code.
    Workarounds for the published modelling file:
      - it only picks cuda or cpu, so the device is forced through a wrapper (MPS works on Apple silicon)
      - passing device= to transcribe() leaks into generate(), so it is stripped there
      - it loads in float32 (~20 GB); dtype = "bfloat16" halves that, with a cast on the encoder input
      - input over 30 s is truncated, so audio is split at pauses first
    """

    def __init__(self, cfg: dict):
        import torch
        from transformers import AutoModel

        self.device = pick_device(cfg.get("device", "auto"))
        self.model = AutoModel.from_pretrained(cfg["repo"], trust_remote_code=True, device=self.device)
        dtype = torch_dtype(cfg.get("dtype", "float32"))
        if dtype != torch.float32:
            for part in (self.model.encoder, self.model.projector, self.model.decoder):
                part.to(dtype)
            self.model.encoder.register_forward_pre_hook(lambda _m, args: tuple(a.to(dtype) for a in args))
        gen = self.model.decoder.generate
        self.model.decoder.generate = lambda *a, **k: gen(*a, **{x: y for x, y in k.items() if x != "device"})
        self.max_new_tokens = int(cfg.get("max_new_tokens", 448))
        self.chunk_s = float(cfg.get("chunk_seconds", 28))

    def transcribe(self, audio) -> str:
        parts = []
        for chunk in split_at_pauses(audio, max_s=self.chunk_s):
            if len(chunk) < SR * 0.3:
                continue
            text = self.model.transcribe(chunk, SR, max_new_tokens=self.max_new_tokens, device=self.device)
            parts.append(str(text).strip())
        return " ".join(p for p in parts if p)


BACKENDS = {"whispercpp": WhisperCpp, "hf-whisper": HfWhisper, "parrotlet": Parrotlet}


def resolve(p: str) -> Path:
    path = Path(os.path.expanduser(p))
    return path if path.is_absolute() else (REPO_ROOT / path)


# --------------------------------------------------------------------------- metrics


def normalise(text: str) -> str:
    """Lowercase, NFC, punctuation and symbols to spaces. Keeps Devanagari matras (category M)."""
    text = unicodedata.normalize("NFC", text).lower()
    text = "".join(" " if unicodedata.category(c)[0] in "PSZC" else c for c in text)
    return re.sub(r"\s+", " ", text).strip()


def devanagari_share(text: str) -> float:
    letters = [c for c in text if unicodedata.category(c)[0] in "LM"]
    if not letters:
        return 0.0
    return sum("ऀ" <= c <= "ॿ" for c in letters) / len(letters)


@dataclass
class Term:
    name: str
    forms: list[str]


def load_terms(path: Path | None) -> list[Term]:
    """One term per line: canonical|alias|alias. Blank lines and # comments are ignored."""
    if not path:
        return []
    terms = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            forms = [normalise(f) for f in line.split("|") if f.strip()]
            terms.append(Term(line.split("|")[0].strip(), forms))
    return terms


def term_in(term: Term, norm_text: str, fuzzy: bool) -> bool:
    from rapidfuzz import fuzz

    padded = f" {norm_text} "
    for form in term.forms:
        if f" {form} " in padded:
            return True
        # tolerate one-letter spelling slips in longer names (e.g. "paclitaxol"), never in short ones
        if fuzzy and len(form) >= 6 and fuzz.partial_ratio(form, norm_text) >= 90:
            return True
    return False


def score(reference: str | None, hypothesis: str, terms: list[Term]) -> dict:
    out: dict = {"hyp_devanagari": round(devanagari_share(hypothesis), 2)}
    if reference is None:
        return out
    import jiwer

    ref, hyp = normalise(reference), normalise(hypothesis)
    out["ref_devanagari"] = round(devanagari_share(reference), 2)
    out["script_mismatch"] = abs(out["ref_devanagari"] - out["hyp_devanagari"]) > 0.5
    out["wer"] = jiwer.wer(ref, hyp) if ref else None
    out["cer"] = jiwer.cer(ref, hyp) if ref else None
    expected = [t for t in terms if term_in(t, ref, fuzzy=False)]
    out["terms_expected"] = [t.name for t in expected]
    out["terms_missed"] = [t.name for t in expected if not term_in(t, hyp, fuzzy=True)]
    return out


# --------------------------------------------------------------------------- worker: one model


def run_worker(model_cfg: dict, samples: list[Sample], terms: list[Term], out_dir: Path) -> dict:
    name = model_cfg["name"]
    backend = BACKENDS[model_cfg["backend"]]
    hyp_dir = out_dir / "transcripts" / slug(name)
    hyp_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.perf_counter()
    engine = backend(model_cfg)
    load_s = time.perf_counter() - t0

    rows = []
    for s in samples:
        audio = load_audio(s.audio)
        dur = len(audio) / SR
        print(f"  [{name}] {s.id} ({dur:.0f}s)…", file=sys.stderr, flush=True)
        t = time.perf_counter()
        try:
            hyp, err = engine.transcribe(audio), None
        except Exception as e:  # keep going; one bad file should not sink the run
            hyp, err = "", f"{type(e).__name__}: {e}"
        proc_s = time.perf_counter() - t
        (hyp_dir / f"{s.id}.txt").write_text(hyp + "\n", encoding="utf-8")
        row = {"sample": s.id, "audio_s": round(dur, 1), "proc_s": round(proc_s, 1), "rtf": round(proc_s / dur, 3) if dur else None}
        if err:
            row["error"] = err
        row.update(score(s.reference, hyp, terms))
        rows.append(row)

    # whisper.cpp runs as a child process, so take the larger of this process and its children
    rss = max(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
    peak_gb = rss / (1024**3 if sys.platform == "darwin" else 1024**2)  # bytes on macOS, KiB on Linux
    return {"name": name, "backend": model_cfg["backend"], "load_s": round(load_s, 1),
            "peak_rss_gb": round(peak_gb, 1), "device": getattr(engine, "device", "whisper.cpp"), "samples": rows}


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# --------------------------------------------------------------------------- report


def summarise(results: list[dict]) -> str:
    lines = ["| Model | WER | CER | Term recall | RTF | Load (s) | Peak RAM (GB) | Errors | Script mismatch |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        if "fatal" in r:
            lines.append(f"| {r['name']} | failed: {r['fatal'][:80]} |||||||| ")
            continue
        rows = r["samples"]
        scored = [x for x in rows if x.get("wer") is not None]
        # corpus-level WER/CER: weight each file by its reference length
        def corpus(metric: str, unit) -> str:
            if not scored:
                return "n/a"
            num = sum(x[metric] * unit(x) for x in scored)
            den = sum(unit(x) for x in scored)
            return f"{num / den:.1%}" if den else "n/a"

        refs = {s.id: s.reference for s in SAMPLES}
        words = lambda x: len(normalise(refs[x["sample"]] or "").split())  # noqa: E731
        chars = lambda x: len(normalise(refs[x["sample"]] or ""))  # noqa: E731
        exp = sum(len(x.get("terms_expected", [])) for x in rows)
        miss = sum(len(x.get("terms_missed", [])) for x in rows)
        recall = f"{(exp - miss) / exp:.0%} ({exp - miss}/{exp})" if exp else "n/a"
        audio = sum(x["audio_s"] for x in rows)
        rtf = f"{sum(x['proc_s'] for x in rows) / audio:.2f}" if audio else "n/a"
        errs = sum(1 for x in rows if "error" in x)
        mism = sum(1 for x in rows if x.get("script_mismatch"))
        lines.append(f"| {r['name']} | {corpus('wer', words)} | {corpus('cer', chars)} | {recall} | {rtf} | "
                     f"{r['load_s']} | {r['peak_rss_gb']} | {errs} | {mism} |")

    lines += ["", "Lower is better for WER, CER and RTF. RTF < 1 means faster than real time "
              "(0.25 = a 20-minute consult takes 5 minutes).",
              "Script mismatch counts files where the model and the reference use different scripts "
              "(Devanagari vs Roman); WER is meaningless for those files.", ""]

    missed: dict[str, dict[str, int]] = {}
    for r in results:
        for x in r.get("samples", []):
            for t in x.get("terms_missed", []):
                missed.setdefault(r["name"], {}).setdefault(t, 0)
                missed[r["name"]][t] += 1
    if missed:
        lines.append("## Missed terms")
        for name, counts in missed.items():
            top = ", ".join(f"{t} ×{n}" for t, n in sorted(counts.items(), key=lambda kv: -kv[1])[:25])
            lines.append(f"- **{name}:** {top}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- main

SAMPLES: list[Sample] = []


def main() -> None:
    global SAMPLES
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=Path(__file__).with_name("models.toml"))
    ap.add_argument("--data", type=Path, default=REPO_ROOT / "asr-bench-data")
    ap.add_argument("--terms", type=Path, help="term list (default: <data>/terms.txt if present)")
    ap.add_argument("--only", help="run only models whose name contains this text")
    ap.add_argument("--out", type=Path, help="output folder (default: <data>/results/<timestamp>)")
    ap.add_argument("--worker", help=argparse.SUPPRESS)  # internal: run one model by exact name
    args = ap.parse_args()

    cfg = tomllib.loads(args.config.read_text(encoding="utf-8"))
    models = [m for m in cfg.get("model", []) if not m.get("disabled")]
    SAMPLES = find_samples(args.data)
    if not SAMPLES:
        raise SystemExit(f"No audio files in {args.data}. See scripts/asr-bench/README.md.")
    terms_path = args.terms or (args.data / "terms.txt" if (args.data / "terms.txt").exists() else None)
    terms = load_terms(terms_path)

    if args.worker:
        model = next(m for m in models if m["name"] == args.worker)
        print(json.dumps(run_worker(model, SAMPLES, terms, args.out)))
        return

    if args.only:
        models = [m for m in models if args.only.lower() in m["name"].lower()]
    out = args.out or args.data / "results" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    with_ref = sum(1 for s in SAMPLES if s.reference is not None)
    print(f"{len(SAMPLES)} recordings ({with_ref} with reference), {len(terms)} terms, {len(models)} models → {out}",
          file=sys.stderr)

    results = []
    for m in models:
        print(f"\n== {m['name']} ({m['backend']})", file=sys.stderr, flush=True)
        cmd = [sys.executable, __file__, "--config", str(args.config), "--data", str(args.data),
               "--out", str(out), "--worker", m["name"]]
        if terms_path:
            cmd += ["--terms", str(terms_path)]
        r = subprocess.run(cmd, stdout=subprocess.PIPE, text=True)
        try:
            results.append(json.loads(r.stdout.strip().splitlines()[-1]))
        except (json.JSONDecodeError, IndexError):
            results.append({"name": m["name"], "fatal": f"exit {r.returncode}, see log above"})

    (out / "results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    report = summarise(results)
    (out / "summary.md").write_text("# ASR benchmark\n\n" + report, encoding="utf-8")
    print("\n" + report)
    print(f"Transcripts, results.json and summary.md are in {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
