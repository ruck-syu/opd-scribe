import type { ReactNode } from 'react'
import {
  FIELD_CATALOG,
  HIDEABLE_WHEN_FILLED,
  sectionCatalog,
  type BoxMm,
  type DocKind,
  type FieldBox,
  type FieldKey,
  type FormTemplate,
  type SectionKey,
  type SectionSpec
} from '../../../shared/formTemplate'
import { Field, Select } from '../components/ui'
import type { BodyKey, Selection } from './FormatCanvas'
import { NumField } from './NumField'
import { fieldCatalogLabel } from './labels'

const BACKGROUND_OPTIONS: [FormTemplate['background'], string][] = [
  ['sample', 'Uploaded sample (blank form)'],
  ['letterhead', 'Letterhead from Settings'],
  ['none', 'Nothing — pre-printed paper']
]

const PAGE_OPTIONS: [FieldBox['pages'], string][] = [
  ['first', 'Page 1 only'],
  ['all', 'Every page']
]

const ADD_FIELD_OPTIONS: [FieldKey | '', string][] = [
  ['', 'Choose a field…'],
  ...FIELD_CATALOG.map(([k, l]) => [k, l] as [FieldKey, string])
]

const headingFor = (kind: DocKind, key: SectionKey): string => sectionCatalog(kind).find(([k]) => k === key)?.[1] ?? key

export function PagePanel(props: { t: FormTemplate; onChange: (patch: Partial<FormTemplate>) => void }): ReactNode {
  const t = props.t
  return (
    <div className="card">
      <h3>Page</h3>
      <p className="muted small">
        {t.sampleId ? 'Page size taken from your sample' : 'Page size (A4)'}: {t.pageWidthMm} × {t.pageHeightMm} mm
      </p>
      <Select<FormTemplate['background']>
        label="Background"
        value={t.background}
        width="100%"
        onChange={(background) => props.onChange({ background })}
        options={BACKGROUND_OPTIONS}
      />
      <label className="check">
        <input type="checkbox" checked={t.repeatBackground} onChange={(e) => props.onChange({ repeatBackground: e.target.checked })} />
        Repeat background on continuation pages
      </label>
      <Field label="Document title" value={t.title} onChange={(title) => props.onChange({ title })} />
      <NumField label="Body font size (pt)" value={t.fontSizePt} width={150} onCommit={(fontSizePt) => props.onChange({ fontSizePt })} />
    </div>
  )
}

export function FieldsPanel(props: {
  t: FormTemplate
  selection: Selection | null
  onAdd: (field: FieldKey) => void
  onSelect: (id: string) => void
  onPatch: (id: string, patch: Partial<FieldBox>) => void
  onRemove: (id: string) => void
}): ReactNode {
  const selectedId = props.selection?.type === 'field' ? props.selection.id : ''
  const selected = selectedId ? props.t.fields.find((f) => f.id === selectedId) ?? null : null
  return (
    <div className="card">
      <h3>Fields</h3>
      <Select<FieldKey | ''>
        label="Add a field"
        value=""
        width={200}
        onChange={(v) => {
          if (v) props.onAdd(v)
        }}
        options={ADD_FIELD_OPTIONS}
      />
      {props.t.fields.length > 0 && (
        <div className="fmt-field-list">
          {props.t.fields.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`small ${selected?.id === f.id ? 'active' : ''}`}
              onClick={() => props.onSelect(f.id)}
            >
              {f.label.trim() || fieldCatalogLabel(f.field)}
            </button>
          ))}
        </div>
      )}
      {selected ? (
        <>
          <h4>{fieldCatalogLabel(selected.field)}</h4>
          <Field
            label={selected.field === 'static' ? 'Fixed text' : 'Label (printed before the value)'}
            value={selected.label}
            onChange={(label) => props.onPatch(selected.id, { label })}
          />
          <div className="row wrap">
            <NumField label="Font size (pt)" value={selected.fontSizePt} width={120} onCommit={(fontSizePt) => props.onPatch(selected.id, { fontSizePt })} />
            <Select<FieldBox['pages']>
              label="Print on"
              value={selected.pages}
              width={140}
              onChange={(pages) => props.onPatch(selected.id, { pages })}
              options={PAGE_OPTIONS}
            />
          </div>
          <label className="check">
            <input type="checkbox" checked={selected.bold} onChange={(e) => props.onPatch(selected.id, { bold: e.target.checked })} />
            Bold
          </label>
          <div className="row wrap tight">
            <NumField label="X (mm)" value={selected.xMm} width={64} onCommit={(xMm) => props.onPatch(selected.id, { xMm })} />
            <NumField label="Y (mm)" value={selected.yMm} width={64} onCommit={(yMm) => props.onPatch(selected.id, { yMm })} />
            <NumField label="W (mm)" value={selected.wMm} width={64} onCommit={(wMm) => props.onPatch(selected.id, { wMm })} />
            <NumField label="H (mm)" value={selected.hMm} width={64} onCommit={(hMm) => props.onPatch(selected.id, { hMm })} />
          </div>
          <button type="button" className="small ghost" onClick={() => props.onRemove(selected.id)}>
            Delete field
          </button>
        </>
      ) : (
        <p className="muted small">Select a field on the sheet (or in the list above) to edit it, or add one.</p>
      )}
    </div>
  )
}

