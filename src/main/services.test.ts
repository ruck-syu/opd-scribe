import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, emptyDocument } from '../shared/defaults'
import { defaultTemplate } from '../shared/formTemplate'
import type { Patient, VerifiedSnapshot } from '../shared/types'
import { contentHash } from './services'

const patient: Patient = {
  id: 'patient-1',
  mrn: 'MRN-001',
  name: 'Asha Rao',
  dateOfBirth: '1972-03-04',
  ageDisplay: '54 y',
  sex: 'female',
  phone: '',
  address: '',
  createdAt: '2026-10-21T09:00:00',
  updatedAt: '2026-10-21T09:00:00'
}

const fixture = (): VerifiedSnapshot => ({
  patient: { ...patient },
  document: emptyDocument(DEFAULT_SETTINGS, '2026-10-21T14:05:00'),
  doctor: { name: 'Dr Meera Iyer', registrationNo: 'KA-12345', qualifications: 'MBBS, MD' },
  clinic: { clinicName: 'Test Clinic', clinicAddress: '', footerText: '' }
})

describe('contentHash', () => {
  it('ignores print formats so format edits never invalidate a verification', () => {
    const snap = fixture()
    const legacy = contentHash(snap)
    const template = defaultTemplate('note', 'template-1', '2026-10-21T09:00:00')
    expect(contentHash({ ...snap, formats: { note: template, prescription: null } })).toBe(legacy)
  })

  it('still changes when clinical content changes', () => {
    const snap = fixture()
    snap.document.plan = { text: 'Continue treatment', sources: [] }
    expect(contentHash(snap)).not.toBe(contentHash(fixture()))
  })
})
