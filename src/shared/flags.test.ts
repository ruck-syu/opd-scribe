import { describe, expect, it } from 'vitest'
import { canVerify, computeFlags } from './flags'
import { DEFAULT_SETTINGS, emptyDocument } from './defaults'
import type { Medication, Patient, Transcript } from './types'

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
