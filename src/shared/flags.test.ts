import { describe, expect, it } from 'vitest'
import { canVerify, computeFlags } from './flags'
import { DEFAULT_SETTINGS, emptyDocument } from './defaults'
import type { Suggestion } from './extract'
import type { Finding, Medication, Patient, Transcript, VisitDocument } from './types'

const patient: Patient = {
  id: 'p1',
  mrn: 'MRN1',
  name: 'Test Patient',
  dateOfBirth: '1970-01-01',
  ageDisplay: '',
  sex: 'female',
  phone: '',
  address: '',
  createdAt: '',
  updatedAt: ''
}

const ids = (f: { id: string }[]): string[] => f.map((x) => x.id)
const acks = (f: { ackKey: string }[]): string[] => f.map((x) => x.ackKey)

const med = (id: string, name: string): Medication => ({
  id,
  name,
  formulationStrength: '',
  dose: '4 mg',
  route: 'oral',
  frequency: 'once daily',
  duration: '3 days',
  quantity: '',
  instructions: '',
  sourceText: ''
})

const conversation = (): Transcript => ({
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
  segments: [
    { id: 's1', startMs: 0, endMs: 1, originalText: 'x', text: 'x', speaker: 'unlabelled', speakerUncertain: true, warning: 'repeated' }
  ]
})

describe('computeFlags', () => {
  it('blocks incomplete medications without guessing', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    doc.prescription.medications.push({
      id: 'm1',
      name: 'Ondansetron',
      formulationStrength: '4 mg',
      dose: '',
      route: 'oral',
      frequency: '',
      duration: '3 days',
      quantity: '',
      instructions: '',
      sourceText: ''
    })
    const flags = computeFlags(patient, doc, [])
    const rx = flags.find((f) => f.id === 'rx.m1.incomplete')
    expect(rx?.severity).toBe('blocking')
    expect(rx?.message).toContain('dose, frequency')
    expect(canVerify(flags, acks(flags))).toBe(false)
  })

  it('blocks missing identity and clearance reason', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '')
    doc.oncology.clearance.decision = 'defer'
    const flags = computeFlags({ ...patient, dateOfBirth: null, mrn: ' ' }, doc, [])
    expect(ids(flags)).toEqual(
      expect.arrayContaining(['identity.mrn', 'identity.age', 'identity.visitDate', 'onc.clearance.reason'])
    )
  })

  it('warnings require acknowledgement', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    const flags = computeFlags(patient, doc, [conversation()])
    expect(flags.every((f) => f.severity === 'warning')).toBe(true)
    expect(ids(flags)).toEqual(expect.arrayContaining(['tx.t1.unreviewed', 'tx.t1.speakers', 'tx.t1.warnings', 'onc.ecog']))
    expect(canVerify(flags, [])).toBe(false)
    expect(canVerify(flags, acks(flags))).toBe(true)
  })
})

describe('acknowledgement keys', () => {
  it('stay stable while the flagged content is unchanged', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    doc.oncology.regimen = 'TPF'
    doc.prescription.medications.push(med('m1', 'Ondansetron'))
    const first = computeFlags(patient, doc, [conversation()])
    const second = computeFlags(patient, doc, [conversation()])
    expect(acks(first)).toEqual(acks(second))
    expect(first.every((f) => f.ackKey.startsWith(f.id + '#'))).toBe(true)
  })

  it('change when the warned content changes', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    doc.oncology.regimen = 'TPF'
    const before = computeFlags(patient, doc, [])
    const regimen = before.find((f) => f.id === 'onc.clearance')
    doc.oncology.regimen = 'TPF 2'
    const after = computeFlags(patient, doc, [])
    expect(after.find((f) => f.id === 'onc.clearance')?.ackKey).not.toBe(regimen?.ackKey)
    // a flag whose content did not change keeps its key
    expect(acks(after)).toEqual(expect.arrayContaining(acks(before).filter((k) => !k.startsWith('onc.clearance#'))))
  })

  it('change when a warned transcript segment changes', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    const t = conversation()
    const before = computeFlags(patient, doc, [t])
    t.segments[0].text = 'corrected wording'
    const after = computeFlags(patient, doc, [t])
    expect(after.find((f) => f.id === 'tx.t1.warnings')?.ackKey).not.toBe(
      before.find((f) => f.id === 'tx.t1.warnings')?.ackKey
    )
    // segment text is not the subject of the speaker warning
    expect(after.find((f) => f.id === 'tx.t1.speakers')?.ackKey).toBe(before.find((f) => f.id === 'tx.t1.speakers')?.ackKey)
  })

  it('old acknowledgements stop counting after a content change', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    doc.oncology.regimen = 'TPF'
    const before = computeFlags(patient, doc, [])
    const oldAcks = acks(before)
    expect(canVerify(before, oldAcks)).toBe(true)
    doc.oncology.regimen = 'TPF 2'
    const after = computeFlags(patient, doc, [])
    expect(canVerify(after, oldAcks)).toBe(false)
    expect(canVerify(after, acks(after))).toBe(true)
    // ids never acknowledge anything on their own
    expect(canVerify(before, ids(before))).toBe(false)
  })
})

