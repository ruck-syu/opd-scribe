import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { call, on } from './api'
import type { AppStatus } from '../../shared/api'
import type { User } from '../../shared/types'
import { Setup } from './screens/Setup'
import { LockScreen } from './screens/Lock'
import { Patients } from './screens/Patients'
import { PatientProfile } from './screens/PatientProfile'
import { Settings } from './screens/Settings'
import { Visit } from './visit/Visit'

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

  if (!status) return <div className="center muted">Loading…</div>
  if (!status.setupDone) return <Setup onDone={refresh} />
  if (!user) return <LockScreen onUnlocked={refresh} />

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand" onClick={() => setRoute({ screen: 'patients' })}>
          OPD Scribe
        </div>
        <nav>
          <button className={route.screen === 'patients' ? 'active' : ''} onClick={() => setRoute({ screen: 'patients' })}>
            Patients
          </button>
          {user.role === 'doctor' && (
            <button className={route.screen === 'settings' ? 'active' : ''} onClick={() => setRoute({ screen: 'settings' })}>
              Settings
            </button>
          )}
        </nav>
        <div className="spacer" />
        <span className="muted">
          {user.name} · {user.role}
        </span>
        <button onClick={lock}>Lock</button>
      </header>
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
