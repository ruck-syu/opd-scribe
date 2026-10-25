import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, type Dirent } from 'node:fs'
import { copyFile, statfs } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, join } from 'node:path'
import { once } from 'node:events'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fmtSize, type ImportReport, type ModelId, type ModelSpec, type ModelStatus } from '../shared/models'

/** The doctor paused or cancelled: not a failure, the partial file is kept for resume. */
class Cancelled extends Error {}

const DROPPED = 'internet connection dropped — press Retry; it continues where it stopped'
const DAMAGED = 'download was damaged, try again'
const RESTART = 'download was interrupted in an unexpected way — press Retry; it starts again'
const UNREACHABLE = 'could not reach the download server — check the internet connection, then press Retry'
const DEFAULT_STALL_MS = 60_000
const DEFAULT_PROGRESS_MS = 250
const REDIRECT_LIMIT = 5
/** a download needs its size plus this margin free on disk */
const SPACE_MARGIN = 1.1

export interface ModelManagerOptions {
  /** folder for the model files (userData/models) */
  dir: string
  catalog: ModelSpec[]
  /** receives the full status list: throttled while downloading, immediate on every change */
  emit?: (statuses: ModelStatus[]) => void
  /** called once a model file is verified and in place */
  onReady?: (id: ModelId) => void
  /** free bytes on the disk holding `dir` */
  freeBytes?: (dir: string) => Promise<number>
  /** no bytes for this long fails the download (resumable) */
  stallMs?: number
  /** minimum gap between progress events */
  progressMs?: number
}

interface Transfer {
  bytes: number
  verifying: boolean
  cancelled: boolean
  /** hash of every byte in the partial file, in order */
  hash: Hash
  /** stops the request or response in flight */
  abort: (err: Error) => void
  done: Promise<void>
}

/**
 * Downloads, verifies and imports the model files. Every file reaches its final name only after its
 * size and SHA-256 match the catalog, so a half-written file is never treated as installed.
 */
export class ModelManager {
  private readonly transfers = new Map<ModelId, Transfer>()
  private readonly failures = new Map<ModelId, string>()
  private lastEmit = 0

  constructor(private readonly opts: ModelManagerOptions) {}

  status(): ModelStatus[] {
    return this.opts.catalog.map((s) => this.statusOf(s))
  }

  isReady(id: ModelId): boolean {
    return this.statusOf(this.specOf(id)).state === 'ready'
  }

  /** Resolves when the running transfer for this model has finished (at once if none is running). */
  settled(id: ModelId): Promise<void> {
    return this.transfers.get(id)?.done ?? Promise.resolve()
  }

