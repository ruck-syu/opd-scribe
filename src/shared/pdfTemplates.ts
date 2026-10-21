import { NOT_DOCUMENTED } from './defaults'
import type {
  Finding,
  FindingState,
  LayoutSettings,
  Medication,
  TextSection,
  VerifiedSnapshot,
  VisitDocument,
  Vitals
} from './types'

export interface RenderOptions {
  draft: boolean
  /** print clinic name/address at the top (used when no letterhead is configured) */
  clinicHeader?: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DRAFT_TEXT = 'UNVERIFIED DRAFT — NOT FOR CLINICAL USE'

const isBlank = (s: string): boolean => s.trim() === ''

const nd = (): string => `<span class="nd">${escapeHtml(NOT_DOCUMENTED)}</span>`

const textValue = (s: string): string => (isBlank(s) ? nd() : escapeHtml(s.trim()))

const requiredField = (s: string): string =>
  isBlank(s) ? '<span class="missing">[not specified]</span>' : escapeHtml(s.trim())

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatVisitDateTime(raw: string): string {
  if (isBlank(raw)) return nd()
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(raw.trim())
  if (!m) return escapeHtml(raw)
  const month = MONTHS[Number(m[2]) - 1]
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  if (!month || day < 1 || day > 31 || hour > 23 || minute > 59) return escapeHtml(raw)
  return `${day} ${month} ${m[1]}, ${m[4]}:${m[5]}`
}

function heading(tag: 'h1' | 'h2' | 'h3', label: string): string {
  return `<${tag}>${escapeHtml(label)}</${tag}>`
}

function identityBox(snap: VerifiedSnapshot): string {
  const p = snap.patient
  const ageOrDob = !isBlank(p.ageDisplay)
    ? escapeHtml(p.ageDisplay.trim())
    : p.dateOfBirth && !isBlank(p.dateOfBirth)
      ? escapeHtml(p.dateOfBirth.trim())
      : nd()
  const sex = p.sex === 'male' ? 'Male' : p.sex === 'female' ? 'Female' : p.sex === 'other' ? 'Other' : nd()
  const rows: Array<[string, string]> = [
    ['Name', textValue(p.name)],
    ['MRN', textValue(p.mrn)],
    ['Age / DOB', ageOrDob],
    ['Sex', sex],
    ['Visit date/time', formatVisitDateTime(snap.document.visitDateTime)],
    ['Visit type', textValue(snap.document.visitType)]
  ]
  const cells = rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`).join('')
  return `<div class="identity"><table class="kv">${cells}</table></div>`
}

function textBody(text: string): string {
  return isBlank(text) ? `<p class="nd">${escapeHtml(NOT_DOCUMENTED)}</p>` : `<div class="text">${escapeHtml(text)}</div>`
}

function textBlock(label: string, section: TextSection, level: 2 | 3): string {
  return `<section class="block">${heading(level === 2 ? 'h2' : 'h3', label)}${textBody(section.text)}</section>`
}

function optionalTextBlock(label: string, section: TextSection): string {
  return isBlank(section.text) ? '' : textBlock(label, section, 2)
}

function findingsList(findings: Finding[]): string {
  const shown = findings.filter((f) => f.state === 'present' || f.state === 'absent')
  if (shown.length === 0) return `<p class="nd">${escapeHtml(NOT_DOCUMENTED)}</p>`
  const items = shown.map((f) => {
    const status = f.state === 'present' ? 'Present' : 'Denied / absent'
    const extras: string[] = []
    if (!isBlank(f.grade)) extras.push(`Grade: ${escapeHtml(f.grade.trim())}`)
    if (!isBlank(f.note)) extras.push(escapeHtml(f.note.trim()))
    const suffix = extras.length > 0 ? ` — ${extras.join(' — ')}` : ''
    return `<li><strong>${escapeHtml(f.name.trim())}</strong>: ${status}${suffix}</li>`
  })
  return `<ul class="findings">${items.join('')}</ul>`
}

function triStateText(state: FindingState): string {
  if (state === 'present') return 'Yes'
  if (state === 'absent') return 'No'
  return nd()
}

function kvTable(rows: Array<[string, string]>): string {
  const cells = rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value.trim())}</td></tr>`).join('')
  return `<table class="kv">${cells}</table>`
}

