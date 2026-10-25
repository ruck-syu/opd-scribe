import { useEffect, useState, type ReactNode } from 'react'
import { call } from '../api'
import type { AsrCheck, PreviewResult } from '../../../shared/api'
import type { AppSettings, AuditEntry, LayoutSettings, Role, User } from '../../../shared/types'
import { SECTION_TARGETS, type SectionKey } from '../../../shared/sections'
import { Area, ErrorBox, Field, Modal, Select, fmtDateTime, useAction } from '../components/ui'
import { PdfPreview } from '../components/PdfPreview'
import { FormatSection } from './FormatEditor'

type Section = 'clinic' | 'print' | 'format' | 'speech' | 'users' | 'data' | 'audit'
const SECTIONS: [Section, string][] = [
  ['clinic', 'Clinic & checklists'],
  ['print', 'Letterhead & printing'],
  ['format', 'OPD print format'],
  ['speech', 'Speech recognition'],
  ['users', 'Users'],
  ['data', 'Backup & restore'],
  ['audit', 'Audit log']
]

export function Settings({ user, onRestored }: { user: User; onRestored: () => void }): ReactNode {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [section, setSection] = useState<Section>('clinic')
  const [saved, setSaved] = useState(false)
  const { busy, error, run } = useAction()

  useEffect(() => {
    void run(async () => setSettings(await call('settings.get')))
  }, [])
  if (!settings) return <ErrorBox error={error} />

  const save = (patch: Partial<AppSettings>): Promise<unknown> =>
    run(async () => {
      setSettings(await call('settings.update', patch))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    })

  return (
    <div className="page">
      <div className="page-head">
        <h2>Settings</h2>
        {saved && <span className="pill ok">Saved</span>}
      </div>
      <nav className="tabs">
        {SECTIONS.map(([k, l]) => (
          <button key={k} className={section === k ? 'active' : ''} onClick={() => setSection(k)}>
            {l}
          </button>
        ))}
      </nav>
      <ErrorBox error={error} />
      <div className="tab-body">
        {section === 'clinic' && <ClinicSection settings={settings} save={save} busy={busy} />}
        {section === 'print' && (
          <PrintSection settings={settings} setSettings={setSettings} save={save} busy={busy} onOpenFormats={() => setSection('format')} />
        )}
        {section === 'format' && <FormatSection settings={settings} setSettings={setSettings} busy={busy} role={user.role} />}
        {section === 'speech' && <SpeechSection settings={settings} save={save} busy={busy} />}
        {section === 'users' && <UsersSection me={user} />}
        {section === 'data' && <DataSection onRestored={onRestored} />}
        {section === 'audit' && <AuditSection />}
      </div>
    </div>
  )
}

type SectionProps = { settings: AppSettings; save: (p: Partial<AppSettings>) => Promise<unknown>; busy: boolean }

const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)

function ClinicSection({ settings, save, busy }: SectionProps): ReactNode {
  const [clinic, setClinic] = useState(settings.clinic)
  const [tox, setTox] = useState(settings.toxicityChecklist.join('\n'))
  const [sym, setSym] = useState(settings.symptomChecklist.join('\n'))
  const [formulary, setFormulary] = useState(settings.formulary.join('\n'))
  const [required, setRequired] = useState<SectionKey[]>(settings.requiredFields)
  const [lockMin, setLockMin] = useState(String(settings.autoLockMinutes))
  const [retain, setRetain] = useState(settings.retainAudio)
  return (
    <div className="card">
      <h3>Clinic</h3>
      <Field label="Clinic / hospital name" value={clinic.clinicName} onChange={(v) => setClinic({ ...clinic, clinicName: v })} />
      <Field label="Address" value={clinic.clinicAddress} onChange={(v) => setClinic({ ...clinic, clinicAddress: v })} />
      <Field label="Footer text (printed on every page)" value={clinic.footerText} onChange={(v) => setClinic({ ...clinic, footerText: v })} />
      <h3>Checklists for new visits</h3>
      <p className="muted small">One item per line. Every item starts as “Not assessed” in each visit.</p>
      <div className="two-col">
        <Area label="Toxicity checklist" rows={8} value={tox} onChange={setTox} />
        <Area label="Symptom checklist" rows={8} value={sym} onChange={setSym} />
      </div>
      <h3>Clinic formulary</h3>
      <p className="muted small">Used only to flag possible misspellings. Leave empty to turn off.</p>
      <Area label="Clinic formulary (one medicine per line)" rows={8} value={formulary} onChange={setFormulary} />
      <h3>Required before verification</h3>
      <p className="muted small">A visit cannot be verified until every checked section has text.</p>
      {SECTION_TARGETS.map(([key, label]) => (
        <label key={key} className="check">
          <input
            type="checkbox"
            checked={required.includes(key)}
            onChange={(e) => setRequired(SECTION_TARGETS.map(([k]) => k).filter((k) => (k === key ? e.target.checked : required.includes(k))))}
          />
          {label}
        </label>
      ))}
      <h3>Privacy</h3>
      <Field label="Auto-lock after idle minutes (0 = off)" type="number" width={260} value={lockMin} onChange={setLockMin} />
      <label className="check">
        <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
        Keep raw audio after a transcript is marked reviewed (default: delete)
      </label>
      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            save({
              clinic,
              toxicityChecklist: lines(tox),
              symptomChecklist: lines(sym),
              formulary: lines(formulary),
              requiredFields: required,
              autoLockMinutes: Math.max(0, Math.floor(Number(lockMin) || 0)),
              retainAudio: retain
            })
          }
        >
          Save
        </button>
      </div>
    </div>
  )
}

