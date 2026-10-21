import { useEffect, useRef, useState, type ReactNode } from 'react'
import { call, errMsg } from '../api'
import { PcmRecorder } from '../audio/recorder'
import type { DictationSection, TranscriptKind } from '../../../shared/types'
import { fmtDuration } from './ui'

type State = 'idle' | 'recording' | 'paused' | 'sending'

export function RecorderPanel(props: {
  encounterId: string
  patientId: string
  kind: TranscriptKind
  section?: DictationSection
  label: string
  disabled?: boolean
  onSubmitted: () => void
}): ReactNode {
  const rec = useRef<PcmRecorder | null>(null)
  const [state, setState] = useState<State>('idle')
  const [ms, setMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return
    const t = setInterval(() => {
      setMs(rec.current?.durationMs ?? 0)
      setLevel(rec.current?.level ?? 0)
    }, 200)
    return () => clearInterval(t)
  }, [state])

  // never leave the mic open when the component goes away
  useEffect(() => () => void rec.current?.cancel(), [])

  const start = async (): Promise<void> => {
    setError('')
    try {
      const r = new PcmRecorder()
      await r.start()
      rec.current = r
      setMs(0)
      setState('recording')
    } catch (e) {
      setError(`Microphone unavailable: ${errMsg(e)}`)
    }
  }

  const pause = (): void => {
    if (!rec.current) return
    rec.current.paused = !rec.current.paused
    setState(rec.current.paused ? 'paused' : 'recording')
  }

  const stop = async (): Promise<void> => {
    if (!rec.current) return
    setState('sending')
    try {
      const { wav, durationMs } = await rec.current.stop()
      rec.current = null
      if (durationMs < 500) throw new Error('Recording too short')
      await call('transcripts.transcribe', {
        encounterId: props.encounterId,
        patientId: props.patientId,
        kind: props.kind,
        section: props.section ?? null,
        wav,
        durationMs
      })
      props.onSubmitted()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setState('idle')
    }
  }

  const discard = async (): Promise<void> => {
    if (!confirm('Discard this recording? It will not be saved.')) return
    await rec.current?.cancel()
    rec.current = null
    setState('idle')
  }

  return (
    <div className={`recorder ${state}`}>
      {state === 'idle' && (
        <button className="rec-btn" disabled={props.disabled} onClick={start}>
          ● {props.label}
        </button>
      )}
      {(state === 'recording' || state === 'paused') && (
        <>
          <span className="rec-dot" style={{ opacity: state === 'paused' ? 0.3 : 1 }} />
          <span className="rec-time">{fmtDuration(ms)}</span>
          <span className="meter">
            <span style={{ width: `${Math.min(100, level * 400)}%` }} />
          </span>
          <span className="muted">{state === 'paused' ? 'Paused' : 'Recording…'}</span>
          <button onClick={pause}>{state === 'paused' ? 'Resume' : 'Pause'}</button>
          <button className="primary" onClick={stop}>
            Stop & transcribe
          </button>
          <button className="ghost" onClick={discard}>
            Discard
          </button>
        </>
      )}
      {state === 'sending' && <span className="muted">Saving audio…</span>}
      {error && <span className="error inline">{error}</span>}
    </div>
  )
}
