import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LlmSettings } from '../shared/types'
import { runLlm } from './llm'

describe.skipIf(process.platform === 'win32')('runLlm CPU fallback (fake engines)', () => {
  let root = ''
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  function setup(): { work: string; model: string; script: (name: string, body: string) => string } {
    root = mkdtempSync(join(tmpdir(), 'opd-llm-'))
    const work = join(root, 'work')
    mkdirSync(work)
    const model = join(root, 'model.gguf')
    writeFileSync(model, 'not a real model')
    const script = (name: string, body: string): string => {
      const p = join(root, name)
      writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      chmodSync(p, 0o755)
      return p
    }
    return { work, model, script }
  }

  const settings = (binaryPath: string, modelPath: string): LlmSettings => ({
    enabled: true,
    binaryPath,
    modelPath,
    threads: 1,
    template: 'chatml'
  })

  it('retries once on the CPU build when the GPU build fails before printing, and keeps the choice', async () => {
    const { work, model, script } = setup()
    const gpu = script('gpu', 'echo "driver failed" >&2\nexit 1')
    const cpu = script('cpu', 'printf \'{"ok":true}\'')
    let fellBack = false

    const out = await runLlm({
      llm: settings(gpu, model),
      prompt: 'prompt text',
      schema: { type: 'object' },
      workDir: work,
      cpuBinaryPath: cpu,
      onCpuFallback: () => {
        fellBack = true
      }
    })

    expect(out).toBe('{"ok":true}')
    expect(fellBack).toBe(true)
    // the prompt and schema files are removed whichever build ran
    expect(readdirSync(work)).toEqual([])
  })

  it('does not retry when the build already printed something before failing', async () => {
    const { work, model, script } = setup()
    const gpu = script('gpu', 'printf partial\nexit 2')
    const cpu = script('cpu', 'printf \'{"ok":true}\'')
    let fellBack = false

    await expect(
      runLlm({
        llm: settings(gpu, model),
        prompt: 'p',
        schema: {},
        workDir: work,
        cpuBinaryPath: cpu,
        onCpuFallback: () => {
          fellBack = true
        }
      })
    ).rejects.toThrow('AI extraction exited with code 2')
    expect(fellBack).toBe(false)
    expect(readdirSync(work)).toEqual([])
  })

  it('reports the original failure when there is no CPU build to try', async () => {
    const { work, model, script } = setup()
    const gpu = script('gpu', 'exit 3')

    await expect(runLlm({ llm: settings(gpu, model), prompt: 'p', schema: {}, workDir: work })).rejects.toThrow(
      'AI extraction exited with code 3'
    )
    expect(readdirSync(work)).toEqual([])
  })
})
