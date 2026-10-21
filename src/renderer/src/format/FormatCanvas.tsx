import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { BoxMm, FormTemplate } from '../../../shared/formTemplate'
import { CANVAS_WIDTH_PX, moveBox, resizeBox } from './geometry'
import { fieldCatalogLabel } from './labels'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type BodyKey = 'bodyFirst' | 'bodyNext'

export type Selection = { type: 'body'; which: BodyKey } | { type: 'field'; id: string }

export interface SampleData {
  type: 'pdf' | 'png' | 'jpg'
  data: Uint8Array
}

type DragMode = 'move' | 'resize'

/** The sheet plus its sample background and all draggable boxes. All geometry is mm-based. */
export function FormatCanvas(props: {
  template: FormTemplate
  sample: SampleData | null
  sampleLoading: boolean
  sampleError: string
  selection: Selection | null
  showContinuation: boolean
  onSelect: (s: Selection | null) => void
  onBodyChange: (which: BodyKey, box: BoxMm) => void
  onFieldChange: (id: string, box: BoxMm) => void
}): ReactNode {
  const t = props.template
  const pxPerMm = CANVAS_WIDTH_PX / t.pageWidthMm
  const heightPx = t.pageHeightMm * pxPerMm
  const sel = props.selection
  const fieldSel = sel?.type === 'field' ? t.fields.find((f) => f.id === sel.id) ?? null : null

  return (
    <div
      className="fmt-sheet"
      style={{ width: CANVAS_WIDTH_PX, height: heightPx }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onSelect(null)
      }}
    >
      <div className="fmt-bg">
        {t.background === 'sample' ? (
          props.sample ? (
            <SampleBackground sample={props.sample} widthPx={CANVAS_WIDTH_PX} heightPx={heightPx} />
          ) : (
            <div className="fmt-bg-note">
              {props.sampleError || (props.sampleLoading ? 'Loading sample…' : t.sampleId ? 'Sample could not be loaded.' : 'No sample uploaded yet.')}
            </div>
          )
        ) : t.background === 'letterhead' ? (
          <div className="fmt-bg-note">Letterhead from Settings (not shown in the editor)</div>
        ) : (
          <div className="fmt-bg-note">Pre-printed paper — no background is printed</div>
        )}
        {t.background === 'sample' && props.sample && props.sampleLoading && <div className="fmt-bg-loading">Loading sample…</div>}
      </div>

      {props.showContinuation && (
        <DraggableBox
          box={t.bodyNext}
          kind="body next"
          label="Content — continuation pages"
          meta={`${t.bodyNext.wMm} × ${t.bodyNext.hMm} mm`}
          selected={sel?.type === 'body' && sel.which === 'bodyNext'}
          pxPerMm={pxPerMm}
          pageW={t.pageWidthMm}
          pageH={t.pageHeightMm}
          onSelect={() => props.onSelect({ type: 'body', which: 'bodyNext' })}
          onChange={(b) => props.onBodyChange('bodyNext', b)}
        />
      )}

      <DraggableBox
        box={t.bodyFirst}
        kind="body"
        label="Content — page 1"
        meta={`${t.bodyFirst.wMm} × ${t.bodyFirst.hMm} mm`}
        selected={sel?.type === 'body' && sel.which === 'bodyFirst'}
        pxPerMm={pxPerMm}
        pageW={t.pageWidthMm}
        pageH={t.pageHeightMm}
        onSelect={() => props.onSelect({ type: 'body', which: 'bodyFirst' })}
        onChange={(b) => props.onBodyChange('bodyFirst', b)}
      />

      {t.fields.map((f) => (
        <DraggableBox
          key={f.id}
          box={f}
          kind="fld"
          label={f.label || fieldCatalogLabel(f.field)}
          title={`${fieldCatalogLabel(f.field)} — ${f.fontSizePt} pt, ${f.pages === 'all' ? 'every page' : 'page 1 only'}`}
          selected={fieldSel?.id === f.id}
          pxPerMm={pxPerMm}
          pageW={t.pageWidthMm}
          pageH={t.pageHeightMm}
          onSelect={() => props.onSelect({ type: 'field', id: f.id })}
          onChange={(b) => props.onFieldChange(f.id, b)}
        />
      ))}
    </div>
  )
}

function DraggableBox(props: {
  box: BoxMm
  kind: string
  label: string
  meta?: string
  title?: string
  selected: boolean
  pxPerMm: number
  pageW: number
  pageH: number
  onSelect: () => void
  onChange: (b: BoxMm) => void
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: DragMode; x: number; y: number; box: BoxMm } | null>(null)

  const start = (e: ReactPointerEvent<HTMLDivElement>, mode: DragMode): void => {
    e.preventDefault()
    e.stopPropagation()
    props.onSelect()
    ref.current?.setPointerCapture(e.pointerId)
    drag.current = { mode, x: e.clientX, y: e.clientY, box: props.box }
  }

  const stop = (): void => {
    drag.current = null
  }

  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / props.pxPerMm
    const dy = (e.clientY - d.y) / props.pxPerMm
    props.onChange(
      d.mode === 'move' ? moveBox(d.box, dx, dy, props.pageW, props.pageH) : resizeBox(d.box, dx, dy, props.pageW, props.pageH)
    )
  }

  return (
    <div
      ref={ref}
      className={`fmt-box ${props.kind} ${props.selected ? 'sel' : ''}`}
      style={{
        left: props.box.xMm * props.pxPerMm,
        top: props.box.yMm * props.pxPerMm,
        width: props.box.wMm * props.pxPerMm,
        height: props.box.hMm * props.pxPerMm
      }}
      title={props.title ?? `${props.label} — ${props.box.wMm} × ${props.box.hMm} mm`}
      onPointerDown={(e) => start(e, 'move')}
      onPointerMove={move}
      onPointerUp={(e) => {
        stop()
        if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId)
      }}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    >
      <div className="fmt-box-label">{props.label}</div>
      {props.meta && <div className="fmt-box-meta">{props.meta}</div>}
      <div className="fmt-resize" title="Drag to resize" onPointerDown={(e) => start(e, 'resize')} />
    </div>
  )
}

function SampleBackground(props: { sample: SampleData; widthPx: number; heightPx: number }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (props.sample.type !== 'pdf') return
    let cancelled = false
    setError('')
    const task = pdfjs.getDocument({ data: props.sample.data.slice() })
    task.promise
      .then(async (doc) => {
        const page = await doc.getPage(1)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const dpr = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale: (props.widthPx * dpr) / base.width })
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${props.widthPx}px`
        canvas.style.height = `${props.heightPx}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        await page.render({ canvas, canvasContext: ctx, viewport }).promise
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [props.sample, props.widthPx, props.heightPx])

  useEffect(() => {
    if (props.sample.type === 'pdf') {
      setImageUrl('')
      return
    }
    const mime = props.sample.type === 'png' ? 'image/png' : 'image/jpeg'
    const url = URL.createObjectURL(new Blob([props.sample.data.slice()], { type: mime }))
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [props.sample])

  if (props.sample.type === 'pdf') {
    return (
      <>
        <canvas ref={canvasRef} className="fmt-canvas" />
        {error && <div className="fmt-bg-note">Sample preview failed: {error}</div>}
      </>
    )
  }
  return imageUrl ? <img src={imageUrl} alt="" className="fmt-img" /> : null
}
