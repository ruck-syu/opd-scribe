// Rendering for custom print formats. The template only decides *where* content goes;
// the content itself always comes from the structured document, and a hidden section
// with content is still printed (after the visible sections).

import { DEFAULT_SETTINGS, NOT_DOCUMENTED, emptyDocument } from './defaults'
import {
  HIDEABLE_WHEN_FILLED,
  type BoxMm,
  type FieldBox,
  type FormTemplate,
  type SectionKey,
  type SectionSpec
} from './formTemplate'
import {
  baseCss,
  draftOverlay,
  escapeHtml,
  formatDateText,
  formatVisitDateTimeText,
  isBlank,
  renderSection
} from './pdfTemplates'
import type { ClinicSettings, Finding, Patient, TextSection, VerifiedSnapshot, VisitDocument, Vitals } from './types'

const assessed = (findings: Finding[]): boolean => findings.some((f) => f.state === 'present' || f.state === 'absent')

const anyText = (...values: string[]): boolean => values.some((v) => !isBlank(v))

const vitalFilled = (v: Vitals): boolean =>
  anyText(v.bp, v.pulse, v.temperature, v.spo2, v.respiratoryRate, v.weight, v.height, v.other)

const textOf = (s: TextSection): boolean => !isBlank(s.text)

/**
 * Does this section contain anything documented? Used only to decide whether a
 * hidden section must still be printed; empty visible sections render "Not documented".
 */
export function sectionHasContent(key: SectionKey, doc: VisitDocument): boolean {
  const h = doc.history
  const rx = doc.prescription
  const o = doc.oncology
  switch (key) {
    case 'chiefComplaints':
    case 'hpi':
    case 'pastHistory':
    case 'medicationHistory':
      return textOf(h[key])
    case 'examination':
    case 'assessment':
    case 'plan':
      return textOf(doc[key])
    case 'investigationsAdvised':
    case 'advice':
    case 'returnPrecautions':
      return textOf(rx[key])
    case 'symptoms':
      return assessed(h.symptoms)
    case 'allergies':
      return h.allergiesReviewed !== 'not_assessed'
    case 'vitals':
      return vitalFilled(doc.vitals)
    case 'oncology':
      return (
        o.ecog !== null ||
        anyText(o.regimen, o.cycleNumber, o.cycleDay, o.lastTreatmentDate, o.nextPlannedTreatment, o.clearance.reason) ||
        o.clearance.decision !== 'not_documented' ||
        textOf(o.investigationsReviewed) ||
        assessed(o.toxicities)
      )
    // Identity/signature can be placed as fixed fields; medicines and follow-up are always
    // printed (an empty list is itself a statement, follow-up is required).
    case 'identity':
    case 'signature':
    case 'medications':
    case 'followUp':
      return true
  }
}

/** Visible sections in the doctor's order, then hidden sections that still have content. */
export function orderedSections(template: FormTemplate, doc: VisitDocument): SectionSpec[] {
  const visible = template.sections.filter((s) => s.show)
  const hiddenFilled = template.sections.filter(
    (s) => !s.show && !HIDEABLE_WHEN_FILLED.includes(s.key) && sectionHasContent(s.key, doc)
  )
  return [...visible, ...hiddenFilled]
}

const ageText = (p: Patient): string =>
  !isBlank(p.ageDisplay) ? p.ageDisplay.trim() : p.dateOfBirth && !isBlank(p.dateOfBirth) ? formatDateText(p.dateOfBirth) : NOT_DOCUMENTED

const sexText = (p: Patient): string =>
  p.sex === 'male' ? 'Male' : p.sex === 'female' ? 'Female' : p.sex === 'other' ? 'Other' : NOT_DOCUMENTED

const textValue = (s: string): string => (isBlank(s) ? NOT_DOCUMENTED : s.trim())

