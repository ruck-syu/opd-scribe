// Services-level integration tests: the safety gates must hold when the IPC/UI
// layer is bypassed and handlers are called directly (roadmap M6 exit, AC-18).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiMap, Channel } from '../shared/api'
import type { Suggestion } from '../shared/extract'
import { uid } from '../shared/defaults'
import type { Encounter, Patient, ReviewFlag, Revision, Transcript, TranscriptSegment, User, VisitDocument } from '../shared/types'
import { Store } from './db'
import { Services, type Platform } from './services'

const DOCTOR_PIN = '1234'
const STAFF_PIN = '5678'
const PHI_NAME = 'ZZPHI Marker'
const PHI_MRN = 'PHI-MRN-777'

type Handlers = ReturnType<Services['handlers']>

interface Harness {
  store: Store
  handlers: Handlers
  dir: string
}

/** Call an IPC handler exactly as the preload would, without any UI checks. */
async function call<C extends Channel>(
  handlers: Handlers,
  channel: C,
  ...args: Parameters<ApiMap[C]>
): Promise<Awaited<ReturnType<ApiMap[C]>>> {
  const fn = handlers[channel] as unknown as (
    ...a: Parameters<ApiMap[C]>
  ) => ReturnType<ApiMap[C]> | Promise<ReturnType<ApiMap[C]>>
  return (await fn(...args)) as Awaited<ReturnType<ApiMap[C]>>
}

async function a4Pdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595.28, 841.89])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  // A page needs contents to be embeddable by composePdf's PDFPageEmbedder.
  page.drawText('fake rendered page', { x: 40, y: 800, size: 10, font })
  return doc.save()
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'opd-services-it-'))
  const pdf = await a4Pdf()
  let saved = 0
  const platform: Platform = {
    dataDir: dir,
    whisperDirs: [],
    version: '0.0.0-test',
    platform: 'test',
    htmlToPdf: async () => pdf,
    openFile: async () => null,
    saveFile: async () => join(dir, `export-${++saved}.pdf`),
    openPath: async () => {},
    emit: () => {}
  }
  const store = await Store.memory()
  const services = new Services(store, Buffer.alloc(32), platform)
  return { store, handlers: services.handlers(), dir }
}

const section = (text: string): VisitDocument['plan'] => ({
  text,
  sources: [{ kind: 'manual', at: new Date().toISOString() }]
})

/** Clinical content that produces no flags at all. */
function fillClinical(doc: VisitDocument): VisitDocument {
  const next = structuredClone(doc)
  next.history.hpi = section('Mild nausea after cycle 3.')
  next.assessment = section('Tolerating chemotherapy.')
  next.plan = section('Continue AC, review in 3 weeks.')
  next.oncology.ecog = 1
  next.oncology.regimen = 'AC'
  next.oncology.clearance = { decision: 'yes', reason: '' }
  next.prescription.followUp = section('Review in 3 weeks')
  return next
}

const completeMedication = (): VisitDocument['prescription']['medications'][number] => ({
  id: 'm1',
  name: 'Ondansetron',
  formulationStrength: '8 mg tab',
  dose: '8 mg',
  route: 'oral',
  frequency: 'TDS',
  duration: '3 days',
  quantity: '9',
  instructions: 'before food',
  sourceText: ''
})

const ackOf = (f: ReviewFlag): string => f.ackKey

let h: Harness

beforeEach(async () => {
  h = await makeHarness()
})

afterEach(() => {
  if (h) rmSync(h.dir, { recursive: true, force: true })
})

