import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FindingState, LifecycleStatus } from '../../../shared/types'

export function Field(props: {
  label: string
  value: string
  onChange?: (v: string) => void
  type?: string
  placeholder?: string
  readOnly?: boolean
  required?: boolean
  autoFocus?: boolean
  width?: number | string
}): ReactNode {
  return (
    <label className="field" style={{ width: props.width }}>
      <span>
        {props.label}
        {props.required && <b className="req"> *</b>}
      </span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        readOnly={props.readOnly || !props.onChange}
        autoFocus={props.autoFocus}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
    </label>
  )
}

export function Area(props: {
  label?: ReactNode
  value: string
  onChange?: (v: string) => void
  rows?: number
  placeholder?: string
  readOnly?: boolean
}): ReactNode {
  return (
    <label className="field">
      {props.label && <span>{props.label}</span>}
      <textarea
        rows={props.rows ?? 3}
        value={props.value}
        placeholder={props.placeholder}
        readOnly={props.readOnly || !props.onChange}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
    </label>
  )
}

export function Select<T extends string>(props: {
  label: string
  value: T
  options: [T, string][]
  onChange?: (v: T) => void
  width?: number | string
}): ReactNode {
  return (
    <label className="field" style={{ width: props.width }}>
      <span>{props.label}</span>
      <select value={props.value} disabled={!props.onChange} onChange={(e) => props.onChange?.(e.target.value as T)}>
        {props.options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Tri-state toggle: Not assessed / Present / Absent. Never defaults to absent (ONC-04). */
export function TriState(props: {
  value: FindingState
  onChange?: (v: FindingState) => void
  labels?: [string, string, string]
}): ReactNode {
  const [na, yes, no] = props.labels ?? ['Not assessed', 'Present', 'Absent']
  const opts: [FindingState, string][] = [
    ['not_assessed', na],
    ['present', yes],
    ['absent', no]
  ]
  return (
    <div className="tri">
      {opts.map(([v, l]) => (
        <button
          key={v}
          type="button"
          className={`tri-${v} ${props.value === v ? 'on' : ''}`}
          disabled={!props.onChange}
          onClick={() => props.onChange?.(v)}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

export function StatusBadge({ status }: { status: LifecycleStatus }): ReactNode {
  const label = { draft: 'Draft', verified: 'Verified', amending: 'Amending', amended: 'Amended' }[status]
  return <span className={`badge badge-${status}`}>{label}</span>
}

export function Modal(props: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }): ReactNode {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [props])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-label={props.title}>
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="ghost" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

export function ErrorBox({ error }: { error: string }): ReactNode {
  return error ? <div className="error">{error}</div> : null
}

/** Run an async action with busy + error state. */
export function useAction(): {
  busy: boolean
  error: string
  setError: (e: string) => void
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError('')
    try {
      return await fn()
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
      return undefined
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

export function fmtDateTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
