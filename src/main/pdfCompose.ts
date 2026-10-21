import { PDFDocument, StandardFonts, rgb, type PDFEmbeddedPage, type PDFImage, type PDFPage } from 'pdf-lib'
import type { LayoutSettings } from '../shared/types'

export const A4 = { width: 595.28, height: 841.89 }
const MM = 72 / 25.4

export const mmToPt = (mm: number): number => mm * MM

export interface Letterhead {
  type: 'pdf' | 'png' | 'jpg'
  data: Uint8Array
}

export interface ComposeOptions {
  /** sheet size in points (default A4); custom formats pass their sample's size */
  pageSize?: { width: number; height: number }
  /** first / continuation backgrounds; overrides `letterhead` and layout.letterheadEveryPage */
  backgrounds?: { first: Letterhead | null; next: Letterhead | null }
  /** full-page field overlay PDF; page i is drawn on top of content page i */
  overlay?: Uint8Array | null
  /** stamp position in mm from the left / bottom edge (default: layout margins) */
  stampLeftMm?: number
  stampRightMm?: number
  stampBottomMm?: number
}

export interface Stamp {
  /** e.g. "Name · MRN 123 · 21 Oct 2026" — printed on every page with page numbers (PDF-04) */
  identity: string
  label: string
}

/** Helvetica can only encode WinAnsi; replace anything else so stamping never fails. */
const winAnsi = (s: string): string => s.replace(/[^\x20-\x7E -ÿ]/g, '?')

interface EmbeddedBackground {
  page: PDFEmbeddedPage | null
  image: PDFImage | null
}

async function embedBackground(out: PDFDocument, background: Letterhead | null): Promise<EmbeddedBackground> {
  if (!background) return { page: null, image: null }
  if (background.type === 'pdf') {
    const [page] = await out.embedPdf(background.data, [0])
    return { page, image: null }
  }
  const image = background.type === 'png' ? await out.embedPng(background.data) : await out.embedJpg(background.data)
  return { page: null, image }
}

/** Backgrounds are never calibration-shifted: they are the sheet itself. */
function drawBackground(page: PDFPage, bg: EmbeddedBackground, width: number, height: number): void {
  if (bg.page) page.drawPage(bg.page, { x: 0, y: 0, width, height })
  if (bg.image) page.drawImage(bg.image, { x: 0, y: 0, width, height })
}

/**
 * Put rendered content pages on top of the background, apply calibration offsets
 * and stamp identity + "Page X of Y" in the bottom margin. An optional overlay PDF
 * (fixed fields) is drawn on top of each content page.
 */
export async function composePdf(
  content: Uint8Array,
  layout: LayoutSettings,
  letterhead: Letterhead | null,
  stamp: Stamp,
  options: ComposeOptions = {}
): Promise<Uint8Array> {
  const src = await PDFDocument.load(content)
  const out = await PDFDocument.create()
  const font = await out.embedFont(StandardFonts.Helvetica)
  const width = options.pageSize?.width ?? A4.width
  const height = options.pageSize?.height ?? A4.height

  const first = options.backgrounds ? options.backgrounds.first : letterhead
  const next = options.backgrounds ? options.backgrounds.next : layout.letterheadEveryPage ? letterhead : null
  const firstBg = await embedBackground(out, first)
  const nextBg = next === first ? firstBg : await embedBackground(out, next)

  // embedPdf embeds only page 0 unless indices are given
  const overlayDoc = options.overlay ? await PDFDocument.load(options.overlay) : null
  const overlayPages = overlayDoc ? await out.embedPages(overlayDoc.getPages()) : []

  const pages = await out.embedPages(src.getPages())
  const total = pages.length
  const dx = layout.offsetXMm * MM
  const dy = -layout.offsetYMm * MM // positive offset moves content down

  const size = 7.5
  const stampLeft = (options.stampLeftMm ?? layout.marginLeftMm) * MM
  const stampRight = (options.stampRightMm ?? layout.marginRightMm) * MM
  const stampY =
    options.stampBottomMm !== undefined
      ? options.stampBottomMm * MM
      : Math.max(layout.marginBottomMm * MM - 5 * MM - size, 4 * MM)

  pages.forEach((emb, i) => {
    const page = out.addPage([width, height])
    drawBackground(page, i === 0 ? firstBg : nextBg, width, height)
    page.drawPage(emb, { x: dx, y: dy, width, height })
    if (overlayPages[i]) page.drawPage(overlayPages[i], { x: dx, y: dy, width, height })

    const y = stampY + dy
    const left = winAnsi(`${stamp.label} | ${stamp.identity}`)
    const right = `Page ${i + 1} of ${total}`
    const color = rgb(0.3, 0.3, 0.3)
    page.drawText(left, { x: stampLeft + dx, y, size, font, color, maxWidth: width * 0.7 })
    page.drawText(right, {
      x: width - stampRight - font.widthOfTextAtSize(right, size) + dx,
      y,
      size,
      font,
      color
    })
  })

  out.setTitle(winAnsi(stamp.label))
  out.setProducer('OPD Scribe')
  out.setCreator('OPD Scribe')
  return out.save()
}

/** Concatenate several finished PDFs (combined export). */
export async function concatPdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const p of parts) {
    const src = await PDFDocument.load(p)
    const copied = await out.copyPages(src, src.getPageIndices())
    copied.forEach((pg) => out.addPage(pg))
  }
  return out.save()
}

/** Calibration test page: rulers & a 10 mm grid inside the content box. */
export function calibrationHtml(layout: LayoutSettings): string {
  const marks = Array.from({ length: 30 }, (_, i) => `<div class="tick" style="top:${i * 10}mm"><span>${i * 10}</span></div>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: ${layout.marginTopMm}mm ${layout.marginRightMm}mm ${layout.marginBottomMm}mm ${layout.marginLeftMm}mm; }
html, body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; font-size: 9pt; }
.box { position: relative; height: calc(297mm - ${layout.marginTopMm + layout.marginBottomMm}mm - 1mm); border: 0.4mm dashed #c00;
  background-image: linear-gradient(#ddd 0.2mm, transparent 0.2mm), linear-gradient(90deg, #ddd 0.2mm, transparent 0.2mm);
  background-size: 10mm 10mm; box-sizing: border-box; overflow: hidden; }
.tick { position: absolute; left: 0; width: 4mm; border-top: 0.3mm solid #c00; }
.tick span { position: absolute; left: 5mm; top: -2mm; color: #c00; font-size: 6pt; }
.msg { position: absolute; top: 40%; left: 0; right: 0; text-align: center; color: #c00; font-size: 12pt; }
</style></head><body><div class="box">${marks}<div class="msg">CALIBRATION TEST — content area<br>
margins T${layout.marginTopMm} B${layout.marginBottomMm} L${layout.marginLeftMm} R${layout.marginRightMm} mm ·
offset X${layout.offsetXMm} Y${layout.offsetYMm} mm</div></div></body></html>`
}