export function SectionsPanel(props: {
  kind: DocKind
  sections: SectionSpec[]
  onPatch: (key: SectionKey, patch: Partial<SectionSpec>) => void
  onMove: (key: SectionKey, dir: -1 | 1) => void
}): ReactNode {
  return (
    <div className="card">
      <h3>Sections</h3>
      <p className="muted small">Printed in this order inside the content area.</p>
      <div className="fmt-sections">
        {props.sections.map((s, i) => (
          <div className="fmt-section" key={s.key}>
            <div className="fmt-move">
              <button type="button" className="small ghost" disabled={i === 0} aria-label="Move up" onClick={() => props.onMove(s.key, -1)}>
                ↑
              </button>
              <button
                type="button"
                className="small ghost"
                disabled={i === props.sections.length - 1}
                aria-label="Move down"
                onClick={() => props.onMove(s.key, 1)}
              >
                ↓
              </button>
            </div>
            <input
              type="text"
              value={s.heading}
              placeholder={headingFor(props.kind, s.key)}
              title={`Section: ${headingFor(props.kind, s.key)}`}
              onChange={(e) => props.onPatch(s.key, { heading: e.target.value })}
            />
            <label className="check">
              <input type="checkbox" checked={s.show} onChange={(e) => props.onPatch(s.key, { show: e.target.checked })} />
              show
            </label>
            {!s.show && !HIDEABLE_WHEN_FILLED.includes(s.key) && <p className="fmt-hint">printed anyway if it has content</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

export function ContentPanel(props: {
  t: FormTemplate
  selection: Selection | null
  onSelect: (which: BodyKey) => void
  onBox: (which: BodyKey, box: BoxMm) => void
}): ReactNode {
  const which = props.selection?.type === 'body' ? props.selection.which : null
  const box = which ? props.t[which] : null
  return (
    <div className="card">
      <h3>Content area</h3>
      <div className="row tight">
        <button type="button" className={`small ${which === 'bodyFirst' ? 'active' : ''}`} onClick={() => props.onSelect('bodyFirst')}>
          Page 1
        </button>
        <button type="button" className={`small ${which === 'bodyNext' ? 'active' : ''}`} onClick={() => props.onSelect('bodyNext')}>
          Continuation pages
        </button>
      </div>
      {box && which ? (
        <div className="row wrap tight fmt-nums">
          <NumField label="X (mm)" value={box.xMm} width={64} onCommit={(xMm) => props.onBox(which, { ...box, xMm })} />
          <NumField label="Y (mm)" value={box.yMm} width={64} onCommit={(yMm) => props.onBox(which, { ...box, yMm })} />
          <NumField label="W (mm)" value={box.wMm} width={64} onCommit={(wMm) => props.onBox(which, { ...box, wMm })} />
          <NumField label="H (mm)" value={box.hMm} width={64} onCommit={(hMm) => props.onBox(which, { ...box, hMm })} />
        </div>
      ) : (
        <p className="muted small">Click a content area on the sheet, or a button above, to edit its position.</p>
      )}
    </div>
  )
}
