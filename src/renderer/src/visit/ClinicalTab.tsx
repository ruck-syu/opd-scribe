import { useState, type ReactNode } from 'react'
import { uid } from '../../../shared/defaults'
import type { ClearanceDecision, Finding, VisitDocument, Vitals } from '../../../shared/types'
import { Area, Field, Select, TriState } from '../components/ui'
import { SectionEditor } from './NoteTab'
import type { VisitCtx } from './Visit'

const VITALS: [keyof Vitals, string, string][] = [
  ['bp', 'BP', 'mmHg'],
  ['pulse', 'Pulse', '/min'],
  ['temperature', 'Temp', '°F / °C'],
  ['spo2', 'SpO₂', '%'],
  ['respiratoryRate', 'RR', '/min'],
  ['weight', 'Weight', 'kg'],
  ['height', 'Height', 'cm']
]

function FindingsEditor(props: {
  title: string
  findings: Finding[]
  readOnly: boolean
  onChange: (f: Finding[]) => void
}): ReactNode {
  const [newName, setNewName] = useState('')
  const set = (id: string, patch: Partial<Finding>): void =>
    props.onChange(props.findings.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  return (
    <div>
      <h4>{props.title}</h4>
      <table className="findings">
        <tbody>
          {props.findings.map((f) => (
            <tr key={f.id} className={`state-${f.state}`}>
              <td className="f-name">{f.name}</td>
              <td>
                <TriState value={f.state} onChange={props.readOnly ? undefined : (state) => set(f.id, { state })} />
              </td>
              <td>
                <input
                  className="small-input"
                  placeholder="Grade"
                  value={f.grade}
                  readOnly={props.readOnly}
                  onChange={(e) => set(f.id, { grade: e.target.value })}
                />
              </td>
              <td>
                <input
                  placeholder="Note"
                  value={f.note}
                  readOnly={props.readOnly}
                  onChange={(e) => set(f.id, { note: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!props.readOnly && (
        <div className="row tight">
          <input placeholder="Add item…" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button
            className="small"
            disabled={!newName.trim()}
            onClick={() => {
              props.onChange([...props.findings, { id: uid(), name: newName.trim(), state: 'not_assessed', grade: '', note: '' }])
              setNewName('')
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  )
}

export function ClinicalTab({ ctx }: { ctx: VisitCtx }): ReactNode {
  const { doc, readOnly } = ctx
  const o = doc.oncology
  const setOnc = (patch: Partial<VisitDocument['oncology']>): void => ctx.update((d) => ({ ...d, oncology: { ...d.oncology, ...patch } }))
  const ro = readOnly ? undefined : true

  return (
    <div>
      <div className="card">
        <h3>Vitals</h3>
        <p className="muted small">Entered as measured. Nothing is calculated (no BMI / BSA / doses).</p>
        <div className="row wrap">
          {VITALS.map(([k, label, unit]) => (
            <Field
              key={k}
              label={`${label} (${unit})`}
              width={140}
              value={doc.vitals[k]}
              onChange={ro && ((v) => ctx.update((d) => ({ ...d, vitals: { ...d.vitals, [k]: v } })))}
            />
          ))}
        </div>
        <Field label="Other" value={doc.vitals.other} onChange={ro && ((v) => ctx.update((d) => ({ ...d, vitals: { ...d.vitals, other: v } })))} />
      </div>

      <div className="card">
        <h3>Oncology</h3>
        <div className="row wrap">
          <Select
            label="ECOG performance status"
            width={220}
            value={o.ecog === null ? '' : String(o.ecog)}
            onChange={ro && ((v) => setOnc({ ecog: v === '' ? null : Number(v) }))}
            options={[
              ['', 'Not recorded'],
              ['0', '0 — Fully active'],
              ['1', '1 — Restricted strenuous activity'],
              ['2', '2 — Ambulatory, self-care'],
              ['3', '3 — Limited self-care'],
              ['4', '4 — Completely disabled']
            ]}
          />
          <Field label="Regimen" value={o.regimen} onChange={ro && ((v) => setOnc({ regimen: v }))} />
          <Field label="Cycle #" width={90} value={o.cycleNumber} onChange={ro && ((v) => setOnc({ cycleNumber: v }))} />
          <Field label="Day" width={90} value={o.cycleDay} onChange={ro && ((v) => setOnc({ cycleDay: v }))} />
          <Field label="Last treatment date" type="date" width={170} value={o.lastTreatmentDate} onChange={ro && ((v) => setOnc({ lastTreatmentDate: v }))} />
        </div>
        <Field label="Next planned treatment" value={o.nextPlannedTreatment} onChange={ro && ((v) => setOnc({ nextPlannedTreatment: v }))} />
        <div className="row wrap">
          <Select<ClearanceDecision>
            label="Treatment clearance"
            width={220}
            value={o.clearance.decision}
            onChange={ro && ((decision) => setOnc({ clearance: { ...o.clearance, decision } }))}
            options={[
              ['not_documented', 'Not documented'],
              ['yes', 'Cleared for treatment'],
              ['no', 'Not cleared'],
              ['defer', 'Deferred']
            ]}
          />
          <div style={{ flex: 1 }}>
            <Area
              label={`Reason${o.clearance.decision === 'no' || o.clearance.decision === 'defer' ? ' (required)' : ''}`}
              rows={2}
              value={o.clearance.reason}
              onChange={ro && ((reason) => setOnc({ clearance: { ...o.clearance, reason } }))}
            />
          </div>
        </div>
        <FindingsEditor
          title="Toxicity review"
          findings={o.toxicities}
          readOnly={readOnly}
          onChange={(toxicities) => setOnc({ toxicities })}
        />
        <SectionEditor ctx={ctx} k="oncology.investigationsReviewed" />
      </div>

      <div className="card">
        <h3>Symptoms & allergies</h3>
        <FindingsEditor
          title="Symptoms"
          findings={doc.history.symptoms}
          readOnly={readOnly}
          onChange={(symptoms) => ctx.update((d) => ({ ...d, history: { ...d.history, symptoms } }))}
        />
        <h4>Allergies reviewed</h4>
        <TriState
          value={doc.history.allergiesReviewed}
          labels={['Not documented', 'Yes', 'No']}
          onChange={ro && ((allergiesReviewed) => ctx.update((d) => ({ ...d, history: { ...d.history, allergiesReviewed } })))}
        />
      </div>
    </div>
  )
}