describe('clinic formulary', () => {
  const docWith = (...meds: Medication[]): ReturnType<typeof emptyDocument> => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    doc.prescription.medications.push(...meds)
    return doc
  }

  it('does not flag a medication that matches the formulary', () => {
    const doc = docWith(
      med('m1', 'Ondansetron 8 mg'),
      med('m2', 'ondansetron'),
      med('m3', 'Tab. Ondansetron'),
      med('m4', 'Inj Trastuzumab-dkst'),
      med('m5', 'ओन्डान्सेट्रॉन')
    )
    const flags = computeFlags(patient, doc, [], ['Ondansetron', 'Trastuzumab dkst', 'ओन्डान्सेट्रॉन'])
    expect(flags.filter((f) => f.id.endsWith('.formulary'))).toEqual([])
  })

  it('flags a medication that matches no entry', () => {
    const doc = docWith(med('m1', 'Paracetamol'))
    const flags = computeFlags(patient, doc, [], ['ondansetron'])
    const flag = flags.find((f) => f.id === 'rx.m1.formulary')
    expect(flag?.severity).toBe('warning')
    expect(flag?.area).toBe('prescription')
    expect(flag?.message).toBe('Paracetamol: not in the clinic formulary — check the spelling')
    // a whole-word match is required, not a substring
    expect(computeFlags(patient, docWith(med('m1', 'Ondansetronx')), [], ['ondansetron']).some((f) => f.id === 'rx.m1.formulary')).toBe(true)
  })

  it('suggests the closest formulary entry within distance 2', () => {
    const doc = docWith(med('m1', 'Ondansetrn'), med('m2', 'Metformn 500 mg'), med('m3', 'Tab Ondansetrn'))
    const flags = computeFlags(patient, doc, [], ['ondansetron', 'metformin'])
    expect(flags.find((f) => f.id === 'rx.m1.formulary')?.message).toContain('(closest: ondansetron)')
    expect(flags.find((f) => f.id === 'rx.m2.formulary')?.message).toContain('(closest: metformin)')
    expect(flags.find((f) => f.id === 'rx.m3.formulary')?.message).toContain('(closest: ondansetron)')
  })

  it('adds no flag when the formulary is empty', () => {
    const doc = docWith(med('m1', 'Ondansetrn'))
    expect(computeFlags(patient, doc, [], []).some((f) => f.id.endsWith('.formulary'))).toBe(false)
    expect(computeFlags(patient, doc, []).some((f) => f.id.endsWith('.formulary'))).toBe(false)
  })

  it('never changes the medication', () => {
    const medication = med('m1', 'Ondansetrn')
    const doc = docWith(medication)
    const snapshot = JSON.parse(JSON.stringify(doc.prescription.medications))
    computeFlags(patient, doc, [], ['ondansetron'])
    expect(doc.prescription.medications).toEqual(snapshot)
    expect(doc.prescription.medications[0].name).toBe('Ondansetrn')
  })
})

/** Flags whose id matches the rule prefix; the rules under test are all warnings unless stated. */
const ruleIds = (f: { id: string }[], prefix: string): string[] => f.map((x) => x.id).filter((id) => id.startsWith(prefix))

const withDoc = (edit: (d: VisitDocument) => void): VisitDocument => {
  const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
  edit(doc)
  return doc
}

const medDoc = (fields: Partial<Medication>): VisitDocument =>
  withDoc((d) => d.prescription.medications.push({ ...med('m1', 'Ondansetron'), ...fields }))

