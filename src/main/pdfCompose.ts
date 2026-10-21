import { PDFDocument, StandardFonts, rgb, type PDFEmbeddedPage, type PDFImage } from 'pdf-lib'
import type { LayoutSettings } from '../shared/types'

export const A4 = { width: 595.28, height: 841.89 }
const MM = 72 / 25.4

export interface Letterhead {
  type: 'pdf' | 'png' | 'jpg'
  data: Uint8Array
}

export interface Stamp {
  /** e.g. "Name · MRN 123 · 21 Oct 2026" — printed on every page with page numbers (PDF-04) */
  identity: string
  label: string
}

/** Helvetica can only encode WinAnsi; replace anything else so stamping never fails. */
const winAnsi = (s: string): string => s.replace(/[^\x20-\x7E -ÿ]/g, '?')

/**
 * Put rendered content pages on top of the letterhead, apply calibration offsets
 * and stamp identity + "Page X of Y" in the bottom margin.
 */
export async function composePdf(
  content: Uint8Array,
  layout: LayoutSettings,
  letterhead: Letterhead | null,
  stamp: Stamp
): Promise<Uint8Array> {
  const src = await PDFDocument.load(content)
  const out = await PDFDocument.create()
  const font = await out.embedFont(StandardFonts.Helvetica)

  let lhPage: PDFEmbeddedPage | null = null
  let lhImage: PDFImage | null = null
  if (letterhead?.type === 'pdf') [lhPage] = await out.embedPdf(letterhead.data, [0])
  if (letterhead?.type === 'png') lhImage = await out.embedPng(letterhead.data)
  if (letterhead?.type === 'jpg') lhImage = await out.embedJpg(letterhead.data)

  const pages = await out.embedPages(src.getPages())
  const total = pages.length
  const dx = layout.offsetXMm * MM
  const dy = -layout.offsetYMm * MM // positive offset moves content down

  pages.forEach((emb, i) => {
    const page = out.addPage([A4.width, A4.height])
    if (i === 0 || layout.letterheadEveryPage) {
      if (lhPage) page.drawPage(lhPage, { x: 0, y: 0, width: A4.width, height: A4.height })
      if (lhImage) page.drawImage(lhImage, { x: 0, y: 0, width: A4.width, height: A4.height })
    }
    page.drawPage(emb, { x: dx, y: dy, width: A4.width, height: A4.height })

    const size = 7.5
    const y = Math.max(layout.marginBottomMm * MM - 5 * MM - size, 4 * MM) + dy
    const left = winAnsi(`${stamp.label} | ${stamp.identity}`)
    const right = `Page ${i + 1} of ${total}`
    const color = rgb(0.3, 0.3, 0.3)
    page.drawText(left, { x: layout.marginLeftMm * MM + dx, y, size, font, color, maxWidth: A4.width * 0.7 })
    page.drawText(right, {
      x: A4.width - layout.marginRightMm * MM - font.widthOfTextAtSize(right, size) + dx,
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
