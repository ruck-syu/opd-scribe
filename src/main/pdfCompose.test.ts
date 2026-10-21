import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/defaults'
import { A4, composePdf, fitStamp, mmToPt, toEncodable } from './pdfCompose'

async function makePdf(pages: Array<{ width: number; height: number }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const size of pages) {
    const page = doc.addPage([size.width, size.height])
    // pdf-lib cannot embed a page without a content stream, so every fixture page gets a mark.
    page.drawText('.', { x: 4, y: 4, size: 6, font })
  }
  return doc.save()
}

const stamp = { identity: 'SAMPLE PATIENT | MRN SAMPLE-0001', label: 'Test' }

describe('composePdf', () => {
  it('keeps A4 and the existing call signature when no options are given', async () => {
    const content = await makePdf([{ width: A4.width, height: A4.height }])
    const out = await composePdf(content, DEFAULT_SETTINGS.layout, null, stamp)
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(A4.width, 1)
    expect(height).toBeCloseTo(A4.height, 1)
  })

  it('uses a custom page size and draws the matching overlay page on each content page', async () => {
    const size = { width: mmToPt(210), height: mmToPt(297) }
    const content = await makePdf([size, size, size])
    const overlay = await makePdf([size, size])
    const out = await composePdf(content, DEFAULT_SETTINGS.layout, null, stamp, {
      pageSize: size,
      backgrounds: { first: null, next: null },
      overlay
    })
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(3)
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize()
      expect(width).toBeCloseTo(size.width, 1)
      expect(height).toBeCloseTo(size.height, 1)
    }
    // content + overlay on pages 1-2, content only on page 3
    const xobjects = doc.getPages().map((p) => p.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict).keys().length)
    expect(xobjects).toEqual([2, 2, 1])
  })

  it('supports a background for the first page and a different continuation background', async () => {
    const size = { width: 300, height: 400 }
    const first = await makePdf([size])
    const next = await makePdf([size])
    const content = await makePdf([size, size])
    const out = await composePdf(content, DEFAULT_SETTINGS.layout, null, stamp, {
      pageSize: size,
      backgrounds: {
        first: { type: 'pdf', data: first },
        next: { type: 'pdf', data: next }
      }
    })
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2)
  })
})

describe('page stamp text', () => {
  const helvetica = async () => (await PDFDocument.create()).embedFont(StandardFonts.Helvetica)

  it('folds accents to base letters and replaces unsupported scripts', async () => {
    const font = await helvetica()
    expect(toEncodable('Śrīmatī Lakshmī', font)).toBe('Srimati Lakshmi')
    expect(toEncodable('Céline — Müller', font)).toBe('Céline — Müller')
    expect(toEncodable('राम', font)).toBe('???')
  })

  it('shrinks to fit one line and elides only when the minimum size overflows', async () => {
    const font = await helvetica()
    const short = fitStamp('OPD Visit Note | A | MRN 1', font, 7.5, 400)
    expect(short).toEqual({ text: 'OPD Visit Note | A | MRN 1', size: 7.5 })
    const long = 'Prescription & Plan | ' + 'Venkatanarasimharajuvaripeta '.repeat(3) + '| MRN 123 | Visit 2026-10-22 00:17'
    const fitted = fitStamp(long, font, 7.5, 400)
    expect(fitted.text).toBe(long)
    expect(fitted.size).toBeLessThan(7.5)
    expect(font.widthOfTextAtSize(fitted.text, fitted.size)).toBeLessThanOrEqual(400.01)
    const elided = fitStamp(long.repeat(4), font, 7.5, 400)
    expect(elided.size).toBe(5)
    expect(elided.text).toContain('…')
    expect(elided.text.startsWith('Prescription & Plan')).toBe(true)
    expect(elided.text.endsWith('00:17')).toBe(true)
    expect(font.widthOfTextAtSize(elided.text, 5)).toBeLessThanOrEqual(400)
  })
})
