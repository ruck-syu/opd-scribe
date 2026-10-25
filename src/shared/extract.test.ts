import { describe, expect, it } from 'vitest'
import { applySuggestion, extractRules, verifySuggestion, type Suggestion } from './extract'
import { DEFAULT_SETTINGS, emptyDocument } from './defaults'
import { getSection } from './sections'
import type { Speaker, Transcript, TranscriptSegment, VisitDocument } from './types'

const seg = (id: string, text: string, speaker: Speaker = 'doctor', extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id,
  startMs: 0,
  endMs: 1,
  originalText: text,
  text,
  speaker,
  speakerUncertain: false,
  warning: '',
  ...extra
})

const transcript = (segments: TranscriptSegment[], status: Transcript['status'] = 'ready'): Transcript => ({
  id: 't1',
  encounterId: 'e1',
  kind: 'conversation',
  section: null,
  createdAt: '',
  durationMs: 1000,
  status,
  error: '',
  reviewed: false,
  audioRetained: false,
  segments
})

const opts = {
  symptoms: ['Fever', 'Breathlessness', 'Pain'],
  toxicities: ['Nausea / vomiting', 'Diarrhea', 'Neuropathy', 'Mucositis'],
  formulary: ['Ondansetron', 'Pantoprazole']
}

const run = (text: string, speaker: Speaker = 'doctor'): ReturnType<typeof extractRules> =>
  extractRules(transcript([seg('s1', text, speaker)]), opts)

const sugg = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: 'x',
  transcriptId: 't1',
  segmentIds: ['s1'],
  target: { kind: 'ecog' },
  value: '1',
  quote: 'ECOG 1',
  engine: 'rules',
  status: 'pending',
  warning: '',
  ...over
})

const doc = (): VisitDocument => emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')

describe('vital signs', () => {
  it.each([
    ['BP 130/80', 'bp', '130/80'],
    ['BP 130 by 80', 'bp', '130/80'],
    ['blood pressure 130 over 80', 'bp', '130/80'],
    ['pulse 78', 'pulse', '78'],
    ['HR 88', 'pulse', '88'],
    ['heart rate 90', 'pulse', '90'],
    ['temp 99', 'temperature', '99'],
    ['temperature 38.2 C', 'temperature', '38.2 °C'],
    ['bukhar 101 F', 'temperature', '101 °F'],
    ['SpO2 96', 'spo2', '96'],
    ['saturation 96%', 'spo2', '96'],
    ['RR 18', 'respiratoryRate', '18'],
    ['weight 62 kg', 'weight', '62 kg'],
    ['wajan 62 kilo', 'weight', '62 kg'],
    ['height 160 cm', 'height', '160 cm']
  ])('"%s" becomes %s = %s, quoting the spoken words', (text, key, value) => {
    const r = run(text)
    expect(r.rejected).toEqual([])
    expect(r.suggestions).toHaveLength(1)
    expect(r.suggestions[0]).toMatchObject({ value, quote: text, target: { kind: 'vital', key } })
  })

  it('ignores implausible or unitless-day readings', () => {
    expect(run('BP 80/120').suggestions).toEqual([])
    expect(run('bukhar 10 din').suggestions).toEqual([])
  })
})

describe('ECOG', () => {
  it.each([
    ['ECOG 1', '1'],
    ['ECOG PS 2', '2'],
    ['performance status 1', '1'],
    ['ECOG do', '2']
  ])('"%s" becomes %s', (text, value) => {
    const r = run(text)
    expect(r.suggestions).toEqual([expect.objectContaining({ value, target: { kind: 'ecog' } })])
  })

  it('rejects an out-of-range grade instead of dropping it', () => {
    const r = run('ECOG 5')
    expect(r.suggestions).toEqual([])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0].reason).toContain('0 to 4')
  })
})

describe('cycle, day and regimen', () => {
  it('reads cycle and day from "cycle 4 day 8" and from C4D1', () => {
    const a = run('Cycle 4 day 8')
    expect(a.suggestions.map((s) => [s.target, s.value])).toEqual([
      [{ kind: 'oncology', key: 'cycleNumber' }, '4'],
      [{ kind: 'oncology', key: 'cycleDay' }, '8']
    ])
    const b = run('C4D1 today')
    expect(b.suggestions.map((s) => [s.target, s.value, s.quote])).toEqual([
      [{ kind: 'oncology', key: 'cycleNumber' }, '4', 'C4D1'],
      [{ kind: 'oncology', key: 'cycleDay' }, '1', 'C4D1']
    ])
  })

  it('takes a regimen only from a known whole token and quotes it', () => {
    const r = run('Continue FOLFOX, cycle 4')
    expect(r.suggestions).toContainEqual(expect.objectContaining({ value: 'FOLFOX', quote: 'FOLFOX', target: { kind: 'oncology', key: 'regimen' } }))
  })

  it('matches short regimen tokens case-sensitively', () => {
    expect(run('Plan AC chemo').suggestions).toContainEqual(expect.objectContaining({ value: 'AC', target: { kind: 'oncology', key: 'regimen' } }))
    expect(run('back pain since 3 days').suggestions.some((s) => s.target.kind === 'oncology')).toBe(false)
  })
})

