import type { ReactNode } from 'react'
import { getSection, sectionLabel, setSection, type SectionKey } from '../../../shared/sections'
import type { DictationSection, SourceKind } from '../../../shared/types'
import { RecorderPanel } from '../components/RecorderPanel'
import { AsrStatus } from './ConversationTab'
import { TranscriptView } from './TranscriptView'
import type { VisitCtx } from './Visit'

const HISTORY: SectionKey[] = ['history.chiefComplaints', 'history.hpi', 'history.pastHistory', 'history.medicationHistory']
const DOCTOR: DictationSection[] = ['examination', 'assessment', 'plan']

const SOURCE_LABEL: Record<SourceKind, string> = {
  conversation: 'conversation',
  dictation: 'dictation',
  manual: 'typed',
  prior_record: 'prior record'
}

export function SectionEditor({ ctx, k, rows = 3 }: { ctx: VisitCtx; k: SectionKey; rows?: number }): ReactNode {
  const s = getSection(ctx.doc, k)
  const kinds = [...new Set(s.sources.map((x) => x.kind))]
  return (
    <label className="field section-editor">
      <span>
        {sectionLabel(k)}
        {kinds.map((kind) => (
          <i key={kind} className={`chip chip-${kind}`}>
            {SOURCE_LABEL[kind]}
          </i>
        ))}
      </span>
      <textarea
        rows={rows}
        value={s.text}
        readOnly={ctx.readOnly}
        placeholder="Not documented"
        onChange={(e) => {
          const text = e.target.value
          ctx.update((d) => {
            const cur = getSection(d, k)
            const sources = cur.sources.some((x) => x.kind === 'manual')
              ? cur.sources
              : [...cur.sources, { kind: 'manual' as const, at: new Date().toISOString() }]
            return setSection(d, k, { text, sources: text.trim() ? sources : [] })
          })
        }}
      />
    </label>
  )
}

export function NoteTab({ ctx }: { ctx: VisitCtx }): ReactNode {
  return (
    <div>
      <AsrStatus />
      <div className="card">
        <h3>Patient-reported history</h3>
        {HISTORY.map((k) => (
          <SectionEditor key={k} ctx={ctx} k={k} />
        ))}
      </div>
      {DOCTOR.map((section) => (
        <div className="card" key={section}>
          <h3>{sectionLabel(section)} (doctor)</h3>
          <p className="muted small">Dictate or type. Dictation is inserted word-for-word after you review it — never rephrased.</p>
          <RecorderPanel
            encounterId={ctx.encounterId}
            patientId={ctx.patientId}
            kind="dictation"
            section={section}
            label={`Dictate ${sectionLabel(section).toLowerCase()}`}
            disabled={ctx.readOnly}
            onSubmitted={ctx.reloadTranscripts}
          />
          {ctx.transcripts
            .filter((t) => t.kind === 'dictation' && t.section === section)
            .map((t) => (
              <TranscriptView key={t.id} ctx={ctx} transcript={t} defaultTarget={section} />
            ))}
          <SectionEditor ctx={ctx} k={section} rows={5} />
        </div>
      ))}
    </div>
  )
}
