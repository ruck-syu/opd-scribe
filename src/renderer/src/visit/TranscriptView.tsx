import { useEffect, useRef, useState, type ReactNode } from 'react'
import { call, errMsg } from '../api'
import { SECTION_TARGETS, appendToSection, segmentsText, type SectionKey } from '../../../shared/sections'
import type { Speaker, Transcript } from '../../../shared/types'
import { fmtDuration } from '../components/ui'
import type { VisitCtx } from './Visit'

const SPEAKERS: [Speaker, string][] = [
  ['unlabelled', '— speaker? —'],
  ['doctor', 'Doctor'],
  ['patient', 'Patient'],
  ['attendant', 'Attendant'],
  ['other', 'Other']
]

/** One transcript: status, editable segments, speaker labels, insert-into-section. */
export function TranscriptView(props: { ctx: VisitCtx; transcript: Transcript; defaultTarget: SectionKey }): ReactNode {
  const { ctx } = props
  const [t, setT] = useState(props.transcript)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<SectionKey>(props.defaultTarget)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(!props.transcript.reviewed)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(t)

  useEffect(() => {
    setT(props.transcript)
    latest.current = props.transcript
  }, [props.transcript])

  const persist = (next: Transcript, immediate = false): void => {
    setT(next)
    latest.current = next
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const go = (): void =>
      void call('transcripts.save', latest.current, ctx.patientId)
        .then(() => setError(''))
        .catch((e) => setError(errMsg(e)))
    if (immediate) go()
    else saveTimer.current = setTimeout(go, 600)
  }
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        void call('transcripts.save', latest.current, ctx.patientId).catch(() => undefined)
      }
    },
    []
  )

  const title =
    t.kind === 'conversation' ? `Conversation · ${fmtDuration(t.durationMs)}` : `Dictation (${t.section}) · ${fmtDuration(t.durationMs)}`
  const pct = ctx.progress[t.id]

  if (t.status === 'transcribing')
    return (
      <div className="transcript card">
        <b>{title}</b> — transcribing{pct !== undefined ? ` ${pct}%` : '…'}
        <div className="meter wide">
          <span style={{ width: `${pct ?? 2}%` }} />
        </div>
      </div>
    )

  if (t.status === 'failed')
    return (
      <div className="transcript card failed">
        <b>{title}</b> — failed: {t.error}
        <div className="actions left">
          <button onClick={() => call('transcripts.retry', t.id, ctx.encounterId, ctx.patientId).then(ctx.reloadTranscripts).catch((e) => setError(errMsg(e)))}>
            Retry
          </button>
          {!ctx.readOnly && (
            <button
              className="ghost"
              onClick={() =>
                confirm('Delete this recording and transcript?') &&
                call('transcripts.delete', t.id, ctx.encounterId, ctx.patientId).then(ctx.reloadTranscripts)
              }
            >
              Delete
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    )

  const chosen = t.segments.filter((s) => selected.has(s.id))
  const insert = (): void => {
    const segs = chosen.length ? chosen : t.segments
    const text = segmentsText(t, segs, true)
    ctx.update((d) => appendToSection(d, target, text, { kind: t.kind, refId: t.id, at: new Date().toISOString() }))
    setSelected(new Set())
  }
  const labelAll = (speaker: Speaker): void =>
    persist({
      ...t,
      segments: t.segments.map((s) => (selected.has(s.id) ? { ...s, speaker, speakerUncertain: speaker === 'unlabelled' } : s))
    })

  const warned = t.segments.filter((s) => s.warning).length
  const uncertain = t.kind === 'conversation' ? t.segments.filter((s) => s.speakerUncertain).length : 0

  return (
    <div className={`transcript card ${t.reviewed ? 'reviewed' : ''}`}>
      <div className="transcript-head" onClick={() => setOpen(!open)}>
        <b>{title}</b>
        <span className="muted">{t.segments.length} segments</span>
        {warned > 0 && <span className="pill warn">{warned} flagged</span>}
        {uncertain > 0 && <span className="pill warn">{uncertain} unlabelled</span>}
        {t.reviewed && <span className="pill ok">Reviewed</span>}
        <div className="spacer" />
        <span className="muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <>
          <div className="segments">
            {t.segments.map((s) => (
              <div key={s.id} className={`segment ${s.warning ? 'has-warning' : ''} sp-${s.speaker}`}>
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={(e) => {
                    const n = new Set(selected)
                    if (e.target.checked) n.add(s.id)
                    else n.delete(s.id)
                    setSelected(n)
                  }}
                />
                <span className="ts mono">{fmtDuration(s.startMs)}</span>
                {t.kind === 'conversation' && (
                  <select
                    value={s.speaker}
                    disabled={ctx.readOnly}
                    className={s.speakerUncertain ? 'uncertain' : ''}
                    onChange={(e) =>
                      persist({
                        ...t,
                        segments: t.segments.map((x) =>
                          x.id === s.id ? { ...x, speaker: e.target.value as Speaker, speakerUncertain: e.target.value === 'unlabelled' } : x
                        )
                      })
                    }
                  >
                    {SPEAKERS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                )}
                <div className="seg-text">
                  <textarea
                    rows={Math.max(1, Math.ceil(s.text.length / 90))}
                    value={s.text}
                    readOnly={ctx.readOnly}
                    onChange={(e) => persist({ ...t, segments: t.segments.map((x) => (x.id === s.id ? { ...x, text: e.target.value } : x)) })}
                  />
                  {s.text !== s.originalText && <div className="orig">Engine heard: “{s.originalText}”</div>}
                  {s.warning && <div className="seg-warning">⚠ {s.warning}</div>}
                </div>
              </div>
            ))}
            {t.segments.length === 0 && <div className="muted">No speech recognised.</div>}
          </div>
          {!ctx.readOnly && (
            <div className="transcript-actions">
              {t.kind === 'conversation' && chosen.length > 0 && (
                <span className="row tight">
                  Label {chosen.length} selected as
                  {SPEAKERS.slice(1).map(([v, l]) => (
                    <button key={v} className="small" onClick={() => labelAll(v)}>
                      {l}
                    </button>
                  ))}
                </span>
              )}
              <span className="row tight">
                Insert {chosen.length ? `${chosen.length} selected` : 'all'} into
                <select value={target} onChange={(e) => setTarget(e.target.value as SectionKey)}>
                  {SECTION_TARGETS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <button className="small" onClick={insert}>
                  Insert
                </button>
              </span>
              <div className="spacer" />
              <label className="check">
                <input type="checkbox" checked={t.reviewed} onChange={(e) => persist({ ...t, reviewed: e.target.checked }, true)} />I have
                reviewed this transcript
              </label>
              <button
                className="ghost small"
                onClick={() =>
                  confirm('Delete this recording and transcript? Text already inserted into the note stays.') &&
                  call('transcripts.delete', t.id, ctx.encounterId, ctx.patientId).then(ctx.reloadTranscripts)
                }
              >
                Delete
              </button>
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  )
}