describe('symptoms and toxicities', () => {
  const finding = (r: ReturnType<typeof extractRules>, name: string): Suggestion | undefined =>
    r.suggestions.find((s) => s.target.kind === 'finding' && s.target.name === name)

  it.each([
    ['bukhar hai', 'Fever', 'present'],
    ['has fever', 'Fever', 'present'],
    ['no fever', 'Fever', 'absent'],
    ['fever nahi hai', 'Fever', 'absent'],
    ['denies vomiting', 'Nausea / vomiting', 'absent'],
    ['ulti nahi hai', 'Nausea / vomiting', 'absent'],
    ['ulti ho rahi hai', 'Nausea / vomiting', 'present'],
    ['has loose motions', 'Diarrhea', 'present'],
    ['tingling in fingers, has numbness', 'Neuropathy', 'present'],
    ['saans phoolna hai', 'Breathlessness', 'present']
  ])('"%s" marks %s as %s', (text, name, state) => {
    const r = run(text)
    expect(finding(r, name)).toMatchObject({ value: state, target: { kind: 'finding', name, state } })
  })

  it('reads each clause separately in Hinglish', () => {
    const r = run('bukhar nahi hai, ulti hai')
    expect(finding(r, 'Fever')?.value).toBe('absent')
    expect(finding(r, 'Nausea / vomiting')?.value).toBe('present')
  })

  it('gives no state when nothing is explicitly said', () => {
    expect(run('fever since 3 days').suggestions).toEqual([])
    expect(run('vomiting').suggestions).toEqual([])
  })

  it('emits a warning and no state when a symptom is both affirmed and negated', () => {
    const t = transcript([seg('s1', 'has fever'), seg('s2', 'no fever')])
    const r = extractRules(t, opts)
    const fever = r.suggestions.filter((s) => s.target.kind === 'finding' && s.target.name === 'Fever')
    expect(fever).toHaveLength(1)
    expect(fever[0].value).toBe('')
    expect(fever[0].warning).toContain('both')
    expect(fever[0].segmentIds).toEqual(['s1', 's2'])
    expect(() => applySuggestion(doc(), fever[0], 'conversation')).toThrow('no state to apply')
  })

  it('warns when the speaker is not confirmed', () => {
    expect(run('bukhar hai', 'unlabelled').suggestions[0].warning).toContain('Speaker not confirmed')
  })
})

describe('medications', () => {
  const med = (r: ReturnType<typeof extractRules>, name: string): Extract<Suggestion['target'], { kind: 'medication' }>['med'] | undefined => {
    const s = r.suggestions.find((x) => x.target.kind === 'medication' && x.target.med.name === name)
    return s?.target.kind === 'medication' ? s.target.med : undefined
  }

  it('fills only the spoken fields and leaves a missing frequency empty', () => {
    const text = 'Start Ondansetron 8 mg 1 tab for 5 days'
    const r = run(text)
    expect(r.rejected).toEqual([])
    expect(r.suggestions).toHaveLength(1)
    expect(r.suggestions[0].value).toBe('Ondansetron, 8 mg, 1 tab, 5 days')
    expect(med(r, 'Ondansetron')).toEqual({
      name: 'Ondansetron',
      formulationStrength: '8 mg',
      dose: '1 tab',
      route: '',
      frequency: '',
      duration: '5 days',
      quantity: '',
      instructions: '',
      sourceText: text
    })
  })

  it('maps spoken frequency, route and duration to canonical values', () => {
    expect(med(run('Ondansetron 4 mg OD by mouth'), 'Ondansetron')).toMatchObject({ frequency: 'OD', route: 'oral' })
    expect(med(run('Ondansetron 4 mg din mein do baar for 1 week'), 'Ondansetron')).toMatchObject({ frequency: 'BD', duration: '1 week' })
    expect(med(run('Pantoprazole 40 mg 1-0-1 IV'), 'Pantoprazole')).toMatchObject({ frequency: '1-0-1', route: 'IV' })
  })

  it('does not take a duration that describes the past', () => {
    expect(med(run('Ondansetron 4 mg, started 2 weeks ago'), 'Ondansetron')?.duration).toBe('')
  })

  it('gives each medicine in one segment only its own fields', () => {
    const r = run('Ondansetron 8 mg OD and Pantoprazole 40 mg BD')
    expect(med(r, 'Ondansetron')).toMatchObject({ formulationStrength: '8 mg', frequency: 'OD', dose: '' })
    expect(med(r, 'Pantoprazole')).toMatchObject({ formulationStrength: '40 mg', frequency: 'BD' })
  })

  it('makes no medication suggestion for a drug outside the formulary', () => {
    const r = run('Inj Paracetamol 1 g 1 tab OD for 3 days')
    expect(r.suggestions.some((s) => s.target.kind === 'medication')).toBe(false)
  })
})

