import type { ReactNode } from 'react'
import { uid } from '../../../shared/defaults'
import type { Medication } from '../../../shared/types'
import { SectionEditor } from './NoteTab'
import type { VisitCtx } from './Visit'

const COLS: [keyof Medication, string, boolean][] = [
  ['name', 'Medicine', true],
  ['formulationStrength', 'Form / strength', false],
  ['dose', 'Dose', true],
  ['route', 'Route', true],
  ['frequency', 'Frequency', true],
  ['duration', 'Duration', true],
  ['quantity', 'Qty', false],
  ['instructions', 'Instructions', false]
]

const blankMed = (): Medication => ({
  id: uid(),
  name: '',
  formulationStrength: '',
  dose: '',
  route: '',
  frequency: '',
  duration: '',
  quantity: '',
  instructions: '',
  sourceText: ''
})

export function RxTab({ ctx }: { ctx: VisitCtx }): ReactNode {
  const meds = ctx.doc.prescription.medications
  const setMeds = (medications: Medication[]): void =>
    ctx.update((d) => ({ ...d, prescription: { ...d.prescription, medications } }))
  const set = (id: string, k: keyof Medication, v: string): void => setMeds(meds.map((m) => (m.id === id ? { ...m, [k]: v } : m)))

  return (
    <div>
      <div className="card">
        <h3>Medicines</h3>
        <p className="muted small">
          Enter exactly as prescribed. The app never suggests or calculates doses; empty required fields block verification and print
          as “[not specified]”.
        </p>
        <table className="rx">
          <thead>
            <tr>
              <th>#</th>
              {COLS.map(([k, l, req]) => (
                <th key={k}>
                  {l}
                  {req && <b className="req">*</b>}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {meds.map((m, i) => (
              <tr key={m.id}>
                <td>{i + 1}</td>
                {COLS.map(([k, , req]) => (
                  <td key={k}>
                    <input
                      className={req && !m[k].trim() ? 'missing' : ''}
                      value={m[k]}
                      readOnly={ctx.readOnly}
                      onChange={(e) => set(m.id, k, e.target.value)}
                    />
                  </td>
                ))}
                <td>
                  {!ctx.readOnly && (
                    <button className="ghost small" onClick={() => setMeds(meds.filter((x) => x.id !== m.id))} title="Remove">
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!ctx.readOnly && (
          <button className="small" onClick={() => setMeds([...meds, blankMed()])}>
            + Add medicine
          </button>
        )}
      </div>
      <div className="card">
        <SectionEditor ctx={ctx} k="prescription.investigationsAdvised" />
        <SectionEditor ctx={ctx} k="prescription.advice" />
        <SectionEditor ctx={ctx} k="prescription.returnPrecautions" />
        <SectionEditor ctx={ctx} k="prescription.followUp" rows={2} />
      </div>
    </div>
  )
}