/** Plain text for a fixed field. Never invents content: blanks read "Not documented". */
export function fieldValue(field: FieldBox, snap: VerifiedSnapshot): string {
  if (field.field === 'static') return field.label
  const p = snap.patient
  const doc = snap.document
  switch (field.field) {
    case 'patient.name':
      return textValue(p.name)
    case 'patient.mrn':
      return textValue(p.mrn)
    case 'patient.ageSex': {
      const age = ageText(p)
      const sex = sexText(p)
      return age === NOT_DOCUMENTED && sex === NOT_DOCUMENTED ? NOT_DOCUMENTED : `${age} / ${sex}`
    }
    case 'patient.age':
      return ageText(p)
    case 'patient.sex':
      return sexText(p)
    case 'patient.phone':
      return textValue(p.phone)
    case 'patient.address':
      return textValue(p.address)
    case 'visit.date':
      return formatDateText(doc.visitDateTime)
    case 'visit.dateTime':
      return formatVisitDateTimeText(doc.visitDateTime)
    case 'visit.type':
      return textValue(doc.visitType)
    case 'doctor.name':
      return textValue(snap.doctor.name)
    case 'doctor.qualifications':
      return textValue(snap.doctor.qualifications)
    case 'doctor.registrationNo':
      return textValue(snap.doctor.registrationNo)
    case 'clinic.name':
      return textValue(snap.clinic.clinicName)
  }
}

const mmText = (n: number): string => String(Math.round(Math.max(0, n) * 100) / 100)

/**
 * Margins for an @page rule derived from a content box:
 * top = y, left = x, right = pageWidth - x - w, bottom = pageHeight - y - h.
 */
export function pageMargins(box: BoxMm, pageWidthMm: number, pageHeightMm: number): string {
  const top = box.yMm
  const left = box.xMm
  const right = pageWidthMm - box.xMm - box.wMm
  const bottom = pageHeightMm - box.yMm - box.hMm
  return `${mmText(top)}mm ${mmText(right)}mm ${mmText(bottom)}mm ${mmText(left)}mm`
}

const documentTitle = (template: FormTemplate): string =>
  isBlank(template.title) ? (template.kind === 'note' ? 'OPD Visit Note' : 'Prescription & Plan') : template.title.trim()

/** Full body document for a custom format, printed at the sample's page size. */
export function renderFormBodyHtml(snap: VerifiedSnapshot, template: FormTemplate, opts: { draft: boolean }): string {
  const t = template
  const next = pageMargins(t.bodyNext, t.pageWidthMm, t.pageHeightMm)
  const first = pageMargins(t.bodyFirst, t.pageWidthMm, t.pageHeightMm)
  const title = isBlank(t.title) ? '' : `<h1>${escapeHtml(t.title.trim())}</h1>`
  const sections = orderedSections(t, snap.document)
    .map((s) => renderSection(s.key, snap, s.heading))
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(documentTitle(t))}</title>
<style>
@page { size: ${mmText(t.pageWidthMm)}mm ${mmText(t.pageHeightMm)}mm; margin: ${next}; }
@page :first { margin: ${first}; }
${baseCss(t.fontSizePt)}
</style>
</head>
<body>
${opts.draft ? draftOverlay() : ''}
<article class="doc doc-${t.kind}">
${title}
${sections}
</article>
</body>
</html>`
}

const fieldMarkup = (field: FieldBox, snap: VerifiedSnapshot): string => {
  if (field.field === 'static') return escapeHtml(field.label)
  const value = fieldValue(field, snap)
  const printed = value === NOT_DOCUMENTED ? `<span class="nd">${escapeHtml(value)}</span>` : escapeHtml(value)
  return `${escapeHtml(field.label)}${printed}`
}

/**
 * Transparent overlay PDF of fixed fields for every body page. Fields never clip or
 * truncate (overflow is visible); only identity fields repeat on continuation pages.
 */
export function renderFieldsOverlayHtml(snap: VerifiedSnapshot, template: FormTemplate, pageCount: number): string {
  const t = template
  const pages = Math.max(1, Math.round(pageCount))
  const divs = Array.from({ length: pages }, (_, i) => {
    const fields = t.fields
      .filter((f) => i === 0 || f.pages === 'all')
      .map((f) => {
        const style = [
          `left:${mmText(f.xMm)}mm`,
          `top:${mmText(f.yMm)}mm`,
          `width:${mmText(f.wMm)}mm`,
          `min-height:${mmText(f.hMm)}mm`,
          `font-size:${f.fontSizePt}pt`,
          `font-weight:${f.bold ? 700 : 400}`,
          'white-space:pre-wrap',
          'overflow:visible'
        ].join(';')
        return `<div class="field" style="${style}">${fieldMarkup(f, snap)}</div>`
      })
      .join('\n')
    return `<div class="page${i === pages - 1 ? ' last' : ''}" style="width:${mmText(t.pageWidthMm)}mm;height:${mmText(t.pageHeightMm)}mm">${fields}</div>`
  }).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fields</title>
<style>
@page { size: ${mmText(t.pageWidthMm)}mm ${mmText(t.pageHeightMm)}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
.page { position: relative; width: ${mmText(t.pageWidthMm)}mm; height: ${mmText(t.pageHeightMm)}mm; overflow: visible; break-after: page; page-break-after: always; }
.page.last { break-after: auto; page-break-after: auto; }
.field { position: absolute; overflow: visible; white-space: pre-wrap; line-height: 1.3; color: #111; font-family: "Segoe UI", Arial, sans-serif; }
.nd { color: #666; font-style: italic; }
</style>
</head>
<body>
${divs}
</body>
</html>`
}