const VITAL_FIELDS: Array<[keyof Vitals, string]> = [
  ['bp', 'BP'],
  ['pulse', 'Pulse'],
  ['temperature', 'Temp'],
  ['spo2', 'SpO2'],
  ['respiratoryRate', 'RR'],
  ['weight', 'Weight'],
  ['height', 'Height'],
  ['other', 'Other']
]

function vitalsTable(vitals: Vitals): string {
  const rows: Array<[string, string]> = []
  for (const [key, label] of VITAL_FIELDS) {
    if (!isBlank(vitals[key])) rows.push([label, vitals[key]])
  }
  return rows.length === 0 ? `<p class="nd">${escapeHtml(NOT_DOCUMENTED)}</p>` : kvTable(rows)
}

function clearanceText(decision: VisitDocument['oncology']['clearance']['decision']): string {
  if (decision === 'yes') return 'Cleared'
  if (decision === 'no') return 'Not cleared'
  if (decision === 'defer') return 'Deferred'
  return nd()
}

function oncologyBlock(doc: VisitDocument): string {
  const o = doc.oncology
  const treatment: Array<[string, string]> = []
  if (!isBlank(o.regimen)) treatment.push(['Regimen', o.regimen])
  if (!isBlank(o.cycleNumber)) treatment.push(['Cycle number', o.cycleNumber])
  if (!isBlank(o.cycleDay)) treatment.push(['Cycle day', o.cycleDay])
  if (!isBlank(o.lastTreatmentDate)) treatment.push(['Last treatment date', o.lastTreatmentDate])
  if (!isBlank(o.nextPlannedTreatment)) treatment.push(['Next planned treatment', o.nextPlannedTreatment])
  const treatmentHtml = treatment.length === 0 ? `<p class="nd">${escapeHtml(NOT_DOCUMENTED)}</p>` : kvTable(treatment)
  const reason = isBlank(o.clearance.reason) ? '' : `<p>Reason: ${escapeHtml(o.clearance.reason.trim())}</p>`
  return `<section class="block">
${heading('h2', 'Oncology')}
<p class="ecog">${o.ecog === null ? nd() : `ECOG ${escapeHtml(String(o.ecog))}`}</p>
${heading('h3', 'Treatment')}
${treatmentHtml}
${heading('h3', 'Toxicity review')}
${findingsList(o.toxicities)}
${heading('h3', 'Treatment clearance')}
<p>${clearanceText(o.clearance.decision)}</p>
${reason}
${heading('h3', 'Investigations reviewed')}
${textBody(o.investigationsReviewed.text)}
</section>`
}

function medicationItem(med: Medication): string {
  const name = requiredField(med.name)
  const strength = isBlank(med.formulationStrength) ? '' : ` <strong>${escapeHtml(med.formulationStrength.trim())}</strong>`
  const fields = [
    ['Dose', med.dose],
    ['Route', med.route],
    ['Frequency', med.frequency],
    ['Duration', med.duration]
  ].map(([label, value]) => `${label}: ${requiredField(value)}`)
  if (!isBlank(med.quantity)) fields.push(`Quantity: ${escapeHtml(med.quantity.trim())}`)
  if (!isBlank(med.instructions)) fields.push(`Instructions: ${escapeHtml(med.instructions.trim())}`)
  return `<li class="med"><div class="med-name"><strong>${name}</strong>${strength}</div><div class="med-details">${fields.join(' · ')}</div></li>`
}

