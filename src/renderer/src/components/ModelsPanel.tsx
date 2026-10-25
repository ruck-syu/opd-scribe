import { useEffect, useState, type ReactNode } from 'react'
import { call, on } from '../api'
import { MODEL_CATALOG, fmtSize, type ImportReport, type ModelId, type ModelStatus } from '../../../shared/models'
import { ErrorBox, useAction } from './ui'

/** Every model's status, kept current by pushes from the main process. */
export function useModels(): ModelStatus[] {
  const [models, setModels] = useState<ModelStatus[]>([])
  useEffect(() => {
    const off = on('models.changed', setModels)
    void call('models.status').then(setModels).catch(() => undefined)
    return off
  }, [])
  return models
}

export function stateOf(models: ModelStatus[], id: ModelId): ModelStatus['state'] | undefined {
  return models.find((m) => m.id === id)?.state
}

export interface AiTick {
  checked: boolean
  onChange: (checked: boolean) => void
}

/** Download rows with progress, Pause / Resume / Retry, and copying the files from a USB drive. */
export function ModelsPanel({ models, aiTick }: { models: ModelStatus[]; aiTick?: AiTick }): ReactNode {
  const { busy, error, run } = useAction()
  const [report, setReport] = useState<ImportReport | null>(null)

  return (
    <div className="models">
      {MODEL_CATALOG.map((spec) => {
        const m = models.find((x) => x.id === spec.id)
        return (
          <div className="model-row" key={spec.id}>
            <div className="model-row-head">
              {aiTick && !spec.required && (
                <input
                  type="checkbox"
                  checked={aiTick.checked}
                  disabled={busy}
                  aria-label={`Use the ${spec.label}`}
                  onChange={(e) => aiTick.onChange(e.target.checked)}
                />
              )}
              <b>{spec.label}</b>
              <span className="muted small">
                {spec.required ? 'Required' : 'Optional'} · {fmtSize(spec.size)}
              </span>
            </div>
            <ModelLine
              id={spec.id}
              status={m}
              busy={busy}
              download={() => void run(() => call('models.download', spec.id))}
              pause={() => void run(() => call('models.cancel', spec.id))}
            />
          </div>
        )
      })}
      <ErrorBox error={error} />
      <div className="models-foot">
        <button
          type="button"
          className="link-btn"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await call('models.importFolder')
              if (r) setReport(r)
            })
          }
        >
          No internet here? Copy the files from a USB drive
        </button>
        {busy && <span className="muted small"> Working…</span>}
        {report && <ImportNote report={report} />}
      </div>
    </div>
  )
}

function ModelLine({
  id,
  status,
  busy,
  download,
  pause
}: {
  id: ModelId
  status: ModelStatus | undefined
  busy: boolean
  download: () => void
  pause: () => void
}): ReactNode {
  if (!status) return <div className="muted small">Checking…</div>
  const { bytes, total } = status
  const amount = `${fmtSize(bytes)} of ${fmtSize(total)}`
  switch (status.state) {
    case 'ready':
      return <div className="ok">Installed</div>
    case 'downloading':
      return (
        <div className="model-progress">
          <Bar done={bytes} total={total} />
          <div className="row tight">
            <span className="small muted">{amount}</span>
            <div className="spacer" />
            <button className="small ghost" onClick={pause} aria-label={`Pause ${id}`}>
              Pause
            </button>
          </div>
        </div>
      )
    case 'verifying':
      return (
        <div className="model-progress">
          <Bar done={total} total={total} />
          <span className="small muted">Checking the file…</span>
        </div>
      )
    case 'failed':
      return (
        <div className="model-progress">
          <div className="error">{status.reason}</div>
          <div className="row tight">
            <span className="small muted">{bytes > 0 ? `${amount} saved` : ''}</span>
            <div className="spacer" />
            <button className="small" disabled={busy} onClick={download}>
              Retry
            </button>
          </div>
        </div>
      )
    case 'missing':
      return bytes > 0 ? (
        <div className="model-progress">
          <Bar done={bytes} total={total} />
          <div className="row tight">
            <span className="small muted">Paused at {amount}</span>
            <div className="spacer" />
            <button className="small" disabled={busy} onClick={download}>
              Resume
            </button>
          </div>
        </div>
      ) : (
        <div className="row tight">
          <span className="small muted">Not downloaded yet</span>
          <div className="spacer" />
          <button className="small" disabled={busy} onClick={download}>
            Download
          </button>
        </div>
      )
  }
}

function Bar({ done, total }: { done: number; total: number }): ReactNode {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0
  return (
    <div className="meter wide">
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

function ImportNote({ report }: { report: ImportReport }): ReactNode {
  const name = (id: ModelId): string => MODEL_CATALOG.find((m) => m.id === id)?.label ?? id
  const nothing = report.imported.length === 0 && report.alreadyInstalled.length === 0 && report.rejected.length === 0
  return (
    <div className={`notice ${report.imported.length > 0 ? 'ok' : ''}`}>
      {report.scanned === 0 || nothing ? (
        <div>No OPD Scribe model files were found in that folder.</div>
      ) : null}
      {report.imported.length > 0 && <div>Copied: {report.imported.map(name).join(', ')}.</div>}
      {report.alreadyInstalled.length > 0 && <div>Already installed: {report.alreadyInstalled.map(name).join(', ')}.</div>}
      {report.rejected.map((r) => (
        <div key={r.file}>
          {r.file}: {r.reason}
        </div>
      ))}
    </div>
  )
}
