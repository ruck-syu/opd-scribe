import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelSpec, ModelStatus } from '../shared/models'
import { ModelManager, type ModelManagerOptions } from './models'

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

interface Fake {
  base: string
  /** the Range header of every request, '' when none */
  requests: string[]
  close(): Promise<void>
}

/** Local server standing in for the model host. Only ever listens on 127.0.0.1. */
async function serve(opts: { data: Buffer; ignoreRange?: boolean; hangAfter?: number }): Promise<Fake> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.headers.range ?? '')
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file.bin' })
      res.end()
      return
    }
    if (req.url !== '/file.bin') {
      res.writeHead(404)
      res.end()
      return
    }
    const { data } = opts
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    if (range && !opts.ignoreRange) {
      const start = Number(range[1])
      if (start >= data.length) {
        res.writeHead(416)
        res.end()
        return
      }
      res.writeHead(206, { 'content-range': `bytes ${start}-${data.length - 1}/${data.length}`, 'content-length': String(data.length - start) })
      res.end(data.subarray(start))
      return
    }
    res.writeHead(200, { 'content-length': String(data.length) })
    if (opts.hangAfter !== undefined) {
      // send part of the file, then go silent without ending the response
      res.write(data.subarray(0, opts.hangAfter))
      return
    }
    res.end(data)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      })
  }
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** Fresh folder per test: the model files live in `dir`, the fake USB stick in `usb`. */
function sandbox(): { root: string; dir: string; usb: string } {
  const root = mkdtempSync(join(tmpdir(), 'opd-models-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return { root, dir: join(root, 'models'), usb: join(root, 'usb') }
}

function specFor(data: Buffer, base: string, extra: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id: 'speech',
    label: 'Speech recognition',
    file: 'speech.bin',
    url: `${base}/file.bin`,
    size: data.length,
    sha256: sha(data),
    required: true,
    ...extra
  }
}

async function serveAndTrack(opts: Parameters<typeof serve>[0]): Promise<Fake> {
  const f = await serve(opts)
  cleanups.push(() => f.close())
  return f
}

function manager(dir: string, catalog: ModelSpec[], extra: Partial<ModelManagerOptions> = {}) {
  const events: ModelStatus[][] = []
  const ready: string[] = []
  const m = new ModelManager({
    dir,
    catalog,
    emit: (s) => events.push(s),
    onReady: (id) => ready.push(id),
    freeBytes: async () => 10 ** 12,
    stallMs: 2000,
    progressMs: 0,
    ...extra
  })
  return { m, events, ready }
}

/** Polls until `cond` holds; the transfers run asynchronously. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condition not reached')
}

describe('ModelManager.download', () => {
  it('follows a redirect, verifies the file and moves it into place', async () => {
    const data = randomBytes(300_000)
    const srv = await serveAndTrack({ data })
    const { dir } = sandbox()
    const { m, events, ready } = manager(dir, [specFor(data, srv.base, { url: `${srv.base}/redirect` })])

    await m.download('speech')
    await m.settled('speech')

    expect(readFileSync(join(dir, 'speech.bin')).equals(data)).toBe(true)
    expect(existsSync(join(dir, 'speech.bin.part'))).toBe(false)
    expect(m.status()).toEqual([{ id: 'speech', state: 'ready', total: data.length, bytes: data.length }])
    expect(ready).toEqual(['speech'])
    expect(events.some((s) => s[0].state === 'downloading')).toBe(true)
    expect(events.at(-1)?.[0].state).toBe('ready')
  })

  it('throttles progress events while the file streams', async () => {
    const data = randomBytes(300_000)
    const srv = await serveAndTrack({ data })
    const { dir } = sandbox()
    const { m, events } = manager(dir, [specFor(data, srv.base)], { progressMs: 60_000 })

    await m.download('speech')
    await m.settled('speech')

    // one event when the download starts, at most one progress event in the window, then the final states
    const downloading = events.filter((s) => s[0].state === 'downloading')
    expect(downloading.length).toBeLessThanOrEqual(2)
    expect(m.status()[0].state).toBe('ready')
  })

  it('resumes a partial file with a Range request', async () => {
    const data = randomBytes(200_000)
    const srv = await serveAndTrack({ data })
    const { dir } = sandbox()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'speech.bin.part'), data.subarray(0, 80_000))
    const { m } = manager(dir, [specFor(data, srv.base)])

    expect(m.status()[0]).toMatchObject({ state: 'missing', bytes: 80_000 })
    await m.download('speech')
    await m.settled('speech')

    expect(srv.requests).toEqual(['bytes=80000-'])
    expect(readFileSync(join(dir, 'speech.bin')).equals(data)).toBe(true)
  })

  it('starts the file over when the server ignores Range and sends it whole', async () => {
    const data = randomBytes(200_000)
    const srv = await serveAndTrack({ data, ignoreRange: true })
    const { dir } = sandbox()
    mkdirSync(dir, { recursive: true })
    // a wrong prefix: if the 200 were appended to it, the result would not verify
    writeFileSync(join(dir, 'speech.bin.part'), randomBytes(80_000))
    const { m } = manager(dir, [specFor(data, srv.base)])

    await m.download('speech')
    await m.settled('speech')

    expect(srv.requests).toEqual(['bytes=80000-'])
    expect(m.status()[0].state).toBe('ready')
    expect(readFileSync(join(dir, 'speech.bin')).equals(data)).toBe(true)
  })

  it('deletes a download whose checksum does not match and asks for a new try', async () => {
    const data = randomBytes(50_000)
    const srv = await serveAndTrack({ data })
    const { dir } = sandbox()
    const { m, ready } = manager(dir, [specFor(data, srv.base, { sha256: '0'.repeat(64) })])

    await m.download('speech')
    await m.settled('speech')

    const status = m.status()[0]
    expect(status).toMatchObject({ state: 'failed', bytes: 0 })
    expect(status.state === 'failed' && status.reason).toBe('download was damaged, try again')
    expect(existsSync(join(dir, 'speech.bin.part'))).toBe(false)
    expect(existsSync(join(dir, 'speech.bin'))).toBe(false)
    expect(ready).toEqual([])
  })

  it('fails a stalled download with a resumable message and keeps what arrived', async () => {
    const data = randomBytes(200_000)
    const srv = await serveAndTrack({ data, hangAfter: 50_000 })
    const { dir } = sandbox()
    const { m } = manager(dir, [specFor(data, srv.base)], { stallMs: 300 })

    await m.download('speech')
    await m.settled('speech')

    const status = m.status()[0]
    expect(status).toMatchObject({ state: 'failed', bytes: 50_000 })
    expect(status.state === 'failed' && status.reason).toBe('internet connection dropped — press Retry; it continues where it stopped')
    expect(readFileSync(join(dir, 'speech.bin.part')).length).toBe(50_000)
  })

  it('refuses before any request when the disk has no room', async () => {
    const data = randomBytes(50_000)
    const srv = await serveAndTrack({ data })
    const { dir } = sandbox()
    const { m } = manager(dir, [specFor(data, srv.base)], { freeBytes: async () => 1000 })

    await expect(m.download('speech')).rejects.toThrow(/Not enough free disk space for Speech recognition/)
    expect(srv.requests).toHaveLength(0)
    expect(m.status()[0].state).toBe('missing')
  })

  it('pauses on cancel and keeps the partial file for the next Download', async () => {
    const data = randomBytes(200_000)
    const srv = await serveAndTrack({ data, hangAfter: 60_000 })
    const { dir } = sandbox()
    const { m } = manager(dir, [specFor(data, srv.base)], { stallMs: 60_000 })

    await m.download('speech')
    await until(() => m.status()[0].bytes > 0)
    await m.cancel('speech')

    const status = m.status()[0]
    expect(status.state).toBe('missing')
    expect(status.bytes).toBeGreaterThan(0)
    expect(readFileSync(join(dir, 'speech.bin.part')).length).toBe(status.bytes)
  })

  it('runs one download per model at a time', async () => {
    const data = randomBytes(200_000)
    const srv = await serveAndTrack({ data, hangAfter: 1000 })
    const { dir } = sandbox()
    const { m } = manager(dir, [specFor(data, srv.base)], { stallMs: 60_000 })

    await m.download('speech')
    await m.download('speech')
    await until(() => srv.requests.length > 0)
    expect(srv.requests).toHaveLength(1)
    await m.cancel('speech')
  })
})

describe('ModelManager.importFrom', () => {
  it('copies only files whose contents match, and reports the rest', async () => {
    const speech = randomBytes(300_000)
    const ai = randomBytes(40_000)
    const { dir, usb } = sandbox()
    const catalog: ModelSpec[] = [
      specFor(speech, 'https://example.invalid'),
      { id: 'ai', label: 'AI helper', file: 'ai.gguf', url: 'https://example.invalid/ai', size: ai.length, sha256: sha(ai), required: false }
    ]
    mkdirSync(join(usb, 'models'), { recursive: true })
    writeFileSync(join(usb, 'ggml-model.bin'), speech)
    writeFileSync(join(usb, 'copy-of-ai.gguf'), randomBytes(40_000)) // same size as the AI model, different bytes
    writeFileSync(join(usb, 'notes.txt'), 'not a model')
    writeFileSync(join(usb, 'models', 'qwen.gguf'), ai)

    const { m, ready } = manager(dir, catalog)
    const report = await m.importFrom(usb)

    expect(report.scanned).toBe(4)
    expect([...report.imported].sort()).toEqual(['ai', 'speech'])
    expect(report.alreadyInstalled).toEqual([])
    expect(report.rejected).toEqual([
      expect.objectContaining({ file: 'copy-of-ai.gguf' })
    ])
    expect(readFileSync(join(dir, 'speech.bin')).equals(speech)).toBe(true)
    expect(readFileSync(join(dir, 'ai.gguf')).equals(ai)).toBe(true)
    expect(existsSync(join(dir, 'speech.bin.part'))).toBe(false)
    expect([...ready].sort()).toEqual(['ai', 'speech'])
    expect(m.status().every((s) => s.state === 'ready')).toBe(true)

    // a second import finds both models already installed and copies nothing
    const again = await m.importFrom(usb)
    expect([...again.alreadyInstalled].sort()).toEqual(['ai', 'speech'])
    expect(again.imported).toEqual([])
  })
})