async function startSession(): Promise<{ doctor: User; patient: Patient; encounter: Encounter }> {
  await call(h.handlers, 'auth.setup', {
    clinicName: 'Test Cancer Clinic',
    clinicAddress: 'Pune',
    doctor: { name: 'Dr Test', registrationNo: 'MMC-1', qualifications: 'MD, DM', pin: DOCTOR_PIN }
  })
  const users = await call(h.handlers, 'auth.users')
  const doctor = await call(h.handlers, 'auth.login', users[0].id, DOCTOR_PIN)
  const patient = await call(h.handlers, 'patients.create', {
    mrn: PHI_MRN,
    name: PHI_NAME,
    dateOfBirth: null,
    ageDisplay: '54 y',
    sex: 'female',
    phone: '',
    address: ''
  })
  const encounter = await call(h.handlers, 'encounters.create', patient.id)
  return { doctor, patient, encounter }
}

function createPatient(mrn: string, name: string): Promise<Patient> {
  return call(h.handlers, 'patients.create', {
    mrn,
    name,
    dateOfBirth: null,
    ageDisplay: '40 y',
    sex: 'male',
    phone: '',
    address: ''
  })
}

function save(encounter: Encounter, patient: Patient, doc: VisitDocument): Promise<Encounter> {
  return call(h.handlers, 'encounters.save', encounter.id, patient.id, doc)
}

function verify(encounter: Encounter, patient: Patient, pin = DOCTOR_PIN): Promise<Encounter> {
  return call(h.handlers, 'review.verify', encounter.id, patient.id, pin)
}

/** Fetch the current flags and acknowledge every warning, then return the doc. */
async function acknowledgedDoc(encounter: Encounter, patient: Patient, doc: VisitDocument): Promise<VisitDocument> {
  const flags = await call(h.handlers, 'review.flags', encounter.id, patient.id)
  const next = structuredClone(doc)
  next.acknowledgedFlags = flags.filter((f) => f.severity === 'warning').map(ackOf)
  return next
}

async function verifiedVisit(): Promise<{ patient: Patient; encounter: Encounter; doc: VisitDocument }> {
  const { patient, encounter } = await startSession()
  const doc = await acknowledgedDoc(encounter, patient, fillClinical(encounter.document))
  await save(encounter, patient, doc)
  await verify(encounter, patient)
  return { patient, encounter, doc }
}