describe('verifySuggestion', () => {
  const t = transcript([seg('s1', 'Ondansetron 1.5 mg OD'), seg('s2', 'Ondansetron 4 mg')])
  const medSugg = (strength: string, quote: string, segmentIds = ['s1']): Suggestion =>
    sugg({
      segmentIds,
      target: {
        kind: 'medication',
        med: { name: 'Ondansetron', formulationStrength: strength, dose: '', route: '', frequency: '', duration: '', quantity: '', instructions: '', sourceText: quote }
      },
      value: `Ondansetron, ${strength}`,
      quote
    })

  it('rejects 15 mg when the quote says 1.5 mg', () => {
    const v = verifySuggestion(medSugg('15 mg', 'Ondansetron 1.5 mg OD'), t)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain('not said')
  })

  it('accepts 1.5 mg when the quote says 1.5 mg', () => {
    expect(verifySuggestion(medSugg('1.5 mg', 'Ondansetron 1.5 mg OD'), t)).toEqual({ ok: true })
  })

  it('rejects a fabricated quote', () => {
    const v = verifySuggestion(medSugg('8 mg', 'Ondansetron 8 mg'), t)
    expect(v).toEqual({ ok: false, reason: 'quote is not in the source segment' })
  })

  it('rejects an unknown segment, an unknown transcript and an empty value', () => {
    expect(verifySuggestion(sugg({ segmentIds: ['nope'], quote: 'ECOG 1' }), transcript([seg('s1', 'ECOG 1')])).ok).toBe(false)
    expect(verifySuggestion(sugg({ transcriptId: 'other', quote: 'ECOG 1' }), transcript([seg('s1', 'ECOG 1')])).ok).toBe(false)
    expect(verifySuggestion(sugg({ value: '' }), transcript([seg('s1', 'ECOG 1')])).ok).toBe(false)
  })

  it('compares quotes ignoring case and whitespace', () => {
    expect(verifySuggestion(medSugg('4 mg', 'ONDANSETRON   4  MG', ['s2']), t)).toEqual({ ok: true })
  })

  it('accepts a conflict only with a warning and a verbatim quote', () => {
    const conflict = sugg({ target: { kind: 'finding', list: 'symptoms', name: 'Fever', state: 'present' }, value: '', quote: 'ECOG 1', warning: 'conflict' })
    expect(verifySuggestion(conflict, transcript([seg('s1', 'ECOG 1')]))).toEqual({ ok: true })
    expect(verifySuggestion({ ...conflict, warning: '' }, transcript([seg('s1', 'ECOG 1')])).ok).toBe(false)
  })
})