describe('ambiguous medication numbers', () => {
  const issuesFor = (fields: Partial<Medication>): string[] =>
    ruleIds(computeFlags(patient, medDoc(fields), []), 'rx.m1.ambiguous')

  it('does not flag clear amounts', () => {
    expect(issuesFor({ dose: '0.5 mg' })).toEqual([])
    expect(issuesFor({ dose: '8 mg', formulationStrength: '4 mg/ml', quantity: '10' })).toEqual([])
    expect(issuesFor({ dose: '1 tab', frequency: 'twice daily', duration: '3 days' })).toEqual([])
    expect(issuesFor({ dose: '500 µg' })).toEqual([])
  })

  it('treats 1-0-1 schedule notation as normal, not a range', () => {
    expect(issuesFor({ frequency: '1-0-1' })).toEqual([])
    expect(issuesFor({ frequency: '1 - 0 - 1 after food' })).toEqual([])
    expect(issuesFor({ frequency: '0-0-1' })).toEqual([])
  })

  it('flags a decimal without a leading zero', () => {
    expect(issuesFor({ dose: '.5 mg' })).toEqual(['rx.m1.ambiguous'])
    const flag = computeFlags(patient, medDoc({ dose: '.5 mg' }), []).find((f) => f.id === 'rx.m1.ambiguous')
    expect(flag?.severity).toBe('warning')
    expect(flag?.message).toContain('missing leading zero')
  })

  it('flags a trailing zero', () => {
    const flag = computeFlags(patient, medDoc({ dose: '5.0 mg' }), []).find((f) => f.id === 'rx.m1.ambiguous')
    expect(flag?.message).toContain('trailing zero')
    expect(issuesFor({ dose: '1.05 mg' })).toEqual([])
  })

  it('flags ranges and fractions', () => {
    expect(issuesFor({ dose: '1-2 tab' })).toEqual(['rx.m1.ambiguous'])
    expect(issuesFor({ dose: '1 to 2 tab' })).toEqual(['rx.m1.ambiguous'])
    expect(issuesFor({ frequency: '6-8 hourly' })).toEqual(['rx.m1.ambiguous'])
    expect(issuesFor({ dose: '1/2 tab' })).toEqual(['rx.m1.ambiguous'])
  })

  it('flags a dose or strength with no unit, but not a bare quantity', () => {
    expect(computeFlags(patient, medDoc({ dose: '8' }), []).find((f) => f.id === 'rx.m1.ambiguous')?.message).toContain('no unit')
    expect(issuesFor({ formulationStrength: '4' })).toEqual(['rx.m1.ambiguous'])
    expect(issuesFor({ quantity: '10' })).toEqual([])
  })

  it('flags error-prone abbreviations', () => {
    expect(issuesFor({ dose: '10 u' })).toEqual(['rx.m1.ambiguous'])
    expect(issuesFor({ dose: '1000 IU' })).toEqual(['rx.m1.ambiguous'])
    expect(issuesFor({ quantity: '2 cc' })).toEqual(['rx.m1.ambiguous'])
    expect(issuesFor({ frequency: 'QD' })).toEqual(['rx.m1.ambiguous'])
    expect(issuesFor({ dose: '500 ug' })).toEqual(['rx.m1.ambiguous'])
    // "units" and "cubic" are not the abbreviation
    expect(issuesFor({ dose: '10 units', duration: 'cubic' })).toEqual([])
  })

  it('gives one flag per medication listing every issue, keyed to the field values', () => {
    const doc = medDoc({ dose: '.5 mg', frequency: '1-2 times' })
    const flags = computeFlags(patient, doc, [])
    const mine = flags.filter((f) => f.id === 'rx.m1.ambiguous')
    expect(mine).toHaveLength(1)
    expect(mine[0].message).toContain('dose ".5 mg"')
    expect(mine[0].message).toContain('frequency "1-2 times"')
    doc.prescription.medications[0].dose = '0.5 mg'
    const after = computeFlags(patient, doc, []).find((f) => f.id === 'rx.m1.ambiguous')
    expect(after?.ackKey).not.toBe(mine[0].ackKey)
  })
})

