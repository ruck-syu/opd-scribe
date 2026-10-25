import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { uid } from '../shared/defaults'
import type { LlmSettings } from '../shared/types'

/** Fill empty LLM paths from well-known folders (bundled resources/llm, userData/llm). */
export function resolveLlm(llm: LlmSettings, dirs: string[]): LlmSettings {
  const files = (d: string): string[] => {
    try {
      return readdirSync(d).map((f) => join(d, f))
    } catch {
      return []
    }
  }
  const all = dirs.flatMap(files)
  const exe = process.platform === 'win32' ? 'llama-completion.exe' : 'llama-completion'
  return {
    ...llm,
    binaryPath: llm.binaryPath || (all.find((f) => f.endsWith(`${sep}${exe}`)) ?? ''),
    modelPath: llm.modelPath || (all.find((f) => /\.gguf$/i.test(f)) ?? '')
  }
}

export function checkLlm(llm: LlmSettings): { binaryOk: boolean; modelOk: boolean; message: string } {
  const binaryOk = !!llm.binaryPath && existsSync(llm.binaryPath)
  const modelOk = !!llm.modelPath && existsSync(llm.modelPath)
  const message = !binaryOk
    ? 'llama-completion not found — set it in Settings › AI extraction'
    : !modelOk
      ? 'Model file (.gguf) not found — set it in Settings › AI extraction'
      : `AI extraction ready — model ${basename(llm.modelPath)}`
  return { binaryOk, modelOk, message }
}

export interface LlmRunOptions {
  llm: LlmSettings
  prompt: string
  schema: Record<string, unknown>
  workDir: string
  timeoutMs?: number
}

/**
 * Run llama-completion once with a JSON grammar and return its stdout. The prompt and schema files
 * are written to workDir and always removed. Errors carry no stderr text: the prompt may echo PHI.
 */
export function runLlm({ llm, prompt, schema, workDir, timeoutMs = 300_000 }: LlmRunOptions): Promise<string> {
  const check = checkLlm(llm)
  if (!check.binaryOk || !check.modelOk) return Promise.reject(new Error(check.message))

  const base = join(workDir, `llm-${uid()}`)
  const promptPath = `${base}.prompt.txt`
  const schemaPath = `${base}.schema.json`
  const cleanup = (): void => {
    rmSync(promptPath, { force: true })
    rmSync(schemaPath, { force: true })
  }
  try {
    writeFileSync(promptPath, prompt, { mode: 0o600 })
    writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 })
  } catch (e) {
    cleanup()
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }

  const args = [
    '-m',
    llm.modelPath,
    '-f',
    promptPath,
    '-jf',
    schemaPath,
    '-no-cnv',
    '--temp',
    '0',
    '-s',
    '42',
    '-n',
    '2048',
    '-c',
    '8192',
    '-t',
    String(llm.threads || 4),
    '--no-display-prompt',
    '--simple-io'
  ]

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (err: Error | null, out = ''): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      cleanup()
      if (err) reject(err)
      else resolve(out)
    }

    let child: ChildProcess
    try {
      child = spawn(llm.binaryPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      finish(new Error('Could not start AI extraction'))
      return
    }
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    // drained so the process never blocks on a full pipe; its text is not kept
    child.stderr?.resume()
    timer = setTimeout(() => {
      child.kill()
      finish(new Error('AI extraction timed out'))
    }, timeoutMs)
    child.on('error', (e) => finish(new Error(`Could not start AI extraction: ${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(`AI extraction exited with code ${code}`))
      else finish(null, out)
    })
  })
}
