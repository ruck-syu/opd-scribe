// Shared domain types used by main, preload and renderer.
// Schema rule (PRD §6.2): empty strings / nulls / 'not_assessed' are NEVER clinical negatives.

import type { FormatSettings } from './formTemplate'

export const SCHEMA_VERSION = 1

export type Role = 'doctor' | 'staff'

export interface User {
  id: string
  name: string
  role: Role
  registrationNo: string
  qualifications: string
  active: boolean
}

export interface Patient {
  id: string
  mrn: string
  name: string
  dateOfBirth: string | null // ISO yyyy-mm-dd
  ageDisplay: string // free text when DOB unknown, e.g. "54 y"
  sex: '' | 'male' | 'female' | 'other'
  phone: string
  address: string
  createdAt: string
  updatedAt: string
}

export type PatientInput = Omit<Patient, 'id' | 'createdAt' | 'updatedAt'>

/** Where a piece of content came from (CMP-08). */
export type SourceKind = 'conversation' | 'dictation' | 'manual' | 'prior_record'

export interface SourceRef {
  kind: SourceKind
  /** transcript id / segment id for conversation & dictation */
  refId?: string
  at: string
}

/** A free-text clinical section with provenance. */
export interface TextSection {
  text: string
  sources: SourceRef[]
}

/** Tri-state finding (ONC-04): never default to absent. */
export type FindingState = 'not_assessed' | 'present' | 'absent'

export interface Finding {
  id: string
  name: string
  state: FindingState
  /** optional grade text as entered by the doctor, e.g. "G2" */
  grade: string
  note: string
}

export type ClearanceDecision = 'not_documented' | 'yes' | 'no' | 'defer'

export interface Medication {
  id: string
  name: string
  formulationStrength: string
  dose: string
  route: string
  frequency: string
  duration: string
  quantity: string
  instructions: string
  /** doctor's original wording when entered from dictation (RX-03) */
  sourceText: string
}

export interface Vitals {
  bp: string
  pulse: string
  temperature: string
  spo2: string
  respiratoryRate: string
  weight: string
  height: string
  other: string
}

export interface VisitDocument {
  schemaVersion: number
  visitDateTime: string
  visitType: string
  history: {
    chiefComplaints: TextSection
    hpi: TextSection
    pastHistory: TextSection
    medicationHistory: TextSection
    allergiesReviewed: FindingState
    symptoms: Finding[]
  }
  vitals: Vitals
  oncology: {
    ecog: number | null // 0-4, null = not recorded
    toxicities: Finding[]
    regimen: string
    cycleNumber: string
    cycleDay: string
    lastTreatmentDate: string
    nextPlannedTreatment: string
    clearance: { decision: ClearanceDecision; reason: string }
    investigationsReviewed: TextSection
  }
  examination: TextSection
  assessment: TextSection
  plan: TextSection
  prescription: {
    medications: Medication[]
    investigationsAdvised: TextSection
    advice: TextSection
    returnPrecautions: TextSection
    followUp: TextSection
  }
  /** ids of warnings the doctor explicitly acknowledged for the current content */
  acknowledgedFlags: string[]
}

/** Longitudinal oncology summary (ONC-01), stored per patient, each field dated (ONC-08). */
export const ONCOLOGY_SUMMARY_FIELDS = [
  ['primarySite', 'Primary site'],
  ['laterality', 'Laterality'],
  ['histology', 'Histology / pathology'],
  ['diagnosisDate', 'Date of diagnosis'],
  ['stage', 'Stage'],
  ['stagingSystemDate', 'Staging system & date'],
  ['biomarkers', 'Biomarkers / molecular'],
  ['priorTreatments', 'Prior surgery / RT / systemic therapy'],
  ['currentLine', 'Current line of therapy'],
  ['regimen', 'Protocol / regimen'],
  ['devices', 'Devices (port, central line)'],
  ['comorbidities', 'Comorbidities'],
  ['allergies', 'Allergies'],
  ['complications', 'Relevant prior complications'],
  ['reports', 'Pathology / imaging / lab references']
] as const

export type OncologySummaryKey = (typeof ONCOLOGY_SUMMARY_FIELDS)[number][0]