describe('relative dates', () => {
  const dateIds = (doc: VisitDocument): string[] => ruleIds(computeFlags(patient, doc, []), 'date.')

  it('flags vague references in follow-up, treatment dates and plan', () => {
    const doc = withDoc((d) => {
      d.prescription.followUp = { text: 'Review next week', sources: [] }
      d.oncology.lastTreatmentDate = 'kal'
      d.oncology.nextPlannedTreatment = 'parso'
      d.plan = { text: 'Start C2 tomorrow', sources: [] }
    })
    expect(dateIds(doc)).toEqual(
      expect.arrayContaining([
        'date.followUp.relative',
        'date.lastTreatmentDate.relative',
        'date.nextPlannedTreatment.relative',
        'date.plan.relative'
      ])
    )
    const flag = computeFlags(patient, doc, []).find((f) => f.id === 'date.followUp.relative')
    expect(flag?.severity).toBe('warning')
    expect(flag?.message).toContain('ambiguous on paper')
    expect(flag?.message).toContain('explicit date')
  })

  it('flags "after some days", weekday names and SOS follow-up', () => {
    expect(dateIds(withDoc((d) => (d.prescription.followUp.text = 'Review after some days')))).toEqual(['date.followUp.relative'])
    expect(dateIds(withDoc((d) => (d.plan.text = 'Review on Monday')))).toEqual(['date.plan.relative'])
    expect(dateIds(withDoc((d) => (d.prescription.followUp.text = 'SOS')))).toEqual(['date.followUp.relative'])
  })

  it('does not flag explicit dates', () => {
    expect(dateIds(withDoc((d) => (d.prescription.followUp.text = 'Review on 2026-11-02')))).toEqual([])
    expect(dateIds(withDoc((d) => (d.plan.text = 'Review on Monday 2 Nov')))).toEqual([])
    expect(dateIds(withDoc((d) => (d.prescription.followUp.text = 'Review next week, 02/11/2026')))).toEqual([])
    expect(dateIds(withDoc((d) => (d.oncology.lastTreatmentDate = '2026-10-01')))).toEqual([])
  })

  it('does not treat SOS medicines in the plan as a follow-up date', () => {
    expect(dateIds(withDoc((d) => (d.plan.text = 'Tab paracetamol SOS for fever')))).toEqual([])
  })

  it('does not match words that only contain a trigger', () => {
    expect(dateIds(withDoc((d) => (d.plan.text = 'Kalpana to continue; parsoning not needed')))).toEqual([])
  })
})

describe('laterality', () => {
  const latIds = (d: VisitDocument): string[] => ruleIds(computeFlags(patient, d, []), 'lat.')

  it('does not flag a single side', () => {
    expect(latIds(withDoc((d) => (d.history.hpi.text = 'left breast lump for 3 months')))).toEqual([])
  })

  it('flags both sides mentioned in one section', () => {
    const doc = withDoc((d) => (d.examination.text = 'Left breast lump 3 cm. Right axilla node palpable'))
    expect(latIds(doc)).toEqual(['lat.examination.mixed'])
    expect(latIds(withDoc((d) => (d.examination.text = 'left breast lump, right axilla node')))).toEqual(['lat.examination.mixed'])
  })

  it('accepts the Hindi and short forms', () => {
    expect(latIds(withDoc((d) => (d.history.hpi.text = 'baayan stan mein gaanth, daayan taraf bhi'))))
      .toEqual(['lat.history.hpi.mixed'])
    expect(latIds(withDoc((d) => (d.examination.text = 'Lt breast mass; rt axilla')))).toEqual(['lat.examination.mixed'])
  })

  it('does not treat R-CHOP, bright or rt-PCR as a side', () => {
    expect(latIds(withDoc((d) => (d.plan.text = 'Continue R-CHOP; bright spot on scan; left lung nodule'))))
      .toEqual([])
    expect(latIds(withDoc((d) => (d.plan.text = 'rt-PCR sent; left arm swelling')))).toEqual([])
  })

  it('checks each section on its own', () => {
    const doc = withDoc((d) => {
      d.history.hpi.text = 'left breast lump'
      d.examination.text = 'right axilla node'
    })
    expect(latIds(doc)).toEqual([])
  })
})

