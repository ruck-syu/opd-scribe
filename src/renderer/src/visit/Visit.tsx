import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { call, errMsg, on } from '../api'
import type { Encounter, Patient, Transcript, User, VisitDocument } from '../../../shared/types'
import { ErrorBox, Field, Modal, StatusBadge, useAction } from '../components/ui'
import { ClinicalTab } from './ClinicalTab'
import { ConversationTab } from './ConversationTab'
import { NoteTab } from './NoteTab'
import { ReviewTab } from './ReviewTab'
import { RxTab } from './RxTab'

export interface VisitCtx {
  encounterId: string
  patientId: string
  doc: VisitDocument
  update: (fn: (d: VisitDocument) => VisitDocument) => void
  readOnly: boolean
  transcripts: Transcript[]
  progress: Record<string, number>
  reloadTranscripts: () => Promise<void>
}

const TABS = [
  ['conversation', 'Conversation'],
  ['clinical', 'Vitals & Oncology'],
  ['note', 'Note & Dictation'],
  ['rx', 'Prescription'],
  ['review', 'Review & Verify']
] as const
type Tab = (typeof TABS)[number][0]

export function Visit(props: { patientId: string; encounterId: string; user: User; back: () => void }): ReactNode {
  const [patient, setPatient] = useState<Patient | null>(null)
  const [enc, setEnc] = useState<Encounter | null>(null)
  const [doc, setDoc] = useState<VisitDocument | null>(null)
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [tab, setTab] = useState<Tab>('conversation')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [saveError, setSaveError] = useState('')
  const [amending, setAmending] = useState(false)
  const { error, run } = useAction()
  const pending = useRef<VisitDocument | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { encounterId, patientId } = props

  const reloadTranscripts = useCallback(async () => {
    setTranscripts(await call('transcripts.list', encounterId, patientId))
  }, [encounterId, patientId])

  useEffect(() => {
    void run(async () => {
      setPatient(await call('patients.get', patientId))
      const e = await call('encounters.get', encounterId, patientId)
      setEnc(e)
      setDoc(e.document)
      await reloadTranscripts()
    })
    return on('transcripts.changed', (ev) => {
      if (ev.encounterId !== encounterId) return
      if (ev.progress === null) {
        setProgress(({ [ev.transcriptId]: _done, ...rest }) => rest)
        void reloadTranscripts()
      } else setProgress((p) => ({ ...p, [ev.transcriptId]: ev.progress! }))
    })
  }, [encounterId, patientId])

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const d = pending.current
    if (!d) return
    pending.current = null
    setSaveState('saving')
    try {
      const e = await call('encounters.save', encounterId, patientId, d)
      setEnc((cur) => (cur ? { ...cur, status: e.status } : e))
      setSaveState(pending.current ? 'saving' : 'saved')
      setSaveError('')
    } catch (err) {
      setSaveState('error')
      setSaveError(errMsg(err))
    }
  }, [encounterId, patientId])

  // flush unsaved edits when leaving the visit
  useEffect(() => () => void flush(), [flush])

  const readOnly = !enc || enc.status === 'verified' || enc.status === 'amended'

  const update = useCallback(
    (fn: (d: VisitDocument) => VisitDocument) => {
      if (readOnly) return
      setDoc((cur) => {
        if (!cur) return cur
        const next = fn(cur)
        pending.current = next
        return next
      })
      setSaveState('saving')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), 700)
    },
    [readOnly, flush]
  )

  if (!patient || !enc || !doc) return <ErrorBox error={error} />

  const ctx: VisitCtx = { encounterId, patientId, doc, update, readOnly, transcripts, progress, reloadTranscripts }

  return (
    <div className="page visit">
      <button
        className="ghost back"
        onClick={async () => {
          await flush()
          props.back()
        }}
      >
        ← {patient.name}
      </button>
      {/* PAT-04: identity always visible in the workspace */}
      <div className="identity-banner sticky">
        <div>
          <div className="id-name">{patient.name}</div>
          <div className="id-meta">
            MRN <b className="mono">{patient.mrn}</b> · {patient.ageDisplay || patient.dateOfBirth || 'Age not recorded'} ·{' '}
            {patient.sex || 'Sex not recorded'}
          </div>
        </div>
        <div className="row tight">
          <Field
            label="Visit date & time"
            type="datetime-local"
            value={doc.visitDateTime}
            onChange={readOnly ? undefined : (v) => update((d) => ({ ...d, visitDateTime: v }))}
          />
          <Field label="Visit type" value={doc.visitType} onChange={readOnly ? undefined : (v) => update((d) => ({ ...d, visitType: v }))} />
        </div>
        <div className="spacer" />
        <StatusBadge status={enc.status} />
        <span className={`save-state ${saveState}`} title={saveError}>
          {readOnly ? 'Locked' : saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Save failed'}
        </span>
        {readOnly && props.user.role === 'doctor' && <button onClick={() => setAmending(true)}>Amend…</button>}
      </div>
      {saveState === 'error' && <div className="error">Could not save: {saveError}</div>}
      {enc.status === 'amending' && <div className="notice">Amending verified visit — reason: {enc.amendmentReason}</div>}

      <nav className="tabs">
        {TABS.map(([k, l]) => (
          <button
            key={k}
            className={tab === k ? 'active' : ''}
            onClick={async () => {
              await flush()
              setTab(k)
            }}
          >
            {l}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'conversation' && <ConversationTab ctx={ctx} />}
        {tab === 'clinical' && <ClinicalTab ctx={ctx} />}
        {tab === 'note' && <NoteTab ctx={ctx} />}
        {tab === 'rx' && <RxTab ctx={ctx} />}
        {tab === 'review' && (
          <ReviewTab
            ctx={ctx}
            user={props.user}
            status={enc.status}
            flush={flush}
            onVerified={(e) => {
              setEnc(e)
              setDoc(e.document)
            }}
          />
        )}
      </div>

      {amending && (
        <AmendDialog
          onClose={() => setAmending(false)}
          onConfirm={async (reason) => {
            const e = await call('encounters.startAmendment', encounterId, patientId, reason)
            setEnc(e)
            setDoc(e.document)
            setAmending(false)
          }}
        />
      )}
    </div>
  )
}

function AmendDialog(props: { onClose: () => void; onConfirm: (reason: string) => Promise<void> }): ReactNode {
  const [reason, setReason] = useState('')
  const { busy, error, run } = useAction()
  return (
    <Modal title="Amend verified visit" onClose={props.onClose}>
      <p className="muted">
        The verified version stays stored unchanged. Your edits become a new revision once verified again.
      </p>
      <Field label="Reason for amendment" value={reason} onChange={setReason} required autoFocus />
      <ErrorBox error={error} />
      <div className="actions">
        <button onClick={props.onClose}>Cancel</button>
        <button className="primary" disabled={busy || !reason.trim()} onClick={() => run(() => props.onConfirm(reason))}>
          Start amendment
        </button>
      </div>
    </Modal>
  )
}
