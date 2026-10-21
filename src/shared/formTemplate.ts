// Custom print formats ("use my own OPD format"). The doctor uploads a sample of their existing
// note / prescription once, then maps where things go. Content is still rendered from structured
// data (never free text), and nothing documented is ever dropped by a format:
// a hidden section that has content is still printed, after the visible ones.

export type DocKind = 'note' | 'prescription'

/** A rectangle on the page, in mm from the top-left corner of the sheet. */
export interface BoxMm {
  xMm: number
  yMm: number
  wMm: number
  hMm: number
}

/** Short single-value fields placed at fixed positions (patient name, date...). */
export const FIELD_CATALOG = [
  ['patient.name', 'Patient name'],
  ['patient.mrn', 'MRN / UHID'],
  ['patient.ageSex', 'Age / Sex'],
  ['patient.age', 'Age / DOB'],
  ['patient.sex', 'Sex'],
  ['patient.phone', 'Phone'],
  ['patient.address', 'Address'],
  ['visit.date', 'Visit date'],
  ['visit.dateTime', 'Visit date & time'],
  ['visit.type', 'Visit type'],
  ['doctor.name', 'Doctor name'],
  ['doctor.qualifications', 'Doctor qualifications'],
  ['doctor.registrationNo', 'Doctor reg. no.'],
  ['clinic.name', 'Clinic name'],
  ['static', 'Fixed text']
] as const

export type FieldKey = (typeof FIELD_CATALOG)[number][0]

export interface FieldBox extends BoxMm {
  id: string
  field: FieldKey
  /** printed before the value, e.g. "Name: ". For 'static' this is the whole text. */
  label: string
  fontSizePt: number
  bold: boolean
  /** 'all' repeats the field on continuation pages (recommended for patient identity) */
  pages: 'first' | 'all'
}

/** Sections that flow (and paginate) inside the body box, in the order the doctor chooses. */
export const NOTE_SECTIONS = [
  ['identity', 'Patient details'],
  ['chiefComplaints', 'Chief complaints'],
  ['hpi', 'History of present illness'],
  ['pastHistory', 'Past history'],
  ['medicationHistory', 'Medication history'],
  ['symptoms', 'Symptoms'],
  ['allergies', 'Allergies reviewed'],
  ['vitals', 'Vitals'],
  ['oncology', 'Oncology'],
  ['examination', 'Examination'],
  ['assessment', 'Assessment'],
  ['plan', 'Plan'],
  ['signature', 'Signature']
] as const

export const PRESCRIPTION_SECTIONS = [
  ['identity', 'Patient details'],
  ['medications', 'Rx'],
  ['investigationsAdvised', 'Investigations advised'],
  ['advice', 'Advice'],
  ['returnPrecautions', 'Return precautions'],
  ['followUp', 'Follow-up'],
  ['signature', 'Signature']
] as const

export type SectionKey = (typeof NOTE_SECTIONS)[number][0] | (typeof PRESCRIPTION_SECTIONS)[number][0]

/**
 * Sections that are never "empty" for the purpose of hiding: identity and signature
 * may be hidden because the same data can be placed as fields; everything else is
 * clinical content and is printed whenever it has content, even when hidden.
 */
export const HIDEABLE_WHEN_FILLED: readonly SectionKey[] = ['identity', 'signature']

export interface SectionSpec {
  key: SectionKey
  /** heading printed above the section ('' = no heading) */
  heading: string
  show: boolean
}

