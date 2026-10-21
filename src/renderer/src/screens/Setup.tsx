import { useState, type ReactNode } from 'react'
import { call } from '../api'
import { ErrorBox, Field, useAction } from '../components/ui'

export function Setup({ onDone }: { onDone: () => void }): ReactNode {
  const [clinicName, setClinicName] = useState('')
  const [clinicAddress, setClinicAddress] = useState('')
  const [name, setName] = useState('')
  const [registrationNo, setReg] = useState('')
  const [qualifications, setQual] = useState('')
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const { busy, error, setError, run } = useAction()

  const submit = (): void => {
    if (pin !== pin2) return setError('PINs do not match')
    void run(async () => {
      await call('auth.setup', { clinicName, clinicAddress, doctor: { name, registrationNo, qualifications, pin } })
      onDone()
    })
  }

  return (
    <div className="center">
      <form
        className="card narrow"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h2>Welcome to OPD Scribe</h2>
        <p className="muted">
          First-time setup. All data stays on this computer, encrypted with a key protected by the operating system.
        </p>
        <h4>Clinic</h4>
        <Field label="Clinic / hospital name" value={clinicName} onChange={setClinicName} />
        <Field label="Address" value={clinicAddress} onChange={setClinicAddress} />
        <h4>Doctor (administrator)</h4>
        <Field label="Full name (as printed)" value={name} onChange={setName} required autoFocus />
        <Field label="Qualifications" value={qualifications} onChange={setQual} placeholder="MBBS, MD, DM (Medical Oncology)" />
        <Field label="Registration number" value={registrationNo} onChange={setReg} />
        <div className="row">
          <Field label="PIN (4–8 digits)" type="password" value={pin} onChange={setPin} required />
          <Field label="Confirm PIN" type="password" value={pin2} onChange={setPin2} required />
        </div>
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>
          Create & continue
        </button>
      </form>
    </div>
  )
}
