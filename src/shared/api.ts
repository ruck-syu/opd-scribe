import type {
  AppSettings,
  AuditEntry,
  DictationSection,
  Encounter,
  EncounterSummary,
  OncologySummary,
  OncologySummaryKey,
  Patient,
  PatientInput,
  ReviewFlag,
  Revision,
  Role,
  Transcript,
  TranscriptKind,
  User,
  VisitDocument
} from './types'
import type { DocKind, FormTemplate } from './formTemplate'

export interface AppStatus {
  setupDone: boolean
  user: User | null
  platform: string
  version: string
}

export interface SetupInput {
  clinicName: string
  clinicAddress: string
  doctor: { name: string; registrationNo: string; qualifications: string; pin: string }
}

export interface UserInput {
  name: string
  role: Role
  registrationNo: string
  qualifications: string
  pin: string
}

export interface CsvPreview {
  fileName: string
  rows: PatientInput[]
  errors: { line: number; message: string }[]
  unmappedColumns: string[]
  existingMrns: string[]
}

export interface TranscribeInput {
  encounterId: string
  patientId: string
  kind: TranscriptKind
  section: DictationSection | null
  wav: ArrayBuffer
  durationMs: number
}

export interface PreviewResult {
  /** one or two PDFs (note, prescription) depending on layout.combinedPdf */
  pdfs: { name: string; data: Uint8Array }[]
  draft: boolean
}

export interface SampleInfo {
  sampleId: string
  sampleType: 'pdf' | 'png' | 'jpg'
  /** size of the sample's first page (A4 for images) */
  pageWidthMm: number
  pageHeightMm: number
}

export interface AsrCheck {
  binaryOk: boolean
  modelOk: boolean
  message: string
}

/** Every IPC channel and its signature. Main implements, preload allow-lists, renderer calls. */
export interface ApiMap {
  'app.status': () => AppStatus
  'auth.setup': (input: SetupInput) => User
  'auth.users': () => Pick<User, 'id' | 'name' | 'role'>[]
  'auth.login': (userId: string, pin: string) => User
  'auth.lock': () => void
  'users.list': () => User[]
  'users.create': (input: UserInput) => User
  'users.update': (id: string, patch: Partial<Omit<UserInput, 'pin'>> & { active?: boolean }) => User
  'users.setPin': (id: string, pin: string) => void

  'settings.get': () => AppSettings
  'settings.update': (patch: Partial<AppSettings>) => AppSettings
  'settings.uploadLetterhead': () => AppSettings
  'settings.clearLetterhead': () => AppSettings
  'settings.testPrint': () => PreviewResult
  'settings.checkAsr': () => AsrCheck
  'settings.pickFile': (title: string, extensions: string[]) => string | null

  /** pick a sample OPD PDF/PNG/JPG, store it encrypted; null if cancelled */
  'formats.uploadSample': (kind: DocKind) => SampleInfo | null
  'formats.sample': (sampleId: string) => { type: 'pdf' | 'png' | 'jpg'; data: Uint8Array } | null
  /** save (version bumped, validated) or revert to the built-in format with null */
  'formats.save': (kind: DocKind, template: FormTemplate | null) => AppSettings
  /** render an unsaved template with a fictitious sample patient (draft watermark) */
  'formats.preview': (template: FormTemplate) => PreviewResult

  'patients.search': (query: string) => Patient[]
  'patients.get': (id: string) => Patient
  'patients.create': (input: PatientInput) => Patient
  'patients.update': (id: string, input: PatientInput) => Patient
  'patients.importPreview': () => CsvPreview | null
  'patients.importCommit': (rows: PatientInput[]) => { imported: number; skipped: number }

  'summary.get': (patientId: string) => OncologySummary
  'summary.update': (patientId: string, key: OncologySummaryKey, value: string) => OncologySummary

  'encounters.list': (patientId: string) => EncounterSummary[]
  'encounters.create': (patientId: string) => Encounter
  'encounters.get': (encounterId: string, patientId: string) => Encounter
  'encounters.save': (encounterId: string, patientId: string, doc: VisitDocument) => Encounter
  'encounters.startAmendment': (encounterId: string, patientId: string, reason: string) => Encounter
  'encounters.revisions': (encounterId: string, patientId: string) => Revision[]

  'transcripts.list': (encounterId: string, patientId: string) => Transcript[]
  'transcripts.transcribe': (input: TranscribeInput) => Transcript
  'transcripts.retry': (transcriptId: string, encounterId: string, patientId: string) => Transcript
  'transcripts.save': (transcript: Transcript, patientId: string) => Transcript
  'transcripts.delete': (transcriptId: string, encounterId: string, patientId: string) => void

  'review.flags': (encounterId: string, patientId: string) => ReviewFlag[]
  'review.preview': (encounterId: string, patientId: string) => PreviewResult
  'review.previewRevision': (encounterId: string, patientId: string, revisionNo: number) => PreviewResult
  'review.verify': (encounterId: string, patientId: string, pin: string) => Encounter
  'review.export': (encounterId: string, patientId: string) => string[] | null
  'review.openExported': (path: string) => void

  'backup.create': (passphrase: string) => string | null
  'backup.restore': (passphrase: string) => boolean

  'audit.list': (limit: number) => AuditEntry[]
}

export type Channel = keyof ApiMap

/** Runtime allow-list (must contain every key of ApiMap). */
export const CHANNELS = [
  'app.status',
  'auth.setup',
  'auth.users',
  'auth.login',
  'auth.lock',
  'users.list',
  'users.create',
  'users.update',
  'users.setPin',
  'settings.get',
  'settings.update',
  'settings.uploadLetterhead',
  'settings.clearLetterhead',
  'settings.testPrint',
  'settings.checkAsr',
  'settings.pickFile',
  'formats.uploadSample',
  'formats.sample',
  'formats.save',
  'formats.preview',
  'patients.search',
  'patients.get',
  'patients.create',
  'patients.update',
  'patients.importPreview',
  'patients.importCommit',
  'summary.get',
  'summary.update',
  'encounters.list',
  'encounters.create',
  'encounters.get',
  'encounters.save',
  'encounters.startAmendment',
  'encounters.revisions',
  'transcripts.list',
  'transcripts.transcribe',
  'transcripts.retry',
  'transcripts.save',
  'transcripts.delete',
  'review.flags',
  'review.preview',
  'review.previewRevision',
  'review.verify',
  'review.export',
  'review.openExported',
  'backup.create',
  'backup.restore',
  'audit.list'
] as const satisfies readonly Channel[]

// compile-time check that CHANNELS covers ApiMap
type Missing = Exclude<Channel, (typeof CHANNELS)[number]>
export const _channelsComplete: Missing extends never ? true : Missing = true

/** Events pushed from main to renderer. */
export interface EventMap {
  'transcripts.changed': { encounterId: string; transcriptId: string; progress: number | null }
  'app.locked': Record<string, never>
}
export type EventName = keyof EventMap
export const EVENTS = ['transcripts.changed', 'app.locked'] as const satisfies readonly EventName[]

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Shape exposed on window.opd by the preload. */
export interface PreloadBridge {
  invoke(channel: Channel, ...args: unknown[]): Promise<IpcResult<unknown>>
  on(event: EventName, cb: (payload: unknown) => void): () => void
}