  /**
   * Starts (or resumes) a download in the background. Rejects before starting when the model is
   * already here or the disk has no room. Progress and the outcome arrive through `emit`.
   */
  async download(id: ModelId): Promise<void> {
    const spec = this.specOf(id)
    if (this.transfers.has(id) || this.isReady(id)) return
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 })

    // reserve the slot first so a second click cannot start a second transfer during the disk check
    const t: Transfer = {
      bytes: 0,
      verifying: false,
      cancelled: false,
      hash: createHash('sha256'),
      abort: () => undefined,
      done: Promise.resolve()
    }
    this.transfers.set(id, t)
    try {
      const free = await (this.opts.freeBytes ?? freeBytesOf)(this.opts.dir)
      const need = Math.ceil(Math.max(0, spec.size - fileSize(this.partPath(spec))) * SPACE_MARGIN)
      if (free < need)
        throw new Error(
          `Not enough free disk space for ${spec.label}: about ${fmtSize(need)} is needed and ${fmtSize(free)} is free. Free up some space, then press Download again.`
        )
    } catch (e) {
      this.transfers.delete(id)
      throw e
    }
    this.failures.delete(id)
    t.done = this.transfer(spec, t)
    this.notify()
  }

  /** Stops the running download and keeps its partial file, so Download continues it later. */
  async cancel(id: ModelId): Promise<void> {
    const t = this.transfers.get(id)
    if (!t) return
    t.cancelled = true
    t.abort(new Cancelled('cancelled'))
    await t.done
  }

  /**
   * Scans a folder (and one level of subfolders) for files whose size matches a model. A match is
   * hashed, and only a file with the exact SHA-256 is copied into place.
   */
  async importFrom(folder: string): Promise<ImportReport> {
    const report: ImportReport = { scanned: 0, imported: [], alreadyInstalled: [], rejected: [] }
    for (const file of listFiles(folder, 1)) {
      report.scanned++
      const name = basename(file)
      const size = fileSize(file)
      const spec = this.opts.catalog.find((s) => s.size === size)
      if (!spec) continue
      if (this.isReady(spec.id)) {
        if (!report.alreadyInstalled.includes(spec.id)) report.alreadyInstalled.push(spec.id)
        continue
      }
      if (this.transfers.has(spec.id)) {
        report.rejected.push({ file: name, reason: 'a download of this model is already running' })
        continue
      }
      if ((await sha256File(file)) !== spec.sha256) {
        report.rejected.push({ file: name, reason: 'same size as a model file, but the contents are different (the copy may be damaged)' })
        continue
      }
      const problem = await this.place(spec, file)
      if (problem) {
        report.rejected.push({ file: name, reason: problem })
        continue
      }
      report.imported.push(spec.id)
      this.ready(spec.id)
    }
    this.notify()
    return report
  }

  // ---------- internals ----------

  private specOf(id: ModelId): ModelSpec {
    return this.opts.catalog.find((s) => s.id === id) ?? throwError('Unknown model')
  }
  private filePath(spec: ModelSpec): string {
    return join(this.opts.dir, spec.file)
  }
  private partPath(spec: ModelSpec): string {
    return `${this.filePath(spec)}.part`
  }

  private statusOf(spec: ModelSpec): ModelStatus {
    const base = { id: spec.id, total: spec.size }
    const t = this.transfers.get(spec.id)
    if (t) return { ...base, state: t.verifying ? 'verifying' : 'downloading', bytes: t.bytes }
    if (fileSize(this.filePath(spec)) === spec.size) return { ...base, state: 'ready', bytes: spec.size }
    const bytes = fileSize(this.partPath(spec))
    const reason = this.failures.get(spec.id)
    return reason ? { ...base, state: 'failed', bytes, reason } : { ...base, state: 'missing', bytes }
  }

  private async transfer(spec: ModelSpec, t: Transfer): Promise<void> {
    let ok = false
    try {
      if (t.cancelled) throw new Cancelled('cancelled')
      await this.fetchInto(spec, t)
      await this.verify(spec, t)
      ok = true
    } catch (e) {
      // error text is shown to the doctor; it never contains the URL or any patient data
      if (!(e instanceof Cancelled) && !t.cancelled)
        this.failures.set(spec.id, e instanceof Error ? e.message : 'download failed, try again')
    } finally {
      this.transfers.delete(spec.id)
      this.notify()
    }
    if (ok) this.ready(spec.id)
  }

  private ready(id: ModelId): void {
    try {
      this.opts.onReady?.(id)
    } catch (e) {
      console.error('[models] onReady failed:', e instanceof Error ? e.name : 'error')
    }
  }

  /** Brings the partial file to `have` bytes (hashing what is already there), then streams the rest. */
  private async fetchInto(spec: ModelSpec, t: Transfer): Promise<void> {
    const part = this.partPath(spec)
    let have = fileSize(part)
    if (have > spec.size) {
      rmSync(part, { force: true })
      have = 0
    }
    if (have > 0) await hashFile(part, t.hash)
    if (t.cancelled) throw new Cancelled('cancelled')
    t.bytes = have
    if (have < spec.size) await this.stream(spec, t, have)
  }

  private async stream(spec: ModelSpec, t: Transfer, have: number): Promise<void> {
    const part = this.partPath(spec)
    const stallMs = this.opts.stallMs ?? DEFAULT_STALL_MS
    let stalled = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    // any stretch with no bytes (before or during the response) fails the download
    const kick = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        stalled = true
        t.abort(new Error('stalled'))
      }, stallMs)
    }
    kick()
    let out: ReturnType<typeof createWriteStream> | undefined
    try {
      let res: IncomingMessage
      try {
        res = await this.get(spec.url, have > 0 ? { Range: `bytes=${have}-` } : {}, t)
      } catch {
        if (t.cancelled) throw new Cancelled('cancelled')
        throw new Error(stalled ? DROPPED : UNREACHABLE)
      }
      if (t.cancelled) {
        res.resume()
        throw new Cancelled('cancelled')
      }

      const code = res.statusCode ?? 0
      const resume = code === 206 && have > 0
      if (!resume && code !== 200) {
        res.resume()
        if (code === 416) rmSync(part, { force: true })
        throw new Error(code === 416 ? RESTART : `download server answered with an error (${code || 'no answer'}), try again later`)
      }
      if (resume && !rangeStartsAt(res.headers['content-range'], have)) {
        res.resume()
        rmSync(part, { force: true })
        throw new Error(RESTART)
      }
      // a 200 means the server ignored Range: the file is sent whole, so start the partial file over
      if (!resume) t.hash = createHash('sha256')
      t.bytes = resume ? have : 0

      out = createWriteStream(part, { flags: resume ? 'a' : 'w' })
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          t.hash.update(chunk)
          t.bytes += chunk.length
          kick()
          this.progress()
          cb(null, chunk)
        }
      })
      try {
        await pipeline(res, counter, out)
      } catch (e) {
        if (t.cancelled) throw new Cancelled('cancelled')
        const noSpace = (e as NodeJS.ErrnoException).code === 'ENOSPC'
        throw new Error(noSpace ? 'the disk is full — free up space, then press Retry' : DROPPED)
      }
    } finally {
      clearTimeout(watchdog)
      // the file must be closed before a later resume or rename touches it
      if (out && !out.closed) await once(out, 'close').catch(() => undefined)
    }
  }

  /** GET with redirects (the model host hands off to a CDN). Only https, or the same scheme as the catalog URL. */
  private get(url: string, headers: Record<string, string>, t: Transfer): Promise<IncomingMessage> {
    const first = new URL(url)
    return new Promise((resolve, reject) => {
      const open = (target: URL, hops: number): void => {
        if (target.protocol !== 'https:' && target.protocol !== first.protocol) return reject(new Error('download address is not allowed'))
        const onResponse = (res: IncomingMessage): void => {
          const code = res.statusCode ?? 0
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume()
            if (hops >= REDIRECT_LIMIT) return reject(new Error('download server redirected too many times'))
            return open(new URL(res.headers.location, target), hops + 1)
          }
          t.abort = (err) => {
            res.destroy(err)
            req.destroy(err)
          }
          resolve(res)
        }
        const opts = { method: 'GET', headers: { ...headers, 'User-Agent': 'OPD-Scribe' } }
        const req: ClientRequest = target.protocol === 'https:' ? httpsRequest(target, opts, onResponse) : httpRequest(target, opts, onResponse)
        t.abort = (err) => req.destroy(err)
        req.on('error', reject)
        req.end()
      }
      open(first, 0)
    })
  }

  private async verify(spec: ModelSpec, t: Transfer): Promise<void> {
    const part = this.partPath(spec)
    t.verifying = true
    this.notify()
    const size = fileSize(part)
    // short: the connection ended early, so the rest can still be fetched
    if (size < spec.size) throw new Error(DROPPED)
    if (size > spec.size || t.hash.digest('hex') !== spec.sha256) {
      rmSync(part, { force: true })
      throw new Error(DAMAGED)
    }
    renameSync(part, this.filePath(spec))
  }

  /** Copies a verified file into place through the .part name. Returns a reason when it cannot. */
  private async place(spec: ModelSpec, file: string): Promise<string | null> {
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 })
    const free = await (this.opts.freeBytes ?? freeBytesOf)(this.opts.dir)
    if (free < spec.size * SPACE_MARGIN) return `not enough free disk space (${fmtSize(spec.size)} needed)`
    const part = this.partPath(spec)
    await copyFile(file, part)
    if ((await sha256File(part)) !== spec.sha256) {
      rmSync(part, { force: true })
      return 'the copy did not verify, try again'
    }
    renameSync(part, this.filePath(spec))
    this.failures.delete(spec.id)
    return null
  }

  /** Progress is throttled; state changes always go out at once. */
  private progress(): void {
    const now = Date.now()
    if (now - this.lastEmit < (this.opts.progressMs ?? DEFAULT_PROGRESS_MS)) return
    this.lastEmit = now
    this.notify()
  }

  private notify(): void {
    this.opts.emit?.(this.status())
  }
}

function throwError(message: string): never {
  throw new Error(message)
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Feeds the file through `hash`. Streams, so a 2.5 GB file never sits in memory. */
async function hashFile(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk)
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await hashFile(path, hash)
  return hash.digest('hex')
}

function rangeStartsAt(header: string | undefined, start: number): boolean {
  const m = /^bytes (\d+)-/.exec(header ?? '')
  return m !== null && Number(m[1]) === start
}

async function freeBytesOf(dir: string): Promise<number> {
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/** Regular files in `folder`, descending `depth` levels into subfolders. Symlinks are skipped. */
function listFiles(folder: string, depth: number): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const p = join(folder, e.name)
    if (e.isFile()) out.push(p)
    else if (e.isDirectory() && depth > 0) out.push(...listFiles(p, depth - 1))
  }
  return out
}
