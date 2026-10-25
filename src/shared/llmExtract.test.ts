import { describe, expect, it } from 'vitest'
import { LLM_SCHEMA, buildPrompt, parseLlmOutput } from './llmExtract'
import type { Speaker, Transcript, TranscriptSegment } from './types'

const seg = (id: string, text: string, speaker: Speaker = 'doctor'): TranscriptSegment => ({
  id,
  startMs: 0,
  endMs: 1,
  originalText: text,
  text,
  speaker,
  speakerUncertain: false,
  warning: ''
})

const transcript = (segments: TranscriptSegment[]): Transcript => ({
  id: 't1',
  encounterId: 'e1',
  kind: 'conversation',
  section: null,
  createdAt: '',
  durationMs: 1000,
  status: 'ready',
  error: '',
  reviewed: false,
  audioRetained: false,
  segments
})

const parseOpts = { symptoms: ['Fever', 'Pain'], toxicities: ['Nausea / vomiting'] }
const out = (items: unknown[]): string => JSON.stringify({ items })

describe('buildPrompt', () => {
  const t = transcript([
    seg('s1', 'BP 130/80'),
    seg('s2', 'Bukhar hai', 'patient'),
    seg('s3', '[untranscribed audio 00:01–00:05]'),
    seg('s4', 'Okay', 'unlabelled')
  ])
  const base = { symptoms: ['Fever'], toxicities: ['Nausea / vomiting'] }

  it('numbers lines by their real index, skips untranscribed markers and names speakers', () => {
    const p = buildPrompt(t, { ...base, template: 'chatml' })
    expect(p).toContain('[1] Doctor: BP 130/80')
    expect(p).toContain('[2] Patient: Bukhar hai')
    expect(p).toContain('[4] Unknown: Okay')
    expect(p).not.toContain('untranscribed')
    expect(p).toContain('Checklist names for "finding": Fever; Nausea / vomiting')
  })

  it('wraps the system and user turns in the chosen template and ends with the assistant opener', () => {
    const chatml = buildPrompt(t, { ...base, template: 'chatml' })
    expect(chatml).toMatch(/^<\|im_start\|>system\n/)
    expect(chatml.endsWith('<|im_start|>assistant\n')).toBe(true)

    const gemma = buildPrompt(t, { ...base, template: 'gemma' })
    expect(gemma.startsWith('<start_of_turn>user\n')).toBe(true)
    expect(gemma.endsWith('<start_of_turn>model\n')).toBe(true)

    const llama3 = buildPrompt(t, { ...base, template: 'llama3' })
    expect(llama3).toContain('<|start_header_id|>user<|end_header_id|>')
    expect(llama3.endsWith('<|start_header_id|>assistant<|end_header_id|>\n\n')).toBe(true)
  })
})

describe('LLM_SCHEMA', () => {
  it('stays within what llama.cpp grammar conversion accepts', () => {
    const json = JSON.stringify(LLM_SCHEMA)
    expect(json).not.toContain('$ref')
    expect(json).not.toContain('oneOf')
    expect(json).toContain('"maxItems":40')
  })
})

