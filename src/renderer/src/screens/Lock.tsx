import { useEffect, useState, type ReactNode } from 'react'
import { call } from '../api'
import type { User } from '../../../shared/types'
import { ErrorBox, Field, useAction } from '../components/ui'

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }): ReactNode {
  const [users, setUsers] = useState<Pick<User, 'id' | 'name' | 'role'>[]>([])
  const [userId, setUserId] = useState('')
  const [pin, setPin] = useState('')
  const { busy, error, run } = useAction()

  useEffect(() => {
    void call('auth.users').then((u) => {
      setUsers(u)
      setUserId(u[0]?.id ?? '')
    })
  }, [])

  return (
    <div className="center">
      <form
        className="card narrow"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await call('auth.login', userId, pin)
            onUnlocked()
          }).finally(() => setPin(''))
        }}
      >
        <h2>OPD Scribe — locked</h2>
        <div className="user-pick">
          {users.map((u) => (
            <button type="button" key={u.id} className={u.id === userId ? 'on' : ''} onClick={() => setUserId(u.id)}>
              {u.name}
              <small>{u.role}</small>
            </button>
          ))}
        </div>
        <Field label="PIN" type="password" value={pin} onChange={setPin} autoFocus />
        <ErrorBox error={error} />
        <button className="primary" disabled={busy || !userId || !pin}>
          Unlock
        </button>
      </form>
    </div>
  )
}