function signatureBlock(snap: VerifiedSnapshot): string {
  const d = snap.doctor
  const footer = isBlank(snap.clinic.footerText)
    ? ''
    : `<div class="footer-text">${escapeHtml(snap.clinic.footerText)}</div>`
  return `<div class="signature-block">
<div class="signature-name">${textValue(d.name)}</div>
<div class="signature-meta">${textValue(d.qualifications)}</div>
<div class="signature-meta">Reg. No: ${textValue(d.registrationNo)}</div>
<div class="signature-line"></div>
<div class="signature-label">Signature</div>
${footer}
</div>`
}

function draftBanner(): string {
  return `<div class="draft-banner">${DRAFT_TEXT}</div>`
}

function draftWatermark(): string {
  const cells = Array.from({ length: 15 }, () => `<span>${DRAFT_TEXT}</span>`).join('')
  return `<div class="watermark" aria-hidden="true">${cells}</div>`
}

function styles(layout: LayoutSettings): string {
  const { marginTopMm, marginRightMm, marginBottomMm, marginLeftMm, fontSizePt } = layout
  return `
@page { size: A4; margin: ${marginTopMm}mm ${marginRightMm}mm ${marginBottomMm}mm ${marginLeftMm}mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; font-size: ${fontSizePt}pt; line-height: 1.45; color: #111; }
h1 { font-size: 1.7em; margin: 0 0 4mm; }
h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
h2 { font-size: 1.15em; margin: 6mm 0 2mm; padding-bottom: 1mm; border-bottom: 0.5pt solid #999; }
h3 { font-size: 1em; margin: 4mm 0 1.5mm; }
p { margin: 0 0 2mm; }
ul, ol { margin: 0 0 2mm; padding-left: 6mm; }
li { margin: 0 0 1.2mm; }
.block { margin: 0 0 4mm; }
.text { white-space: pre-wrap; }
.nd { color: #666; font-style: italic; }
.missing { color: #b00020; font-weight: 700; }
.identity { margin: 0 0 5mm; padding: 1mm 3mm; border: 0.5pt solid #999; break-inside: avoid; page-break-inside: avoid; }
table.kv { width: 100%; border-collapse: collapse; margin: 0 0 2mm; }
table.kv tr { break-inside: avoid; page-break-inside: avoid; }
table.kv th, table.kv td { text-align: left; vertical-align: top; padding: 1mm 2mm 1mm 0; border-bottom: 0.4pt dotted #ccc; }
table.kv th { width: 30%; font-weight: 600; white-space: nowrap; }
.meds { padding-left: 7mm; }
.med { margin: 0 0 3mm; break-inside: avoid; page-break-inside: avoid; }
.med-name { font-size: 1.02em; }
.med-details { margin-top: 0.8mm; }
.signature-block { margin-top: 10mm; break-inside: avoid; page-break-inside: avoid; }
.signature-name { font-weight: 600; }
.signature-meta { color: #333; }
.signature-line { width: 60mm; height: 14mm; margin-top: 3mm; border-bottom: 0.7pt solid #111; }
.signature-label { font-size: 0.9em; color: #444; }
.footer-text { margin-top: 6mm; padding-top: 2mm; border-top: 0.4pt solid #ccc; font-size: 0.9em; white-space: pre-wrap; }
.clinic-header { margin: 0 0 5mm; padding-bottom: 2mm; border-bottom: 1pt solid #333; text-align: center; }
.clinic-name { font-size: 1.35em; font-weight: 700; }
.clinic-address { color: #333; white-space: pre-wrap; }
.page-break { height: 0; break-before: page; page-break-before: always; }
.draft-banner { margin: 0 0 4mm; padding: 2mm; border: 1.5pt solid #b00020; color: #b00020; background: #fff1f0; font-weight: 700; text-align: center; letter-spacing: 0.4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.watermark { position: fixed; top: -20mm; right: -20mm; bottom: -20mm; left: -20mm; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(5, 1fr); place-items: center; gap: 6mm; transform: rotate(-28deg); opacity: 0.07; pointer-events: none; z-index: 9999; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.watermark span { font-size: 20pt; font-weight: 700; color: #000; white-space: nowrap; }
`
}

