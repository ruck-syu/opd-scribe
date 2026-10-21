import { useEffect, useState, type ReactNode } from 'react'
import { call } from '../api'
import { ONCOLOGY_SUMMARY_FIELDS } from '../../../shared/types'
import type { EncounterSummary, OncologySummary, OncologySummaryKey, Patient, User } from '../../../shared/types'
import { ErrorBox, StatusBadge, fmtDateTime, useAction } from '../components/ui'
import { PatientForm } from './Patients'

export function PatientProfile(props: {
  patientId: string
  user: User
  back: () => void
  openVisit: (encounterId: string) => void
}): ReactNode {
  const [patient, setPatient] = useState<Patient | null>(null)
  const [summary, setSummary] = useState<OncologySummary>({})
  const [visits, setVisits] = useState<EncounterSummary[]>([])
  const [editing, setEditing] = useState(false)
  const { busy, error, run } = useAction()

  useEffect(() => {
    void run(async () => {
      setPatient(await call('patients.get', props.patientId))
      setSummary(await call('summary.get', props.patientId))
      setVisits(await call('encounters.list', props.patientId))
    })
  }, [props.patientId])

  if (!patient) return <ErrorBox error={error} />

  const newVisit = (): void =>
    void run(async () => {
      const draft = visits.find((v) => v.status === 'draft')
      if (draft && !confirm('There is already a draft visit for this patient. Start another new visit anyway?')) {
        props.openVisit(draft.id)
        return
      }
      const e = await call('encounters.create', props.patientId)
      props.openVisit(e.id)
    })

  return (
    <div className="page">
      <button className="ghost back" onClick={props.back}>
        ← Patients
      </button>
      <div className="identity-banner">
        <div>
          <div className="id-name">{patient.name}</div>
          <div className="id-meta">
            MRN <b className="mono">{patient.mrn}</b> · {patient.ageDisplay || patient.dateOfBirth || 'Age not recorded'} ·{' '}
            {patient.sex || 'Sex not recorded'} {patient.phone && `· ${patient.phone}`}
          </div>
        </div>
        <div className="spacer" />
        <button onClick={() => setEditing(true)}>Edit details</button>
        <button className="primary" disabled={busy} onClick={newVisit}>
          + New visit
        </button>
      </div>
      <ErrorBox error={error} />

      <div className="two-col">
        <section className="card">
          <h3>Visits</h3>
          <table className="list">
            <tbody>
              {visits.map((v) => (
                <tr key={v.id} className="clickable" onClick={() => props.openVisit(v.id)}>
                  <td>{fmtDateTime(v.visitDateTime)}</td>
                  <td>
                    <StatusBadge status={v.status} />
                  </td>
                  <td className="muted">{v.revisionCount > 0 ? `${v.revisionCount} verified revision(s)` : ''}</td>
                </tr>
              ))}
              {visits.length === 0 && (
                <tr>
                  <td className="muted">No visits yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Oncology summary</h3>
          <p className="muted small">Each field shows when and by whom it was last updated. Only enter what is documented.</p>
          {ONCOLOGY_SUMMARY_FIELDS.map(([key, label]) => (
            <SummaryRow
              key={key}
              label={label}
              field={summary[key]}
              onSave={(value) =>
                run(async () => setSummary(await call('summary.update', props.patientId, key as OncologySummaryKey, value)))
              }
            />
          ))}
        </section>
      </div>

      {editing && (
        <PatientForm
          title="Edit patient"
          initial={patient}
          onClose={() => setEditing(false)}
          onSave={async (input) => {
            setPatient(await call('patients.update', patient.id, input))
            setEditing(false)
          }}
        />
      )}
    </div>
  )
}

function SummaryRow(props: { label: string; field: OncologySummary[OncologySummaryKey]; onSave: (v: string) => void }): ReactNode {
  const [edit, setEdit] = useState(false)
  const [value, setValue] = useState(props.field?.value ?? '')
  useEffect(() => setValue(props.field?.value ?? ''), [props.field?.value])
  return (
    <div className="summary-row">
      <div className="summary-label">{props.label}</div>
      {edit ? (
        <div className="summary-edit">
          <textarea rows={2} value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
          <button
            className="primary"
            onClick={() => {
              props.onSave(value)
              setEdit(false)
            }}
          >
            Save
          </button>
          <button onClick={() => setEdit(false)}>Cancel</button>
        </div>
      ) : (
        <div className="summary-value" onClick={() => setEdit(true)} title="Click to edit">
          {props.field?.value ? <span className="pre">{props.field.value}</span> : <span className="nd">Not documented</span>}
          {props.field && (
            <small className="muted">
              {' '}
              — {fmtDateTime(props.field.updatedAt)}, {props.field.updatedBy}
            </small>
          )}
        </div>
      )}
    </div>
  )
}
