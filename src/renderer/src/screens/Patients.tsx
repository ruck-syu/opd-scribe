import { useEffect, useState, type ReactNode } from 'react'
import { call } from '../api'
import type { CsvPreview } from '../../../shared/api'
import type { Patient, PatientInput } from '../../../shared/types'
import { ErrorBox, Field, Modal, Select, useAction } from '../components/ui'

export const emptyPatient = (): PatientInput => ({
  mrn: '',
  name: '',
  dateOfBirth: null,
  ageDisplay: '',
  sex: '',
  phone: '',
  address: ''
})

export function Patients({ open }: { open: (id: string) => void }): ReactNode {
  const [q, setQ] = useState('')
  const [list, setList] = useState<Patient[]>([])
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState<CsvPreview | null>(null)
  const { error, run } = useAction()

  const search = (query: string): void => void run(async () => setList(await call('patients.search', query)))
  useEffect(() => {
    const t = setTimeout(() => search(q), 150)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="page">
      <div className="page-head">
        <h2>Patients</h2>
        <div className="spacer" />
        <button onClick={() => run(async () => setImporting(await call('patients.importPreview')))}>Import CSV…</button>
        <button className="primary" onClick={() => setCreating(true)}>
          + New patient
        </button>
      </div>
      <input className="search" autoFocus placeholder="Search by MRN, name or phone…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ErrorBox error={error} />
      <table className="list">
        <thead>
          <tr>
            <th>MRN</th>
            <th>Name</th>
            <th>Age / DOB</th>
            <th>Sex</th>
            <th>Phone</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id} onClick={() => open(p.id)} className="clickable">
              <td className="mono">{p.mrn}</td>
              <td>{p.name}</td>
              <td>{p.ageDisplay || p.dateOfBirth || '—'}</td>
              <td>{p.sex || '—'}</td>
              <td>{p.phone || '—'}</td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No patients found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {creating && (
        <PatientForm
          title="New patient"
          initial={emptyPatient()}
          onClose={() => setCreating(false)}
          onSave={async (input) => {
            const p = await call('patients.create', input)
            setCreating(false)
            open(p.id)
          }}
        />
      )}
      {importing && (
        <CsvImport
          preview={importing}
          onClose={() => setImporting(null)}
          onDone={() => {
            setImporting(null)
            search(q)
          }}
        />
      )}
    </div>
  )
}

export function PatientForm(props: {
  title: string
  initial: PatientInput
  onClose: () => void
  onSave: (p: PatientInput) => Promise<void>
}): ReactNode {
  const [p, setP] = useState(props.initial)
  const { busy, error, run } = useAction()
  const set = <K extends keyof PatientInput>(k: K, v: PatientInput[K]): void => setP((x) => ({ ...x, [k]: v }))
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => props.onSave(p))
        }}
      >
        <div className="row">
          <Field label="MRN / UHID" value={p.mrn} onChange={(v) => set('mrn', v)} required autoFocus />
          <Field label="Full name" value={p.name} onChange={(v) => set('name', v)} required />
        </div>
        <div className="row">
          <Field label="Date of birth" type="date" value={p.dateOfBirth ?? ''} onChange={(v) => set('dateOfBirth', v || null)} />
          <Field label="Age (if DOB unknown)" value={p.ageDisplay} onChange={(v) => set('ageDisplay', v)} placeholder="e.g. 54 y" />
          <Select
            label="Sex"
            value={p.sex}
            onChange={(v) => set('sex', v)}
            options={[
              ['', 'Not recorded'],
              ['female', 'Female'],
              ['male', 'Male'],
              ['other', 'Other']
            ]}
          />
        </div>
        <div className="row">
          <Field label="Phone" value={p.phone} onChange={(v) => set('phone', v)} />
          <Field label="Address" value={p.address} onChange={(v) => set('address', v)} />
        </div>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}

function CsvImport(props: { preview: CsvPreview; onClose: () => void; onDone: () => void }): ReactNode {
  const { preview } = props
  const existing = new Set(preview.existingMrns)
  const fresh = preview.rows.filter((r) => !existing.has(r.mrn))
  const { busy, error, run } = useAction()
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null)

  return (
    <Modal title={`Import ${preview.fileName}`} onClose={props.onClose} wide>
      {result ? (
        <>
          <p>
            Imported <b>{result.imported}</b> patients, skipped {result.skipped}.
          </p>
          <div className="actions">
            <button className="primary" onClick={props.onDone}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            <b>{fresh.length}</b> new patients will be imported. {existing.size > 0 && `${existing.size} already exist (MRN match) and will be skipped. `}
            {preview.errors.length > 0 && `${preview.errors.length} problem(s) found.`}
          </p>
          {preview.unmappedColumns.length > 0 && <p className="muted">Ignored columns: {preview.unmappedColumns.join(', ')}</p>}
          {preview.errors.length > 0 && (
            <ul className="errors-list">
              {preview.errors.slice(0, 50).map((e, i) => (
                <li key={i}>
                  Line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          )}
          <div className="scroll-box">
            <table className="list compact">
              <thead>
                <tr>
                  <th>MRN</th>
                  <th>Name</th>
                  <th>DOB</th>
                  <th>Age</th>
                  <th>Sex</th>
                  <th>Phone</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 200).map((r, i) => (
                  <tr key={i} className={existing.has(r.mrn) ? 'dim' : ''}>
                    <td className="mono">{r.mrn}</td>
                    <td>{r.name}</td>
                    <td>{r.dateOfBirth ?? ''}</td>
                    <td>{r.ageDisplay}</td>
                    <td>{r.sex}</td>
                    <td>{r.phone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorBox error={error} />
          <div className="actions">
            <button onClick={props.onClose}>Cancel</button>
            <button
              className="primary"
              disabled={busy || fresh.length === 0}
              onClick={() => run(async () => setResult(await call('patients.importCommit', fresh)))}
            >
              Import {fresh.length} patients
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