export interface SummaryField {
  value: string
  updatedAt: string
  updatedBy: string // user name
  source: string // 'manual' | 'visit:<encounterId>'
}

export type OncologySummary = Partial<Record<OncologySummaryKey, SummaryField>>

// ---------- Transcripts ----------

export type Speaker = 'unlabelled' | 'doctor' | 'patient' | 'attendant' | 'other'

export interface TranscriptSegment {
  id: string
  startMs: number
  endMs: number
  /** immutable engine output (AUD-11) */
  originalText: string
  /** current (possibly corrected) text */
  text: string
  speaker: Speaker
  /** true until a human set the speaker (AUD-08) */
  speakerUncertain: boolean
  /** engine-level warning, e.g. repeated/hallucinated output or gap */
  warning: string
}

export type DictationSection = 'examination' | 'assessment' | 'plan'
export type TranscriptKind = 'conversation' | 'dictation'

export interface Transcript {
  id: string
  encounterId: string
  kind: TranscriptKind
  section: DictationSection | null
  createdAt: string
  durationMs: number
  status: 'transcribing' | 'ready' | 'failed'
  error: string
  segments: TranscriptSegment[]
  /** doctor confirmed the transcript was reviewed */
  reviewed: boolean
  audioRetained: boolean
}

// ---------- Encounters, revisions, verification ----------

export type LifecycleStatus =
  | 'draft' // never verified
  | 'verified' // current content == latest verified revision (rev 1)
  | 'amending' // a verified visit reopened, edits not yet verified
  | 'amended' // current content == latest verified revision (rev > 1)

export interface Encounter {
  id: string
  patientId: string
  createdAt: string
  createdBy: string
  status: LifecycleStatus
  document: VisitDocument
  /** hash of the latest verified revision, null if none */
  verifiedHash: string | null
  amendmentReason: string
}

export interface EncounterSummary {
  id: string
  patientId: string
  visitDateTime: string
  status: LifecycleStatus
  createdAt: string
  revisionCount: number
}

export interface Revision {
  id: string
  encounterId: string
  revisionNo: number
  hash: string
  verifiedBy: string // user id
  verifiedByName: string
  verifiedAt: string
  amendmentReason: string
  snapshot: VerifiedSnapshot
}

/** Everything that was rendered & verified, frozen. */
export interface VerifiedSnapshot {
  patient: Patient
  document: VisitDocument
  doctor: { name: string; registrationNo: string; qualifications: string }
  clinic: ClinicSettings
  /** print formats in force when rendered; frozen at verification, excluded from the content hash */
  formats?: FormatSettings
}

// ---------- Flags ----------

export interface ReviewFlag {
  id: string // stable for the same issue, used for acknowledgement
  severity: 'blocking' | 'warning'
  area: 'identity' | 'history' | 'transcript' | 'dictation' | 'oncology' | 'note' | 'prescription'
  message: string
}

// ---------- Settings ----------

export interface ClinicSettings {
  clinicName: string
  clinicAddress: string
  footerText: string
}

export interface LayoutSettings {
  /** content margins in mm (space reserved for letterhead header/footer) */
  marginTopMm: number
  marginBottomMm: number
  marginLeftMm: number
  marginRightMm: number
  /** calibration offset applied to content, mm */
  offsetXMm: number
  offsetYMm: number
  letterheadEveryPage: boolean
  combinedPdf: boolean
  fontSizePt: number
}

export interface AsrSettings {
  binaryPath: string
  modelPath: string
  language: string // 'hi' | 'en' | 'auto'
  threads: number
  initialPrompt: string // clinic formulary / terminology hint
}

export interface AppSettings {
  clinic: ClinicSettings
  layout: LayoutSettings
  asr: AsrSettings
  /** STO-04: default delete raw audio after transcript confirmed */
  retainAudio: boolean
  autoLockMinutes: number
  toxicityChecklist: string[]
  symptomChecklist: string[]
  /** letterhead file stored encrypted in app data; only its type is in settings */
  letterheadType: '' | 'pdf' | 'png' | 'jpg'
  /** custom print formats built from an uploaded sample; null = built-in format */
  formats: FormatSettings
}

export interface AuditEntry {
  id: string
  at: string
  userId: string
  action: string
  entity: string
  entityId: string
  detail: string // never contains PHI
}