describe('verification gates (services bypassed)', () => {
  it('blocks export and any verified preview before verification', async () => {
    const { patient, encounter } = await startSession()

    await expect(call(h.handlers, 'review.export', encounter.id, patient.id)).rejects.toThrow(
      /not verified — export and print are blocked/
    )
    await expect(call(h.handlers, 'review.previewRevision', encounter.id, patient.id, 1)).rejects.toThrow(
      /Revision not found/
    )

    // A pre-verification preview is allowed, but it must be an explicit draft.
    const draft = await call(h.handlers, 'review.preview', encounter.id, patient.id)
    expect(draft.draft).toBe(true)
    expect(draft.pdfs.length).toBeGreaterThan(0)
  })

  it('rejects verification with unacknowledged warnings, a wrong PIN, or a staff account', async () => {
    const { patient, encounter } = await startSession()
    const doc = fillClinical(encounter.document)
    doc.prescription.followUp = section('') // warning: follow-up not documented
    await save(encounter, patient, doc)

    const flags = await call(h.handlers, 'review.flags', encounter.id, patient.id)
    expect(flags.some((f) => f.severity === 'warning')).toBe(true)

    await expect(verify(encounter, patient)).rejects.toThrow(
      /Resolve all blocking issues and acknowledge all warnings before verifying/
    )
    await expect(verify(encounter, patient, '9999')).rejects.toThrow(/Wrong PIN/)

    const staff = await call(h.handlers, 'users.create', {
      name: 'ZZ Staff',
      role: 'staff',
      registrationNo: '',
      qualifications: '',
      pin: STAFF_PIN
    })
    await call(h.handlers, 'auth.login', staff.id, STAFF_PIN)
    await expect(verify(encounter, patient)).rejects.toThrow(/Only a doctor can do this/)

    // Back to the doctor: acknowledging the warning is what unlocks verification.
    await call(h.handlers, 'auth.login', (await call(h.handlers, 'auth.users'))[0].id, DOCTOR_PIN)
    const acked = await acknowledgedDoc(encounter, patient, doc)
    expect(acked.acknowledgedFlags).toContain(ackOf(flags.find((f) => f.severity === 'warning')!))
    await save(encounter, patient, acked)
    const verified = await verify(encounter, patient)
    expect(verified.status).toBe('verified')
  })

  it('never lets an acknowledged blocking flag through', async () => {
    const { patient, encounter } = await startSession()
    const doc = fillClinical(encounter.document)
    doc.prescription.medications = [{ ...completeMedication(), dose: '' }]
    await save(encounter, patient, doc)

    const flags = await call(h.handlers, 'review.flags', encounter.id, patient.id)
    const blocking = flags.filter((f) => f.severity === 'blocking')
    expect(blocking.length).toBeGreaterThan(0)
    expect(blocking[0].message).toMatch(/missing dose/)

    // Even putting every flag id (including blocking ones) in acknowledgedFlags is not enough.
    const bypass = structuredClone(doc)
    bypass.acknowledgedFlags = flags.map(ackOf)
    await save(encounter, patient, bypass)

    await expect(verify(encounter, patient)).rejects.toThrow(
      /Resolve all blocking issues and acknowledge all warnings before verifying/
    )
    const unchanged = await call(h.handlers, 'encounters.get', encounter.id, patient.id)
    expect(unchanged.status).toBe('draft')
  })

  it('locks a verified visit and exports a real PDF', async () => {
    const { patient, encounter, doc } = await verifiedVisit()

    await expect(save(encounter, patient, doc)).rejects.toThrow(/Verified visit is locked/)

    const paths = await call(h.handlers, 'review.export', encounter.id, patient.id)
    expect(paths).not.toBeNull()
    expect(paths!.length).toBeGreaterThan(0)
    for (const path of paths!) {
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path).subarray(0, 4).toString('ascii')).toBe('%PDF')
    }

    const preview = await call(h.handlers, 'review.preview', encounter.id, patient.id)
    expect(preview.draft).toBe(false)
  })
})

describe('integrity after verification', () => {
  it('rejects export when the encounter is edited directly through the Store', async () => {
    const { patient, encounter } = await verifiedVisit()

    // Bypass encounters.save entirely: write a new document straight into the row.
    const stored = await call(h.handlers, 'encounters.get', encounter.id, patient.id)
    stored.document.plan = section('Tampered plan written behind the service')
    h.store.updateEncounter(stored)

    await expect(call(h.handlers, 'review.export', encounter.id, patient.id)).rejects.toThrow(
      /Visit changed after verification — verify again before export/
    )
    // A "verified" preview is held to the same integrity check.
    await expect(call(h.handlers, 'review.preview', encounter.id, patient.id)).rejects.toThrow(
      /Visit changed after verification — verify again before export/
    )
  })

  it('rejects export when a stored revision snapshot no longer matches its hash', async () => {
    const { patient, encounter } = await verifiedVisit()
    const [original] = await call(h.handlers, 'encounters.revisions', encounter.id, patient.id)

    // The schema trigger forbids UPDATE on revisions, so use the Store's only revision
    // write path to append a snapshot whose contents no longer hash to its stored hash.
    const tampered = structuredClone(original) as Revision
    tampered.id = uid()
    tampered.revisionNo = original.revisionNo + 1
    tampered.snapshot.document.plan = section('Tampered revision plan')
    const current = await call(h.handlers, 'encounters.get', encounter.id, patient.id)
    h.store.verifyEncounter({ ...current, verifiedHash: tampered.hash }, tampered)

    await expect(call(h.handlers, 'review.export', encounter.id, patient.id)).rejects.toThrow(
      /Verified content integrity check failed — export blocked/
    )
  })
})

