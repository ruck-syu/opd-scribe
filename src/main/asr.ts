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
        resolve(parseWhisperJson(json))
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