describe('negation and contradiction', () => {
  const nausea = (d: VisitDocument): Finding => d.oncology.toxicities.find((f) => f.name === 'Nausea / vomiting')!
  const contraIds = (d: VisitDocument): string[] => ruleIds(computeFlags(patient, d, []), 'contra.')

  it('flags a finding marked absent that the narrative affirms', () => {
    const doc = withDoc((d) => {
      nausea(d).state = 'absent'
      d.history.hpi.text = 'nausea since 2 days'
    })
    const id = `contra.${nausea(doc).id}`
    expect(contraIds(doc)).toEqual([id])
    const flag = computeFlags(patient, doc, []).find((f) => f.id === id)
    expect(flag?.severity).toBe('warning')
    expect(flag?.message).toContain('marked absent')
    expect(flag?.message).toContain('nausea since 2 days')
  })

  it('flags a finding marked present that the narrative denies', () => {
    const doc = withDoc((d) => {
      nausea(d).state = 'present'
      d.history.chiefComplaints.text = 'Patient denies nausea'
    })
    expect(contraIds(doc)).toEqual([`contra.${nausea(doc).id}`])
    const doc2 = withDoc((d) => {
      nausea(d).state = 'present'
      d.history.hpi.text = 'nausea nahi hai'
    })
    expect(contraIds(doc2)).toEqual([`contra.${nausea(doc2).id}`])
  })

  it('does not flag consistent statements', () => {
    const denied = withDoc((d) => {
      nausea(d).state = 'absent'
      d.history.hpi.text = 'Denies nausea, vomiting. No pain.'
    })
    expect(contraIds(denied)).toEqual([])
    const resolved = withDoc((d) => {
      nausea(d).state = 'absent'
      d.history.hpi.text = 'Nausea resolved with antiemetic'
    })
    expect(contraIds(resolved)).toEqual([])
    const unassessed = withDoc((d) => (d.history.hpi.text = 'nausea since 2 days'))
    expect(contraIds(unassessed)).toEqual([])
  })

  it('does not flag a present finding when the narrative also affirms it', () => {
    const doc = withDoc((d) => {
      nausea(d).state = 'present'
      d.history.hpi.text = 'No fever, but nausea since 2 days'
    })
    expect(contraIds(doc)).toEqual([])
  })

  it('flags a double negative in free text, but not "no evidence of disease" or "not tolerating"', () => {
    const flagged = withDoc((d) => (d.plan.text = 'Pain not without food; chemo deferred'))
    expect(ruleIds(computeFlags(patient, flagged, []), 'neg.')).toEqual(['neg.plan.unclear'])
    expect(ruleIds(computeFlags(patient, withDoc((d) => (d.history.hpi.text = 'Not unwell')), []), 'neg.')).toEqual([
      'neg.history.hpi.unclear'
    ])
    expect(ruleIds(computeFlags(patient, withDoc((d) => (d.plan.text = 'no pain not relieved by rest')), []), 'neg.')).toEqual([
      'neg.plan.unclear'
    ])
    const clean = withDoc((d) => {
      d.assessment.text = 'No evidence of disease on CT'
      d.plan.text = 'Not tolerating oral intake, admit. Not until next week'
    })
    expect(ruleIds(computeFlags(patient, clean, []), 'neg.')).toEqual([])
  })

  it('flags a conversation where a symptom is denied in one segment and affirmed in another', () => {
    const t: Transcript = {
      ...conversation(),
      segments: [
        { id: 's1', startMs: 0, endMs: 1, originalText: '', text: 'No vomiting since admission', speaker: 'patient', speakerUncertain: false, warning: '' },
        { id: 's2', startMs: 1, endMs: 2, originalText: '', text: 'vomiting yesterday once', speaker: 'patient', speakerUncertain: false, warning: '' }
      ]
    }
    const vomit = DEFAULT_SETTINGS.toxicityChecklist.indexOf('Nausea / vomiting')
    expect(vomit).toBeGreaterThanOrEqual(0)
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    const flags = computeFlags(patient, doc, [t])
    const id = `tx.t1.contradiction.${doc.oncology.toxicities[vomit].id}`
    expect(ids(flags)).toContain(id)
    expect(flags.find((f) => f.id === id)?.severity).toBe('warning')
  })

  it('does not flag a conversation that only repeats one side, or questions', () => {
    const t: Transcript = {
      ...conversation(),
      segments: [
        { id: 's1', startMs: 0, endMs: 1, originalText: '', text: 'Any vomiting?', speaker: 'doctor', speakerUncertain: false, warning: '' },
        { id: 's2', startMs: 1, endMs: 2, originalText: '', text: 'No', speaker: 'patient', speakerUncertain: false, warning: '' }
      ]
    }
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    expect(ruleIds(computeFlags(patient, doc, [t]), 'tx.t1.contradiction.')).toEqual([])
  })
})

