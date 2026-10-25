import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, safeStorage, session, shell, systemPreferences } from 'electron'
import { join } from 'node:path'
import { CHANNELS, type Channel, type IpcResult } from '../shared/api'
import { loadOrCreateDataKey } from './crypto'
import { Store } from './db'
import { Services, UserError, type Platform } from './services'

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
let win: BrowserWindow | null = null

app.setName('OPD Scribe')
if (!app.requestSingleInstanceLock()) app.quit()

const CSP = [
  "default-src 'self'",
  `script-src 'self'${isDev ? " 'unsafe-inline'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  `connect-src 'self'${isDev ? ' ws://localhost:* http://localhost:*' : ''}`,
  "media-src 'self' blob: mediastream:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/** Render HTML to PDF in an isolated, script-less hidden window. */
async function htmlToPdf(html: string): Promise<Uint8Array> {
  const w = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: false }
  })
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const buf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true })
    return new Uint8Array(buf)
  } finally {
    w.destroy()
  }
}

function platform(): Platform {
  return {
    dataDir: app.getPath('userData'),
    whisperDirs: [
      join(app.getPath('userData'), 'whisper'),
      app.isPackaged ? join(process.resourcesPath, 'whisper') : join(app.getAppPath(), 'resources', 'whisper')
    ],
    llmDirs: [
      join(app.getPath('userData'), 'llm'),
      app.isPackaged ? join(process.resourcesPath, 'llm') : join(app.getAppPath(), 'resources', 'llm')
    ],
    version: app.getVersion(),
    platform: process.platform,
    htmlToPdf,
    async openFile(title, extensions) {
      const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile'], filters: [{ name: title, extensions }] })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    async saveFile(title, defaultName, extensions) {
      const r = await dialog.showSaveDialog(win!, { title, defaultPath: defaultName, filters: [{ name: title, extensions }] })
      return r.canceled ? null : (r.filePath ?? null)
    },
    async openPath(path) {
      const err = await shell.openPath(path)
      if (err) throw new UserError(err)
    },
    emit(event, payload) {
      win?.webContents.send(`event:${event}`, payload)
    }
  }
}

function registerIpc(services: Services): void {
  const handlers = services.handlers() as unknown as Record<Channel, (...a: unknown[]) => unknown>
  const allowed = new Set<string>(CHANNELS)
  for (const ch of CHANNELS) {
    ipcMain.handle(ch, async (event, ...args): Promise<IpcResult<unknown>> => {
      // only our own window may call in
      if (!win || event.sender.id !== win.webContents.id || !allowed.has(ch)) return { ok: false, error: 'Forbidden' }
      try {
        return { ok: true, value: await handlers[ch](...args) }
      } catch (e) {
        // No PHI in logs: log only the channel and error class, never arguments.
        if (!(e instanceof UserError)) console.error(`[ipc] ${ch} failed:`, e instanceof Error ? e.name : 'error')
        const msg = e instanceof Error ? e.message : 'Unexpected error'
        return { ok: false, error: msg }
      }
    })
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'OPD Scribe',
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!isDev || !url.startsWith(process.env.ELECTRON_RENDERER_URL!)) e.preventDefault()
  })
  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  if (!isDev) Menu.setApplicationMenu(null)

  const ses = session.defaultSession
  ses.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } })
  })
  // No network: block everything except our own renderer (dev server / file / data / devtools).
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url
    const ok =
      u.startsWith('file:') ||
      u.startsWith('data:') ||
      u.startsWith('blob:') ||
      u.startsWith('devtools:') ||
      u.startsWith('chrome-extension:') ||
      (isDev && /^(https?|wss?):\/\/localhost[:/]/.test(u))
    cb({ cancel: !ok })
  })
  const mediaOnly = (permission: string): boolean => permission === 'media' || permission === 'clipboard-sanitized-write'
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(mediaOnly(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => mediaOnly(permission))
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone').catch(() => false)

  let services: Services
  try {
    const dataDir = app.getPath('userData')
    const key = loadOrCreateDataKey(join(dataDir, 'data.key'), safeStorage)
    const store = await Store.open(join(dataDir, 'opd.db.enc'), key)
    services = new Services(store, key, platform())
  } catch (e) {
    dialog.showErrorBox('OPD Scribe cannot start', e instanceof Error ? e.message : String(e))
    app.quit()
    return
  }
  registerIpc(services)
  createWindow()

  const lockNow = (): void => {
    services.lock()
    win?.webContents.send('event:app.locked', {})
  }
  powerMonitor.on('lock-screen', lockNow)
  powerMonitor.on('suspend', lockNow)
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})
app.on('window-all-closed', () => app.quit())
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (ev) => ev.preventDefault())
})
