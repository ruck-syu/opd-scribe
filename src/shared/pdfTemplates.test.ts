import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, NOT_DOCUMENTED, emptyDocument } from './defaults'
import { escapeHtml, renderCombinedHtml, renderNoteHtml, renderPrescriptionHtml } from './pdfTemplates'

const LAYOUT = DEFAULT_SETTINGS.layout
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
    clinic: { clinicName: 'Test Clinic', clinicAddress: '', footerText: 'Test footer' }
  }
}

describe('escapeHtml', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml('<script>alert("x") & \'y\'</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;'
    )
  })

  it('escapes a patient name containing markup in the rendered note', () => {
    const snap = fixture()
    snap.patient.name = '<b>Asha</b>'
    const html = renderNoteHtml(snap, LAYOUT, { draft: false })
    expect(html).toContain('&lt;b&gt;Asha&lt;/b&gt;')
    expect(html).not.toContain('<b>Asha</b>')
  })
})

describe('renderNoteHtml', () => {
  it('wraps long unbroken tokens instead of letting them widen the page', () => {
    // an overflowing token makes Chromium shrink the whole printed page to fit
    expect(renderNoteHtml(fixture(), LAYOUT, { draft: false })).toMatch(/overflow-wrap: anywhere/)
  })

  it('renders present and absent findings but never not_assessed ones', () => {
    const snap = fixture()
    snap.document.history.symptoms = [
      { id: 's1', name: 'Unreviewed pain', state: 'not_assessed', grade: '', note: '' },
      { id: 's2', name: 'Cough', state: 'absent', grade: '', note: '' },
      { id: 's3', name: 'Fever', state: 'present', grade: 'G1', note: 'since morning' }
    ]
    const html = renderNoteHtml(snap, LAYOUT, { draft: false })
    expect(html).not.toContain('Unreviewed pain')
    expect(html).toContain('Denied / absent')
    expect(html).toContain(': Present')
    expect(html).toContain('Grade: G1')
    expect(html).toContain('since morning')
  })

  it('renders the not-assessed default document without inventing negatives', () => {
    const html = renderNoteHtml(fixture(), LAYOUT, { draft: false })
    expect(html).toContain(NOT_DOCUMENTED)
    expect(html).not.toContain('Denied / absent')
    expect(html).not.toContain('No medicines prescribed')
  })

  it('formats the visit date and time', () => {
    const html = renderNoteHtml(fixture(), LAYOUT, { draft: false })
    expect(html).toContain('21 Oct 2026, 14:05')
  })

  it('applies layout margins and font size to the page', () => {
    const layout = { ...DEFAULT_SETTINGS.layout, marginTopMm: 40, marginRightMm: 15, marginBottomMm: 25, marginLeftMm: 15 }
    const html = renderNoteHtml(fixture(), layout, { draft: false })
    expect(html).toContain('@page { size: A4; margin: 40mm 15mm 25mm 15mm; }')
    expect(html).toContain('font-size: 10.5pt')
  })

  it('shows the draft banner and watermark only when draft is true', () => {
    const snap = fixture()
    const draft = renderNoteHtml(snap, LAYOUT, { draft: true })
    const final = renderNoteHtml(snap, LAYOUT, { draft: false })
    expect(draft).toContain('class="draft-banner"')
    expect(draft).toContain('class="watermark"')
    expect(draft).toContain('UNVERIFIED DRAFT — NOT FOR CLINICAL USE')
    expect(final).not.toContain('class="draft-banner"')
    expect(final).not.toContain('class="watermark"')
    expect(final).not.toContain('UNVERIFIED DRAFT')
  })
})

describe('renderPrescriptionHtml', () => {
  it('marks missing medication fields instead of inferring them', () => {
    const snap = fixture()
    snap.document.prescription.medications = [
      {
        id: 'm1',
        name: 'Metformin',
        formulationStrength: '500 mg',
        dose: '',
        route: 'PO',
        frequency: '',
        duration: '5 days',
        quantity: '',
        instructions: '',
        sourceText: ''
      }
    ]
    const html = renderPrescriptionHtml(snap, LAYOUT, { draft: false })
    expect(html).toContain('Metformin')
    expect(html).toContain('500 mg')
    expect((html.match(/\[not specified\]/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('Dose: <span class="missing">[not specified]</span>')
    expect(html).toContain('Frequency: <span class="missing">[not specified]</span>')
    expect(html).not.toContain('Quantity:')
  })

  it('shows the empty-medicines message only for an empty list', () => {
    const snap = fixture()
    expect(renderPrescriptionHtml(snap, LAYOUT, { draft: false })).toContain('No medicines prescribed')
    snap.document.prescription.medications = [
      {
        id: 'm1',
        name: 'Paracetamol',
        formulationStrength: '',
        dose: '500 mg',
        route: 'PO',
        frequency: 'SOS',
        duration: '',
        quantity: '',
        instructions: 'For fever',
        sourceText: ''
      }
    ]
    const html = renderPrescriptionHtml(snap, LAYOUT, { draft: false })
    expect(html).not.toContain('No medicines prescribed')
    expect(html).toContain('For fever')
  })

  it('keeps follow-up visible and omits other empty sections', () => {
    const html = renderPrescriptionHtml(fixture(), LAYOUT, { draft: false })
    expect(html).toContain('Follow-up')
    expect(html).toContain(NOT_DOCUMENTED)
    expect(html).not.toContain('Investigations advised')
    expect(html).not.toContain('Return precautions')
  })
})

describe('renderCombinedHtml', () => {
  it('contains both titles, a page break, and a complete standalone document', () => {
    const html = renderCombinedHtml(fixture(), LAYOUT, { draft: false })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('OPD Visit Note')
    expect(html).toMatch(/Prescription (?:&amp;|&) Plan/)
    expect(html).toContain('class="page-break"')
    expect(html).toContain('</html>')
  })
})