describe('clinic-required fields', () => {
  it('blocks verification while a required section is empty', () => {
    const doc = withDoc((d) => (d.history.hpi.text = '   '))
    const flags = computeFlags(patient, doc, [], [], ['history.hpi'])
    const flag = flags.find((f) => f.id === 'required.history.hpi')
    expect(flag?.severity).toBe('blocking')
    expect(flag?.message).toBe('History of present illness is required by the clinic')
    expect(canVerify(flags, acks(flags))).toBe(false)
  })

  it('does not block once the required section has text', () => {
    const doc = withDoc((d) => (d.plan.text = 'Continue; review'))
    const flags = computeFlags(patient, doc, [], [], ['plan'])
    expect(ids(flags).some((id) => id.startsWith('required.'))).toBe(false)
  })

  it('adds nothing when no fields are required, and ignores unknown keys', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')
    expect(ids(computeFlags(patient, doc, []))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^required\./)]))
    expect(() => computeFlags(patient, doc, [], [], ['nope' as never])).not.toThrow()
  })
})

describe('common clinical text', () => {
  it('stays free of the new warnings', () => {
    const doc = withDoc((d) => {
      d.history.chiefComplaints.text = 'Fever for 2 days, no cough'
      d.history.hpi.text = 'Denies nausea, vomiting. Pain abdomen since 3 days, improving. Weight stable.'
      d.examination.text = 'Pallor +. No pedal edema. Right lung clear. Scar healed.'
      d.assessment.text = 'Febrile neutropenia resolving. Stable on TPF.'
      d.plan.text = 'Continue regimen. Review with reports. ECG on 2026-11-02.'
      d.prescription.followUp.text = 'Review on 2026-11-02 with CBC'
      d.oncology.lastTreatmentDate = '2026-10-01'
      d.oncology.nextPlannedTreatment = 'C4 D1 on 2026-11-02'
      d.prescription.medications.push(
        med('m1', 'Ondansetron'),
        { ...med('m2', 'Paracetamol'), dose: '500 mg', frequency: '1-0-1', duration: '3 days', quantity: '6' }
      )
      d.oncology.toxicities.find((f) => f.name === 'Nausea / vomiting')!.state = 'absent'
    })
    const newRules = ['rx.', 'date.', 'lat.', 'contra.', 'neg.', 'required.']
    const found = computeFlags(patient, doc, []).filter((f) => newRules.some((p) => f.id.startsWith(p)) && f.id !== 'rx.m1.incomplete')
    expect(found.map((f) => f.id)).toEqual([])
  })
})

describe('undecided suggestions', () => {
  const suggestion = (id: string, status: Suggestion['status']): Suggestion => ({
    id,
    transcriptId: 't1',
    segmentIds: ['s1'],
    target: { kind: 'vital', key: 'bp' },
    value: '130/80',
    quote: 'BP 130/80',
    engine: 'rules',
    status,
    warning: ''
  })
  const doc = (): VisitDocument => emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:00')

  it('warns with the sorted pending ids and ignores accepted and dismissed ones', () => {
    const t: Transcript = {
      ...conversation(),
      suggestions: [suggestion('b', 'pending'), suggestion('c', 'accepted'), suggestion('a', 'pending'), suggestion('d', 'dismissed')]
    }
    const flag = computeFlags(patient, doc(), [t]).find((f) => f.id === 'tx.t1.suggestions')
    expect(flag?.severity).toBe('warning')
    expect(flag?.area).toBe('transcript')
    expect(flag?.message).toBe('Conversation transcript has 2 suggestion(s) not yet accepted or dismissed')
    expect(flag?.ackKey).toBe(
      computeFlags(patient, doc(), [{ ...t, suggestions: [suggestion('a', 'pending'), suggestion('b', 'pending')] }]).find(
        (f) => f.id === 'tx.t1.suggestions'
      )?.ackKey
    )
  })

  it('changes the acknowledgement key when the set of pending suggestions changes', () => {
    const key = (s: Suggestion[]): string | undefined =>
      computeFlags(patient, doc(), [{ ...conversation(), suggestions: s }]).find((f) => f.id === 'tx.t1.suggestions')?.ackKey
    expect(key([suggestion('a', 'pending')])).not.toBe(key([suggestion('a', 'pending'), suggestion('b', 'pending')]))
  })

  it('adds no flag once every suggestion is decided', () => {
    const t: Transcript = { ...conversation(), suggestions: [suggestion('a', 'accepted'), suggestion('b', 'dismissed')] }
    expect(ids(computeFlags(patient, doc(), [t]))).not.toContain('tx.t1.suggestions')
  })
})
