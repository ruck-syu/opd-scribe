import { useEffect, useRef, useState, type ReactNode } from 'react'
import { call, errMsg } from '../api'
import { PcmRecorder } from '../audio/recorder'
import type { DictationSection, TranscriptKind } from '../../../shared/types'
import { fmtDuration } from './ui'

type State = 'idle' | 'recording' | 'paused' | 'sending'
type Captured = { wav: ArrayBuffer; durationMs: number }

const INTERRUPTED =
  'Microphone disconnected — the recording so far was saved. Reconnect the microphone and record again to continue.'
const INTERRUPTED_EMPTY = 'Microphone disconnected before anything was recorded. Reconnect the microphone and try again.'

export function RecorderPanel(props: {
  encounterId: string
  patientId: string
  kind: TranscriptKind
  section?: DictationSection
  label: string
  disabled?: boolean
  /** ask for (and enforce) consultation recording consent before the first recording */
  requireConsent?: boolean
  onSubmitted: () => void
}): ReactNode {
  const rec = useRef<PcmRecorder | null>(null)
  const [state, setState] = useState<State>('idle')
  const [ms, setMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [consent, setConsent] = useState<boolean | null>(props.requireConsent && !props.disabled ? null : true)
  const [agreed, setAgreed] = useState(false)
  const [pending, setPending] = useState<Captured | null>(null)

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

  useEffect(() => {
    if (!props.requireConsent || props.disabled) {
      setConsent(true)
      return
    }
    let live = true
    setConsent(null)
    void call('encounters.consent', props.encounterId, props.patientId)
      .then((given) => {
        if (live) setConsent(given)
      })
      .catch((e) => {
        if (!live) return
        setConsent(false)
        setError(errMsg(e))
      })
    return () => {
      live = false
    }
  }, [props.requireConsent, props.disabled, props.encounterId, props.patientId])

  const submit = async (audio: Captured): Promise<void> => {
    try {
      await call('transcripts.transcribe', {
        encounterId: props.encounterId,
        patientId: props.patientId,
        kind: props.kind,
        section: props.section ?? null,
        wav: audio.wav,
        durationMs: audio.durationMs
      })
      setPending(null)
      props.onSubmitted()
    } catch (e) {
      // The audio is never dropped on failure: a consent/lock/ASR error keeps it for Retry.
      setPending(audio)
      setError(errMsg(e))
    }
  }

  const start = async (): Promise<void> => {
    setError('')
    setNotice('')
    try {
      const r = new PcmRecorder()
      r.onInterrupted = () => void interrupted(r)
      rec.current = r
      await r.start()
      setMs(0)
      setState('recording')
    } catch (e) {
      rec.current = null
      setError(`Microphone unavailable: ${errMsg(e)}`)
    }
  }

  const pause = (): void => {
    if (!rec.current) return
    rec.current.paused = !rec.current.paused
    setState(rec.current.paused ? 'paused' : 'recording')
  }

  const stop = async (): Promise<void> => {
    const r = rec.current
    if (!r) return
    rec.current = null
    setState('sending')
    try {
      const audio = await r.stop()
      if (audio.durationMs < 500) setError('Recording too short')
      else await submit(audio)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setState('idle')
    }
  }

  /** Mic unplugged / device revoked: keep what we have and submit it like Stop. */
  const interrupted = async (r: PcmRecorder): Promise<void> => {
    if (rec.current !== r) return
    rec.current = null
    setState('sending')
    try {
      const audio = await r.stop()
      if (audio.durationMs < 500) {
        setNotice(INTERRUPTED_EMPTY)
        return
      }
      setNotice(INTERRUPTED)
      await submit(audio)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setState('idle')
    }
  }

  const retry = async (): Promise<void> => {
    if (!pending) return
    setState('sending')
    await submit(pending)
    setState('idle')
  }

  const discard = async (): Promise<void> => {
    if (!confirm('Discard this recording? It will not be saved.')) return
    await rec.current?.cancel()
    rec.current = null
    setState('idle')
  }

  const confirmConsent = async (): Promise<void> => {
    setError('')
    try {
      await call('encounters.recordConsent', props.encounterId, props.patientId)
      setConsent(true)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <div className={`recorder ${state}`}>
      {state === 'idle' && pending && (
        <>
          <span className="muted small">Recording not saved yet — the audio is kept.</span>
          <button className="primary" onClick={retry}>
            Retry
          </button>
          <button className="ghost" onClick={() => confirm('Discard this recording? It will not be saved.') && setPending(null)}>
            Discard audio
          </button>
        </>
      )}
      {state === 'idle' && !pending && consent === null && <span className="muted small">Checking consent…</span>}
      {state === 'idle' && !pending && consent === false && (
        <>
          <label className="check small">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>The patient has agreed to this consultation being recorded</span>
          </label>
          <button disabled={!agreed} onClick={confirmConsent}>
            Confirm consent
          </button>
        </>
      )}
      {state === 'idle' && !pending && consent === true && (
        <>
          {props.requireConsent && !props.disabled && <span className="muted small">Consent recorded</span>}
          <button className="rec-btn" disabled={props.disabled} onClick={start}>
            ● {props.label}
          </button>
        </>
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
      {notice && <span className="notice small">{notice}</span>}
      {error && <span className="error inline">{error}</span>}
    </div>
  )
}
