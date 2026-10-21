import { describe, expect, it } from 'vitest'
import { parseWhisperJson } from './asr'

const seg = (from: number, to: number, text: string) => ({ offsets: { from, to }, text })

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
