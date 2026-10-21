import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '../shared/types'
import {
  parseWhisperJson,
  readPcm16Mono,
  speechRegions,
  uncoveredSpeech,
  withCoverageMarkers
} from './asr'

const seg = (from: number, to: number, text: string) => ({ offsets: { from, to }, text })

const RATE = 16000

/** Deterministic 16 kHz signal: low alternating noise plus sine bursts (ms ranges). */
function signal(seconds: number, bursts: Array<[number, number]>, amplitude = 8000): Int16Array {
  const samples = new Int16Array(Math.round(seconds * RATE))
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 40 : -40
  for (const [startMs, endMs] of bursts) {
    const from = Math.round((startMs / 1000) * RATE)
    const to = Math.min(samples.length, Math.round((endMs / 1000) * RATE))
    for (let i = from; i < to; i++)
      samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE))
  }
  return samples
}

function chunk(id: string, data: Buffer): Buffer {
  const pad = data.length % 2
  const out = Buffer.alloc(8 + data.length + pad)
  out.write(id, 0, 'ascii')
  out.writeUInt32LE(data.length, 4)
  data.copy(out, 8)
  return out
}

function wav(
  samples: Int16Array,
  opts: { bits?: number; extra?: Array<{ id: string; data?: Buffer }> } = {}
): Buffer {
  const bits = opts.bits ?? 16
  const blockAlign = bits / 8
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2)
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(1, 2) // mono
  fmt.writeUInt32LE(RATE, 4)
  fmt.writeUInt32LE(RATE * blockAlign, 8)
  fmt.writeUInt16LE(blockAlign, 12)
  fmt.writeUInt16LE(bits, 14)
  const chunks = [chunk('fmt ', fmt)]
  for (const e of opts.extra ?? []) chunks.push(chunk(e.id, e.data ?? Buffer.alloc(0)))
  chunks.push(chunk('data', data))
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WAVE', 8, 'ascii')
  return Buffer.concat([head, body])
}

function ts(startMs: number, endMs: number): TranscriptSegment {
  return {
    id: `seg-${startMs}-${endMs}`,
    startMs,
    endMs,
    originalText: 'text',
    text: 'text',
    speaker: 'unlabelled',
    speakerUncertain: true,
    warning: ''
  }
}

describe('parseWhisperJson', () => {
  it('maps segments, unlabelled and speaker-uncertain', () => {
    const out = parseWhisperJson({ transcription: [seg(0, 2500, ' दर्द कब से है? '), seg(2500, 3000, '  ')] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ startMs: 0, endMs: 2500, text: 'दर्द कब से है?', speaker: 'unlabelled', speakerUncertain: true, warning: '' })
    expect(out[0].originalText).toBe(out[0].text)
  })

  it('flags loops, repeats and known hallucinations without dropping them', () => {
    const out = parseWhisperJson({
      transcription: [
        seg(0, 5000, 'ok ok ok ok ok ok ok ok ok'),
        seg(5000, 9000, 'Fever since two days'),
        seg(9000, 13000, 'fever since two days.'),
        seg(13000, 15000, 'Thank you for watching')
      ]
    })
    expect(out).toHaveLength(4)
    expect(out[0].warning).toMatch(/loop/)
    expect(out[1].warning).toBe('')
    expect(out[2].warning).toMatch(/previous segment/)
    expect(out[3].warning).toMatch(/hallucinated/)
  })
})

describe('readPcm16Mono', () => {
  it('reads 16-bit mono PCM and walks past an extra LIST chunk (odd size)', () => {
    const samples = signal(1, [[200, 500]])
    const pcm = readPcm16Mono(wav(samples, { extra: [{ id: 'LIST', data: Buffer.alloc(9, 65) }] }))
    expect(pcm).not.toBeNull()
    expect(pcm?.sampleRate).toBe(RATE)
    expect(pcm?.samples.length).toBe(samples.length)
    expect(pcm?.samples[100]).toBe(samples[100])
  })

  it('returns null for anything that is not 16-bit mono PCM', () => {
    expect(readPcm16Mono(wav(signal(1, []), { bits: 8 }))).toBeNull()
    expect(readPcm16Mono(Buffer.from('not a wav'))).toBeNull()
  })
})

describe('speechRegions', () => {
  it('finds bursts, merges short dips and drops blips', () => {
    const pcm = readPcm16Mono(wav(signal(4, [[1000, 2000], [2200, 3000], [3500, 3600]])))
    expect(pcm).not.toBeNull()
    const regions = speechRegions(pcm!.samples, pcm!.sampleRate)
    expect(regions).toHaveLength(1)
    expect(regions[0].startMs).toBe(990)
    expect(regions[0].endMs).toBe(3000)
  })

  it('returns nothing for silence', () => {
    const pcm = readPcm16Mono(wav(signal(2, [])))
    expect(speechRegions(pcm!.samples, pcm!.sampleRate)).toEqual([])
  })
})

describe('uncoveredSpeech', () => {
  it('applies padding to segments and keeps only long gaps', () => {
    const regions = [{ startMs: 0, endMs: 10000 }]
    const segments = [ts(1000, 3000), ts(2500, 4000)]
    expect(uncoveredSpeech(regions, segments)).toEqual([{ startMs: 4600, endMs: 10000 }])
    expect(uncoveredSpeech(regions, segments, { minMs: 6000 })).toEqual([])
  })
})

describe('withCoverageMarkers', () => {
  it('adds nothing when every speech region is covered', () => {
    const segments = [ts(800, 3200)]
    expect(withCoverageMarkers(segments, wav(signal(4, [[1000, 3000]])))).toEqual(segments)
  })

  it('marks a whole uncovered burst with its mm:ss range', () => {
    const first = ts(0, 1000)
    const out = withCoverageMarkers([first], wav(signal(7, [[2000, 5000]])))
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(first)
    expect(out[1]).toMatchObject({
      startMs: 1980,
      endMs: 5010,
      originalText: '[untranscribed audio 00:01–00:05]',
      text: '[untranscribed audio 00:01–00:05]',
      speaker: 'unlabelled',
      speakerUncertain: true
    })
    expect(out[1].warning).toMatch(/Speech was detected/)
    expect(out[1].id).not.toBe(first.id)
  })

  it('marks speech when whisper returned no segments at all', () => {
    const out = withCoverageMarkers([], wav(signal(5, [[1000, 3000]])))
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('[untranscribed audio 00:00–00:03]')
    expect(out[0].warning).toMatch(/nothing was transcribed/)
  })

  it('ignores bursts shorter than minMs', () => {
    expect(withCoverageMarkers([], wav(signal(6, [[500, 800], [4000, 4300]])))).toEqual([])
  })

  it('returns segments unchanged when the WAV is not 16-bit mono PCM', () => {
    const segments = [ts(0, 1000)]
    expect(withCoverageMarkers(segments, wav(signal(4, [[1000, 3000]]), { bits: 8 }))).toBe(segments)
  })
})
