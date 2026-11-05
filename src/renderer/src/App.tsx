import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { call, on } from './api'
import type { AppStatus } from '../../shared/api'
import type { User } from '../../shared/types'
import { Setup } from './screens/Setup'
import { GettingReady } from './screens/GettingReady'
import { LockScreen } from './screens/Lock'
import { Patients } from './screens/Patients'
import { PatientProfile } from './screens/PatientProfile'
import { Settings } from './screens/Settings'
import { Visit } from './visit/Visit'
import { BrandMark } from './components/ui'

export type Route =
  | { screen: 'patients' }
  | { screen: 'patient'; patientId: string }
  | { screen: 'visit'; patientId: string; encounterId: string }
  | { screen: 'settings' }

export function App(): ReactNode {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [route, setRoute] = useState<Route>({ screen: 'patients' })

  const refresh = useCallback(async () => setStatus(await call('app.status')), [])
  useEffect(() => {
    void refresh()
    return on('app.locked', () => void refresh())
  }, [refresh])

  const user = status?.user ?? null
  const lock = useCallback(async () => {
    await call('auth.lock')
    await refresh()
  }, [refresh])

  useAutoLock(user, lock)

  // speech files missing at sign-in: offer the download once per sign-in ("Later" or Continue skips it)
  const [speechReady, setSpeechReady] = useState<boolean | null>(null)
  const [readySkipped, setReadySkipped] = useState(false)
  useEffect(() => {
    setReadySkipped(false)
    setSpeechReady(null)
    if (!user) return
    void call('models.status')
      .then((list) => setSpeechReady(list.some((m) => m.id === 'speech' && m.state === 'ready')))
      .catch(() => setSpeechReady(true))
  }, [user?.id])

  if (!status) return <div className="center muted">Loading…</div>
  if (!status.setupDone) return <Setup onDone={refresh} />
  if (!user) return <LockScreen onUnlocked={refresh} />
  if (speechReady === null) return <div className="center muted">Loading…</div>
  if (!speechReady && !readySkipped) return <GettingReady onDone={() => setReadySkipped(true)} />

  return (
    <div className="shell">
      <aside className="rail">
        <button className="brand" onClick={() => setRoute({ screen: 'patients' })} aria-label="OPD Scribe, go to patients">
          <BrandMark />
          <span>
            OPD Scribe
            <small>Offline on this computer</small>
          </span>
        </button>
        <nav className="rail-nav">
          <button
            className={route.screen !== 'settings' ? 'active' : ''}
            aria-current={route.screen !== 'settings' ? 'page' : undefined}
            onClick={() => setRoute({ screen: 'patients' })}
          >
            Patients
          </button>
          {user.role === 'doctor' && (
            <button
              className={route.screen === 'settings' ? 'active' : ''}
              aria-current={route.screen === 'settings' ? 'page' : undefined}
              onClick={() => setRoute({ screen: 'settings' })}
            >
              Settings
            </button>
          )}
        </nav>
        <div className="spacer" />
        <div className="rail-user">
          <span className="avatar" aria-hidden="true">
            {initials(user.name)}
          </span>
          <span className="rail-user-name">
            {user.name}
            <small>{user.role === 'doctor' ? 'Doctor' : 'Staff'}</small>
          </span>
        </div>
        <button className="rail-lock" onClick={lock}>
          Lock screen
        </button>
      </aside>
      <main className="content">
        {route.screen === 'patients' && <Patients open={(patientId) => setRoute({ screen: 'patient', patientId })} />}
        {route.screen === 'patient' && (
          <PatientProfile
            key={route.patientId}
            patientId={route.patientId}
            user={user}
            back={() => setRoute({ screen: 'patients' })}
            openVisit={(encounterId) => setRoute({ screen: 'visit', patientId: route.patientId, encounterId })}
          />
        )}
        {route.screen === 'visit' && (
          <Visit
            key={route.encounterId}
            patientId={route.patientId}
            encounterId={route.encounterId}
            user={user}
            back={() => setRoute({ screen: 'patient', patientId: route.patientId })}
          />
        )}
        {route.screen === 'settings' && <Settings user={user} onRestored={refresh} />}
      </main>
    </div>
  )
}

function initials(name: string): string {
  const parts = name
    .replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Lock after N idle minutes (SEC: auto-lock). */
function useAutoLock(user: User | null, lock: () => Promise<void>): void {
  const [minutes, setMinutes] = useState(10)
  useEffect(() => {
    if (user) call('settings.get').then((s) => setMinutes(s.autoLockMinutes)).catch(() => undefined)
  }, [user])
  useEffect(() => {
    if (!user || minutes <= 0) return
    let last = Date.now()
    const bump = (): void => {
      last = Date.now()
    }
    const evs = ['mousemove', 'keydown', 'mousedown', 'wheel'] as const
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }))
    const t = setInterval(() => {
      // don't lock in the middle of a recording
      if (document.querySelector('.recorder.recording, .recorder.paused')) bump()
      if (Date.now() - last > minutes * 60_000) void lock()
    }, 15_000)
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump))
      clearInterval(t)
    }
  }, [user, minutes, lock])
}