describe('sections', () => {
  it('routes doctor cues to their sections and keeps the text verbatim', () => {
    const cases: [string, string][] = [
      ['On examination: pallor, no icterus', 'examination'],
      ['Impression: progressive disease', 'assessment'],
      ['Plan: continue treatment', 'plan'],
      ['Advice: avoid crowds', 'prescription.advice'],
      ['Follow up after 2 weeks', 'prescription.followUp'],
      ['Send CBC, LFT and CT chest', 'prescription.investigationsAdvised']
    ]
    for (const [text, key] of cases) {
      const s = run(text).suggestions.find((x) => x.target.kind === 'section')
      expect(s, text).toMatchObject({ value: text, target: { kind: 'section', key } })
    }
  })

  it('never gives a patient or attendant an examination, assessment, plan or advice', () => {
    const r = extractRules(
      transcript([
        seg('s1', 'Impression: progression', 'patient'),
        seg('s2', 'On examination: swelling', 'attendant'),
        seg('s3', 'Plan: start pills', 'patient'),
        seg('s4', 'Advice: rest', 'patient'),
        seg('s5', 'mujhe bukhar hai', 'patient'),
        seg('s6', 'since 3 days, weight loss', 'attendant')
      ]),
      opts
    )
    const keys = r.suggestions.filter((s) => s.target.kind === 'section').map((s) => (s.target.kind === 'section' ? s.target.key : ''))
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((k) => k === 'history.chiefComplaints' || k === 'history.hpi')).toBe(true)
    expect(keys).toEqual(['history.chiefComplaints', 'history.hpi'])
  })

  it('warns that an unlabelled segment has no confirmed speaker', () => {
    const s = run('Impression: stable', 'unlabelled').suggestions[0]
    expect(s.warning).toContain('Speaker not confirmed')
  })

  it('ignores untranscribed-audio markers', () => {
    const r = run('[untranscribed audio 00:01–00:05] BP 130/80 Impression: stable')
    expect(r.suggestions).toEqual([])
    expect(r.rejected).toEqual([])
  })

  it('emits nothing unless the transcript is ready', () => {
    const r = extractRules(transcript([seg('s1', 'BP 130/80')], 'transcribing'), opts)
    expect(r).toEqual({ suggestions: [], rejected: [] })
  })
})

describe('applySuggestion', () => {
  it('refuses to overwrite a vital with a different value', () => {
    const d = doc()
    d.vitals.bp = '120/80'
    expect(() => applySuggestion(d, sugg({ target: { kind: 'vital', key: 'bp' }, value: '130/80', quote: 'BP 130/80' }), 'conversation')).toThrow(
      'vitals.bp already has a value'
    )
  })

  it('refuses to overwrite ECOG but accepts the same value', () => {
    const d = doc()
    d.oncology.ecog = 2
    expect(() => applySuggestion(d, sugg({ value: '1' }), 'conversation')).toThrow('oncology.ecog already has a value')
    expect(applySuggestion(d, sugg({ value: '2' }), 'conversation').oncology.ecog).toBe(2)
  })

  it('does not mutate the input document', () => {
    const d = doc()
    const before = JSON.stringify(d)
    const next = applySuggestion(d, sugg({ target: { kind: 'vital', key: 'bp' }, value: '130/80', quote: 'BP 130/80' }), 'conversation')
    expect(JSON.stringify(d)).toBe(before)
    expect(next).not.toBe(d)
    expect(next.vitals.bp).toBe('130/80')
  })

  it('appends a section verbatim with provenance', () => {
    const next = applySuggestion(
      doc(),
      sugg({ target: { kind: 'section', key: 'history.hpi' }, value: 'fever 2 days', quote: 'fever 2 days', segmentIds: ['s1', 's2'] }),
      'conversation'
    )
    const section = getSection(next, 'history.hpi')
    expect(section.text).toBe('fever 2 days')
    expect(section.sources).toEqual([expect.objectContaining({ kind: 'conversation', refId: 't1:s1,s2' })])
  })

  it('sets a finding state by name without touching others', () => {
    const d = doc()
    const next = applySuggestion(
      d,
      sugg({ target: { kind: 'finding', list: 'symptoms', name: 'cough', state: 'present' }, value: 'present', quote: 'khansi hai' }),
      'conversation'
    )
    expect(next.history.symptoms.find((f) => f.name === 'Cough')?.state).toBe('present')
    expect(next.history.symptoms.filter((f) => f.state !== 'not_assessed')).toHaveLength(1)
    expect(d.history.symptoms.every((f) => f.state === 'not_assessed')).toBe(true)
    expect(next.oncology.toxicities.every((f) => f.state === 'not_assessed')).toBe(true)
  })

  it('refuses a finding that is not in the checklist', () => {
    expect(() =>
      applySuggestion(
        doc(),
        sugg({ target: { kind: 'finding', list: 'toxicities', name: 'Hiccups', state: 'present' }, value: 'present', quote: 'hiccups' }),
        'conversation'
      )
    ).toThrow('not in the toxicities checklist')
  })

  it('adds a medication with a fresh id and leaves the input list alone', () => {
    const d = doc()
    const s = extractRules(transcript([seg('s1', 'Ondansetron 8 mg 1 tab')]), opts).suggestions[0]
    const next = applySuggestion(d, s, 'dictation')
    expect(d.prescription.medications).toHaveLength(0)
    expect(next.prescription.medications).toHaveLength(1)
    expect(next.prescription.medications[0]).toMatchObject({ name: 'Ondansetron', frequency: '', dose: '1 tab' })
    expect(next.prescription.medications[0].id).toBeTruthy()
  })
})

