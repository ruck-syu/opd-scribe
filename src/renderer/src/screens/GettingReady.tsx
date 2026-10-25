import { useEffect, useState, type ReactNode } from 'react'
import { call } from '../api'
import type { AsrCheck, LlmCheck } from '../../../shared/api'
import type { ModelId } from '../../../shared/models'
import { ErrorBox, useAction } from '../components/ui'
import { ModelsPanel, stateOf, useModels } from '../components/ModelsPanel'

/** Shown after first-time setup, and at sign-in whenever the speech files are missing. */
export function GettingReady({ onDone }: { onDone: () => void }): ReactNode {
  const models = useModels()
  const [aiHelper, setAiHelperState] = useState(true)
  const [check, setCheck] = useState<{ speech: AsrCheck; ai: LlmCheck | null } | null>(null)
  const { busy, error, run } = useAction()

  const speechReady = stateOf(models, 'speech') === 'ready'
  const aiReady = stateOf(models, 'ai') === 'ready'
  const working = models.some((m) => m.state === 'downloading' || m.state === 'verifying')
  const toGet: ModelId[] = []
  if (!speechReady) toGet.push('speech')
  if (aiHelper && !aiReady) toGet.push('ai')

  // the choice is sent only on an explicit action (tick or Download), so opening this screen never switches the helper on
  const setAiHelper = (on: boolean): void => {
    setAiHelperState(on)
    void call('models.setAiHelper', on).catch(() => undefined)
  }

  // the check step runs once the required files are in place
  useEffect(() => {
    if (!speechReady) {
      setCheck(null)
      return
    }
    void run(async () => {
      const speech = await call('settings.checkAsr')
      const ai = aiHelper && aiReady ? await call('settings.checkLlm') : null
      setCheck({ speech, ai })
    })
  }, [speechReady, aiReady, aiHelper])

  const speechOk = speechReady && !!check && check.speech.binaryOk && check.speech.modelOk
  const aiOk = !!check?.ai && check.ai.binaryOk && check.ai.modelOk

  return (
    <div className="center">
      <div className="card narrow getting-ready">
        <h2>Getting ready</h2>
        <p>OPD Scribe needs a few files before it can listen to consultations and help with notes.</p>
        <p className="muted small">This happens once. After this, OPD Scribe works without internet. No patient information is sent.</p>

        {toGet.length > 0 && (
          <button
            className="primary big-download"
            disabled={busy || working}
            onClick={() =>
              void run(async () => {
                // staff cannot change the AI helper; their downloads still go ahead
                await call('models.setAiHelper', aiHelper).catch(() => undefined)
                for (const id of toGet) await call('models.download', id)
              })
            }
          >
            {working ? 'Downloading…' : 'Download'}
          </button>
        )}

        <ModelsPanel models={models} aiTick={{ checked: aiHelper, onChange: setAiHelper }} />

        <ErrorBox error={error} />
        {speechReady && check && (
          <div className={`notice ${speechOk ? 'ok' : ''}`}>
            {speechOk
              ? 'Speech recognition is ready.'
              : 'Speech recognition is downloaded but would not start on this computer. You can keep working and ask for help.'}
          </div>
        )}
        {aiHelper && aiReady && check && (
          <div className={`notice ${aiOk ? 'ok' : ''}`}>
            {aiOk ? 'The AI helper is ready.' : 'The AI helper is downloaded but would not start. Notes still work without it.'}
          </div>
        )}
        {aiHelper && !aiReady && <p className="muted small">The AI helper switches on when its download finishes.</p>}
        {!aiHelper && <p className="muted small">The AI helper is off. You can turn it on later in Settings.</p>}

        <div className="actions">
          <button className={speechOk ? 'primary' : 'ghost'} onClick={onDone}>
            {speechOk ? 'Continue' : 'Later'}
          </button>
        </div>
      </div>
    </div>
  )
}