describe('parseLlmOutput', () => {
  it('accepts well-cited items and maps them to targets', () => {
    const t = transcript([seg('s1', 'BP 130/80. Has fever since 3 days'), seg('s2', 'Tab Ondansetron 8 mg TDS for 3 days')])
    const raw = out([
      { segment: 1, quote: 'BP 130/80', field: 'vital.bp', value: '130/80' },
      { segment: 1, quote: 'Has fever', field: 'finding', value: 'Fever', state: 'present' },
      {
        segment: 2,
        quote: 'Tab Ondansetron 8 mg TDS for 3 days',
        field: 'medication',
        value: '',
        med: { name: 'Ondansetron', strength: '', dose: '8 mg', route: '', frequency: 'TDS', duration: '3 days', instructions: '' }
      }
    ])
    const { suggestions, rejected } = parseLlmOutput(raw, t, parseOpts)
    expect(rejected).toEqual([])
    expect(suggestions.map((s) => s.target.kind)).toEqual(['vital', 'finding', 'medication'])
    expect(suggestions.every((s) => s.engine === 'llm' && s.status === 'pending')).toBe(true)
    expect(suggestions[0]).toMatchObject({ value: '130/80', segmentIds: ['s1'], transcriptId: 't1' })
    expect(suggestions[1].target).toEqual({ kind: 'finding', list: 'symptoms', name: 'Fever', state: 'present' })
    expect(suggestions[2].value).toBe('Ondansetron, 8 mg, TDS, 3 days')
    expect(suggestions[2].target).toMatchObject({ kind: 'medication', med: { sourceText: 'Tab Ondansetron 8 mg TDS for 3 days', quantity: '' } })
    expect(suggestions[0].id).toMatch(/^t1:llm:[0-9a-f]{8}$/)
  })

  it('rejects a fabricated quote that is not in the cited line', () => {
    const t = transcript([seg('s1', 'Feels well today')])
    const { suggestions, rejected } = parseLlmOutput(out([{ segment: 1, quote: 'Patient has jaundice', field: 'assessment', value: 'Jaundice' }]), t, parseOpts)
    expect(suggestions).toEqual([])
    expect(rejected).toEqual([{ quote: 'Patient has jaundice', value: 'Jaundice', reason: 'quote is not in the source segment' }])
  })

  it('never takes a dose number the line did not say (15 mg from a line saying 1.5 mg)', () => {
    const t = transcript([seg('s1', 'Tab Ondansetron 1.5 mg TDS')])
    const raw = out([
      {
        segment: 1,
        quote: 'Tab Ondansetron 1.5 mg TDS',
        field: 'medication',
        value: '',
        med: { name: 'Ondansetron', strength: '15 mg', dose: '', route: '', frequency: 'TDS', duration: '', instructions: '' }
      }
    ])
    const [s] = parseLlmOutput(raw, t, parseOpts).suggestions
    expect(s.target).toMatchObject({ med: { formulationStrength: '1.5 mg' } })
    expect(s.warning).toContain('strength "15 mg" (the line says "1.5 mg")')
  })

  it('blanks a route, frequency or duration the quote does not say, and warns', () => {
    const t = transcript([seg('s1', 'Ondansetron 8 mg for 5 days')])
    const raw = out([
      {
        segment: 1,
        quote: 'Ondansetron 8 mg for 5 days',
        field: 'medication',
        value: '',
        med: { name: 'Ondansetron', strength: '8 mg', dose: '', route: 'oral', frequency: 'BD', duration: '5 days', instructions: 'after food' }
      }
    ])
    const [s] = parseLlmOutput(raw, t, parseOpts).suggestions
    expect(s.target).toMatchObject({ med: { route: '', frequency: '', duration: '5 days', instructions: '' } })
    expect(s.warning).toContain('route "oral"')
    expect(s.warning).toContain('frequency "BD"')
    expect(s.warning).toContain('instructions "after food"')
  })

  it('keeps a frequency the rules read from the quote in another form', () => {
    const t = transcript([seg('s1', 'Ondansetron 8 mg twice daily')])
    const raw = out([
      { segment: 1, quote: 'Ondansetron 8 mg twice daily', field: 'medication', value: '', med: { name: 'Ondansetron', strength: '8 mg', dose: '', route: '', frequency: 'BD', duration: '', instructions: '' } }
    ])
    const [s] = parseLlmOutput(raw, t, parseOpts).suggestions
    expect(s.target).toMatchObject({ med: { frequency: 'BD' } })
    expect(s.warning).not.toContain('not in the quote')
  })

  it('reads medication details from the medicine\'s own words, not from where the model put them', () => {
    // real model output: frequency in dose, duration in frequency, the next medicine in instructions
    const t = transcript([seg('s1', 'Ondansetron 8 mg twice daily for 5 days and pantoprazole 40 mg OD.')])
    const raw = out([
      { segment: 1, quote: 'Ondansetron 8 mg twice daily for 5 days and pantoprazole 40 mg OD.', field: 'medication', value: '', state: '',
        med: { name: 'Ondansetron', strength: '8 mg', dose: 'twice daily', route: '', frequency: 'for 5 days', duration: '', instructions: 'and pantoprazole 40 mg OD' } },
      { segment: 1, quote: 'pantoprazole 40 mg OD', field: 'medication', value: '', state: '',
        med: { name: 'Pantoprazole', strength: '40 mg', dose: '', route: 'oral', frequency: 'OD', duration: '', instructions: '' } }
    ])
    const [ond, pan] = parseLlmOutput(raw, t, parseOpts).suggestions
    expect(ond.target).toMatchObject({ med: { formulationStrength: '8 mg', dose: '', frequency: 'BD', duration: '5 days', instructions: '' } })
    expect(ond.warning).toContain('not said that way in the line')
    // a medicine outside the formulary still comes through, with only what was said for it
    expect(pan.target).toMatchObject({ med: { name: 'Pantoprazole', formulationStrength: '40 mg', frequency: 'OD', route: '' } })
  })

  it('skips items that propose no value without listing them as rejected', () => {
    const t = transcript([seg('s1', 'BP 130 by 80')])
    const { suggestions, rejected } = parseLlmOutput(out([{ segment: 1, quote: 'BP 130 by 80', field: 'vital.pulse', value: '' }]), t, parseOpts)
    expect(suggestions).toEqual([])
    expect(rejected).toEqual([])
  })

  it('rejects a checklist name that is not on either list', () => {
    const t = transcript([seg('s1', 'has hiccups')])
    const { suggestions, rejected } = parseLlmOutput(out([{ segment: 1, quote: 'has hiccups', field: 'finding', value: 'Hiccups', state: 'present' }]), t, parseOpts)
    expect(suggestions).toEqual([])
    expect(rejected[0].reason).toBe('"Hiccups" is not a checklist name')
  })

  it('rejects a finding whose quote does not say what the state claims', () => {
    const t = transcript([seg('s1', 'no fever at all')])
    const { suggestions, rejected } = parseLlmOutput(out([{ segment: 1, quote: 'no fever at all', field: 'finding', value: 'Fever', state: 'present' }]), t, parseOpts)
    expect(suggestions).toEqual([])
    expect(rejected[0].reason).toBe('the quote does not say Fever is present')
  })

  it('rejects patient speech for anything other than history', () => {
    const t = transcript([seg('s1', 'I feel better now, no pain', 'patient')])
    const { suggestions, rejected } = parseLlmOutput(
      out([
        { segment: 1, quote: 'I feel better now', field: 'assessment', value: 'Improving' },
        { segment: 1, quote: 'no pain', field: 'finding', value: 'Pain', state: 'absent' }
      ]),
      t,
      parseOpts
    )
    expect(suggestions).toEqual([])
    expect(rejected.map((r) => r.reason)).toEqual([
      'patient speech can only feed history fields',
      'patient speech can only feed history fields'
    ])
  })

  it('puts the speaker\'s own words into a section, never the model\'s rendering', () => {
    // a real 4B model rendered "ulti" (vomiting) as "Urticaria"
    const t = transcript([seg('s1', 'Mujhe teen din se ulti ho rahi hai', 'patient')])
    const { suggestions, rejected } = parseLlmOutput(out([{ segment: 1, quote: 'teen din se ulti', field: 'chiefComplaints', value: 'Urticaria' }]), t, parseOpts)
    expect(rejected).toEqual([])
    expect(suggestions[0]).toMatchObject({ target: { kind: 'section', key: 'history.chiefComplaints' }, value: 'Mujhe teen din se ulti ho rahi hai', warning: '' })
  })

  it('rejects any item cited from a question', () => {
    const t = transcript([seg('s1', 'Bukhar hai kya?')])
    const { suggestions, rejected } = parseLlmOutput(out([{ segment: 1, quote: 'Bukhar hai kya?', field: 'hpi', value: 'Patient asks if fever is present' }]), t, parseOpts)
    expect(suggestions).toEqual([])
    expect(rejected[0].reason).toBe('questions are not statements')
  })

  it('tolerates text around the JSON', () => {
    const t = transcript([seg('s1', 'Plan review in 2 weeks')])
    const raw = `Sure, here it is:\n\`\`\`json\n${out([{ segment: 1, quote: 'review in 2 weeks', field: 'followUp', value: 'Review in 2 weeks' }])}\n\`\`\`\nDone.`
    const { suggestions, rejected } = parseLlmOutput(raw, t, parseOpts)
    expect(rejected).toEqual([])
    expect(suggestions.map((s) => s.target)).toEqual([{ kind: 'section', key: 'prescription.followUp' }])
  })

  it('reads JSON followed by the engine end-of-text marker and blank lines', () => {
    const t = transcript([seg('s1', 'BP 130/80')])
    const raw = '{\n  "items": [\n    {"segment": 1, "quote": "BP 130/80", "field": "vital.bp", "value": "130/80"}\n  ]\n} [end of text]\n\n'
    const { suggestions, rejected } = parseLlmOutput(raw, t, parseOpts)
    expect(rejected).toEqual([])
    expect(suggestions.map((s) => s.value)).toEqual(['130/80'])
  })

  it('reports invalid JSON as one rejected entry', () => {
    const t = transcript([seg('s1', 'BP 130/80')])
    expect(parseLlmOutput('{"items": [', t, parseOpts)).toEqual({
      suggestions: [],
      rejected: [{ quote: '', value: '', reason: 'model output was not valid JSON' }]
    })
    expect(parseLlmOutput('no json here', t, parseOpts).rejected).toHaveLength(1)
  })
})