describe('determinism', () => {
  it('gives the same suggestions and ids on a rerun of the same input', () => {
    const t = transcript([seg('s1', 'BP 130 by 80, ECOG 1, has fever'), seg('s2', 'Ondansetron 8 mg OD'), seg('s3', 'Plan: continue')])
    const a = extractRules(t, opts)
    const b = extractRules(t, opts)
    expect(a).toEqual(b)
    expect(a.suggestions.map((s) => s.id)).toEqual(b.suggestions.map((s) => s.id))
    expect(a.suggestions[0].id).toMatch(/^t1:rules:[0-9a-f]{8}$/)
  })

  it('keeps an id when an unrelated segment is edited or added', () => {
    const before = extractRules(transcript([seg('s1', 'Hello'), seg('s2', 'Ondansetron 8 mg OD')]), opts)
    const after = extractRules(transcript([seg('s0', 'BP 120/80'), seg('s1', 'Hello there'), seg('s2', 'Ondansetron 8 mg OD')]), opts)
    const med = (r: typeof before): string | undefined => r.suggestions.find((s) => s.target.kind === 'medication')?.id
    expect(med(after)).toBe(med(before))
  })
})

describe('review fixes', () => {
  const kinds = (texts: [TranscriptSegment['speaker'], string][]) =>
    extractRules(
      transcript(texts.map(([speaker, text], i) => ({ ...seg(`s${i}`, text), speaker, speakerUncertain: false }))),
      { symptoms: ['Fever'], toxicities: ['Nausea / vomiting'], formulary: ['Ondansetron', 'Paracetamol'] }
    ).suggestions

  it('never turns a question into a finding', () => {
    expect(kinds([['doctor', 'Bukhar hai kya?'], ['doctor', 'Do you have vomiting'], ['doctor', 'Any fever']])).toEqual([])
  })

  it('does not attach a non-formulary medicine\'s details to a formulary one', () => {
    const [m] = kinds([['doctor', 'Ondansetron 4 mg and pantoprazole 40 mg BD before food']])
    expect(m.target).toMatchObject({ kind: 'medication', med: { name: 'Ondansetron', formulationStrength: '4 mg', frequency: '' } })
  })

  it('reads Hinglish "subah shaam" as BD and a stated grade as present', () => {
    const [m] = kinds([['doctor', 'Paracetamol 650 mg subah shaam']])
    expect(m.target).toMatchObject({ med: { frequency: 'BD' } })
    const r = extractRules(transcript([seg('s1', 'Grade 1 neuropathy, likely oxaliplatin related'), seg('s2', 'haathon mein jhunjhuni hai', 'patient')]), {
      symptoms: [],
      toxicities: ['Neuropathy'],
      formulary: []
    })
    expect(r.suggestions.filter((x) => x.target.kind === 'finding').map((x) => x.value)).toEqual(['present'])
  })

  it('keeps a decimal strength: the point in 1.5 mg is not a sentence end', () => {
    const [m] = kinds([['doctor', 'Ondansetron 1.5 mg BD. Review later']])
    expect(m.target).toMatchObject({ med: { formulationStrength: '1.5 mg', frequency: 'BD' } })
  })

  it('reads "twice daily" as BD, not as a clash of OD and BD', () => {
    const [m] = kinds([['doctor', 'Take ondansetron 8 mg twice daily for 5 days']])
    expect(m.target).toMatchObject({ med: { frequency: 'BD', duration: '5 days' } })
  })

  it('reads "day N" as a cycle day only in a chemotherapy context', () => {
    expect(kinds([['doctor', 'Paracetamol 650 mg every day 2 tablets']]).some((s) => s.target.kind === 'oncology')).toBe(false)
    expect(kinds([['doctor', 'Today is cycle 3 day 8']]).find((s) => s.target.kind === 'oncology' && s.target.key === 'cycleDay')?.value).toBe('8')
  })

  it('keeps speech from anyone but the doctor out of examination, assessment and plan', () => {
    expect(kinds([['other', 'Plan is to stop chemo']]).some((s) => s.target.kind === 'section')).toBe(false)
  })

  it('suggests a dictation into its own section without the speaker warning', () => {
    const t: Transcript = { ...transcript([seg('s1', 'Abdomen soft, non tender')]), kind: 'dictation', section: 'examination' }
    const [s] = extractRules(t, opts).suggestions
    expect(s.target).toEqual({ kind: 'section', key: 'examination' })
    expect(s.warning).toBe('')
  })
})
