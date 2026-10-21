import { useEffect, useRef, useState, type ReactNode } from 'react'
import { call } from '../api'
import type { PreviewResult, SampleInfo } from '../../../shared/api'
import type { AppSettings, Role } from '../../../shared/types'
import {
  defaultTemplate,
  validateTemplate,
  type BoxMm,
  type DocKind,
  type FieldBox,
  type FieldKey,
  type FormTemplate,
  type SectionKey,
  type SectionSpec
} from '../../../shared/formTemplate'
import { uid } from '../../../shared/defaults'
import { ErrorBox, Modal, fmtDateTime, useAction } from '../components/ui'
import { PdfPreview } from '../components/PdfPreview'
import { FormatCanvas, type BodyKey, type SampleData, type Selection } from '../format/FormatCanvas'
import { fitBox, moveBox } from '../format/geometry'
import { DEFAULT_FIELD_LABELS } from '../format/labels'
import { ContentPanel, FieldsPanel, PagePanel, SectionsPanel } from '../format/FormatPanels'

type Editing = { kind: DocKind; template: FormTemplate }

/** Settings section: shows the state of both custom formats and opens the editor (doctors only). */
export function FormatSection(props: {
  settings: AppSettings
  setSettings: (s: AppSettings) => void
  busy: boolean
  role: Role
}): ReactNode {
  const [editing, setEditing] = useState<Editing | null>(null)
  const { busy: localBusy, error, run } = useAction()
  const doctor = props.role === 'doctor'
  const disabled = props.busy || localBusy

  const startEditing = (kind: DocKind, uploadFirst: boolean): Promise<void> =>
    run(async () => {
      const existing = props.settings.formats[kind]
      let template = existing ?? defaultTemplate(kind, uid(), new Date().toISOString())
      if (uploadFirst) {
        const info = await call('formats.uploadSample', kind)
        if (info) template = withSample(template, info)
      }
      setEditing({ kind, template })
    })

  const revert = (kind: DocKind): Promise<void> =>
    run(async () => {
      if (!confirm('Revert this format to the built-in layout? The custom layout will be deleted.')) return
      props.setSettings(await call('formats.save', kind, null))
    })

  const card = (kind: DocKind, title: string): ReactNode => {
    const t = props.settings.formats[kind]
    return (
      <div className="card" key={kind}>
        <div className="row">
          <h3>{title}</h3>
          <div className="spacer" />
          {t && <span className="pill">Custom</span>}
        </div>
        <p>{t ? `Custom format v${t.version}, updated ${fmtDateTime(t.updatedAt)}` : 'Built-in format'}</p>
        {doctor ? (
          <div className="row wrap">
            {!t && (
              <button type="button" className="primary" disabled={disabled} onClick={() => void startEditing(kind, true)}>
                Create from sample…
              </button>
            )}
            <button type="button" disabled={disabled} onClick={() => void startEditing(kind, false)}>
              Edit…
            </button>
            {t && (
              <button type="button" className="ghost" disabled={disabled} onClick={() => void revert(kind)}>
                Revert to built-in
              </button>
            )}
          </div>
        ) : (
          <p className="muted small">Only a doctor can change print formats.</p>
        )}
      </div>
    )
  }

  return (
    <div>
      <p className="muted small">
        Upload a blank copy (or a sample) of your existing OPD sheet, then mark where each item goes. Only the positions are used — content is
        always taken from the visit. Anything documented that your format has no place for is still printed, after the other sections.
      </p>
      <ErrorBox error={error} />
      <div className="two-col">
        {card('note', 'Clinical note format')}
        {card('prescription', 'Prescription format')}
      </div>

      {editing && (
        <FormatEditor
          kind={editing.kind}
          initial={editing.template}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            props.setSettings(s)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function FormatEditor(props: {
  kind: DocKind
  initial: FormTemplate
  onClose: () => void
  onSaved: (s: AppSettings) => void
}): ReactNode {
  const [t, setT] = useState(props.initial)
  const [dirty, setDirty] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [showContinuation, setShowContinuation] = useState(true)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [sample, setSample] = useState<SampleData | null>(null)
  const [sampleLoading, setSampleLoading] = useState(false)
  const [sampleError, setSampleError] = useState('')
  const previewRef = useRef<HTMLDivElement>(null)
  const { busy, error, run } = useAction()
  const problems = validateTemplate(t)

  const update = (fn: (cur: FormTemplate) => FormTemplate): void => {
    setT((cur) => fn(cur))
    setDirty(true)
    setPreview(null)
  }

  useEffect(() => {
    if (!t.sampleId) {
      setSample(null)
      setSampleError('')
      setSampleLoading(false)
      return
    }
    let cancelled = false
    setSample(null)
    setSampleLoading(true)
    setSampleError('')
    call('formats.sample', t.sampleId)
      .then((s) => {
        if (cancelled) return
        setSample(s)
        setSampleLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setSampleError(e instanceof Error ? e.message : String(e))
        setSampleLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [t.sampleId])

  useEffect(() => {
    if (preview) previewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [preview])

  // Arrow keys nudge the selected box; Delete removes the selected field. Ignored while typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (!selection) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection.type !== 'field') return
        e.preventDefault()
        const id = selection.id
        setT((cur) => ({ ...cur, fields: cur.fields.filter((f) => f.id !== id) }))
        setDirty(true)
        setPreview(null)
        setSelection(null)
        return
      }
      const step = e.shiftKey ? 5 : 0.5
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      if (dx === 0 && dy === 0) return
      e.preventDefault()
      setT((cur) => {
        if (selection.type === 'body') {
          const moved = moveBox(cur[selection.which], dx, dy, cur.pageWidthMm, cur.pageHeightMm)
          return selection.which === 'bodyFirst' ? { ...cur, bodyFirst: moved } : { ...cur, bodyNext: moved }
        }
        return {
          ...cur,
          fields: cur.fields.map((f) => (f.id === selection.id ? { ...f, ...moveBox(f, dx, dy, cur.pageWidthMm, cur.pageHeightMm) } : f))
        }
      })
      setDirty(true)
      setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection])

  const close = (): void => {
    if (!dirty || confirm('Discard your changes to this format?')) props.onClose()
  }

  const uploadSample = (): Promise<void> =>
    run(async () => {
      const info = await call('formats.uploadSample', props.kind)
      if (info) update((cur) => withSample(cur, info))
    })

  const addField = (field: FieldKey): void => {
    const raw: FieldBox = {
      id: uid(),
      field,
      label: DEFAULT_FIELD_LABELS[field],
      fontSizePt: 10,
      bold: false,
      pages: field.startsWith('patient.') || field.startsWith('visit.') ? 'all' : 'first',
      xMm: t.bodyFirst.xMm + 3,
      yMm: t.bodyFirst.yMm + 10 + (t.fields.length % 8) * 9,
      wMm: 60,
      hMm: 7
    }
    const box = fitBox(raw, t.pageWidthMm, t.pageHeightMm)
    update((cur) => ({ ...cur, fields: [...cur.fields, { ...raw, ...box }] }))
    setSelection({ type: 'field', id: raw.id })
  }

  const removeField = (id: string): void => {
    update((cur) => ({ ...cur, fields: cur.fields.filter((f) => f.id !== id) }))
    setSelection((cur) => (cur?.type === 'field' && cur.id === id ? null : cur))
  }

  const patchField = (id: string, patch: Partial<FieldBox>): void =>
    update((cur) => ({ ...cur, fields: cur.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) }))

  const setFieldBox = (id: string, box: BoxMm): void =>
    update((cur) => ({ ...cur, fields: cur.fields.map((f) => (f.id === id ? { ...f, ...box } : f)) }))

  const setBody = (which: BodyKey, box: BoxMm): void =>
    update((cur) => (which === 'bodyFirst' ? { ...cur, bodyFirst: box } : { ...cur, bodyNext: box }))

  const patchSection = (key: SectionKey, patch: Partial<SectionSpec>): void =>
    update((cur) => ({ ...cur, sections: cur.sections.map((s) => (s.key === key ? { ...s, ...patch } : s)) }))

  const moveSection = (key: SectionKey, dir: -1 | 1): void =>
    update((cur) => {
      const i = cur.sections.findIndex((s) => s.key === key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= cur.sections.length) return cur
      const sections = [...cur.sections]
      const item = sections[i]
      sections[i] = sections[j]
      sections[j] = item
      return { ...cur, sections }
    })

  const save = (): Promise<void> =>
    run(async () => {
      if (problems.length > 0) return
      props.onSaved(await call('formats.save', props.kind, t))
    })

  const doPreview = (): Promise<void> => run(async () => setPreview(await call('formats.preview', t)))

  return (
    <Modal title={props.kind === 'note' ? 'Clinical note format' : 'Prescription format'} wide onClose={close}>
      <div className="fmt-head">
        <p className="muted small">
          Positions are in millimetres from the top-left of the sheet. Drag a box to move it; drag the bottom-right corner to resize. Arrow keys
          nudge by 0.5 mm (Shift: 5 mm).
        </p>
        <div className="spacer" />
        {dirty && <span className="pill warn">Unsaved changes</span>}
      </div>
      <ErrorBox error={error} />

      <div className="fmt-layout">
        <div className="fmt-canvas-col">
          <div className="fmt-toolbar">
            <button type="button" className="small" disabled={busy} onClick={() => void uploadSample()}>
              {t.sampleId ? 'Replace sample…' : 'Upload sample…'}
            </button>
            <span className="muted small">
              {t.pageWidthMm} × {t.pageHeightMm} mm
            </span>
            <label className="check">
              <input type="checkbox" checked={showContinuation} onChange={(e) => setShowContinuation(e.target.checked)} />
              Show continuation area
            </label>
          </div>

          <FormatCanvas
            template={t}
            sample={sample}
            sampleLoading={sampleLoading}
            sampleError={sampleError}
            selection={selection}
            showContinuation={showContinuation}
            onSelect={setSelection}
            onBodyChange={setBody}
            onFieldChange={setFieldBox}
          />
          <p className="muted small">{backgroundCaption(t)}</p>

          {problems.length > 0 ? (
            <div className="notice">
              <b>Fix these before saving</b>
              <ul className="errors-list fmt-problems">
                {problems.map((p, i) => (
                  <li key={`${i}-${p}`}>{p}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted small ok">No problems — this format can be saved.</p>
          )}
        </div>

        <div className="fmt-panel">
          <PagePanel t={t} onChange={(patch) => update((cur) => ({ ...cur, ...patch }))} />
          <FieldsPanel
            t={t}
            selection={selection}
            onAdd={addField}
            onSelect={(id) => setSelection({ type: 'field', id })}
            onPatch={patchField}
            onRemove={removeField}
          />
          <SectionsPanel kind={props.kind} sections={t.sections} onPatch={patchSection} onMove={moveSection} />
          <ContentPanel t={t} selection={selection} onSelect={(which) => setSelection({ type: 'body', which })} onBox={setBody} />
        </div>
      </div>

      {preview && (
        <div ref={previewRef}>
          <PreviewBlock result={preview} onClose={() => setPreview(null)} />
        </div>
      )}

      <div className="actions fmt-actions">
        <button type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => void doPreview()}>
          Preview with sample patient
        </button>
        <button type="button" className="primary" disabled={busy || problems.length > 0} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  )
}

function PreviewBlock(props: { result: PreviewResult; onClose: () => void }): ReactNode {
  return (
    <div className="card fmt-preview">
      <div className="row">
        <h3>Sample patient preview</h3>
        {props.result.draft && <span className="pill warn">Draft</span>}
        <div className="spacer" />
        <button type="button" className="small ghost" onClick={props.onClose}>
          Hide
        </button>
      </div>
      <p className="muted small">Rendered from a fictitious sample patient; no real patient data is used.</p>
      {props.result.pdfs.length === 0 && <p className="muted">No preview was returned.</p>}
      {props.result.pdfs.map((p) => (
        <div key={p.name}>
          {props.result.pdfs.length > 1 && (
            <h4>{p.name === 'note' ? 'Clinical note' : p.name === 'prescription' ? 'Prescription' : p.name}</h4>
          )}
          <PdfPreview data={p.data} />
        </div>
      ))}
    </div>
  )
}

function backgroundCaption(t: FormTemplate): string {
  if (t.background === 'sample') {
    return t.sampleId
      ? `Background: uploaded sample${t.sampleType ? ` (${t.sampleType.toUpperCase()})` : ''}, first page.`
      : 'Background: upload a sample first, or choose another background.'
  }
  if (t.background === 'letterhead') return 'Background: letterhead from Settings. It is not drawn in the editor.'
  return 'Background: nothing. The boxes are printed on your pre-printed paper.'
}

function withSample(t: FormTemplate, info: SampleInfo): FormTemplate {
  return {
    ...t,
    sampleId: info.sampleId,
    sampleType: info.sampleType,
    pageWidthMm: info.pageWidthMm,
    pageHeightMm: info.pageHeightMm,
    background: 'sample',
    bodyFirst: fitBox(t.bodyFirst, info.pageWidthMm, info.pageHeightMm),
    bodyNext: fitBox(t.bodyNext, info.pageWidthMm, info.pageHeightMm),
    fields: t.fields.map((f) => ({ ...f, ...fitBox(f, info.pageWidthMm, info.pageHeightMm) }))
  }
}
