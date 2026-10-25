import { useEffect, useState, type ReactNode } from 'react'
import { call } from '../api'
import type { AsrCheck } from '../../../shared/api'
import { RecorderPanel } from '../components/RecorderPanel'
import { TranscriptView } from './TranscriptView'
import type { VisitCtx } from './Visit'

export function AsrStatus(): ReactNode {
  const [check, setCheck] = useState<AsrCheck | null>(null)
  useEffect(() => {
    void call('settings.checkAsr').then(setCheck)
  }, [])
  if (!check || (check.binaryOk && check.modelOk)) return null
  return <div className="notice">{check.message}. Recordings are kept so you can retry after setup.</div>
}

export function ConversationTab({ ctx }: { ctx: VisitCtx }): ReactNode {
  const convo = ctx.transcripts.filter((t) => t.kind === 'conversation')
  return (
    <div>
      <AsrStatus />
      <div className="card">
        <p className="muted small">
          Speakers are not detected automatically — label each segment (select several and use “Label as”). Nothing is
          added to the note until a suggestion is accepted or text is inserted.
        </p>
        <RecorderPanel
          encounterId={ctx.encounterId}
          patientId={ctx.patientId}
          kind="conversation"
          label="Record consultation"
          disabled={ctx.readOnly}
          requireConsent
          onSubmitted={ctx.reloadTranscripts}
        />
      </div>
      {convo.map((t) => (
        <TranscriptView key={t.id} ctx={ctx} transcript={t} defaultTarget="history.hpi" />
      ))}
    </div>
  )
}
