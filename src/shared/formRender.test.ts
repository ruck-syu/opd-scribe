import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, NOT_DOCUMENTED, emptyDocument } from './defaults'
import {
  fieldValue,
  orderedSections,
  pageMargins,
  renderFieldsOverlayHtml,
  renderFormBodyHtml,
  sampleSnapshot,
  sectionHasContent
} from './formRender'
import { defaultTemplate, type FieldBox, type FormTemplate } from './formTemplate'
import type { Patient, VerifiedSnapshot } from './types'

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

function fixture(): VerifiedSnapshot {
  return {
    patient: { ...patient },
    document: emptyDocument(DEFAULT_SETTINGS, '2026-10-21T14:05:00'),
    doctor: { name: 'Dr Meera Iyer', registrationNo: 'KA-12345', qualifications: 'MBBS, MD' },
    clinic: { clinicName: 'Test Clinic', clinicAddress: '', footerText: '' }
  }
}

const template = (): FormTemplate => defaultTemplate('note', 'template-1', '2026-10-21T09:00:00')

const section = (t: FormTemplate, key: FormTemplate['sections'][number]['key']): FormTemplate['sections'][number] =>
  t.sections.find((s) => s.key === key)!

const field = (patch: Partial<FieldBox>): FieldBox => ({
  id: 'f1',
  field: 'patient.name',
  label: 'Name: ',
  xMm: 10,
  yMm: 10,
  wMm: 80,
  hMm: 8,
  fontSizePt: 10,
  bold: false,
  pages: 'first',
  ...patch
})

describe('sectionHasContent', () => {
  it('treats not-assessed findings, blank vitals and an undocumented oncology block as empty', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T14:05:00')
    expect(sectionHasContent('symptoms', doc)).toBe(false)
    expect(sectionHasContent('allergies', doc)).toBe(false)
    expect(sectionHasContent('vitals', doc)).toBe(false)
    expect(sectionHasContent('oncology', doc)).toBe(false)
    expect(sectionHasContent('chiefComplaints', doc)).toBe(false)
  })

  it('counts documented findings, tri-state answers, vitals and oncology data', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T14:05:00')
    doc.history.symptoms = [{ id: 's1', name: 'Cough', state: 'absent', grade: '', note: '' }]
    expect(sectionHasContent('symptoms', doc)).toBe(true)
    doc.history.allergiesReviewed = 'not_assessed'
    expect(sectionHasContent('allergies', doc)).toBe(false)
    doc.history.allergiesReviewed = 'present'
    expect(sectionHasContent('allergies', doc)).toBe(true)
    doc.vitals.bp = '126/78'
    expect(sectionHasContent('vitals', doc)).toBe(true)
    doc.oncology.ecog = 0
    expect(sectionHasContent('oncology', doc)).toBe(true)
    doc.oncology.ecog = null
    doc.oncology.clearance.decision = 'yes'
    expect(sectionHasContent('oncology', doc)).toBe(true)
  })

  it('always counts medicines and follow-up as content', () => {
    const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T14:05:00')
    expect(sectionHasContent('medications', doc)).toBe(true)
    expect(sectionHasContent('followUp', doc)).toBe(true)
  })
})

describe('orderedSections', () => {
  it('omits a hidden section when it has no content', () => {
    const t = template()
    const plan = section(t, 'plan')
    plan.show = false
    plan.heading = 'Plan section heading'
    const doc = fixture().document

    expect(orderedSections(t, doc).some((s) => s.key === 'plan')).toBe(false)
    expect(renderFormBodyHtml(fixture(), t, { draft: false })).not.toContain('Plan section heading')
  })

  it('prints a hidden clinical section with content after the visible sections', () => {
    const snap = fixture()
    snap.document.history.chiefComplaints = { text: 'Cough for two weeks', sources: [] }
    snap.document.plan = { text: 'Continue treatment', sources: [] }
    const t = template()
    const complaints = section(t, 'chiefComplaints')
    complaints.heading = 'Visible complaints'
    const plan = section(t, 'plan')
    plan.show = false
    plan.heading = 'Hidden but filled plan'

    const order = orderedSections(t, snap.document).map((s) => s.key)
    expect(order[order.length - 1]).toBe('plan')

    const html = renderFormBodyHtml(snap, t, { draft: false })
    expect(html).toContain('Hidden but filled plan')
    expect(html).toContain('Continue treatment')
    expect(html.indexOf('Hidden but filled plan')).toBeGreaterThan(html.indexOf('Visible complaints'))
  })

  it('allows identity and signature to be hidden even though they always have data', () => {
    const snap = fixture()
    const t = template()
    section(t, 'identity').show = false
    section(t, 'signature').show = false

    const keys = orderedSections(t, snap.document).map((s) => s.key)
    expect(keys).not.toContain('identity')
    expect(keys).not.toContain('signature')
    const html = renderFormBodyHtml(snap, t, { draft: false })
    expect(html).not.toContain('class="identity"')
    expect(html).not.toContain('class="signature-block"')
  })
})

