import { useEffect, useState, type ReactNode } from 'react'
import { call } from '../api'
import type { PreviewResult } from '../../../shared/api'
import { blockingFlags, canVerify } from '../../../shared/flags'
import type { Encounter, LifecycleStatus, ReviewFlag, Revision, User } from '../../../shared/types'
import { ErrorBox, Field, Modal, fmtDateTime, useAction } from '../components/ui'
import { PdfPreview } from '../components/PdfPreview'
import type { VisitCtx } from './Visit'

export function ReviewTab(props: {
  ctx: VisitCtx
  user: User
  status: LifecycleStatus
  flush: () => Promise<void>
  onVerified: (e: Encounter) => void
}): ReactNode {
  const { ctx, status } = props
  const [flags, setFlags] = useState<ReviewFlag[] | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [revPreview, setRevPreview] = useState<{ no: number; result: PreviewResult } | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [exported, setExported] = useState<string[]>([])
  const { busy, error, run } = useAction()
  const locked = status === 'verified' || status === 'amended'

  const refresh = (): Promise<unknown> =>
    run(async () => {
      await props.flush()
      setFlags(await call('review.flags', ctx.encounterId, ctx.patientId))
      setRevisions(await call('encounters.revisions', ctx.encounterId, ctx.patientId))
      setPreview(null)
    })

  useEffect(() => {
    void refresh()
  }, [status])

  const acked = new Set(ctx.doc.acknowledgedFlags)
  const blocking = flags ? blockingFlags(flags) : []
  const warnings = flags ? flags.filter((f) => f.severity === 'warning') : []
  const ready = flags !== null && canVerify(flags, ctx.doc.acknowledgedFlags)

  const toggleAck = (id: string, on: boolean): void =>
    ctx.update((d) => ({
      ...d,
      acknowledgedFlags: on ? [...new Set([...d.acknowledgedFlags, id])] : d.acknowledgedFlags.filter((x) => x !== id)
    }))

  return (
    <div>
      {locked ? (
        <div className="notice ok">
          This visit is {status}. The PDF below is rendered from the stored verified revision and cannot be edited. Use “Amend…” to
          make changes.
        </div>
      ) : (
        <div className="card">
          <div className="row">
            <h3>Pre-verification checks</h3>
            <div className="spacer" />
            <button className="small" disabled={busy} onClick={() => void refresh()}>
              Re-check
            </button>
          </div>
          {flags === null && <p className="muted">Checking…</p>}
          {flags?.length === 0 && <p className="ok">No issues found.</p>}
          {blocking.length > 0 && (
            <>
              <h4>Must fix before verifying</h4>
              <ul className="flags">
                {blocking.map((f) => (
                  <li key={f.id} className="flag blocking">
                    <span className="pill">{f.area}</span> {f.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {warnings.length > 0 && (
            <>
              <h4>Review and acknowledge</h4>
              <ul className="flags">
                {warnings.map((f) => (
                  <li key={f.id} className="flag warning">
                    <label className="check">
                      <input type="checkbox" checked={acked.has(f.id)} onChange={(e) => toggleAck(f.id, e.target.checked)} />
                      <span className="pill warn">{f.area}</span> {f.message}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="card">
        <div className="row">
          <h3>{locked ? 'Verified document' : 'Draft preview'}</h3>
          <div className="spacer" />
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await props.flush()
                setPreview(await call('review.preview', ctx.encounterId, ctx.patientId))
              })
            }
          >
            {preview ? 'Refresh preview' : 'Show preview'}
          </button>
          {!locked && props.user.role === 'doctor' && (
            <button className="primary" disabled={busy || !ready} title={ready ? '' : 'Resolve the checks above first'} onClick={() => setVerifying(true)}>
              Verify & lock…
            </button>
          )}
          {locked && (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const paths = await call('review.export', ctx.encounterId, ctx.patientId)
                  if (paths) setExported(paths)
                })
              }
            >
              Export PDF…
            </button>
          )}
        </div>
        {!locked && props.user.role !== 'doctor' && <p className="muted small">Only a doctor can verify. Printing is available after verification.</p>}
        {!locked && <p className="muted small">Draft previews are watermarked and cannot be exported or printed.</p>}
        <ErrorBox error={error} />
        {exported.length > 0 && (
          <div className="notice ok">
            Saved:
            {exported.map((p) => (
              <div key={p} className="row tight">
                <span className="mono small">{p}</span>
                <button className="small" onClick={() => run(() => call('review.openExported', p))}>
                  Open / print
                </button>
              </div>
            ))}
          </div>
        )}
        {preview && <PdfSet result={preview} />}
      </div>

      {revisions.length > 0 && (
        <div className="card">
          <h3>Revision history</h3>
          <table className="list compact">
            <thead>
              <tr>
                <th>Rev</th>
                <th>Verified by</th>
                <th>When</th>
                <th>Amendment reason</th>
                <th>Hash</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.id}>
                  <td>{r.revisionNo}</td>
                  <td>{r.verifiedByName}</td>
                  <td>{fmtDateTime(r.verifiedAt)}</td>
                  <td>{r.amendmentReason || '—'}</td>
                  <td className="mono small">{r.hash.slice(0, 12)}</td>
                  <td>
                    <button
                      className="small"
                      onClick={() =>
                        run(async () =>
                          setRevPreview({ no: r.revisionNo, result: await call('review.previewRevision', ctx.encounterId, ctx.patientId, r.revisionNo) })
                        )
                      }
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revPreview && (
        <Modal title={`Revision ${revPreview.no}`} wide onClose={() => setRevPreview(null)}>
          <PdfSet result={revPreview.result} />
        </Modal>
      )}

      {verifying && (
        <VerifyDialog
          user={props.user}
          onClose={() => setVerifying(false)}
          onVerify={async (pin) => {
            await props.flush()
            const e = await call('review.verify', ctx.encounterId, ctx.patientId, pin)
            setVerifying(false)
            props.onVerified(e)
          }}
        />
      )}
    </div>
  )
}

function PdfSet({ result }: { result: PreviewResult }): ReactNode {
  return (
    <div className="pdf-wrap">
      {result.pdfs.map((p) => (
        <div key={p.name}>
          {result.pdfs.length > 1 && <h4>{p.name === 'note' ? 'Clinical note' : p.name === 'prescription' ? 'Prescription' : p.name}</h4>}
          <PdfPreview data={p.data} />
        </div>
      ))}
    </div>
  )
}

function VerifyDialog(props: { user: User; onClose: () => void; onVerify: (pin: string) => Promise<void> }): ReactNode {
  const [pin, setPin] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const { busy, error, run } = useAction()
  return (
    <Modal title="Verify and lock" onClose={props.onClose}>
      <label className="check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I, {props.user.name}, have reviewed the
        complete note and prescription and confirm they are accurate.
      </label>
      <Field label="Your PIN" type="password" value={pin} onChange={setPin} autoFocus />
      <ErrorBox error={error} />
      <div className="actions">
        <button onClick={props.onClose}>Cancel</button>
        <button className="primary" disabled={busy || !confirmed || pin.length < 4} onClick={() => run(() => props.onVerify(pin))}>
          Verify
        </button>
      </div>
    </Modal>
  )
}
