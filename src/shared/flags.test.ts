import { describe, expect, it } from 'vitest'
import { canVerify, computeFlags } from './flags'
import { DEFAULT_SETTINGS, emptyDocument } from './defaults'
import type { Patient, Transcript } from './types'

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
    expect(canVerify(flags, ids(flags))).toBe(false)
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
    const t: Transcript = {
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
    }
    const flags = computeFlags(patient, doc, [t])
    expect(flags.every((f) => f.severity === 'warning')).toBe(true)
    expect(ids(flags)).toEqual(expect.arrayContaining(['tx.t1.unreviewed', 'tx.t1.speakers', 'tx.t1.warnings', 'onc.ecog']))
    expect(canVerify(flags, [])).toBe(false)
    expect(canVerify(flags, ids(flags))).toBe(true)
  })
})