describe('encounter / patient binding', () => {
  it('rejects encounter-scoped calls with a patient that does not own the visit', async () => {
    const { patient, encounter } = await startSession()
    const other = await createPatient('OTHER-1', 'Other Patient')

    await expect(save(encounter, other, encounter.document)).rejects.toThrow(/Patient \/ visit mismatch/)
    await expect(call(h.handlers, 'encounters.get', encounter.id, other.id)).rejects.toThrow(/Patient \/ visit mismatch/)
    await expect(
      call(h.handlers, 'encounters.startAmendment', encounter.id, other.id, 'Wrong patient')
    ).rejects.toThrow(/Patient \/ visit mismatch/)
    await expect(call(h.handlers, 'encounters.revisions', encounter.id, other.id)).rejects.toThrow(
      /Patient \/ visit mismatch/
    )
    await expect(call(h.handlers, 'transcripts.list', encounter.id, other.id)).rejects.toThrow(/Patient \/ visit mismatch/)

    const wav = new ArrayBuffer(64)
    new Uint8Array(wav).set([0x52, 0x49, 0x46, 0x46]) // "RIFF"
    await expect(
      call(h.handlers, 'transcripts.transcribe', {
        encounterId: encounter.id,
        patientId: other.id,
        kind: 'dictation',
        section: 'plan',
        wav,
        durationMs: 1000
      })
    ).rejects.toThrow(/Patient \/ visit mismatch/)

    const ghost: Transcript = {
      id: uid(),
      encounterId: encounter.id,
      kind: 'conversation',
      section: null,
      createdAt: new Date().toISOString(),
      durationMs: 0,
      status: 'ready',
      error: '',
      segments: [],
      reviewed: false,
      audioRetained: true
    }
    await expect(call(h.handlers, 'transcripts.save', ghost, other.id)).rejects.toThrow(/Patient \/ visit mismatch/)
    await expect(call(h.handlers, 'transcripts.retry', ghost.id, encounter.id, other.id)).rejects.toThrow(
      /Patient \/ visit mismatch/
    )
    await expect(call(h.handlers, 'transcripts.delete', ghost.id, encounter.id, other.id)).rejects.toThrow(
      /Patient \/ visit mismatch/
    )

    // The visit itself must be untouched by all of the above.
    const stored = await call(h.handlers, 'encounters.get', encounter.id, patient.id)
    expect(stored.status).toBe('draft')
  })
})

describe('amendments', () => {
  it('requires a reason, keeps revision 1 viewable, and creates revision 2', async () => {
    const { patient, encounter, doc } = await verifiedVisit()
    const [rev1] = await call(h.handlers, 'encounters.revisions', encounter.id, patient.id)

    await expect(call(h.handlers, 'encounters.startAmendment', encounter.id, patient.id, '   ')).rejects.toThrow(
      /amendment reason is required/
    )

    const amending = await call(h.handlers, 'encounters.startAmendment', encounter.id, patient.id, 'Corrected plan')
    expect(amending.status).toBe('amending')
    expect(amending.amendmentReason).toBe('Corrected plan')
    expect(amending.document.acknowledgedFlags).toEqual([])
    expect(await call(h.handlers, 'encounters.revisions', encounter.id, patient.id)).toHaveLength(1)

    const preview1 = await call(h.handlers, 'review.previewRevision', encounter.id, patient.id, 1)
    expect(preview1.draft).toBe(false)
    expect(preview1.pdfs.length).toBeGreaterThan(0)

    const edited = structuredClone(doc)
    edited.plan = section('Corrected plan text after amendment')
    await save(encounter, patient, edited)
    await save(encounter, patient, await acknowledgedDoc(encounter, patient, edited))

    const amended = await verify(encounter, patient)
    expect(amended.status).toBe('amended')

    const revisions = await call(h.handlers, 'encounters.revisions', encounter.id, patient.id)
    expect(revisions).toHaveLength(2)
    expect(revisions[0]).toEqual(rev1)
    expect(revisions[1].revisionNo).toBe(2)
    expect(revisions[1].amendmentReason).toBe('Corrected plan')
    expect(revisions[1].snapshot.document.plan.text).toBe('Corrected plan text after amendment')

    // The original revision is still rendered from its frozen snapshot.
    const again = await call(h.handlers, 'review.previewRevision', encounter.id, patient.id, 1)
    expect(again.draft).toBe(false)
    expect(again.pdfs.length).toBeGreaterThan(0)
  })
})