const text = (value: string): TextSection => ({ text: value, sources: [] })

/** Fictitious patient used only for template previews (always rendered as a draft). */
export function sampleSnapshot(clinic: ClinicSettings, doctor?: VerifiedSnapshot['doctor']): VerifiedSnapshot {
  const doc = emptyDocument(DEFAULT_SETTINGS, '2026-10-21T10:30')
  doc.visitType = 'Follow-up'
  doc.history.chiefComplaints = text('Sample: dry cough for two weeks.')
  doc.history.hpi = text('Sample: gradually worsening, no fever.')
  doc.history.pastHistory = text('Sample: hypertension, on treatment.')
  doc.history.medicationHistory = text('Sample: amlodipine 5 mg once daily.')
  doc.history.symptoms = [
    { id: 'sample-symptom-1', name: 'Cough', state: 'present', grade: '', note: 'Sample: mostly at night' },
    { id: 'sample-symptom-2', name: 'Fever', state: 'absent', grade: '', note: '' }
  ]
  doc.history.allergiesReviewed = 'absent'
  doc.vitals = {
    bp: '126/78',
    pulse: '76',
    temperature: '98.4 F',
    spo2: '98%',
    respiratoryRate: '16',
    weight: '62 kg',
    height: '160 cm',
    other: ''
  }
  doc.oncology = {
    ecog: 1,
    toxicities: [
      { id: 'sample-toxicity-1', name: 'Nausea / vomiting', state: 'absent', grade: '', note: '' },
      { id: 'sample-toxicity-2', name: 'Neuropathy', state: 'present', grade: 'G1', note: 'Sample note' }
    ],
    regimen: 'Sample regimen',
    cycleNumber: '2',
    cycleDay: '1',
    lastTreatmentDate: '2026-10-01',
    nextPlannedTreatment: '2026-10-29',
    clearance: { decision: 'yes', reason: 'Sample: counts adequate.' },
    investigationsReviewed: text('Sample: CBC and creatinine within range.')
  }
  doc.examination = text('Sample: chest clear, no added sounds.')
  doc.assessment = text('Sample: stable on current treatment.')
  doc.plan = text('Sample: continue treatment, review in two weeks.')
  doc.prescription = {
    medications: [
      {
        id: 'sample-med-1',
        name: 'SAMPLE MEDICINE A',
        formulationStrength: 'Sample strength',
        dose: 'Sample dose',
        route: 'Sample route',
        frequency: 'Sample frequency',
        duration: 'Sample duration',
        quantity: 'Sample qty',
        instructions: 'Sample instructions',
        sourceText: ''
      },
      {
        id: 'sample-med-2',
        name: 'SAMPLE MEDICINE B with a longer name to check wrapping',
        formulationStrength: '',
        dose: 'Sample dose',
        route: 'Sample route',
        frequency: 'Sample frequency',
        duration: 'Sample duration',
        quantity: '',
        instructions: '',
        sourceText: ''
      }
    ],
    investigationsAdvised: text('Sample: chest X-ray.'),
    advice: text('Sample: drink plenty of fluids.'),
    returnPrecautions: text('Sample: return if breathless.'),
    followUp: text('Sample: review in two weeks.')
  }
  return {
    patient: {
      id: 'sample-patient',
      mrn: 'SAMPLE-0001',
      name: 'SAMPLE PATIENT',
      dateOfBirth: '1972-03-04',
      ageDisplay: '54 y',
      sex: 'female',
      phone: '00000 00000',
      address: 'Sample address',
      createdAt: '2026-10-21T10:00:00',
      updatedAt: '2026-10-21T10:00:00'
    },
    document: doc,
    doctor: doctor ?? { name: 'Dr Sample Doctor', registrationNo: 'REG-0000', qualifications: 'MBBS, MD' },
    clinic
  }
}
