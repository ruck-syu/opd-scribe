import type { BoxMm } from '../../../shared/formTemplate'

/** Width of the editing sheet in CSS pixels; the height follows the page's aspect ratio. */
export const CANVAS_WIDTH_PX = 620

/** validateTemplate() rejects boxes smaller than this, so dragging/resizing respects it too. */
export const MIN_BOX_MM = 5

export const roundHalf = (n: number): number => Math.round(n * 2) / 2

export const clamp = (n: number, lo: number, hi: number): number => (hi < lo ? lo : Math.min(Math.max(n, lo), hi))

/** Puts a box fully on the sheet, rounded to 0.5 mm. */
export function fitBox(b: BoxMm, pageW: number, pageH: number): BoxMm {
  const wMm = clamp(roundHalf(b.wMm), MIN_BOX_MM, Math.max(MIN_BOX_MM, pageW))
  const hMm = clamp(roundHalf(b.hMm), MIN_BOX_MM, Math.max(MIN_BOX_MM, pageH))
  return {
    xMm: clamp(roundHalf(b.xMm), 0, Math.max(0, pageW - wMm)),
    yMm: clamp(roundHalf(b.yMm), 0, Math.max(0, pageH - hMm)),
    wMm,
    hMm
  }
}

/** Moves a box by a delta, keeping its size and clamping it inside the sheet. */
export function moveBox(b: BoxMm, dx: number, dy: number, pageW: number, pageH: number): BoxMm {
  return {
    ...b,
    xMm: roundHalf(clamp(b.xMm + dx, 0, Math.max(0, pageW - b.wMm))),
    yMm: roundHalf(clamp(b.yMm + dy, 0, Math.max(0, pageH - b.hMm)))
  }
}

/** Resizes from the bottom-right handle, clamped to the sheet and to the minimum size. */
export function resizeBox(b: BoxMm, dx: number, dy: number, pageW: number, pageH: number): BoxMm {
  return {
    ...b,
    wMm: roundHalf(clamp(b.wMm + dx, MIN_BOX_MM, Math.max(MIN_BOX_MM, pageW - b.xMm))),
    hMm: roundHalf(clamp(b.hMm + dy, MIN_BOX_MM, Math.max(MIN_BOX_MM, pageH - b.yMm)))
  }
}
