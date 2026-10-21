import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Renders PDF bytes to canvases in-memory (no temp files). */
export function PdfPreview({ data }: { data: Uint8Array }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const host = ref.current
    if (!host) return
    host.innerHTML = ''
    const task = pdfjs.getDocument({ data: data.slice() })
    task.promise
      .then(async (doc) => {
        for (let i = 1; i <= doc.numPages && !cancelled; i++) {
          const page = await doc.getPage(i)
          const viewport = page.getViewport({ scale: 1.4 })
          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width * devicePixelRatio)
          canvas.height = Math.floor(viewport.height * devicePixelRatio)
          canvas.style.width = `${viewport.width}px`
          canvas.className = 'pdf-page'
          const ctx = canvas.getContext('2d')!
          ctx.scale(devicePixelRatio, devicePixelRatio)
          if (cancelled) return
          host.appendChild(canvas)
          await page.render({ canvas, canvasContext: ctx, viewport }).promise
        }
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [data])

  return (
    <div className="pdf-wrap">
      {error && <div className="error">Preview failed: {error}</div>}
      <div ref={ref} className="pdf-pages" />
    </div>
  )
}