const MM: [keyof LayoutSettings, string][] = [
  ['marginTopMm', 'Top margin (mm)'],
  ['marginBottomMm', 'Bottom margin (mm)'],
  ['marginLeftMm', 'Left margin (mm)'],
  ['marginRightMm', 'Right margin (mm)'],
  ['offsetXMm', 'Calibration X offset (mm)'],
  ['offsetYMm', 'Calibration Y offset (mm)'],
  ['fontSizePt', 'Font size (pt)']
]

function PrintSection({
  settings,
  setSettings,
  save,
  busy,
  onOpenFormats
}: SectionProps & { setSettings: (s: AppSettings) => void; onOpenFormats: () => void }): ReactNode {
  const [layout, setLayout] = useState(settings.layout)
  const [nums, setNums] = useState<Record<string, string>>(() => Object.fromEntries(MM.map(([k]) => [k, String(settings.layout[k])])))
  const [test, setTest] = useState<PreviewResult | null>(null)
  const { busy: b2, error, run } = useAction()
  const custom = (['note', 'prescription'] as const).filter((k) => settings.formats[k] !== null)

  const parsed = (): LayoutSettings => {
    const next = { ...layout } as Record<string, unknown>
    for (const [k] of MM) {
      const n = Number(nums[k])
      if (!Number.isFinite(n)) throw new Error(`Invalid number for ${k}`)
      next[k] = n
    }
    return next as unknown as LayoutSettings
  }

  return (
    <div className="card">
      <p className="muted small">
        Using your own OPD sheet? Set it up under{' '}
        <button type="button" className="link-btn" onClick={onOpenFormats}>
          OPD print format
        </button>
        .{custom.length > 0 && ` Custom format active for: ${custom.join(' / ')}.`}
      </p>
      <h3>Letterhead</h3>
      <p className="muted small">
        Upload your printed letterhead as PDF, PNG or JPG (A4). Content is placed inside the margins below so it never overlaps the header
        or footer.
      </p>
      <div className="row">
        <span>{settings.letterheadType ? `Letterhead uploaded (${settings.letterheadType.toUpperCase()})` : 'No letterhead — plain A4'}</span>
        <button disabled={b2} onClick={() => run(async () => setSettings(await call('settings.uploadLetterhead')))}>
          Upload…
        </button>
        {settings.letterheadType && (
          <button className="ghost" disabled={b2} onClick={() => run(async () => setSettings(await call('settings.clearLetterhead')))}>
            Remove
          </button>
        )}
      </div>
      <h3>Layout</h3>
      <div className="row wrap">
        {MM.map(([k, l]) => (
          <Field key={k} label={l} type="number" width={170} value={nums[k]} onChange={(v) => setNums({ ...nums, [k]: v })} />
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={layout.letterheadEveryPage} onChange={(e) => setLayout({ ...layout, letterheadEveryPage: e.target.checked })} />
        Letterhead on every page (otherwise first page only)
      </label>
      <label className="check">
        <input type="checkbox" checked={layout.combinedPdf} onChange={(e) => setLayout({ ...layout, combinedPdf: e.target.checked })} />
        Note and prescription in one PDF (otherwise two files)
      </label>
      <ErrorBox error={error} />
      <div className="actions">
        <button
          disabled={b2 || busy}
          onClick={() =>
            run(async () => {
              await save({ layout: parsed() })
              setTest(await call('settings.testPrint'))
            })
          }
        >
          Save & test print
        </button>
        <button className="primary" disabled={busy} onClick={() => run(() => save({ layout: parsed() }))}>
          Save
        </button>
      </div>
      {test && (
        <Modal title="Calibration page" wide onClose={() => setTest(null)}>
          <p className="muted small">
            Print this on your letterhead paper at 100% scale. The rulers should line up; adjust the offsets if they are shifted.
          </p>
          {test.pdfs.map((p) => (
            <PdfPreview key={p.name} data={p.data} />
          ))}
        </Modal>
      )}
    </div>
  )
}

function SpeechSection({ settings, save, busy }: SectionProps): ReactNode {
  const [asr, setAsr] = useState(settings.asr)
  const [threads, setThreads] = useState(String(settings.asr.threads))
  const [check, setCheck] = useState<AsrCheck | null>(null)
  const { busy: b2, error, run } = useAction()
  const pick = (k: 'binaryPath' | 'modelPath', title: string, ext: string[]): Promise<unknown> =>
    run(async () => {
      const p = await call('settings.pickFile', title, ext)
      if (p) setAsr((a) => ({ ...a, [k]: p }))
    })
  const doSave = (): Promise<unknown> =>
    run(async () => {
      await save({ asr: { ...asr, threads: Math.max(1, Math.floor(Number(threads) || 1)) } })
      setCheck(await call('settings.checkAsr'))
    })
  return (
    <div className="card">
      <h3>Offline speech recognition (whisper.cpp)</h3>
      <p className="muted small">
        Point to the whisper-cli executable and a ggml model file. Everything runs on this computer; audio never leaves it. See
        docs/SPEECH_MODEL.md.
      </p>
      <div className="row">
        <Field label="whisper-cli executable" value={asr.binaryPath} onChange={(v) => setAsr({ ...asr, binaryPath: v })} />
        <button disabled={b2} onClick={() => pick('binaryPath', 'Choose whisper-cli', ['exe', '*'])}>
          Browse…
        </button>
      </div>
      <div className="row">
        <Field label="Model file (.bin)" value={asr.modelPath} onChange={(v) => setAsr({ ...asr, modelPath: v })} />
        <button disabled={b2} onClick={() => pick('modelPath', 'Choose model', ['bin', 'gguf'])}>
          Browse…
        </button>
      </div>
      <div className="row wrap">
        <Select
          label="Language"
          width={200}
          value={asr.language}
          onChange={(language) => setAsr({ ...asr, language })}
          options={[
            ['hi', 'Hindi (with English terms)'],
            ['en', 'English'],
            ['auto', 'Auto-detect']
          ]}
        />
        <Field label="CPU threads" type="number" width={120} value={threads} onChange={setThreads} />
      </div>
      <Area
        label="Vocabulary hint (drug names, regimens, terms the model should expect)"
        rows={3}
        value={asr.initialPrompt}
        onChange={(initialPrompt) => setAsr({ ...asr, initialPrompt })}
      />
      <ErrorBox error={error} />
      {check && <div className={`notice ${check.binaryOk && check.modelOk ? 'ok' : ''}`}>{check.message}</div>}
      <div className="actions">
        <button disabled={b2} onClick={() => run(async () => setCheck(await call('settings.checkAsr')))}>
          Check
        </button>
        <button className="primary" disabled={busy || b2} onClick={() => void doSave()}>
          Save
        </button>
      </div>
    </div>
  )
}

const blankUser = { name: '', role: 'staff' as Role, registrationNo: '', qualifications: '', pin: '' }

function UsersSection({ me }: { me: User }): ReactNode {
  const [users, setUsers] = useState<User[]>([])
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(blankUser)
  const [pinFor, setPinFor] = useState<User | null>(null)
  const [newPin, setNewPin] = useState('')
  const { busy, error, run } = useAction()
  const load = (): Promise<unknown> => run(async () => setUsers(await call('users.list')))
  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="card">
      <div className="row">
        <h3>Users</h3>
        <div className="spacer" />
        <button onClick={() => setAdding(true)}>+ Add user</button>
      </div>
      <p className="muted small">Doctors can verify, amend and change settings. Staff can register patients and prepare drafts.</p>
      <ErrorBox error={error} />
      <table className="list">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Registration</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'dim'}>
              <td>
                {u.name}
                {u.id === me.id && <span className="muted"> (you)</span>}
              </td>
              <td>{u.role}</td>
              <td>{u.registrationNo || '—'}</td>
              <td>{u.active ? 'Active' : 'Deactivated'}</td>
              <td className="row tight">
                <button className="small" onClick={() => setPinFor(u)}>
                  Reset PIN
                </button>
                {u.id !== me.id && (
                  <button
                    className="small ghost"
                    disabled={busy}
                    onClick={() => run(async () => (await call('users.update', u.id, { active: !u.active }), await load()))}
                  >
                    {u.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {adding && (
        <Modal title="Add user" onClose={() => setAdding(false)}>
          <Field label="Full name" value={form.name} onChange={(name) => setForm({ ...form, name })} required autoFocus />
          <Select<Role>
            label="Role"
            value={form.role}
            onChange={(role) => setForm({ ...form, role })}
            options={[
              ['staff', 'Staff'],
              ['doctor', 'Doctor']
            ]}
          />
          {form.role === 'doctor' && (
            <>
              <Field label="Registration no." value={form.registrationNo} onChange={(registrationNo) => setForm({ ...form, registrationNo })} />
              <Field label="Qualifications" value={form.qualifications} onChange={(qualifications) => setForm({ ...form, qualifications })} />
            </>
          )}
          <Field label="PIN (4–8 digits)" type="password" value={form.pin} onChange={(pin) => setForm({ ...form, pin })} required />
          <ErrorBox error={error} />
          <div className="actions">
            <button onClick={() => setAdding(false)}>Cancel</button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await call('users.create', form)
                  setForm(blankUser)
                  setAdding(false)
                  await load()
                })
              }
            >
              Create
            </button>
          </div>
        </Modal>
      )}

      {pinFor && (
        <Modal title={`Set PIN for ${pinFor.name}`} onClose={() => setPinFor(null)}>
          <Field label="New PIN (4–8 digits)" type="password" value={newPin} onChange={setNewPin} autoFocus />
          <ErrorBox error={error} />
          <div className="actions">
            <button onClick={() => setPinFor(null)}>Cancel</button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await call('users.setPin', pinFor.id, newPin)
                  setNewPin('')
                  setPinFor(null)
                })
              }
            >
              Set PIN
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function DataSection({ onRestored }: { onRestored: () => void }): ReactNode {
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [restorePass, setRestorePass] = useState('')
  const [msg, setMsg] = useState('')
  const { busy, error, setError, run } = useAction()
  return (
    <div className="card">
      <h3>Encrypted backup</h3>
      <p className="muted small">
        Creates a single passphrase-encrypted file with all patients, visits and retained audio. Store it on a USB drive. Without the
        passphrase it cannot be opened — write it down somewhere safe.
      </p>
      <div className="row wrap">
        <Field label="Passphrase (min 8 characters)" type="password" value={pass} onChange={setPass} width={260} />
        <Field label="Repeat passphrase" type="password" value={pass2} onChange={setPass2} width={260} />
        <button
          className="primary"
          disabled={busy || pass.length < 8}
          onClick={() => {
            if (pass !== pass2) return setError('Passphrases do not match')
            void run(async () => {
              const path = await call('backup.create', pass)
              if (path) setMsg(`Backup saved to ${path}`)
              setPass('')
              setPass2('')
            })
          }}
        >
          Create backup…
        </button>
      </div>
      <h3>Restore</h3>
      <p className="muted small">
        Restoring <b>replaces all data on this computer</b> with the backup contents. You will be signed out.
      </p>
      <div className="row wrap">
        <Field label="Backup passphrase" type="password" value={restorePass} onChange={setRestorePass} width={260} />
        <button
          disabled={busy || !restorePass}
          onClick={() =>
            confirm('Replace ALL current data with the backup? This cannot be undone.') &&
            void run(async () => {
              if (await call('backup.restore', restorePass)) onRestored()
            })
          }
        >
          Restore from file…
        </button>
      </div>
      <ErrorBox error={error} />
      {msg && <div className="notice ok">{msg}</div>}
    </div>
  )
}

function AuditSection(): ReactNode {
  const [rows, setRows] = useState<AuditEntry[]>([])
  const { error, run } = useAction()
  useEffect(() => {
    void run(async () => setRows(await call('audit.list', 300)))
  }, [])
  return (
    <div className="card">
      <h3>Audit log (latest 300)</h3>
      <ErrorBox error={error} />
      <div className="scroll-box">
        <table className="list compact">
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.at)}</td>
                <td className="mono small">{r.userId.slice(0, 8)}</td>
                <td>{r.action}</td>
                <td>
                  {r.entity} <span className="mono small dim">{r.entityId.slice(0, 8)}</span>
                </td>
                <td className="small">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
