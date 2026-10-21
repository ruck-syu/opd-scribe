// Renders build/icon.svg to build/icon.png (1024 px, used for macOS/Linux) and
// build/icon.ico (16–256 px, Windows). Run with: npm run icons
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const dir = join(__dirname, '..', 'build')
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

async function render(size) {
  const w = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, javascript: false }
  })
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 200))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  w.destroy()
  return img.resize({ width: size, height: size, quality: 'best' })
}

// ICO container with PNG-compressed entries (supported since Windows Vista).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, e)
    header.writeUInt8(size >= 256 ? 0 : size, e + 1)
    header.writeUInt16LE(1, e + 4) // colour planes
    header.writeUInt16LE(32, e + 6) // bits per pixel
    header.writeUInt32LE(data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...pngs.map((p) => p.data)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  try {
    // render once; ICO sizes are downscaled from the master (a second offscreen window is flaky on macOS)
    const master = await render(1024)
    writeFileSync(join(dir, 'icon.png'), master.toPNG())
    const pngs = ICO_SIZES.map((size) => ({ size, data: master.resize({ width: size, height: size, quality: 'best' }).toPNG() }))
    writeFileSync(join(dir, 'icon.ico'), ico(pngs))
    console.log('wrote build/icon.png and build/icon.ico')
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
