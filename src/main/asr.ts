import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { uid } from '../shared/defaults'
import type { AsrSettings, TranscriptSegment } from '../shared/types'

interface WhisperJson {
  transcription?: { offsets?: { from: number; to: number }; text?: string }[]
}

const KNOWN_HALLUCINATIONS = [
  /thank(s| you) for watching/i,
  /please subscribe/i,
  /like and subscribe/i,
  /^\s*[[(](music|applause|silence|blank_audio)[\])]\s*$/i,
  /subtitles? by/i
]

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** True when one word/short phrase repeats many times in a row ("ok ok ok ok ..."). */
function hasLoop(text: string): boolean {
  const words = norm(text).split(' ').filter(Boolean)
  if (words.length < 8) return false
  for (let n = 1; n <= 4; n++) {
    let repeats = 1
    for (let i = n; i + n <= words.length; i += n) {
      const same = words.slice(i, i + n).join(' ') === words.slice(i - n, i).join(' ')
      repeats = same ? repeats + 1 : 1
      if (repeats >= 6) return true
    }
  }
  return false
}

/**
 * Convert whisper.cpp JSON to transcript segments and flag likely hallucinations
 * (AUD-10). Segments are never dropped or rewritten — only flagged for the doctor.
 */
export function parseWhisperJson(json: WhisperJson): TranscriptSegment[] {
  const segs: TranscriptSegment[] = (json.transcription ?? [])
    .map((s) => ({
      id: uid(),
      startMs: s.offsets?.from ?? 0,
      endMs: s.offsets?.to ?? 0,
      originalText: (s.text ?? '').trim(),
      text: (s.text ?? '').trim(),
      speaker: 'unlabelled' as const,
      speakerUncertain: true,
      warning: ''
    }))
    .filter((s) => s.originalText.length > 0)

  segs.forEach((s, i) => {
    const warnings: string[] = []
    if (KNOWN_HALLUCINATIONS.some((re) => re.test(s.originalText))) warnings.push('Possible non-speech / hallucinated text')
    if (hasLoop(s.originalText)) warnings.push('Repeated words — possible recognition loop')
    const prev = segs[i - 1]
    if (prev && norm(prev.originalText) === norm(s.originalText) && norm(s.originalText).length > 0)
      warnings.push('Same text as previous segment — possible repetition')
    const seconds = Math.max((s.endMs - s.startMs) / 1000, 0.1)
    if (s.originalText.length / seconds > 40) warnings.push('Too much text for segment duration')
    s.warning = warnings.join('; ')
  })
  return segs
}

// ---------- Coverage invariant ----------
// Whisper sometimes skips speech entirely. Every detected speech region that no
// segment covers becomes a visible marker and a review warning — nothing is dropped.

export interface SpeechRegion {
  startMs: number
  endMs: number
}

export interface CoverageOptions {
  padMs?: number
  minMs?: number
}

/** Parse PCM 16-bit mono samples from RIFF/WAVE. Walks chunks, so headers need not be 44 bytes. */
export function readPcm16Mono(wav: Buffer): { samples: Int16Array; sampleRate: number } | null {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
    return null
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let fmtFound = false
  let dataOffset = -1
  let dataSize = 0
  let off = 12
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4)
    const size = wav.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      if (size < 16 || body + size > wav.length) return null
      format = wav.readUInt16LE(body)
      channels = wav.readUInt16LE(body + 2)
      sampleRate = wav.readUInt32LE(body + 4)
      bits = wav.readUInt16LE(body + 14)
      fmtFound = true
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(size, Math.max(0, wav.length - body))
    }
    if (size > wav.length - body && id !== 'data') break
    off = body + size + (size % 2) // chunks are word-aligned
  }
  if (!fmtFound || format !== 1 || channels !== 1 || bits !== 16 || sampleRate <= 0 || dataOffset < 0)
    return null
  const count = Math.floor(dataSize / 2)
  const samples = new Int16Array(count)
  for (let i = 0; i < count; i++) samples[i] = wav.readInt16LE(dataOffset + i * 2)
  return { samples, sampleRate }
}

/** Speech regions from 30 ms RMS frames, merged over short dips and ignoring brief blips. */
export function speechRegions(samples: Int16Array, sampleRate: number): SpeechRegion[] {
  if (sampleRate <= 0) return []
  const frame = Math.max(1, Math.round(sampleRate * 0.03))
  const frames = Math.floor(samples.length / frame)
  if (frames === 0) return []

  const rms = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const base = f * frame
    for (let i = 0; i < frame; i++) {
      const s = samples[base + i]
      sum += s * s
    }
    rms[f] = Math.sqrt(sum / frame)
  }

  const sorted = Array.from(rms).sort((a, b) => a - b)
  const noiseFloor = sorted[Math.min(frames - 1, Math.floor(frames * 0.1))]
  const threshold = Math.max(500, noiseFloor * 4)
  const minSamples = (sampleRate * 300) / 1000
  const maxGapSamples = (sampleRate * 400) / 1000

  const runs: { start: number; end: number }[] = []
  let runStart = -1
  let runEnd = -1
  for (let f = 0; f < frames; f++) {
    if (rms[f] > threshold) {
      if (runStart < 0) runStart = f * frame
      runEnd = (f + 1) * frame
    } else if (runStart >= 0) {
      runs.push({ start: runStart, end: runEnd })
      runStart = -1
    }
  }
  if (runStart >= 0) runs.push({ start: runStart, end: runEnd })

  // merge on sample positions before converting to ms
  const merged: { start: number; end: number }[] = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end < maxGapSamples) last.end = r.end
    else merged.push({ ...r })
  }
  return merged
    .filter((r) => r.end - r.start >= minSamples)
    .map((r) => ({
      startMs: Math.round((r.start / sampleRate) * 1000),
      endMs: Math.round((r.end / sampleRate) * 1000)
    }))
}