describe('renderFormBodyHtml', () => {
  it('derives @page margins from the first and continuation content boxes', () => {
    const t = template()
    t.pageWidthMm = 210
    t.pageHeightMm = 297
    t.bodyFirst = { xMm: 20, yMm: 50, wMm: 170, hMm: 200 }
    t.bodyNext = { xMm: 15, yMm: 30, wMm: 180, hMm: 210 }

    const html = renderFormBodyHtml(fixture(), t, { draft: false })
    expect(html).toContain('@page { size: 210mm 297mm; margin: 30mm 15mm 57mm 15mm; }')
    expect(html).toContain('@page :first { margin: 50mm 20mm 47mm 20mm; }')
    expect(html).toContain('font-size: 10.5pt')
    expect(pageMargins(t.bodyNext, t.pageWidthMm, t.pageHeightMm)).toBe('30mm 15mm 57mm 15mm')
  })

  it('keeps the draft banner and watermark for draft renders', () => {
    const draft = renderFormBodyHtml(fixture(), template(), { draft: true })
    const final = renderFormBodyHtml(fixture(), template(), { draft: false })
    expect(draft).toContain('class="draft-banner"')
    expect(draft).toContain('class="watermark"')
    expect(final).not.toContain('class="draft-banner"')
  })

  it('prints visible empty sections instead of dropping them silently', () => {
    const t = template()
    t.sections.forEach((s) => (s.show = true))
    const html = renderFormBodyHtml(fixture(), t, { draft: false })
    expect(html).toContain(NOT_DOCUMENTED)
    expect(html).toContain('Assessment')
  })
})

describe('fieldValue', () => {
  it('formats the visit date, date-time and age/sex', () => {
    const snap = fixture()
    expect(fieldValue(field({ field: 'visit.date' }), snap)).toBe('21 Oct 2026')
    expect(fieldValue(field({ field: 'visit.dateTime' }), snap)).toBe('21 Oct 2026, 14:05')
    expect(fieldValue(field({ field: 'patient.ageSex' }), snap)).toBe('54 y / Female')
  })

  it('prints "Not documented" for blank values and the label for fixed text', () => {
    const snap = fixture()
    expect(fieldValue(field({ field: 'patient.phone' }), snap)).toBe(NOT_DOCUMENTED)
    expect(fieldValue(field({ field: 'static', label: 'Clinic hours: 9–5' }), snap)).toBe('Clinic hours: 9–5')
  })
})

describe('renderFieldsOverlayHtml', () => {
  it('creates one page per body page and repeats only "all" fields', () => {
    const t = template()
    t.fields = [
      field({ id: 'f1', field: 'patient.name', label: 'Name: ', pages: 'first' }),
      field({ id: 'f2', field: 'patient.mrn', label: 'MRN: ', yMm: 20, pages: 'all', bold: true })
    ]
    const html = renderFieldsOverlayHtml(fixture(), t, 3)
    expect((html.match(/<div class="page/g) ?? []).length).toBe(3)
    expect((html.match(/Name: /g) ?? []).length).toBe(1)
    expect((html.match(/MRN: /g) ?? []).length).toBe(3)
    expect(html).toContain('@page { size: 210mm 297mm; margin: 0; }')
    expect(html).toContain('page-break-after: always')
    expect(html).toContain('page last')
    expect(html).toContain('font-weight:700')
  })

  it('escapes labels and values and marks undocumented values', () => {
    const snap = fixture()
    snap.patient.name = '<b>Asha</b>'
    const t = template()
    t.fields = [
      field({ id: 'f1', field: 'patient.name', label: '<i>Name</i>: ' }),
      field({ id: 'f2', field: 'static', label: '<script>alert(1)</script>', yMm: 20 }),
      field({ id: 'f3', field: 'patient.phone', label: 'Phone: ', yMm: 30 })
    ]
    const html = renderFieldsOverlayHtml(snap, t, 1)
    expect(html).toContain('&lt;b&gt;Asha&lt;/b&gt;')
    expect(html).not.toContain('<b>Asha</b>')
    expect(html).toContain('&lt;i&gt;Name&lt;/i&gt;:')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain(`<span class="nd">${NOT_DOCUMENTED}</span>`)
  })
})

describe('sampleSnapshot', () => {
  it('is clearly fictitious and fills every section', () => {
    const snap = sampleSnapshot({ clinicName: 'Test Clinic', clinicAddress: '', footerText: '' })
    expect(snap.patient.name).toBe('SAMPLE PATIENT')
    expect(snap.patient.mrn).toBe('SAMPLE-0001')
    expect(snap.document.prescription.medications.length).toBeGreaterThan(1)
    expect(snap.document.plan.text).not.toBe('')
    expect(snap.document.oncology.regimen).not.toBe('')
  })
})
