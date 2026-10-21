import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readEncrypted, writeEncrypted } from './crypto'
import { DEFAULT_SETTINGS, uid } from '../shared/defaults'
import type {
  AppSettings,
  AuditEntry,
  Encounter,
  EncounterSummary,
  OncologySummary,
  Patient,
  PatientInput,
  Revision,
  Role,
  Transcript,
  User
} from '../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, registration_no TEXT NOT NULL DEFAULT '',
  qualifications TEXT NOT NULL DEFAULT '', pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, mrn TEXT NOT NULL UNIQUE, name TEXT NOT NULL, dob TEXT, age_display TEXT NOT NULL DEFAULT '',
  sex TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS patients_name ON patients(name);
CREATE TABLE IF NOT EXISTS oncology_summary (patient_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS summary_history (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, status TEXT NOT NULL,
  document TEXT NOT NULL, verified_hash TEXT, amendment_reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS encounters_patient ON encounters(patient_id);
CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, encounter_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS transcripts_encounter ON transcripts(encounter_id);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY, encounter_id TEXT NOT NULL, revision_no INTEGER NOT NULL, hash TEXT NOT NULL,
  verified_by TEXT NOT NULL, verified_by_name TEXT NOT NULL, verified_at TEXT NOT NULL,
  amendment_reason TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL, UNIQUE (encounter_id, revision_no));
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL,
  entity_id TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE TRIGGER IF NOT EXISTS revisions_immutable BEFORE UPDATE ON revisions
  BEGIN SELECT RAISE(ABORT, 'verified revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS revisions_nodelete BEFORE DELETE ON revisions
  BEGIN SELECT RAISE(ABORT, 'verified revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_immutable BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`

type Row = Record<string, SqlValue>
const now = (): string => new Date().toISOString()

export async function openSqlJs(): Promise<initSqlJs.SqlJsStatic> {
  const require = createRequire(__filename)
  const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))
  return initSqlJs({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer })
}

export class Store {
  private depth = 0

  private constructor(
    private db: Database,
    private readonly SQL: initSqlJs.SqlJsStatic,
    private readonly path: string,
    private readonly key: Buffer
  ) {}

  static async open(path: string, key: Buffer): Promise<Store> {
    const SQL = await openSqlJs()
    const db = existsSync(path) ? new SQL.Database(readEncrypted(key, path)) : new SQL.Database()
    const store = new Store(db, SQL, path, key)
    store.migrate()
    return store
  }

  /** In-memory store for tests. */
  static async memory(): Promise<Store> {
    const SQL = await openSqlJs()
    const store = new Store(new SQL.Database(), SQL, '', Buffer.alloc(32))
    store.migrate()
    return store
  }

  private migrate(): void {
    this.db.exec(SCHEMA)
    this.db.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`)
    this.persist()
  }

  persist(): void {
    if (!this.path) return
    writeEncrypted(this.key, this.path, Buffer.from(this.db.export()))
  }

  exportPlain(): Buffer {
    return Buffer.from(this.db.export())
  }

  /** Replace the whole database (backup restore). */
  replaceWith(plain: Buffer): void {
    const next = new this.SQL.Database(plain)
    next.exec('SELECT count(*) FROM patients') // throws if not an OPD db
    this.db.close()
    this.db = next
    this.migrate()
  }

  private all(sql: string, params: SqlValue[] = []): Row[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      const rows: Row[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as Row)
      return rows
    } finally {
      stmt.free()
    }
  }

  private get(sql: string, params: SqlValue[] = []): Row | undefined {
    return this.all(sql, params)[0]
  }

  private run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params)
  }

  /** Run several statements atomically and persist once. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.depth++
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      this.persist()
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    } finally {
      this.depth--
    }
  }

  // ---------- settings & blobs ----------

  getSettings(): AppSettings {
    const row = this.get(`SELECT value FROM meta WHERE key = 'settings'`)
    const saved = row ? (JSON.parse(String(row.value)) as Partial<AppSettings>) : {}
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      clinic: { ...DEFAULT_SETTINGS.clinic, ...saved.clinic },
      layout: { ...DEFAULT_SETTINGS.layout, ...saved.layout },
      asr: { ...DEFAULT_SETTINGS.asr, ...saved.asr },
      formats: { ...DEFAULT_SETTINGS.formats, ...saved.formats }
    }
  }

  saveSettings(s: AppSettings): void {
    this.tx(() => this.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', ?)`, [JSON.stringify(s)]))
  }

  getBlob(key: string): Buffer | null {
    const row = this.get(`SELECT data FROM blobs WHERE key = ?`, [key])
    return row ? Buffer.from(row.data as Uint8Array) : null
  }

  setBlob(key: string, data: Buffer | null): void {
    this.tx(() => {
      if (data) this.run(`INSERT OR REPLACE INTO blobs (key, data) VALUES (?, ?)`, [key, new Uint8Array(data)])
      else this.run(`DELETE FROM blobs WHERE key = ?`, [key])
    })
  }

  // ---------- users ----------

  private toUser(r: Row): User {
    return {
      id: String(r.id),
      name: String(r.name),
      role: String(r.role) as Role,
      registrationNo: String(r.registration_no),
      qualifications: String(r.qualifications),
      active: r.active === 1
    }
  }

  userCount(): number {
    return Number(this.get(`SELECT count(*) AS n FROM users`)?.n ?? 0)
  }

  listUsers(): User[] {
    return this.all(`SELECT * FROM users ORDER BY name`).map((r) => this.toUser(r))
  }

  getUser(id: string): User | null {
    const r = this.get(`SELECT * FROM users WHERE id = ?`, [id])
    return r ? this.toUser(r) : null
  }

  getPinHash(id: string): string | null {
    const r = this.get(`SELECT pin_hash FROM users WHERE id = ? AND active = 1`, [id])
    return r ? String(r.pin_hash) : null
  }

  createUser(u: Omit<User, 'id' | 'active'>, pinHash: string): User {
    const id = uid()
    this.tx(() =>
      this.run(
        `INSERT INTO users (id, name, role, registration_no, qualifications, pin_hash, active, created_at) VALUES (?,?,?,?,?,?,1,?)`,
        [id, u.name, u.role, u.registrationNo, u.qualifications, pinHash, now()]
      )
    )
    return this.getUser(id)!
  }

  updateUser(u: User): User {
    this.tx(() =>
      this.run(`UPDATE users SET name=?, role=?, registration_no=?, qualifications=?, active=? WHERE id=?`, [
        u.name,
        u.role,
        u.registrationNo,
        u.qualifications,
        u.active ? 1 : 0,
        u.id
      ])
    )
    return this.getUser(u.id)!
  }

  setPinHash(id: string, pinHash: string): void {
    this.tx(() => this.run(`UPDATE users SET pin_hash=? WHERE id=?`, [pinHash, id]))
  }

  // ---------- patients ----------

  private toPatient(r: Row): Patient {
    return {
      id: String(r.id),
      mrn: String(r.mrn),
      name: String(r.name),
      dateOfBirth: r.dob ? String(r.dob) : null,
      ageDisplay: String(r.age_display),
      sex: String(r.sex) as Patient['sex'],
      phone: String(r.phone),
      address: String(r.address),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at)
    }
  }

  searchPatients(query: string, limit = 50): Patient[] {
    const q = query.trim()
    if (!q) return this.all(`SELECT * FROM patients ORDER BY updated_at DESC LIMIT ?`, [limit]).map((r) => this.toPatient(r))
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    return this.all(
      `SELECT * FROM patients WHERE mrn LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
       ORDER BY (mrn = ?) DESC, name LIMIT ?`,
      [like, like, like, q, limit]
    ).map((r) => this.toPatient(r))
  }

  getPatient(id: string): Patient | null {
    const r = this.get(`SELECT * FROM patients WHERE id = ?`, [id])
    return r ? this.toPatient(r) : null
  }

  mrnExists(mrn: string, exceptId = ''): boolean {
    return !!this.get(`SELECT 1 AS x FROM patients WHERE mrn = ? AND id != ?`, [mrn.trim(), exceptId])
  }

  existingMrns(mrns: string[]): string[] {
    const set = new Set(this.all(`SELECT mrn FROM patients`).map((r) => String(r.mrn)))
    return mrns.filter((m) => set.has(m))
  }

  private insertPatient(p: PatientInput): string {
    const id = uid()
    const t = now()
    this.run(
      `INSERT INTO patients (id, mrn, name, dob, age_display, sex, phone, address, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, p.mrn.trim(), p.name.trim(), p.dateOfBirth, p.ageDisplay, p.sex, p.phone, p.address, t, t]
    )
    return id
  }

  createPatient(p: PatientInput): Patient {
    return this.getPatient(this.tx(() => this.insertPatient(p)))!
  }

  importPatients(rows: PatientInput[]): { imported: number; skipped: number } {
    let imported = 0
    let skipped = 0
    this.tx(() => {
      for (const r of rows) {
        if (!r.mrn.trim() || !r.name.trim() || this.mrnExists(r.mrn)) {
          skipped++
          continue
        }
        this.insertPatient(r)
        imported++
      }
    })
    return { imported, skipped }
  }

  updatePatient(id: string, p: PatientInput): Patient {
    this.tx(() =>
      this.run(`UPDATE patients SET mrn=?, name=?, dob=?, age_display=?, sex=?, phone=?, address=?, updated_at=? WHERE id=?`, [
        p.mrn.trim(),
        p.name.trim(),
        p.dateOfBirth,
        p.ageDisplay,
        p.sex,
        p.phone,
        p.address,
        now(),
        id
      ])
    )
    return this.getPatient(id)!
  }

  // ---------- oncology summary ----------

  getSummary(patientId: string): OncologySummary {
    const r = this.get(`SELECT json FROM oncology_summary WHERE patient_id = ?`, [patientId])
    return r ? (JSON.parse(String(r.json)) as OncologySummary) : {}
  }

  saveSummary(patientId: string, summary: OncologySummary, key: string, value: string, by: string): void {
    this.tx(() => {
      this.run(`INSERT OR REPLACE INTO oncology_summary (patient_id, json) VALUES (?, ?)`, [patientId, JSON.stringify(summary)])
      this.run(`INSERT INTO summary_history (id, patient_id, key, value, at, by) VALUES (?,?,?,?,?,?)`, [
        uid(),
        patientId,
        key,
        value,
        now(),
        by
      ])
    })
  }

  // ---------- encounters ----------

  private toEncounter(r: Row): Encounter {
    return {
      id: String(r.id),
      patientId: String(r.patient_id),
      createdAt: String(r.created_at),
      createdBy: String(r.created_by),
      status: String(r.status) as Encounter['status'],
      document: JSON.parse(String(r.document)),
      verifiedHash: r.verified_hash ? String(r.verified_hash) : null,
      amendmentReason: String(r.amendment_reason)
    }
  }

  listEncounters(patientId: string): EncounterSummary[] {
    return this.all(
      `SELECT e.id, e.patient_id, e.status, e.created_at, json_extract(e.document, '$.visitDateTime') AS visit,
         (SELECT count(*) FROM revisions r WHERE r.encounter_id = e.id) AS revs
       FROM encounters e WHERE e.patient_id = ? ORDER BY e.created_at DESC`,
      [patientId]
    ).map((r) => ({
      id: String(r.id),
      patientId: String(r.patient_id),
      visitDateTime: String(r.visit ?? ''),
      status: String(r.status) as Encounter['status'],
      createdAt: String(r.created_at),
      revisionCount: Number(r.revs)
    }))
  }

  getEncounter(id: string): Encounter | null {
    const r = this.get(`SELECT * FROM encounters WHERE id = ?`, [id])
    return r ? this.toEncounter(r) : null
  }

  insertEncounter(e: Encounter): Encounter {
    this.tx(() =>
      this.run(
        `INSERT INTO encounters (id, patient_id, created_at, created_by, status, document, verified_hash, amendment_reason, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [e.id, e.patientId, e.createdAt, e.createdBy, e.status, JSON.stringify(e.document), e.verifiedHash, e.amendmentReason, now()]
      )
    )
    return this.getEncounter(e.id)!
  }

  private updateEncounterRow(e: Encounter): void {
    this.run(`UPDATE encounters SET status=?, document=?, verified_hash=?, amendment_reason=?, updated_at=? WHERE id=?`, [
      e.status,
      JSON.stringify(e.document),
      e.verifiedHash,
      e.amendmentReason,
      now(),
      e.id
    ])
  }

  updateEncounter(e: Encounter): Encounter {
    this.tx(() => this.updateEncounterRow(e))
    return this.getEncounter(e.id)!
  }

  /** Atomically append an immutable revision and mark the encounter verified. */
  verifyEncounter(e: Encounter, rev: Revision): Encounter {
    this.tx(() => {
      this.run(
        `INSERT INTO revisions (id, encounter_id, revision_no, hash, verified_by, verified_by_name, verified_at, amendment_reason, snapshot)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          rev.id,
          rev.encounterId,
          rev.revisionNo,
          rev.hash,
          rev.verifiedBy,
          rev.verifiedByName,
          rev.verifiedAt,
          rev.amendmentReason,
          JSON.stringify(rev.snapshot)
        ]
      )
      this.updateEncounterRow(e)
    })
    return this.getEncounter(e.id)!
  }

  listRevisions(encounterId: string): Revision[] {
    return this.all(`SELECT * FROM revisions WHERE encounter_id = ? ORDER BY revision_no`, [encounterId]).map((r) => ({
      id: String(r.id),
      encounterId: String(r.encounter_id),
      revisionNo: Number(r.revision_no),
      hash: String(r.hash),
      verifiedBy: String(r.verified_by),
      verifiedByName: String(r.verified_by_name),
      verifiedAt: String(r.verified_at),
      amendmentReason: String(r.amendment_reason),
      snapshot: JSON.parse(String(r.snapshot))
    }))
  }

  // ---------- transcripts ----------

  listTranscripts(encounterId: string): Transcript[] {
    return this.all(`SELECT json FROM transcripts WHERE encounter_id = ? ORDER BY created_at`, [encounterId]).map(
      (r) => JSON.parse(String(r.json)) as Transcript
    )
  }

  getTranscript(id: string): Transcript | null {
    const r = this.get(`SELECT json FROM transcripts WHERE id = ?`, [id])
    return r ? (JSON.parse(String(r.json)) as Transcript) : null
  }

  saveTranscript(t: Transcript): Transcript {
    this.tx(() =>
      this.run(`INSERT OR REPLACE INTO transcripts (id, encounter_id, json, created_at) VALUES (?,?,?,?)`, [
        t.id,
        t.encounterId,
        JSON.stringify(t),
        t.createdAt
      ])
    )
    return t
  }

  deleteTranscript(id: string): void {
    this.tx(() => this.run(`DELETE FROM transcripts WHERE id = ?`, [id]))
  }

  /** Transcripts left in 'transcribing' by a crash/quit. */
  interruptedTranscripts(): Transcript[] {
    return this.all(`SELECT json FROM transcripts WHERE json_extract(json, '$.status') = 'transcribing'`).map(
      (r) => JSON.parse(String(r.json)) as Transcript
    )
  }

  // ---------- audit ----------

  audit(userId: string, action: string, entity: string, entityId: string, detail = ''): void {
    this.tx(() =>
      this.run(`INSERT INTO audit (id, at, user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?,?)`, [
        uid(),
        now(),
        userId,
        action,
        entity,
        entityId,
        detail
      ])
    )
  }

  listAudit(limit: number): AuditEntry[] {
    return this.all(`SELECT * FROM audit ORDER BY at DESC LIMIT ?`, [limit]).map((r) => ({
      id: String(r.id),
      at: String(r.at),
      userId: String(r.user_id),
      action: String(r.action),
      entity: String(r.entity),
      entityId: String(r.entity_id),
      detail: String(r.detail)
    }))
  }
}
