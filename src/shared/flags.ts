import type { Patient, ReviewFlag, Transcript, VisitDocument } from './types'

/** Short FNV-1a hex hash; used to bind an acknowledgement to the content it was made about. */
function fingerprint(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Lowercase, anything but letters/digits (any script) collapsed to single spaces. */
const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

interface FormularyEntry {
  raw: string
  norm: string
}

/**
 * null when the medication name contains a formulary entry as whole words
 * ("Tab. Ondansetron 8 mg" matches "ondansetron"); otherwise the closest entry
 * within edit distance 2 of the whole name or one of its words, if any.
 */
function formularyMiss(medName: string, entries: FormularyEntry[]): { closest: string | null } | null {
  const name = normalise(medName)
  if (entries.some((e) => ` ${name} `.includes(` ${e.norm} `))) return null
  // words shorter than 4 letters (tab, mg, od) would match short entries by accident
  const candidates = [name, ...name.split(' ').filter((w) => w.length >= 4)]
  let closest: string | null = null
  let best = 3
  for (const e of entries) {
    const d = Math.min(...candidates.map((c) => levenshtein(e.norm, c)))
    if (d < best) {
      best = d
      closest = e.raw
    }
  }
  return { closest }
}

/**
 * Deterministic review flags (REV-03..05). Blocking flags prevent verification;
 * warnings must each be acknowledged by the doctor before verification.
 * Nothing here infers or fills clinical content; the formulary only flags names.
 */
export function computeFlags(
  patient: Patient,
  doc: VisitDocument,
  transcripts: Transcript[],
  formulary: string[] = []
): ReviewFlag[] {
  const flags: ReviewFlag[] = []
  // content = what the flag is about; the ack stops counting once it changes
  const push = (
    severity: ReviewFlag['severity'],
    id: string,
    area: ReviewFlag['area'],
    message: string,
    content = ''
  ): void => {
    flags.push({ id, ackKey: `${id}#${fingerprint(content)}`, severity, area, message })
  }
  const block = (id: string, area: ReviewFlag['area'], message: string, content = ''): void =>
    push('blocking', id, area, message, content)
  const warn = (id: string, area: ReviewFlag['area'], message: string, content = ''): void =>
    push('warning', id, area, message, content)
  const empty = (s: string | null | undefined): boolean => !s || !s.trim()
  const entries: FormularyEntry[] = formulary.map((e) => ({ raw: e.trim(), norm: normalise(e) })).filter((e) => e.norm)

  if (empty(patient.name)) block('identity.name', 'identity', 'Patient name is missing')
  if (empty(patient.mrn)) block('identity.mrn', 'identity', 'Patient MRN is missing')
  if (empty(patient.dateOfBirth) && empty(patient.ageDisplay))
    block('identity.age', 'identity', 'Patient age / date of birth is missing')
  if (empty(doc.visitDateTime)) block('identity.visitDate', 'identity', 'Visit date is missing')

  doc.prescription.medications.forEach((m, i) => {
    const label = empty(m.name) ? `Medicine #${i + 1}` : m.name.trim()
    const missing = (
      [
        ['name', m.name],
        ['dose', m.dose],
        ['route', m.route],
        ['frequency', m.frequency],
        ['duration', m.duration]
      ] as const
    )
      .filter(([, v]) => empty(v))
      .map(([k]) => k)
    if (missing.length) block(`rx.${m.id}.incomplete`, 'prescription', `${label}: missing ${missing.join(', ')}`)

    if (!entries.length || empty(m.name)) return
    // spelling hint only; the medication itself is never changed
    const miss = formularyMiss(m.name, entries)
    if (miss)
      warn(
        `rx.${m.id}.formulary`,
        'prescription',
        `${m.name.trim()}: not in the clinic formulary — check the spelling${miss.closest ? ` (closest: ${miss.closest})` : ''}`,
        m.name
      )
  })

  const { decision, reason } = doc.oncology.clearance
  if ((decision === 'no' || decision === 'defer') && empty(reason))
    block('onc.clearance.reason', 'oncology', 'Treatment not cleared / deferred without a documented reason')

  for (const t of transcripts) {
    const what = t.kind === 'conversation' ? 'Conversation transcript' : `Dictation (${t.section ?? 'unassigned'})`
    const area = t.kind === 'conversation' ? 'transcript' : 'dictation'
    if (t.status === 'transcribing') block(`tx.${t.id}.pending`, area, `${what} is still transcribing`)
    if (t.status === 'failed')
      warn(`tx.${t.id}.failed`, area, `${what} failed to transcribe: ${t.error || 'unknown error'}`, t.error)
    if (t.status !== 'ready') continue
    if (!t.reviewed) warn(`tx.${t.id}.unreviewed`, area, `${what} has not been marked reviewed`)
    const uncertain = t.segments.filter((s) => s.speakerUncertain)
    if (t.kind === 'conversation' && uncertain.length)
      warn(
        `tx.${t.id}.speakers`,
        area,
        `${what} has segments with unconfirmed speaker`,
        uncertain.map((s) => s.id).join(',')
      )
    const warned = t.segments.filter((s) => s.warning)
    if (warned.length)
      warn(
        `tx.${t.id}.warnings`,
        area,
        `${what} has ${warned.length} segment(s) flagged as possibly unreliable`,
        warned.map((s) => `${s.id}:${s.text}:${s.warning}`).join('|')
      )
  }

  if (doc.oncology.ecog === null) warn('onc.ecog', 'oncology', 'ECOG performance status not recorded')
  if (doc.oncology.clearance.decision === 'not_documented' && !empty(doc.oncology.regimen))
    warn('onc.clearance', 'oncology', 'Patient is on a regimen but treatment clearance is not documented', doc.oncology.regimen)
  if (empty(doc.assessment.text)) warn('note.assessment', 'note', 'Assessment is empty')
  if (empty(doc.plan.text)) warn('note.plan', 'note', 'Plan is empty')
  if (empty(doc.prescription.followUp.text)) warn('rx.followUp', 'prescription', 'Follow-up is not documented')

  return flags
}

export function blockingFlags(flags: ReviewFlag[]): ReviewFlag[] {
  return flags.filter((f) => f.severity === 'blocking')
}

export function unacknowledgedWarnings(flags: ReviewFlag[], acknowledged: string[]): ReviewFlag[] {
  const ack = new Set(acknowledged)
  return flags.filter((f) => f.severity === 'warning' && !ack.has(f.ackKey))
}

/** True when the doctor is allowed to verify. */
export function canVerify(flags: ReviewFlag[], acknowledged: string[]): boolean {
  return blockingFlags(flags).length === 0 && unacknowledgedWarnings(flags, acknowledged).length === 0
}
