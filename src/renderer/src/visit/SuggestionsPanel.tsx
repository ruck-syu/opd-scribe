import { useEffect, useRef, useState, type ReactNode } from 'react'
import { call, errMsg } from '../api'
import { applySuggestion, type Suggestion, type SuggestionTarget } from '../../../shared/extract'
import { sectionLabel } from '../../../shared/sections'
import type { Medication, Transcript, Vitals, VisitDocument } from '../../../shared/types'
import type { VisitCtx } from './Visit'

type OncKey = Extract<SuggestionTarget, { kind: 'oncology' }>['key']
type Group = 'vitals' | 'oncology' | 'findings' | 'medicines' | 'sections'
type MedField = 'formulationStrength' | 'dose' | 'route' | 'frequency' | 'duration' | 'quantity' | 'instructions'

const VITAL_LABEL: Record<keyof Vitals, string> = {
  bp: 'BP',
  pulse: 'Pulse',
  temperature: 'Temperature',
  spo2: 'SpO₂',
  respiratoryRate: 'Resp. rate',
  weight: 'Weight',
  height: 'Height',
  other: 'Other vitals'
}
const ONC_LABEL: Record<OncKey, string> = {
  regimen: 'Regimen',
  cycleNumber: 'Cycle',
  cycleDay: 'Cycle day',
  lastTreatmentDate: 'Last treatment',
  nextPlannedTreatment: 'Next planned treatment'
}
const GROUPS: [Group, string][] = [
  ['vitals', 'Vitals'],
  ['oncology', 'Oncology'],
  ['findings', 'Symptoms & toxicities'],
  ['medicines', 'Medicines'],
  ['sections', 'Note sections']
]
const MED_FIELDS: [MedField, string][] = [
  ['formulationStrength', 'Strength'],
  ['dose', 'Dose'],
  ['route', 'Route'],
  ['frequency', 'Frequency'],
  ['duration', 'Duration'],
  ['quantity', 'Quantity'],
  ['instructions', 'Instructions']
]

const groupOf = (t: SuggestionTarget): Group => {
  switch (t.kind) {
    case 'vital':
      return 'vitals'
    case 'ecog':
    case 'oncology':
      return 'oncology'
    case 'finding':
      return 'findings'
    case 'medication':
      return 'medicines'
    case 'section':
      return 'sections'
  }
}

function labelOf(s: Suggestion): string {
  const t = s.target
  switch (t.kind) {
    case 'vital':
      return VITAL_LABEL[t.key]
    case 'ecog':
      return 'ECOG'
    case 'oncology':
      return ONC_LABEL[t.key]
    case 'finding':
      return t.name
    case 'medication':
      return t.med.name
    case 'section':
      return sectionLabel(t.key)
  }
}

function valueOf(s: Suggestion): string {
  if (s.target.kind !== 'finding') return s.value
  if (s.value === 'present') return 'Present'
  if (s.value === 'absent') return 'Absent'
  return 'Conflicting: no state suggested'
}

/** Why a row cannot go into the note: the field already holds a value the doctor should look at. */
function explain(s: Suggestion, doc: VisitDocument, e: unknown): string {
  const t = s.target
  const current =
    t.kind === 'vital' ? doc.vitals[t.key] : t.kind === 'oncology' ? doc.oncology[t.key] : t.kind === 'ecog' ? doc.oncology.ecog : ''
  return current !== null && current !== '' ? `${labelOf(s)} already has ${current} — edit it in the note or dismiss` : errMsg(e)
}

const keyOf = (t: SuggestionTarget): string =>
  t.kind === 'vital' ? `vital:${t.key}` : t.kind === 'oncology' ? `onc:${t.key}` : t.kind === 'section' ? `section:${t.key}` : t.kind

/** Conversation fields that no pending or accepted suggestion covers. Named only, never guessed. */
function notMentioned(doc: VisitDocument, suggestions: Suggestion[]): string[] {
  const covered = new Set(suggestions.filter((s) => s.status !== 'dismissed').map((s) => keyOf(s.target)))
  const out: string[] = []
  for (const k of Object.keys(VITAL_LABEL) as (keyof Vitals)[])
    if (!doc.vitals[k].trim() && !covered.has(`vital:${k}`)) out.push(VITAL_LABEL[k])
  if (doc.oncology.ecog === null && !covered.has('ecog')) out.push('ECOG')
  if (!doc.oncology.regimen.trim() && !covered.has('onc:regimen')) out.push('Regimen')
  if (!doc.oncology.cycleNumber.trim() && !covered.has('onc:cycleNumber')) out.push('Cycle number')
  if (!doc.prescription.followUp.text.trim() && !covered.has('section:prescription.followUp')) out.push('Follow-up')
  return out
}