describe('PHI hygiene (AC-18)', () => {
  it('never writes the patient name or MRN to console output or the audit log', async () => {
    const captured: string[] = []
    const renderArg = (value: unknown): string => {
      if (typeof value === 'string') return value
      if (value instanceof Error) return value.message
      try {
        return JSON.stringify(value) ?? String(value)
      } catch {
        return String(value)
      }
    }
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map(renderArg).join(' '))
      })
    )

    try {
      const { patient, encounter } = await startSession()
      const doc = fillClinical(encounter.document)
      doc.prescription.medications = [completeMedication()]
      await save(encounter, patient, doc)
      await call(h.handlers, 'review.flags', encounter.id, patient.id)

      // Failing paths are part of the scripted session too.
      await expect(call(h.handlers, 'review.export', encounter.id, patient.id)).rejects.toThrow(/not verified/)
      await expect(verify(encounter, patient, '0000')).rejects.toThrow(/Wrong PIN/)
      const other = await createPatient('OTHER-2', 'Other Patient')
      await expect(save(encounter, other, doc)).rejects.toThrow(/Patient \/ visit mismatch/)

      const acked = await acknowledgedDoc(encounter, patient, doc)
      await save(encounter, patient, acked)
      await verify(encounter, patient)
      const paths = await call(h.handlers, 'review.export', encounter.id, patient.id)
      expect(paths).not.toBeNull()

      await expect(
        call(h.handlers, 'encounters.startAmendment', encounter.id, patient.id, '')
      ).rejects.toThrow(/amendment reason is required/)
      await call(h.handlers, 'encounters.startAmendment', encounter.id, patient.id, 'PHI hygiene pass')

      const staff = await call(h.handlers, 'users.create', {
        name: 'ZZ Staff',
        role: 'staff',
        registrationNo: '',
        qualifications: '',
        pin: STAFF_PIN
      })
      await call(h.handlers, 'auth.login', staff.id, STAFF_PIN)
      await expect(
        call(h.handlers, 'review.verify', encounter.id, patient.id, STAFF_PIN)
      ).rejects.toThrow(/Only a doctor can do this/)

      const users = await call(h.handlers, 'auth.users')
      await call(h.handlers, 'auth.login', users[0].id, DOCTOR_PIN)

      const audit = await call(h.handlers, 'audit.list', 1000)
      const auditText = JSON.stringify(audit)
      expect(auditText).not.toContain(PHI_NAME)
      expect(auditText).not.toContain(PHI_MRN)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }

    const output = captured.join('\n')
    expect(output).not.toContain(PHI_NAME)
    expect(output).not.toContain(PHI_MRN)
  })
})