/** Parts of speech regions not covered by any segment (each padded), at least minMs long. */
export function uncoveredSpeech(
  regions: SpeechRegion[],
  segments: TranscriptSegment[],
  opts: CoverageOptions = {}
): SpeechRegion[] {
  const padMs = opts.padMs ?? 600
  const minMs = opts.minMs ?? 1500
  const covered = segments
    .map((s) => ({ startMs: s.startMs - padMs, endMs: s.endMs + padMs }))
    .sort((a, b) => a.startMs - b.startMs)

  const gaps: SpeechRegion[] = []
  for (const r of regions) {
    let cursor = r.startMs
    for (const c of covered) {
      if (c.endMs <= cursor) continue
      if (c.startMs >= r.endMs) break
      if (c.startMs > cursor) gaps.push({ startMs: cursor, endMs: Math.min(c.startMs, r.endMs) })
      cursor = Math.max(cursor, c.endMs)
      if (cursor >= r.endMs) break
    }
    if (cursor < r.endMs) gaps.push({ startMs: cursor, endMs: r.endMs })
  }

  gaps.sort((a, b) => a.startMs - b.startMs)
  const merged: SpeechRegion[] = []
  for (const g of gaps) {
    const last = merged[merged.length - 1]
    if (last && g.startMs <= last.endMs) last.endMs = Math.max(last.endMs, g.endMs)
    else merged.push({ ...g })
  }
  return merged.filter((g) => g.endMs - g.startMs >= minMs)
}

const COVERAGE_WARNING =
  'Speech was detected here but nothing was transcribed — listen to the audio or re-record'

/** mm:ss, zero-padded (01:05). */
const mmss = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Add a visible marker for every stretch of detected speech whisper did not transcribe. */
export function withCoverageMarkers(segments: TranscriptSegment[], wav: Buffer): TranscriptSegment[] {
  const pcm = readPcm16Mono(wav)
  if (!pcm) return segments
  const gaps = uncoveredSpeech(speechRegions(pcm.samples, pcm.sampleRate), segments)
  const markers: TranscriptSegment[] = gaps.map((g) => {
    const text = `[untranscribed audio ${mmss(g.startMs)}–${mmss(g.endMs)}]`
    return {
      id: uid(),
      startMs: g.startMs,
      endMs: g.endMs,
      originalText: text,
      text,
      speaker: 'unlabelled',
      speakerUncertain: true,
      warning: COVERAGE_WARNING
    }
  })
  return [...segments, ...markers].sort((a, b) => a.startMs - b.startMs)
}

/** Fill empty engine paths from well-known folders (bundled resources/whisper, userData/whisper). */
export function resolveAsr(asr: AsrSettings, dirs: string[]): AsrSettings {
  const files = (d: string): string[] => {
    try {
      return readdirSync(d).map((f) => join(d, f))
    } catch {
      return []
    }
  }
  const all = dirs.flatMap(files)
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  return {
    ...asr,
    binaryPath: asr.binaryPath || (all.find((f) => f.endsWith(`${sep}${exe}`)) ?? ''),
    modelPath: asr.modelPath || (all.find((f) => /ggml-.*\.bin$/i.test(f)) ?? '')
  }
}

export function checkAsr(asr: AsrSettings): { binaryOk: boolean; modelOk: boolean; message: string } {
  const binaryOk = !!asr.binaryPath && existsSync(asr.binaryPath)
  const modelOk = !!asr.modelPath && existsSync(asr.modelPath)
  const message = !binaryOk
    ? 'whisper-cli executable not found — set it in Settings › Speech engine'
    : !modelOk
      ? 'Speech model (ggml .bin) not found — set it in Settings › Speech engine'
      : `Speech engine ready — model ${basename(asr.modelPath)}`
  return { binaryOk, modelOk, message }
}

export interface RunOptions {
  asr: AsrSettings
  wav: Buffer
  workDir: string
  onProgress: (percent: number) => void
}

/** Run whisper-cli once on a WAV. Temp files are always removed. */
export function runWhisper({ asr, wav, workDir, onProgress }: RunOptions): Promise<TranscriptSegment[]> {
  const check = checkAsr(asr)
  if (!check.binaryOk || !check.modelOk) return Promise.reject(new Error(check.message))

  const base = join(workDir, `asr-${uid()}`)
  const wavPath = `${base}.wav`
  writeFileSync(wavPath, wav, { mode: 0o600 })
  const args = ['-m', asr.modelPath, '-f', wavPath, '-oj', '-of', base, '-t', String(asr.threads || 4), '-pp']
  args.push('-l', asr.language || 'auto')
  if (asr.initialPrompt.trim()) args.push('--prompt', asr.initialPrompt.trim())

  return new Promise<TranscriptSegment[]>((resolve, reject) => {
    const child = spawn(asr.binaryPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let tail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4000)
      for (const m of chunk.matchAll(/progress\s*=\s*(\d+)%/g)) onProgress(Number(m[1]))
    })
    child.on('error', (e) => reject(new Error(`Could not start speech engine: ${e.message}`)))
    child.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(`Speech engine exited with code ${code}: ${lastLine(tail)}`)
        const json = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as WhisperJson
        resolve(withCoverageMarkers(parseWhisperJson(json), wav))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      } finally {
        rmSync(wavPath, { force: true })
        rmSync(`${base}.json`, { force: true })
      }
    })
  })
}

const lastLine = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-1)[0] ?? ''