function MedFields({ med }: { med: Omit<Medication, 'id'> }): ReactNode {
  return (
    <div className="sug-med">
      {MED_FIELDS.map(([k, l]) => (
        <span key={k}>
          <i>{l}</i> {med[k] || <span className="nd">— not said</span>}
        </span>
      ))}
    </div>
  )
}

/**
 * Proposed field values from one transcript, each with the words it came from. Accepting a row
 * writes it into the note through applySuggestion; nothing enters the note without that click.
 */
export function SuggestionsPanel(props: { ctx: VisitCtx; transcript: Transcript; onChange: (t: Transcript) => void }): ReactNode {
  const { ctx, transcript: t, onChange } = props
  const [busy, setBusy] = useState(false)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [groupError, setGroupError] = useState('')
  const [showRejected, setShowRejected] = useState(false)
  const [llmOn, setLlmOn] = useState(false)
  // written into the note but the decision was not saved: a retry must not insert the text twice
  const applied = useRef(new Set<string>())

  useEffect(() => {
    call('settings.get')
      .then((s) => setLlmOn(s.llm.enabled))
      .catch(() => setLlmOn(false))
  }, [])

  const suggestions = t.suggestions ?? []
  const rejected = t.rejectedSuggestions ?? []
  const pending = suggestions.filter((s) => s.status === 'pending')
  const manual = t.kind === 'conversation' ? notMentioned(ctx.doc, suggestions) : []
  const setRowError = (id: string, msg: string): void => setRowErrors((r) => ({ ...r, [id]: msg }))
  const aiCount = suggestions.filter((s) => s.engine === 'llm').length

  const runAi = async (): Promise<void> => {
    setBusy(true)
    setGroupError('')
    try {
      onChange(await call('transcripts.runLlm', t.id, ctx.patientId))
    } catch (e) {
      setGroupError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  /** One status line for the optional AI extraction: running, failed (with retry), done, or not yet run. */
  const aiLine = (): ReactNode => {
    if (t.llmStatus === 'running') return <p className="notice small">AI extraction running…</p>
    if (t.llmStatus === 'failed')
      return (
        <div className="error small">
          AI extraction failed: {t.llmError || 'unknown error'}
          {!ctx.readOnly && (
            <button className="small" disabled={busy} onClick={() => void runAi()}>
              Retry
            </button>
          )}
        </div>
      )
    if (t.llmStatus === 'done')
      return aiCount > 0 ? (
        <p className="muted small">Includes {aiCount} AI suggestion(s), marked AI. Each one still needs your acceptance.</p>
      ) : (
        <p className="muted small">AI extraction ran and proposed nothing new.</p>
      )
    if (llmOn && !ctx.readOnly)
      return (
        <div className="row tight">
          <span className="muted small">AI extraction has not run on this recording.</span>
          <button className="small" disabled={busy} onClick={() => void runAi()}>
            Run AI extraction
          </button>
        </div>
      )
    return null
  }
  const ai = aiLine()

  /** Writes rows into the note, then records each decision. Returns the first row that failed, if any. */
  const accept = async (rows: Suggestion[]): Promise<Suggestion | null> => {
    setBusy(true)
    try {
      let doc = ctx.doc
      let failed: Suggestion | null = null
      const written: Suggestion[] = []
      const decide: Suggestion[] = []
      for (const s of rows) {
        setRowError(s.id, '')
        if (!applied.current.has(s.id)) {
          try {
            doc = applySuggestion(doc, s, t.kind)
            written.push(s)
          } catch (e) {
            setRowError(s.id, explain(s, doc, e))
            failed = s
            break
          }
        }
        decide.push(s)
      }
      // rows written before a failure still get their decision recorded
      if (written.length) ctx.update(() => doc)
      for (const s of decide) applied.current.add(s.id)
      for (const s of decide) {
        try {
          onChange(await call('transcripts.decideSuggestion', t.id, ctx.patientId, s.id, 'accepted'))
          applied.current.delete(s.id)
        } catch (e) {
          setRowError(s.id, `Added to the note, but not recorded as accepted: ${errMsg(e)}. Accept again to retry.`)
          return s
        }
      }
      return failed
    } finally {
      setBusy(false)
    }
  }

  const acceptAll = async (rows: Suggestion[]): Promise<void> => {
    setGroupError('')
    const failed = await accept(rows)
    if (failed) setGroupError(`Stopped at ${labelOf(failed)}. Rows before it were handled; the rest are unchanged.`)
  }

  const dismiss = async (s: Suggestion): Promise<void> => {
    setBusy(true)
    setRowError(s.id, '')
    try {
      onChange(await call('transcripts.decideSuggestion', t.id, ctx.patientId, s.id, 'dismissed'))
    } catch (e) {
      setRowError(s.id, errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const renderRow = (s: Suggestion): ReactNode => (
    <div key={s.id} className={`suggestion ${s.warning ? 'has-warning' : ''}`}>
      <div className="sug-main">
        <b>{labelOf(s)}</b>
        {s.engine === 'llm' && <span className="pill ai" title="Proposed by the local AI model; check it against the quote">AI</span>}
        {s.target.kind === 'medication' ? (
          <MedFields med={s.target.med} />
        ) : (
          <span className="sug-value">{valueOf(s)}</span>
        )}
        <div className="sug-quote muted small">“{s.quote}”</div>
        {s.warning && <div className="sug-warning small">⚠ {s.warning}</div>}
        {rowErrors[s.id] && <div className="error">{rowErrors[s.id]}</div>}
      </div>
      {!ctx.readOnly && (
        <div className="sug-actions">
          {s.value ? (
            <button className="small primary" disabled={busy} onClick={() => void accept([s])}>
              Accept
            </button>
          ) : null}
          <button className="small ghost" disabled={busy} onClick={() => void dismiss(s)}>
            {s.value ? 'Dismiss' : 'Noted'}
          </button>
        </div>
      )}
    </div>
  )

  if (!suggestions.length && !rejected.length && !manual.length && !ai) return null
  const rejectedLabel = `${rejected.length} candidate${rejected.length === 1 ? '' : 's'} rejected (not backed by the transcript)`

  const unlabelled =
    t.kind === 'conversation'
      ? t.segments.filter((x) => x.speakerUncertain || x.speaker === 'unlabelled').length
      : 0

  return (
    <div className="suggestions">
      <div className="sug-head">
        <b>Suggestions from this recording</b>
        <span className="muted small">Nothing enters the note until you accept a row.</span>
      </div>
      {ai && <div className="sug-ai">{ai}</div>}
      {unlabelled > 0 && (
        <p className="notice small">
          {unlabelled} segment(s) have no confirmed speaker, so their suggestions are marked “Speaker not confirmed” and
          are left out of “Accept all”. Label the speakers in the transcript below — what the patient says is history, not
          a finding or an order.
        </p>
      )}
      {groupError && <div className="error">{groupError}</div>}

      {GROUPS.map(([g, title]) => {
        const rows = pending.filter((s) => groupOf(s.target) === g)
        const decided = suggestions.filter((s) => s.status !== 'pending' && groupOf(s.target) === g)
        if (!rows.length && !decided.length) return null
        // AI rows are accepted one by one, never in bulk
        const safe = rows.filter((s) => s.value && !s.warning && s.engine === 'rules')
        return (
          <div key={g} className="sug-group">
            <div className="sug-group-head">
              <b>{title}</b>
              <span className="muted small">{rows.length} to review</span>
              <div className="spacer" />
              {!ctx.readOnly && safe.length > 0 && (
                <button className="small" disabled={busy} onClick={() => void acceptAll(safe)}>
                  Accept all without warnings ({safe.length})
                </button>
              )}
            </div>
            {rows.map(renderRow)}
            {decided.map((s) => (
              <div key={s.id} className="sug-done small">
                <span className="muted">{labelOf(s)}</span>
                {s.engine === 'llm' && <span className="pill ai">AI</span>}
                <span className={`pill ${s.status === 'accepted' ? 'ok' : ''}`}>{s.status === 'accepted' ? 'Accepted' : 'Dismissed'}</span>
              </div>
            ))}
          </div>
        )
      })}

      {rejected.length > 0 && (
        <div className="sug-rejected">
          <button className="ghost small" onClick={() => setShowRejected(!showRejected)}>
            {showRejected ? '▾' : '▸'} {rejectedLabel}
          </button>
          {showRejected && (
            <ul className="small">
              {rejected.map((r, i) => (
                <li key={i}>
                  <span className="mono">“{r.quote}”</span> → {r.value || '(no value)'} <span className="muted">— {r.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {manual.length > 0 && (
        <div className="sug-manual small">
          <span className="muted">Not mentioned — fill manually:</span> {manual.join(', ')}
        </div>
      )}
    </div>
  )
}
