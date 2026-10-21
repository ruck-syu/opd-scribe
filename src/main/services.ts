import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import type { ApiMap, Channel, PreviewResult } from '../shared/api'
import { canonicalJson, clinicalContent } from '../shared/canonical'
import { emptyDocument, uid } from '../shared/defaults'
import { canVerify, computeFlags } from '../shared/flags'
import { renderFormBodyHtml, renderFieldsOverlayHtml, sampleSnapshot } from '../shared/formRender'
import { A4_MM, validateTemplate, type DocKind, type FormTemplate } from '../shared/formTemplate'
import { renderNoteHtml, renderPrescriptionHtml } from '../shared/pdfTemplates'
import type {
  AppSettings,
  Encounter,
  OncologySummaryKey,
  Patient,
  PatientInput,
  Revision,
  Transcript,
  User,
  VerifiedSnapshot
} from '../shared/types'
import { ONCOLOGY_SUMMARY_FIELDS } from '../shared/types'
import { checkAsr, resolveAsr, runWhisper } from './asr'
import { createBackup, readBackup } from './backup'
import { hashPin, readEncrypted, verifyPin, writeEncrypted } from './crypto'
import { parsePatientCsv } from './csvImport'
import type { Store } from './db'
import { calibrationHtml, composePdf, concatPdfs, mmToPt, type Letterhead } from './pdfCompose'

/** Electron-specific capabilities, injected so services stay testable. */
export interface Platform {
  dataDir: string
  /** folders searched for whisper-cli and a ggml model when Settings paths are empty */
  whisperDirs: string[]
  version: string
  platform: string
  htmlToPdf(html: string): Promise<Uint8Array>
  openFile(title: string, extensions: string[]): Promise<string | null>
  saveFile(title: string, defaultName: string, extensions: string[]): Promise<string | null>
  openPath(path: string): Promise<void>
  emit(event: 'transcripts.changed', payload: { encounterId: string; transcriptId: string; progress: number | null }): void
}

type Handlers = { [C in Channel]: (...args: Parameters<ApiMap[C]>) => ReturnType<ApiMap[C]> | Promise<ReturnType<ApiMap[C]>> }

export class UserError extends Error {}
const fail = (msg: string): never => {
  throw new UserError(msg)
}
const nowIso = (): string => new Date().toISOString()
const localNow = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Sample blobs are identified by content, never by the file extension. */
function sampleBlobType(data: Uint8Array): 'pdf' | 'png' | 'jpg' | null {
  if (data.length >= 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) return 'pdf'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  return null
}

const SAMPLE_MAX_BYTES = 15 * 1024 * 1024
const round1 = (n: number): number => Math.round(n * 10) / 10

export function contentHash(snap: VerifiedSnapshot): string {
  // Print formats are presentation, not clinical content: editing them never invalidates
  // a verification, and legacy snapshots without formats hash exactly as before.
  const { formats: _formats, ...rest } = snap
  return createHash('sha256')
    .update(canonicalJson({ ...rest, document: clinicalContent(snap.document) }))
    .digest('hex')
}

const MAX_PIN_FAILURES = 5
const LOCKOUT_MS = 60_000

export class Services {
  private user: User | null = null
  private failures = 0
  private lockedUntil = 0