function clinicHeader(snap: VerifiedSnapshot): string {
  const { clinicName, clinicAddress } = snap.clinic
  if (isBlank(clinicName) && isBlank(clinicAddress)) return ''
  return `<header class="clinic-header">${isBlank(clinicName) ? '' : `<div class="clinic-name">${escapeHtml(clinicName.trim())}</div>`}${
    isBlank(clinicAddress) ? '' : `<div class="clinic-address">${escapeHtml(clinicAddress.trim())}</div>`
  }</header>`
}

function wrapDocument(title: string, layout: LayoutSettings, opts: RenderOptions, body: string, snap: VerifiedSnapshot): string {
  const overlay = `${opts.draft ? `${draftBanner()}${draftWatermark()}` : ''}${opts.clinicHeader ? clinicHeader(snap) : ''}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${styles(layout)}</style>
</head>
<body>
${overlay}
${body}
</body>
</html>`
}

function noteBody(snap: VerifiedSnapshot): string {
  const doc = snap.document
  const h = doc.history
  return `<article class="doc doc-note">
${heading('h1', 'OPD Visit Note')}
${identityBox(snap)}
<section class="block">
${heading('h2', 'Patient-reported history')}
${textBlock('Chief complaints', h.chiefComplaints, 3)}
${textBlock('History of present illness', h.hpi, 3)}
${textBlock('Past history', h.pastHistory, 3)}
${textBlock('Medication history', h.medicationHistory, 3)}
<section class="block">${heading('h3', 'Symptoms')}${findingsList(h.symptoms)}</section>
<section class="block">${heading('h3', 'Allergies reviewed')}<p>${triStateText(h.allergiesReviewed)}</p></section>
</section>
<section class="block">${heading('h2', 'Vitals')}${vitalsTable(doc.vitals)}</section>
${oncologyBlock(doc)}
${textBlock('Examination (doctor)', doc.examination, 2)}
${textBlock('Assessment (as documented by doctor)', doc.assessment, 2)}
${textBlock('Plan (as documented by doctor)', doc.plan, 2)}
${signatureBlock(snap)}
</article>`
}

function prescriptionBody(snap: VerifiedSnapshot): string {
  const rx = snap.document.prescription
  const meds = rx.medications.length === 0
    ? '<p>No medicines prescribed</p>'
    : `<ol class="meds">${rx.medications.map((med) => medicationItem(med)).join('')}</ol>`
  return `<article class="doc doc-prescription">
${heading('h1', 'Prescription & Plan')}
${identityBox(snap)}
<section class="block">
${heading('h2', 'Medicines')}
${meds}
</section>
${optionalTextBlock('Investigations advised', rx.investigationsAdvised)}
${optionalTextBlock('Advice', rx.advice)}
${optionalTextBlock('Return precautions', rx.returnPrecautions)}
${textBlock('Follow-up', rx.followUp, 2)}
${signatureBlock(snap)}
</article>`
}

export function renderNoteHtml(snap: VerifiedSnapshot, layout: LayoutSettings, opts: RenderOptions): string {
  return wrapDocument('OPD Visit Note', layout, opts, noteBody(snap), snap)
}

export function renderPrescriptionHtml(snap: VerifiedSnapshot, layout: LayoutSettings, opts: RenderOptions): string {
  return wrapDocument('Prescription & Plan', layout, opts, prescriptionBody(snap), snap)
}

export function renderCombinedHtml(snap: VerifiedSnapshot, layout: LayoutSettings, opts: RenderOptions): string {
  const body = `${noteBody(snap)}<div class="page-break" aria-hidden="true"></div>${prescriptionBody(snap)}`
  return wrapDocument('OPD Visit Note / Prescription & Plan', layout, opts, body, snap)
}
