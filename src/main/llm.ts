import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { uid } from '../shared/defaults'
import type { LlmSettings } from '../shared/types'
import { threadCount } from './threads'

/** Fill empty LLM paths from the folders in `dirs`, searched in order (bundled engine, downloaded models, legacy folders). */
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
  /** CPU-only build, tried once when `llm.binaryPath` fails before printing anything */
  cpuBinaryPath?: string
  /** called only after the CPU build succeeded, so the choice can be kept for the session */
  onCpuFallback?: () => void
}

type Attempt = { ok: true; out: string } | { ok: false; error: Error; beforeOutput: boolean }

/**
 * Run llama-completion once with a JSON grammar and return its stdout. The prompt and schema files
 * are written to workDir and always removed. Errors carry no stderr text: the prompt may echo PHI.
 */
export async function runLlm({ llm, prompt, schema, workDir, timeoutMs = 300_000, cpuBinaryPath, onCpuFallback }: LlmRunOptions): Promise<string> {
  const check = checkLlm(llm)
  if (!check.binaryOk || !check.modelOk) throw new Error(check.message)

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
    throw e instanceof Error ? e : new Error(String(e))
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
    String(threadCount(llm.threads)),
    '--no-display-prompt',
    '--simple-io'
  ]

  try {
    const first = await attempt(llm.binaryPath, args, timeoutMs)
    if (first.ok) return first.out
    // a GPU build that dies before printing anything (driver trouble) gets one retry on the CPU build
    if (!cpuBinaryPath || !first.beforeOutput || cpuBinaryPath === llm.binaryPath) throw first.error
    const second = await attempt(cpuBinaryPath, args, timeoutMs)
    if (!second.ok) throw second.error
    onCpuFallback?.()
    return second.out
  } finally {
    cleanup()
  }
}

function attempt(binary: string, args: string[], timeoutMs: number): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: Attempt): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    let child: ChildProcess
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      finish({ ok: false, error: new Error('Could not start AI extraction'), beforeOutput: true })
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
      finish({ ok: false, error: new Error('AI extraction timed out'), beforeOutput: false })
    }, timeoutMs)
    child.on('error', (e) =>
      finish({ ok: false, error: new Error(`Could not start AI extraction: ${e.message}`), beforeOutput: true })
    )
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, out })
      else finish({ ok: false, error: new Error(`AI extraction exited with code ${code}`), beforeOutput: out.length === 0 })
    })
  })
}