  constructor(
    private store: Store,
    private readonly key: Buffer,
    private readonly platform: Platform
  ) {
    mkdirSync(this.audioDir, { recursive: true, mode: 0o700 })
    rmSync(this.tmpDir, { recursive: true, force: true })
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 })
    for (const t of store.interruptedTranscripts()) {
      store.saveTranscript({ ...t, status: 'failed', error: 'Interrupted (app closed during transcription) — retry available' })
    }
  }

  get audioDir(): string {
    return join(this.platform.dataDir, 'audio')
  }
  get tmpDir(): string {
    return join(this.platform.dataDir, 'tmp')
  }
  private audioPath(transcriptId: string): string {
    if (!/^[\w-]+$/.test(transcriptId)) fail('Invalid transcript id')
    return join(this.audioDir, `${transcriptId}.enc`)
  }

  lock(): void {
    this.user = null
  }

  // ---------- guards ----------

  private requireUser(): User {
    return this.user ?? fail('Locked — please sign in')
  }
  private requireDoctor(): User {
    const u = this.requireUser()
    return u.role === 'doctor' ? u : fail('Only a doctor can do this')
  }
  private audit(action: string, entity: string, entityId: string, detail = ''): void {
    this.store.audit(this.user?.id ?? 'system', action, entity, entityId, detail)
  }
  private checkPin(userId: string, pin: string): void {
    if (Date.now() < this.lockedUntil) fail('Too many wrong PINs — wait a minute and try again')
    const hash = this.store.getPinHash(userId)
    if (!hash || !verifyPin(pin, hash)) {
      this.failures++
      if (this.failures >= MAX_PIN_FAILURES) {
        this.failures = 0
        this.lockedUntil = Date.now() + LOCKOUT_MS
      }
      this.store.audit(userId, 'auth.fail', 'user', userId)
      fail('Wrong PIN')
    }
    this.failures = 0
  }
  private validPin(pin: string): string {
    return /^\d{4,8}$/.test(pin) ? pin : fail('PIN must be 4–8 digits')
  }

  /** PAT-08: every encounter-scoped call must name the right patient. */
  private encounterFor(encounterId: string, patientId: string): Encounter {
    const e = this.store.getEncounter(encounterId) ?? fail('Visit not found')
    if (e.patientId !== patientId) {
      this.audit('binding.mismatch', 'encounter', encounterId)
      fail('Patient / visit mismatch — action blocked. Reopen the visit from the patient profile.')
    }
    return e
  }
  private patient(id: string): Patient {
    return this.store.getPatient(id) ?? fail('Patient not found')
  }

  private validatePatient(p: PatientInput, exceptId = ''): PatientInput {
    const clean: PatientInput = {
      mrn: p.mrn.trim(),
      name: p.name.trim(),
      dateOfBirth: p.dateOfBirth?.trim() || null,
      ageDisplay: p.ageDisplay.trim(),
      sex: p.sex,
      phone: p.phone.trim(),
      address: p.address.trim()
    }
    if (!clean.mrn) fail('MRN is required')
    if (!clean.name) fail('Name is required')
    if (clean.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(clean.dateOfBirth)) fail('Date of birth must be YYYY-MM-DD')
    if (clean.dateOfBirth && clean.dateOfBirth > localNow().slice(0, 10)) fail('Date of birth is in the future')
    if (this.store.mrnExists(clean.mrn, exceptId)) fail(`MRN ${clean.mrn} already belongs to another patient`)
    return clean
  }

  // ---------- documents / PDF ----------

  private snapshot(e: Encounter, doctor: Pick<User, 'name' | 'registrationNo' | 'qualifications'>): VerifiedSnapshot {
    const settings = this.store.getSettings()
    return {
      patient: this.patient(e.patientId),
      document: e.document,
      doctor: { name: doctor.name, registrationNo: doctor.registrationNo, qualifications: doctor.qualifications },
      clinic: settings.clinic,
      formats: settings.formats
    }
  }

  private letterhead(settings: AppSettings): Letterhead | null {
    const data = this.store.getBlob('letterhead')
    return data && settings.letterheadType ? { type: settings.letterheadType, data: new Uint8Array(data) } : null
  }

  private sample(sampleId: string): Letterhead | null {
    if (!sampleId) return null
    const data = this.store.getBlob(`format-sample-${sampleId}`)
    if (!data) return null
    const type = sampleBlobType(data)
    return type ? { type, data: new Uint8Array(data) } : null
  }

  /** Built-in format when `template` is null; otherwise the doctor's own layout. */
  private async renderKind(
    kind: DocKind,
    snap: VerifiedSnapshot,
    draft: boolean,
    template: FormTemplate | null,
    settings: AppSettings
  ): Promise<Uint8Array> {
    const label =
      kind === 'note' ? (draft ? 'DRAFT OPD Visit Note' : 'OPD Visit Note') : draft ? 'DRAFT Prescription & Plan' : 'Prescription & Plan'
    const p = snap.patient
    const identity = `${p.name} | MRN ${p.mrn} | Visit ${snap.document.visitDateTime.replace('T', ' ')}`

    if (!template) {
      const opts = { draft, clinicHeader: !settings.letterheadType }
      const html = kind === 'note' ? renderNoteHtml(snap, settings.layout, opts) : renderPrescriptionHtml(snap, settings.layout, opts)
      return composePdf(await this.platform.htmlToPdf(html), settings.layout, this.letterhead(settings), { identity, label })
    }

    const body = await this.platform.htmlToPdf(renderFormBodyHtml(snap, template, { draft }))
    const pageCount = (await PDFDocument.load(body)).getPageCount()
    const overlay =
      template.fields.length === 0
        ? null
        : await this.platform.htmlToPdf(renderFieldsOverlayHtml(snap, template, pageCount))
    const background =
      template.background === 'sample'
        ? (this.sample(template.sampleId) ?? fail('Sample file is missing — upload it again'))
        : template.background === 'letterhead'
          ? this.letterhead(settings)
          : null
    return composePdf(body, settings.layout, background, { identity, label }, {
      pageSize: { width: mmToPt(template.pageWidthMm), height: mmToPt(template.pageHeightMm) },
      backgrounds: { first: background, next: template.repeatBackground ? background : null },
      overlay,
      stampLeftMm: template.bodyNext.xMm,
      stampRightMm: template.pageWidthMm - template.bodyNext.xMm - template.bodyNext.wMm,
      stampBottomMm: 4
    })
  }

  private async renderPdfs(snap: VerifiedSnapshot, draft: boolean): Promise<PreviewResult> {
    const settings = this.store.getSettings()
    const formats = snap.formats ?? settings.formats
    const note = await this.renderKind('note', snap, draft, formats.note, settings)
    const rx = await this.renderKind('prescription', snap, draft, formats.prescription, settings)
    const pdfs = settings.layout.combinedPdf
      ? [{ name: 'visit', data: await concatPdfs([note, rx]) }]
      : [
          { name: 'note', data: note },
          { name: 'prescription', data: rx }
        ]
    return { pdfs, draft }
  }

  /** VER-07: only content identical to the latest verified revision may leave the app. */
  private exportableRevision(e: Encounter): Revision {
    if (e.status !== 'verified' && e.status !== 'amended') fail('This visit is not verified — export and print are blocked')
    const revs = this.store.listRevisions(e.id)
    const latest = revs[revs.length - 1] ?? fail('No verified revision found')
    if (latest.hash !== e.verifiedHash || contentHash(latest.snapshot) !== latest.hash)
      fail('Verified content integrity check failed — export blocked')
    const current = { ...latest.snapshot, document: e.document }
    if (contentHash(current) !== latest.hash) fail('Visit changed after verification — verify again before export')
    return latest
  }

  // ---------- transcription ----------

  private startTranscription(t: Transcript): void {
    const settings = this.store.getSettings()
    const wav = readEncrypted(this.key, this.audioPath(t.id))
    let last = -1
    runWhisper({
      asr: resolveAsr(settings.asr, this.platform.whisperDirs),
      wav,
      workDir: this.tmpDir,
      onProgress: (pct) => {
        if (pct === last) return
        last = pct
        this.platform.emit('transcripts.changed', { encounterId: t.encounterId, transcriptId: t.id, progress: pct })
      }
    })
      .then((segments) => {
        this.store.saveTranscript({ ...t, status: 'ready', error: '', segments })
        this.store.audit('system', 'transcript.ready', 'transcript', t.id, `segments=${segments.length}`)
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        this.store.saveTranscript({ ...t, status: 'failed', error: msg.slice(0, 500) })
        this.store.audit('system', 'transcript.failed', 'transcript', t.id)
      })
      .finally(() => {
        this.platform.emit('transcripts.changed', { encounterId: t.encounterId, transcriptId: t.id, progress: null })
      })
  }

  // ---------- handlers ----------

  handlers(): Handlers {
    const s = this.store
    return {
      'app.status': () => ({
        setupDone: s.userCount() > 0,
        user: this.user,
        platform: this.platform.platform,
        version: this.platform.version
      }),

      'auth.setup': (input) => {
        if (s.userCount() > 0) fail('Setup already completed')
        const d = input.doctor
        if (!d.name.trim()) fail('Doctor name is required')
        const user = s.createUser(
          { name: d.name.trim(), role: 'doctor', registrationNo: d.registrationNo.trim(), qualifications: d.qualifications.trim() },
          hashPin(this.validPin(d.pin))
        )
        const settings = s.getSettings()
        s.saveSettings({ ...settings, clinic: { ...settings.clinic, clinicName: input.clinicName.trim(), clinicAddress: input.clinicAddress.trim() } })
        this.user = user
        this.audit('setup', 'user', user.id)
        return user
      },
      'auth.users': () => s.listUsers().filter((u) => u.active).map(({ id, name, role }) => ({ id, name, role })),
      'auth.login': (userId, pin) => {
        this.checkPin(userId, pin)
        this.user = s.getUser(userId)
        this.audit('login', 'user', userId)
        return this.user!
      },
      'auth.lock': () => {
        if (this.user) this.audit('lock', 'user', this.user.id)
        this.lock()
      },

      'users.list': () => (this.requireDoctor(), s.listUsers()),
      'users.create': (input) => {
        this.requireDoctor()
        if (!input.name.trim()) fail('Name is required')
        const u = s.createUser(
          { name: input.name.trim(), role: input.role, registrationNo: input.registrationNo.trim(), qualifications: input.qualifications.trim() },
          hashPin(this.validPin(input.pin))
        )
        this.audit('user.create', 'user', u.id, `role=${u.role}`)
        return u
      },
      'users.update': (id, patch) => {
        const me = this.requireDoctor()
        const u = s.getUser(id) ?? fail('User not found')
        const next = { ...u, ...patch }
        if (id === me.id && (next.role !== 'doctor' || !next.active)) fail('You cannot remove your own doctor access')
        this.audit('user.update', 'user', id)
        return s.updateUser(next)
      },
      'users.setPin': (id, pin) => {
        const me = this.requireUser()
        if (me.id !== id && me.role !== 'doctor') fail('Only a doctor can reset another user’s PIN')
        s.setPinHash(id, hashPin(this.validPin(pin)))
        this.audit('user.pin', 'user', id)
      },

      'settings.get': () => (this.requireUser(), s.getSettings()),
      'settings.update': (patch) => {
        this.requireDoctor()
        const cur = s.getSettings()
        const next: AppSettings = {
          ...cur,
          ...patch,
          clinic: { ...cur.clinic, ...patch.clinic },
          layout: { ...cur.layout, ...patch.layout },
          asr: { ...cur.asr, ...patch.asr },
          letterheadType: cur.letterheadType,
          formats: cur.formats
        }
        s.saveSettings(next)
        this.audit('settings.update', 'settings', 'app', Object.keys(patch).join(','))
        return next
      },
      'settings.uploadLetterhead': async () => {
        this.requireDoctor()
        const path = await this.platform.openFile('Choose letterhead', ['pdf', 'png', 'jpg', 'jpeg'])
        if (!path) return s.getSettings()
        const ext = extname(path).toLowerCase().replace('.', '')
        const type = ext === 'jpeg' ? 'jpg' : (ext as AppSettings['letterheadType'])
        if (!['pdf', 'png', 'jpg'].includes(type)) fail('Letterhead must be PDF, PNG or JPG')
        s.setBlob('letterhead', readFileSync(path))
        const next = { ...s.getSettings(), letterheadType: type }
        s.saveSettings(next)
        this.audit('settings.letterhead', 'settings', 'letterhead', type)
        return next
      },
      'settings.clearLetterhead': () => {
        this.requireDoctor()
        s.setBlob('letterhead', null)
        const next = { ...s.getSettings(), letterheadType: '' as const }
        s.saveSettings(next)
        return next
      },
      'settings.testPrint': async () => {
        this.requireUser()
        const settings = s.getSettings()
        const pdf = await composePdf(
          await this.platform.htmlToPdf(calibrationHtml(settings.layout)),
          settings.layout,
          this.letterhead(settings),
          { identity: 'Test patient | MRN TEST | Calibration', label: 'Calibration test' }
        )
        return { pdfs: [{ name: 'calibration', data: pdf }], draft: true }
      },
      'settings.checkAsr': () => (this.requireUser(), checkAsr(resolveAsr(s.getSettings().asr, this.platform.whisperDirs))),
      'settings.pickFile': (title, extensions) => (this.requireDoctor(), this.platform.openFile(title, extensions)),

      'formats.uploadSample': async (kind) => {
        this.requireDoctor()
        const what = kind === 'note' ? 'note' : 'prescription'
        const path = await this.platform.openFile(`Choose a sample OPD ${what}`, ['pdf', 'png', 'jpg', 'jpeg'])
        if (!path) return null
        const ext = extname(path).toLowerCase().replace('.', '')
        const type = ext === 'jpeg' ? 'jpg' : ext
        if (type !== 'pdf' && type !== 'png' && type !== 'jpg') return fail('Sample must be a PDF, PNG or JPG')
        if (statSync(path).size > SAMPLE_MAX_BYTES) fail('Sample must be 15 MB or smaller')
        const data = readFileSync(path)
        const sniffed = sampleBlobType(data)
        if (!sniffed || sniffed !== type) fail('Sample file does not match its file type')

        let pageWidthMm = A4_MM.w
        let pageHeightMm = A4_MM.h
        if (type === 'pdf') {
          try {
            const doc = await PDFDocument.load(data)
            const { width, height } = doc.getPage(0).getSize()
            pageWidthMm = round1((width * 25.4) / 72)
            pageHeightMm = round1((height * 25.4) / 72)
          } catch {
            fail('Could not read this PDF')
          }
        }

        // Samples are never overwritten or deleted: verified revisions still reference them.
        const sampleId = uid()
        this.store.setBlob(`format-sample-${sampleId}`, data)
        this.audit('formats.sample', 'settings', kind, type)
        return { sampleId, sampleType: type, pageWidthMm, pageHeightMm }
      },
      'formats.sample': (sampleId) => {
        this.requireUser()
        if (!/^[0-9a-f-]{36}$/.test(sampleId)) fail('Invalid sample id')
        const data = this.store.getBlob(`format-sample-${sampleId}`)
        if (!data) return null
        const type = sampleBlobType(data)
        if (!type) return fail('Unrecognised sample file')
        return { type, data: new Uint8Array(data) }
      },
      'formats.save': (kind, template) => {
        this.requireDoctor()
        const cur = s.getSettings()
        if (!template) {
          const next: AppSettings = { ...cur, formats: { ...cur.formats, [kind]: null } }
          s.saveSettings(next)
          this.audit('formats.save', 'settings', kind, 'built-in')
          return next
        }
        if (template.kind !== kind) fail('Format kind does not match the document')
        const errors = validateTemplate(template)
        if (errors.length > 0) fail(errors.join('; '))
        if (template.background === 'sample' && !s.getBlob(`format-sample-${template.sampleId}`))
          fail('Sample file is missing — upload it again')
        const current = cur.formats[kind]
        const version = (current?.version ?? 0) + 1
        const saved: FormTemplate = {
          ...template,
          id: current?.id || template.id || uid(),
          version,
          updatedAt: nowIso()
        }
        const next: AppSettings = { ...cur, formats: { ...cur.formats, [kind]: saved } }
        s.saveSettings(next)
        this.audit('formats.save', 'settings', kind, `v${version}`)
        return next
      },
      'formats.preview': async (template) => {
        this.requireUser()
        const errors = validateTemplate(template)
        if (errors.length > 0) fail(errors.join('; '))
        const settings = s.getSettings()
        const pdf = await this.renderKind(template.kind, sampleSnapshot(settings.clinic), true, template, settings)
        return { pdfs: [{ name: template.kind, data: pdf }], draft: true }
      },

      'patients.search': (q) => (this.requireUser(), s.searchPatients(q)),
      'patients.get': (id) => (this.requireUser(), this.patient(id)),
      'patients.create': (input) => {
        this.requireUser()
        const p = s.createPatient(this.validatePatient(input))
        this.audit('patient.create', 'patient', p.id)
        return p
      },
      'patients.update': (id, input) => {
        this.requireUser()
        this.patient(id)
        const p = s.updatePatient(id, this.validatePatient(input, id))
        this.audit('patient.update', 'patient', id)
        return p
      },
      'patients.importPreview': async () => {
        this.requireUser()
        const path = await this.platform.openFile('Import patients (CSV)', ['csv'])
        if (!path) return null
        const res = parsePatientCsv(readFileSync(path, 'utf8'))
        return { fileName: path.split(/[\\/]/).pop() ?? 'file.csv', ...res, existingMrns: s.existingMrns(res.rows.map((r) => r.mrn)) }
      },
      'patients.importCommit': (rows) => {
        this.requireUser()
        const clean = rows.filter((r) => r.mrn?.trim() && r.name?.trim())
        const res = s.importPatients(clean)
        this.audit('patient.import', 'patient', 'csv', `imported=${res.imported} skipped=${res.skipped + rows.length - clean.length}`)
        return { imported: res.imported, skipped: res.skipped + rows.length - clean.length }
      },

      'summary.get': (patientId) => (this.requireUser(), this.patient(patientId), s.getSummary(patientId)),
      'summary.update': (patientId, key: OncologySummaryKey, value) => {
        const u = this.requireUser()
        this.patient(patientId)
        if (!ONCOLOGY_SUMMARY_FIELDS.some(([k]) => k === key)) fail('Unknown summary field')
        const cur = s.getSummary(patientId)
        const next = { ...cur, [key]: { value, updatedAt: nowIso(), updatedBy: u.name, source: 'manual' } }
        s.saveSummary(patientId, next, key, value, u.name)
        this.audit('summary.update', 'patient', patientId, key)
        return next
      },

      'encounters.list': (patientId) => (this.requireUser(), s.listEncounters(patientId)),
      'encounters.create': (patientId) => {
        const u = this.requireUser()
        this.patient(patientId)
        const e = s.insertEncounter({
          id: uid(),
          patientId,
          createdAt: nowIso(),
          createdBy: u.id,
          status: 'draft',
          document: emptyDocument(s.getSettings(), localNow()),
          verifiedHash: null,
          amendmentReason: ''
        })
        this.audit('encounter.create', 'encounter', e.id)
        return e
      },
      'encounters.get': (encounterId, patientId) => (this.requireUser(), this.encounterFor(encounterId, patientId)),
      'encounters.save': (encounterId, patientId, doc) => {
        this.requireUser()
        const e = this.encounterFor(encounterId, patientId)
        if (e.status === 'verified' || e.status === 'amended') fail('Verified visit is locked — start an amendment to edit')
        return s.updateEncounter({ ...e, document: doc })
      },
      'encounters.startAmendment': (encounterId, patientId, reason) => {
        this.requireDoctor()
        const e = this.encounterFor(encounterId, patientId)
        if (e.status !== 'verified' && e.status !== 'amended') fail('Only a verified visit can be amended')
        if (!reason.trim()) fail('An amendment reason is required')
        this.audit('encounter.amend.start', 'encounter', encounterId)
        return s.updateEncounter({ ...e, status: 'amending', amendmentReason: reason.trim(), document: { ...e.document, acknowledgedFlags: [] } })
      },
      'encounters.revisions': (encounterId, patientId) => (this.requireUser(), this.encounterFor(encounterId, patientId), s.listRevisions(encounterId)),

      'transcripts.list': (encounterId, patientId) => (this.requireUser(), this.encounterFor(encounterId, patientId), s.listTranscripts(encounterId)),
      'transcripts.transcribe': (input) => {
        this.requireUser()
        const e = this.encounterFor(input.encounterId, input.patientId)
        if (e.status === 'verified' || e.status === 'amended') fail('Verified visit is locked — start an amendment first')
        if (input.kind === 'dictation' && !input.section) fail('Dictation needs a target section')
        const wav = Buffer.from(input.wav)
        if (wav.length < 44 || wav.subarray(0, 4).toString('ascii') !== 'RIFF') fail('Invalid audio')
        const t: Transcript = {
          id: uid(),
          encounterId: e.id,
          kind: input.kind,
          section: input.kind === 'dictation' ? input.section : null,
          createdAt: nowIso(),
          durationMs: Math.round(input.durationMs),
          status: 'transcribing',
          error: '',
          segments: [],
          reviewed: false,
          audioRetained: true
        }
        writeEncrypted(this.key, this.audioPath(t.id), wav)
        s.saveTranscript(t)
        this.audit('transcript.create', 'transcript', t.id, `kind=${t.kind}`)
        this.startTranscription(t)
        return t
      },
      'transcripts.retry': (transcriptId, encounterId, patientId) => {
        this.requireUser()
        this.encounterFor(encounterId, patientId)
        const t = s.getTranscript(transcriptId) ?? fail('Transcript not found')
        if (t.encounterId !== encounterId) fail('Transcript does not belong to this visit')
        if (!existsSync(this.audioPath(t.id))) fail('Audio for this recording is no longer stored — cannot retry')
        const next = s.saveTranscript({ ...t, status: 'transcribing', error: '' })
        this.startTranscription(next)
        return next
      },
      'transcripts.save': (t, patientId) => {
        this.requireUser()
        const e = this.encounterFor(t.encounterId, patientId)
        const cur = s.getTranscript(t.id) ?? fail('Transcript not found')
        if (cur.encounterId !== e.id) fail('Transcript does not belong to this visit')
        if (cur.status !== 'ready') fail('Transcript is not ready')
        // AUD-11: engine output is immutable; only text / speaker / reviewed may change
        const byId = new Map(cur.segments.map((x) => [x.id, x]))
        const segments = t.segments
          .filter((x) => byId.has(x.id))
          .map((x) => ({ ...byId.get(x.id)!, text: x.text, speaker: x.speaker, speakerUncertain: x.speakerUncertain }))
        let audioRetained = cur.audioRetained
        if (t.reviewed && !cur.reviewed && !s.getSettings().retainAudio) {
          rmSync(this.audioPath(cur.id), { force: true })
          audioRetained = false
          this.audit('audio.delete', 'transcript', cur.id, 'after review')
        }
        return s.saveTranscript({ ...cur, segments, reviewed: t.reviewed, audioRetained })
      },
      'transcripts.delete': (transcriptId, encounterId, patientId) => {
        this.requireUser()
        const e = this.encounterFor(encounterId, patientId)
        if (e.status === 'verified' || e.status === 'amended') fail('Verified visit is locked')
        const t = s.getTranscript(transcriptId) ?? fail('Transcript not found')
        if (t.encounterId !== encounterId) fail('Transcript does not belong to this visit')
        rmSync(this.audioPath(t.id), { force: true })
        s.deleteTranscript(t.id)
        this.audit('transcript.delete', 'transcript', t.id)
      },

      'review.flags': (encounterId, patientId) => {
        this.requireUser()
        const e = this.encounterFor(encounterId, patientId)
        return computeFlags(this.patient(patientId), e.document, s.listTranscripts(encounterId), s.getSettings().formulary)
      },
      'review.preview': async (encounterId, patientId) => {
        const u = this.requireUser()
        const e = this.encounterFor(encounterId, patientId)
        if (e.status === 'verified' || e.status === 'amended') {
          const rev = this.exportableRevision(e)
          return this.renderPdfs(rev.snapshot, false)
        }
        const doctor = u.role === 'doctor' ? u : (s.listUsers().find((x) => x.role === 'doctor' && x.active) ?? u)
        return this.renderPdfs(this.snapshot(e, doctor), true)
      },
      'review.previewRevision': async (encounterId, patientId, revisionNo) => {
        this.requireUser()
        this.encounterFor(encounterId, patientId)
        const rev = s.listRevisions(encounterId).find((r) => r.revisionNo === revisionNo) ?? fail('Revision not found')
        return this.renderPdfs(rev.snapshot, false)
      },
      'review.verify': (encounterId, patientId, pin) => {
        const doctor = this.requireDoctor()
        this.checkPin(doctor.id, pin)
        const e = this.encounterFor(encounterId, patientId)
        if (e.status === 'verified' || e.status === 'amended') fail('Already verified')
        const flags = computeFlags(this.patient(patientId), e.document, s.listTranscripts(encounterId), s.getSettings().formulary)
        if (!canVerify(flags, e.document.acknowledgedFlags))
          fail('Resolve all blocking issues and acknowledge all warnings before verifying')
        const snap = this.snapshot(e, doctor)
        const hash = contentHash(snap)
        const revisionNo = s.listRevisions(encounterId).length + 1
        if (revisionNo > 1 && !e.amendmentReason.trim()) fail('Amendment reason is required')
        const rev: Revision = {
          id: uid(),
          encounterId,
          revisionNo,
          hash,
          verifiedBy: doctor.id,
          verifiedByName: doctor.name,
          verifiedAt: nowIso(),
          amendmentReason: revisionNo > 1 ? e.amendmentReason : '',
          snapshot: snap
        }
        const next = s.verifyEncounter({ ...e, status: revisionNo > 1 ? 'amended' : 'verified', verifiedHash: hash }, rev)
        this.audit('encounter.verify', 'encounter', encounterId, `rev=${revisionNo} hash=${hash.slice(0, 12)}`)
        return next
      },
      'review.export': async (encounterId, patientId) => {
        this.requireUser()
        const e = this.encounterFor(encounterId, patientId)
        const rev = this.exportableRevision(e)
        const { pdfs } = await this.renderPdfs(rev.snapshot, false)
        const safe = (x: string): string => x.replace(/[^\w.-]+/g, '_')
        const base = `${safe(rev.snapshot.patient.mrn)}_${rev.snapshot.document.visitDateTime.slice(0, 10)}_r${rev.revisionNo}`
        const target = await this.platform.saveFile('Save verified PDF', `${base}.pdf`, ['pdf'])
        if (!target) return null
        const paths =
          pdfs.length === 1 ? [target] : pdfs.map((p) => target.replace(/\.pdf$/i, '') + `_${p.name}.pdf`)
        pdfs.forEach((p, i) => writeFileSync(paths[i], p.data))
        this.audit('encounter.export', 'encounter', encounterId, `rev=${rev.revisionNo} files=${paths.length}`)
        return paths
      },
      'review.openExported': async (path) => {
        this.requireUser()
        if (!path.toLowerCase().endsWith('.pdf') || !existsSync(path)) fail('File not found')
        await this.platform.openPath(path)
      },

      'backup.create': async (passphrase) => {
        this.requireDoctor()
        const entries = [{ name: 'opd.sqlite', data: s.exportPlain() }]
        for (const f of readdirSync(this.audioDir).filter((x) => x.endsWith('.enc'))) {
          entries.push({ name: `audio/${f.replace(/\.enc$/, '')}`, data: readEncrypted(this.key, join(this.audioDir, f)) })
        }
        const data = createBackup(entries, passphrase)
        const stamp = localNow().replace(/[:T]/g, '-')
        const target = await this.platform.saveFile('Save encrypted backup', `opd-backup-${stamp}.opdbackup`, ['opdbackup'])
        if (!target) return null
        writeFileSync(target, data)
        this.audit('backup.create', 'backup', 'file', `entries=${entries.length}`)
        return target
      },
      'backup.restore': async (passphrase) => {
        this.requireDoctor()
        const path = await this.platform.openFile('Restore backup', ['opdbackup'])
        if (!path) return false
        const entries = readBackup(readFileSync(path), passphrase)
        const db = entries.find((x) => x.name === 'opd.sqlite') ?? fail('Backup does not contain a database')
        s.replaceWith(db.data)
        for (const f of readdirSync(this.audioDir)) rmSync(join(this.audioDir, f), { force: true })
        for (const x of entries.filter((x) => x.name.startsWith('audio/'))) {
          writeEncrypted(this.key, this.audioPath(x.name.slice('audio/'.length)), x.data)
        }
        this.lock()
        this.store.audit('system', 'backup.restore', 'backup', 'file', `entries=${entries.length}`)
        return true
      },

      'audit.list': (limit) => (this.requireDoctor(), s.listAudit(Math.min(Math.max(limit, 1), 1000)))
    }
  }
}