export interface FormTemplate {
  id: string
  kind: DocKind
  /** bumped on every save; frozen into verified snapshots */
  version: number
  updatedAt: string
  /** sheet size, taken from the sample's first page (A4 for images) */
  pageWidthMm: number
  pageHeightMm: number
  /** id of the uploaded sample blob (stored as `format-sample-<sampleId>`); '' = none */
  sampleId: string
  sampleType: '' | 'pdf' | 'png' | 'jpg'
  /** what is printed under the content: the uploaded sample (blank form), the letterhead, or nothing (pre-printed paper) */
  background: 'sample' | 'letterhead' | 'none'
  /** draw the background on continuation pages too */
  repeatBackground: boolean
  /** document title printed at the top of the body ('' = none) */
  title: string
  /** where flowing content goes on page 1 and on continuation pages */
  bodyFirst: BoxMm
  bodyNext: BoxMm
  fontSizePt: number
  sections: SectionSpec[]
  fields: FieldBox[]
}

export interface FormatSettings {
  note: FormTemplate | null // null = built-in format
  prescription: FormTemplate | null
}

export const A4_MM = { w: 210, h: 297 }

export const sectionCatalog = (kind: DocKind): readonly (readonly [SectionKey, string])[] =>
  kind === 'note' ? NOTE_SECTIONS : PRESCRIPTION_SECTIONS

export function defaultTemplate(kind: DocKind, id: string, now: string): FormTemplate {
  return {
    id,
    kind,
    version: 0,
    updatedAt: now,
    pageWidthMm: A4_MM.w,
    pageHeightMm: A4_MM.h,
    sampleId: '',
    sampleType: '',
    background: 'letterhead',
    repeatBackground: true,
    title: kind === 'note' ? 'OPD Visit Note' : '',
    bodyFirst: { xMm: 15, yMm: 60, wMm: 180, hMm: 207 },
    bodyNext: { xMm: 15, yMm: 40, wMm: 180, hMm: 227 },
    fontSizePt: 10.5,
    sections: sectionCatalog(kind).map(([key, heading]) => ({ key, heading, show: true })),
    fields: []
  }
}

/** Returns a list of problems; empty means the template can be saved. */
export function validateTemplate(t: FormTemplate): string[] {
  const errs: string[] = []
  const inPage = (b: BoxMm, what: string): void => {
    if (![b.xMm, b.yMm, b.wMm, b.hMm].every(Number.isFinite)) errs.push(`${what}: invalid position`)
    else if (b.wMm < 5 || b.hMm < 5) errs.push(`${what}: too small`)
    else if (b.xMm < 0 || b.yMm < 0 || b.xMm + b.wMm > t.pageWidthMm + 0.5 || b.yMm + b.hMm > t.pageHeightMm + 0.5)
      errs.push(`${what}: outside the page`)
  }
  if (!(t.pageWidthMm >= 50 && t.pageHeightMm >= 50 && t.pageWidthMm <= 600 && t.pageHeightMm <= 600)) errs.push('Page size is invalid')
  inPage(t.bodyFirst, 'Content area (page 1)')
  inPage(t.bodyNext, 'Content area (continuation pages)')
  if (t.bodyFirst.hMm < 20 || t.bodyNext.hMm < 20) errs.push('Content areas must be at least 20 mm tall')
  if (!(t.fontSizePt >= 6 && t.fontSizePt <= 18)) errs.push('Font size must be 6–18 pt')
  if (t.background === 'sample' && !t.sampleId) errs.push('Upload a sample to use it as background')
  const allowed = new Set(sectionCatalog(t.kind).map(([k]) => k))
  const seen = new Set<string>()
  for (const s of t.sections) {
    if (!allowed.has(s.key)) errs.push(`Unknown section ${s.key}`)
    if (seen.has(s.key)) errs.push(`Section ${s.key} listed twice`)
    seen.add(s.key)
  }
  for (const k of allowed) if (!seen.has(k)) errs.push(`Section ${k} missing`)
  t.fields.forEach((f, i) => {
    inPage(f, `Field ${i + 1} (${f.label || f.field})`)
    if (!(f.fontSizePt >= 6 && f.fontSizePt <= 24)) errs.push(`Field ${i + 1}: font size must be 6–24 pt`)
    if (f.field === 'static' && !f.label.trim()) errs.push(`Field ${i + 1}: fixed text is empty`)
  })
  return errs
}
