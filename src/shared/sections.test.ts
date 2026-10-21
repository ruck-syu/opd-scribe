import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, emptyDocument } from './defaults'
import { appendToSection, getSection, segmentsText } from './sections'
import type { Transcript } from './types'

describe('sections', () => {
  it('appends verbatim with provenance, without touching other sections', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    const src = { kind: 'dictation' as const, refId: 't1', at: 'x' }
    let next = appendToSection(doc, 'history.hpi', '  fever 2 days ', src)
    next = appendToSection(next, 'history.hpi', 'no vomiting', src)
    expect(getSection(next, 'history.hpi')).toEqual({ text: 'fever 2 days\nno vomiting', sources: [src, src] })
    expect(getSection(next, 'plan').text).toBe('')
    expect(getSection(doc, 'history.hpi').text).toBe('')
  })

  it('labels speakers only for conversation', () => {
    const t = { kind: 'conversation' } as Transcript
    const segs = [
      { id: '1', startMs: 0, endMs: 1, originalText: 'a', text: 'Pain?', speaker: 'doctor', speakerUncertain: false, warning: '' },
      { id: '2', startMs: 1, endMs: 2, originalText: 'b', text: 'Yes', speaker: 'unlabelled', speakerUncertain: true, warning: '' }
    ] as const
    expect(segmentsText(t, [...segs], true)).toBe('Doctor: Pain?\nYes')
  })
})
