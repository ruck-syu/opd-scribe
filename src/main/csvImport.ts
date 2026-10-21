import Papa from 'papaparse'
import type { PatientInput } from '../shared/types'

export interface CsvImportResult {
  rows: PatientInput[]
  errors: { line: number; message: string }[]
  unmappedColumns: string[]
}

type Field = 'mrn' | 'name' | 'dateOfBirth' | 'ageDisplay' | 'sex' | 'phone' | 'address'

const ALIASES: Record<Field, string[]> = {
  mrn: ['mrn', 'mrno', 'uhid', 'opd', 'opdno', 'opdnumber', 'patientid', 'regno', 'registrationno'],
  name: ['name', 'patientname', 'fullname'],
  dateOfBirth: ['dob', 'dateofbirth', 'birthdate'],
  ageDisplay: ['age'],
  sex: ['sex', 'gender'],
  phone: ['phone', 'mobile', 'contact', 'phoneno', 'mobileno'],
  address: ['address']
}

const FIELDS = Object.keys(ALIASES) as Field[]

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_.-]/g, '')
}

function mapColumns(headers: string[]): {
  columns: Partial<Record<Field, string>>
  unmapped: string[]
} {
  const columns: Partial<Record<Field, string>> = {}
  const unmapped: string[] = []
  for (const header of headers) {
    const key = normalizeHeader(header)
    if (!key) continue
    const field = FIELDS.find((candidate) => ALIASES[candidate].includes(key))
    if (!field) {
      unmapped.push(header.trim())
    } else if (!columns[field]) {
      columns[field] = header
    }
  }
  return { columns, unmapped }
}

function normalizeSex(raw: string): PatientInput['sex'] {
  switch (raw.trim().toLowerCase()) {
    case 'm':
    case 'male':
      return 'male'
    case 'f':
    case 'female':
      return 'female'
    case 'o':
    case 'other':
    case 'others':
    case 'transgender':
      return 'other'
    default:
      return ''
  }
}

function normalizeAgeDisplay(raw: string): string {
  const text = raw.trim()
  return /^\d+$/.test(text) ? `${text} y` : text
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

function todayIso(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseDateOfBirth(raw: string, now: Date): { value: string | null; invalid: boolean } {
  const text = raw.trim()
  if (!text) return { value: null, invalid: false }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text)
  let parts: [number, number, number] | null = null
  if (iso) {
    parts = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  } else if (dayFirst) {
    parts = [Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1])]
  }
  if (!parts) return { value: null, invalid: true }
  const value = toIsoDate(parts[0], parts[1], parts[2])
  if (!value) return { value: null, invalid: true }
  if (value > todayIso(now)) return { value: null, invalid: true }
  return { value, invalid: false }
}

export function parsePatientCsv(csvText: string, now: Date = new Date()): CsvImportResult {
  const text = csvText.replace(/^\uFEFF/, '')
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy'
  })
  const headers = (parsed.meta.fields ?? []).filter((field) => typeof field === 'string')
  const { columns, unmapped } = mapColumns(headers)

  const missing: string[] = []
  if (!columns.mrn) missing.push('mrn')
  if (!columns.name) missing.push('name')
  if (missing.length > 0) {
    const message =
      missing.length === 1
        ? `Missing required column: ${missing[0]}`
        : `Missing required columns: ${missing.join(', ')}`
    return { rows: [], errors: [{ line: 1, message }], unmappedColumns: unmapped }
  }

  const rows: PatientInput[] = []
  const errors: { line: number; message: string }[] = []
  const seenMrn = new Set<string>()

  parsed.data.forEach((raw, index) => {
    const line = index + 2
    const record = raw as Record<string, string | undefined>
    const cell = (field: Field): string => {
      const header = columns[field]
      return header === undefined ? '' : String(record[header] ?? '').trim()
    }

    const mrn = cell('mrn')
    const name = cell('name')
    if (!mrn) errors.push({ line, message: 'Missing MRN' })
    if (!name) errors.push({ line, message: 'Missing name' })
    if (!mrn || !name) return
    if (seenMrn.has(mrn)) {
      errors.push({ line, message: 'Duplicate MRN in file' })
      return
    }
    seenMrn.add(mrn)

    const dob = parseDateOfBirth(cell('dateOfBirth'), now)
    if (dob.invalid) errors.push({ line, message: 'Invalid date of birth' })

    rows.push({
      mrn,
      name,
      dateOfBirth: dob.value,
      ageDisplay: normalizeAgeDisplay(cell('ageDisplay')),
      sex: normalizeSex(cell('sex')),
      phone: cell('phone'),
      address: cell('address')
    })
  })

  return { rows, errors, unmappedColumns: unmapped }
}