describe('consultation recording consent', () => {
  /** Minimal RIFF header: enough for the handler's audio sanity check. */
  const riff = (): ArrayBuffer => {
    const wav = new ArrayBuffer(64)
    new Uint8Array(wav).set([0x52, 0x49, 0x46, 0x46])
    return wav
  }

  /** Run transcribe and return its error message (empty string when it was accepted). */
  const transcribe = async (
    patient: Patient,
    encounter: Encounter,
    kind: 'conversation' | 'dictation'
  ): Promise<string> => {
    try {
      await call(h.handlers, 'transcripts.transcribe', {
        encounterId: encounter.id,
        patientId: patient.id,
        kind,
        section: kind === 'dictation' ? 'plan' : null,
        wav: riff(),
        durationMs: 1000
      })
      return ''
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  it('rejects a consultation recording until consent is recorded', async () => {
    const { patient, encounter } = await startSession()
    expect(await call(h.handlers, 'encounters.consent', encounter.id, patient.id)).toBe(false)

    await expect(
      call(h.handlers, 'transcripts.transcribe', {
        encounterId: encounter.id,
        patientId: patient.id,
        kind: 'conversation',
        section: null,
        wav: riff(),
        durationMs: 1000
      })
    ).rejects.toThrow(/Record the patient's consent before recording the consultation/)

    // Nothing was written: no transcript row was created for the rejected audio.
    expect(await call(h.handlers, 'transcripts.list', encounter.id, patient.id)).toHaveLength(0)
  })

  it('does not block dictation on consultation consent', async () => {
    const { patient, encounter } = await startSession()
    const error = await transcribe(patient, encounter, 'dictation')
    expect(error).not.toMatch(/consent/i)
  })

  it('allows consultation recordings once consent is recorded', async () => {
    const { patient, encounter } = await startSession()
    await call(h.handlers, 'encounters.recordConsent', encounter.id, patient.id)

    expect(await call(h.handlers, 'encounters.consent', encounter.id, patient.id)).toBe(true)
    const error = await transcribe(patient, encounter, 'conversation')
    expect(error).not.toMatch(/consent/i)
  })

  it('rejects consent for a patient that does not own the visit, and keeps PHI out of the audit', async () => {
    const { patient, encounter } = await startSession()
    const other = await createPatient('OTHER-CONSENT', 'Other Patient')

    await expect(call(h.handlers, 'encounters.recordConsent', encounter.id, other.id)).rejects.toThrow(
      /Patient \/ visit mismatch/
    )

    await call(h.handlers, 'encounters.recordConsent', encounter.id, patient.id)
    const entry = (await call(h.handlers, 'audit.list', 1000)).find((e) => e.action === 'consent.recording')
    expect(entry).toBeDefined()
    expect(entry!.entity).toBe('encounter')
    expect(entry!.entityId).toBe(encounter.id)
    expect(entry!.detail).toBe('')
    expect(JSON.stringify(entry)).not.toContain(PHI_NAME)
  })
})

describe('transcript suggestions', () => {
  const seg = (id: string, text: string): TranscriptSegment => ({
    id,
    startMs: 0,
    endMs: 1000,
    originalText: text,
    text,
    speaker: 'doctor',
    speakerUncertain: false,
    warning: ''
  })

  /** A ready conversation (inserted directly, as the engine would) for a visit with one formulary medicine. */
  async function visitWithTranscript(): Promise<{ patient: Patient; encounter: Encounter; t: Transcript }> {
    const { patient, encounter } = await startSession()
    await call(h.handlers, 'settings.update', { formulary: ['Ondansetron'] })
    const t = h.store.saveTranscript({
      id: uid(),
      encounterId: encounter.id,
      kind: 'conversation',
      section: null,
      createdAt: new Date().toISOString(),
      durationMs: 60000,
      status: 'ready',
      error: '',
      reviewed: false,
      audioRetained: false,
      segments: [seg('s1', 'BP 130/80, ECOG 1'), seg('s2', 'Tab Ondansetron 8 mg TDS for 3 days')]
    })
    return { patient, encounter, t }
  }

  const decide = (patientId: string, transcriptId: string, suggestionId: string, status: 'accepted' | 'dismissed'): Promise<Transcript> =>
    call(h.handlers, 'transcripts.decideSuggestion', transcriptId, patientId, suggestionId, status)

  it('extracts pending suggestions on save and ignores suggestions sent by the client', async () => {
    const { patient, t } = await visitWithTranscript()
    const forged = { id: 'forged', status: 'accepted' } as Suggestion
    const saved = await call(h.handlers, 'transcripts.save', { ...t, suggestions: [forged] }, patient.id)
    const sugs = saved.suggestions ?? []
    expect(sugs.length).toBeGreaterThan(0)
    expect(sugs.every((s) => s.status === 'pending')).toBe(true)
    expect(sugs.some((s) => s.id === 'forged')).toBe(false)
    expect(sugs.find((s) => s.target.kind === 'vital' && s.target.key === 'bp')?.value).toBe('130/80')
    expect(sugs.find((s) => s.target.kind === 'ecog')?.value).toBe('1')
    expect(sugs.find((s) => s.target.kind === 'medication')).toBeDefined()
  })

  it('keeps decisions when an unrelated segment is edited and refuses unknown or repeated decisions', async () => {
    const { patient, encounter, t } = await visitWithTranscript()
    const first = await call(h.handlers, 'transcripts.save', t, patient.id)
    const bp = first.suggestions!.find((s) => s.target.kind === 'vital' && s.target.key === 'bp')!
    const ecog = first.suggestions!.find((s) => s.target.kind === 'ecog')!
    const med = first.suggestions!.find((s) => s.target.kind === 'medication')!

    const afterAccept = await decide(patient.id, t.id, bp.id, 'accepted')
    expect(afterAccept.suggestions?.find((s) => s.id === bp.id)?.status).toBe('accepted')
    await decide(patient.id, t.id, ecog.id, 'dismissed')

    // only the medicine segment changes; the BP and ECOG decisions must survive
    const edited = {
      ...first,
      segments: first.segments.map((x) => (x.id === 's2' ? { ...x, text: 'Tab Ondansetron 8 mg TDS for 5 days' } : x))
    }
    const next = await call(h.handlers, 'transcripts.save', edited, patient.id)
    expect(next.suggestions?.find((s) => s.id === bp.id)?.status).toBe('accepted')
    expect(next.suggestions?.find((s) => s.id === ecog.id)?.status).toBe('dismissed')
    expect(next.suggestions?.find((s) => s.id === med.id)).toBeUndefined()
    expect(next.suggestions?.find((s) => s.target.kind === 'medication')?.status).toBe('pending')

    const stored = (await call(h.handlers, 'transcripts.list', encounter.id, patient.id))[0]
    expect(stored.suggestions?.find((s) => s.id === bp.id)?.status).toBe('accepted')

    await expect(decide(patient.id, t.id, 'no-such-id', 'accepted')).rejects.toThrow(/Suggestion not found/)
    await expect(decide(patient.id, t.id, bp.id, 'dismissed')).rejects.toThrow(/already accepted or dismissed/)

    const entry = (await call(h.handlers, 'audit.list', 1000)).find((e) => e.action === 'suggestion.accept')
    expect(entry?.entity).toBe('transcript')
    expect(entry?.entityId).toBe(t.id)
    expect(entry?.detail).toBe('vital')
    expect(JSON.stringify(entry)).not.toContain('130/80')
  })

  it('refuses decisions on a verified visit and for a patient who does not own the visit', async () => {
    const { patient, encounter, t } = await visitWithTranscript()
    const first = await call(h.handlers, 'transcripts.save', t, patient.id)
    const bp = first.suggestions!.find((s) => s.target.kind === 'vital' && s.target.key === 'bp')!

    const other = await createPatient('OTHER-SUG', 'Other Patient')
    await expect(decide(other.id, t.id, bp.id, 'accepted')).rejects.toThrow(/Patient \/ visit mismatch/)

    // the pending suggestion warning is acknowledged like any other warning
    const doc = await acknowledgedDoc(encounter, patient, fillClinical(encounter.document))
    await save(encounter, patient, doc)
    await verify(encounter, patient)

    await expect(decide(patient.id, t.id, bp.id, 'accepted')).rejects.toThrow(/Verified visit is locked/)
    const stored = (await call(h.handlers, 'transcripts.list', encounter.id, patient.id))[0]
    expect(stored.suggestions?.find((s) => s.id === bp.id)?.status).toBe('pending')
  })
})
