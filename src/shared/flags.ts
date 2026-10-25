import type { Finding, Medication, Patient, ReviewFlag, Transcript, VisitDocument } from './types'
import { SECTION_TARGETS, getSection, sectionLabel, type SectionKey } from './sections'

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

const tokens = (s: string): string[] => normalise(s).split(' ').filter(Boolean)

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

const MED_TEXT_FIELDS = ['dose', 'formulationStrength', 'frequency', 'duration', 'quantity'] as const

/** Abbreviations misread on paper, with what to write instead (ISMP do-not-use style). */
const MISREAD_ABBREVIATIONS: [string, string][] = [
  ['u', 'write "units"'],
  ['iu', 'write "international units"'],
  ['cc', 'write "mL"'],
  ['qd', 'write "once daily"'],
  ['ug', 'write "mcg" or "µg"']
]

/** Ambiguous number / abbreviation problems in one medication's text fields. */
function medicationIssues(m: Medication): string[] {
  const issues: string[] = []
  for (const field of MED_TEXT_FIELDS) {
    const v = m[field].trim()
    if (!v) continue
    const at = `${field} "${v}"`
    // 1-0-1 is the standard morning-noon-night schedule, not a range
    const noSchedule = v.replace(/\p{N}(?:\s*-\s*\p{N}){2,3}/gu, ' ')
    if (/(?<![\p{N}.])\.\p{N}/u.test(v)) issues.push(`${at}: missing leading zero`)
    if (/(?<!\p{N})\p{N}+\.\p{N}*0(?!\p{N})/u.test(v)) issues.push(`${at}: trailing zero can be read as ten times the amount`)
    if (/\p{N}\s*(?:[-–]|\bto\b)\s*\p{N}/iu.test(noSchedule)) issues.push(`${at}: range`)
    if (/\p{N}\s*\/\s*\p{N}|[½¼¾⅓⅔]/u.test(v)) issues.push(`${at}: fraction`)
    if ((field === 'dose' || field === 'formulationStrength') && /\p{N}/u.test(v) && !/[\p{L}%]/u.test(v))
      issues.push(`${at}: no unit`)
    for (const [abbr, hint] of MISREAD_ABBREVIATIONS)
      if (new RegExp(`(?<![\\p{L}\\p{N}])${abbr}(?![\\p{L}\\p{N}])`, 'iu').test(v))
        issues.push(`${at}: "${abbr}" is easily misread — ${hint}`)
  }
  return issues
}

/** Vague references to a day. Ignored when the same field also carries an explicit date. */
const RELATIVE_DATE =
  /(?<!\p{L})(?:next\s+(?:week|month|year|fortnight)|tomorrow|tmrw|kal|parso(?:n)?|after\s+(?:some|a\s+few|few|a\s+couple\s+of|couple\s+of|several)\s+(?:days|weeks|months|time)|after\s+(?:a\s+while|sometime)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?!\p{L})/iu
const SOS = /(?<!\p{L})sos(?!\p{L})/iu
const EXPLICIT_DATE =
  /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i

/** The first relative reference in a date field, or null. SOS only counts for follow-up. */
function relativeDate(text: string, sos: boolean): string | null {
  if (EXPLICIT_DATE.test(text)) return null
  const hit = text.match(RELATIVE_DATE) ?? (sos ? text.match(SOS) : null)
  return hit ? hit[0] : null
}

const LEFT = /(?<![\p{L}\p{N}])(?:left|baayan|baaya|lt(?!-\p{L}))(?![\p{L}\p{N}])/iu
const RIGHT = /(?<![\p{L}\p{N}])(?:right|daayan|daaya|rt(?!-\p{L}))(?![\p{L}\p{N}])/iu

/** Double negatives: "not without", "not un-", and "no/nahi ... not/nahi" within about six words. */
const DOUBLE_NEGATIVE =
  /\bnot\s+without\b|\bnot\s+un(?!der|til\b|less\b)[a-z]+|\bno\b(?:\s+[\p{L}'-]+){0,5}?\s+not\b|\b(nahi|nahin|nhi)\b(?:\s+[\p{L}'-]+){0,5}?\s+(?:nahi|nahin|nhi)\b/iu

/** Words that deny a finding when they sit before it (within 6 words) or right after it. */
const NEGATION = new Set(['no', 'not', 'nil', 'denies', 'denied', 'denying', 'without', 'absent', 'negative', 'nahi', 'nahin', 'nhi', 'nai'])
const NEGATED_AFTER = new Set(['nahi', 'nahin', 'nhi', 'nai', 'absent', 'negative', 'nil'])
/** Contrast and clause words end a negation's reach ("no fever, but nausea" affirms nausea). */
const CLAUSE_BREAK = new Set(['but', 'however', 'although', 'though', 'except', 'yet', 'also', 'still', 'has', 'have', 'had', 'is', 'was', 'are'])
/** A finding followed by these has resolved: neither affirmed nor denied. */
const RESOLVED = new Set(['resolved', 'resolving', 'subsided', 'settled', 'gone', 'better', 'improved', 'relieved'])

/** Narrative sections where a symptom or toxicity can be affirmed or denied. */
const NARRATIVE: SectionKey[] = ['history.chiefComplaints', 'history.hpi', 'examination']

/** Name plus each "/"-separated part of 5+ letters, so "Nausea / vomiting" matches either word. */
function nameVariants(name: string): string[][] {
  const parts = name.includes('/') ? name.split('/').map(tokens).filter((p) => p.join('').length >= 5) : []
  return [tokens(name), ...parts].filter((v) => v.length)
}

interface Mention {
  negated: boolean
  clause: string
}

/** Each mention of a finding name in free text, with whether a negation cue sits beside it. */
function mentionsOf(text: string, name: string): Mention[] {
  const variants = nameVariants(name)
  const out: Mention[] = []
  // sentence breaks end a negation's reach; commas do not, so "denies nausea, vomiting" covers both
  for (const clause of text.split(/[.;!?\n]+/)) {
    const toks = tokens(clause)
    for (const v of variants)
      for (let i = 0; i + v.length <= toks.length; i++) {
        if (v.some((w, j) => toks[i + j] !== w)) continue
        const after = toks.slice(i + v.length, i + v.length + 2)
        if (after.some((w) => RESOLVED.has(w))) continue
        const window = toks.slice(Math.max(0, i - 6), i)
        const before = window.slice(window.reduce((at, w, j) => (CLAUSE_BREAK.has(w) ? j + 1 : at), 0))
        out.push({
          negated: before.some((w) => NEGATION.has(w)) || after.some((w) => NEGATED_AFTER.has(w)),
          clause: clause.trim()
        })
      }
  }
  return out
}

/** Standard area for a section key, as used by ReviewFlag. */
function sectionArea(key: SectionKey): ReviewFlag['area'] {
  if (key.startsWith('history.')) return 'history'
  if (key.startsWith('oncology.')) return 'oncology'
  if (key.startsWith('prescription.')) return 'prescription'
  return 'note'
}

/**
 * Deterministic review flags (REV-03..05). Blocking flags prevent verification;
 * warnings must each be acknowledged by the doctor before verification.
 * Nothing here infers or fills clinical content; the formulary only flags names,
 * and the text rules only point at wording for the doctor to check.
 */
export function computeFlags(
  patient: Patient,
  doc: VisitDocument,
  transcripts: Transcript[],
  formulary: string[] = [],
  requiredFields: SectionKey[] = []
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
  const checklist: Finding[] = [...doc.history.symptoms, ...doc.oncology.toxicities]

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

    const issues = medicationIssues(m)
    if (issues.length)
      warn(
        `rx.${m.id}.ambiguous`,
        'prescription',
        `${label}: ambiguous entry — ${issues.join('; ')}`,
        [m.dose, m.formulationStrength, m.frequency, m.duration, m.quantity].join('|')
      )

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
    const pending = (t.suggestions ?? []).filter((s) => s.status === 'pending').map((s) => s.id).sort()
    if (pending.length)
      warn(
        `tx.${t.id}.suggestions`,
        area,
        `${what} has ${pending.length} suggestion(s) not yet accepted or dismissed`,
        pending.join(',')
      )
    if (t.kind === 'conversation') {
      // questions are not statements; a denial and an affirmation in different segments clash
      const segs = t.segments.filter((s) => !s.text.includes('?'))
      for (const f of checklist) {
        const neg = segs.filter((s) => mentionsOf(s.text, f.name).some((m) => m.negated))
        const aff = segs.filter((s) => mentionsOf(s.text, f.name).some((m) => !m.negated))
        if (!neg.some((n) => aff.some((a) => a.id !== n.id))) continue
        const involved = [...new Set([...neg, ...aff])]
        warn(
          `tx.${t.id}.contradiction.${f.id}`,
          area,
          `${what} says "${f.name}" is both denied and affirmed — confirm with the patient`,
          involved.map((s) => `${s.id}:${s.text}`).join('|')
        )
      }
    }
  }

  const narrative = NARRATIVE.map((key) => ({ key, text: getSection(doc, key).text }))
  const checkFindings = (findings: Finding[], area: ReviewFlag['area']): void => {
    for (const f of findings) {
      if (f.state === 'not_assessed') continue
      const found = narrative.flatMap(({ key, text }) => mentionsOf(text, f.name).map((m) => ({ ...m, key })))
      // absent clashes with any affirmation; present clashes only when denied and never affirmed
      let clash = found.filter((m) => !m.negated)
      if (f.state === 'present') clash = found.some((m) => !m.negated) ? [] : found.filter((m) => m.negated)
      if (clash.length)
        warn(
          `contra.${f.id}`,
          area,
          `${f.name} is marked ${f.state}, but ${sectionLabel(clash[0].key)} says "${clash[0].clause}"`,
          `${f.state}|${clash.map((m) => m.clause).join('|')}`
        )
    }
  }
  checkFindings(doc.history.symptoms, 'history')
  checkFindings(doc.oncology.toxicities, 'oncology')

  if (doc.oncology.ecog === null) warn('onc.ecog', 'oncology', 'ECOG performance status not recorded')
  if (doc.oncology.clearance.decision === 'not_documented' && !empty(doc.oncology.regimen))
    warn('onc.clearance', 'oncology', 'Patient is on a regimen but treatment clearance is not documented', doc.oncology.regimen)
  if (empty(doc.assessment.text)) warn('note.assessment', 'note', 'Assessment is empty')
  if (empty(doc.plan.text)) warn('note.plan', 'note', 'Plan is empty')
  if (empty(doc.prescription.followUp.text)) warn('rx.followUp', 'prescription', 'Follow-up is not documented')

  const dateFields: [string, string, ReviewFlag['area'], string, boolean][] = [
    ['followUp', 'Follow-up', 'prescription', doc.prescription.followUp.text, true],
    ['lastTreatmentDate', 'Last treatment date', 'oncology', doc.oncology.lastTreatmentDate, false],
    ['nextPlannedTreatment', 'Next planned treatment', 'oncology', doc.oncology.nextPlannedTreatment, false],
    ['plan', 'Plan', 'note', doc.plan.text, false]
  ]
  for (const [field, label, area, text, sos] of dateFields) {
    const hit = relativeDate(text, sos)
    if (hit)
      warn(
        `date.${field}.relative`,
        area,
        `${label}: "${hit}" gives no explicit date — the reference day is ambiguous on paper, enter an explicit date`,
        text
      )
  }

  for (const [key, label] of SECTION_TARGETS) {
    const text = getSection(doc, key).text
    const area = sectionArea(key)
    if (LEFT.test(text) && RIGHT.test(text))
      warn(`lat.${key}.mixed`, area, `${label} mentions both left and right — confirm the side for each finding`, text)
    const double = text.match(DOUBLE_NEGATIVE)
    if (double)
      warn(`neg.${key}.unclear`, area, `${label} has a double negative ("${double[0]}") — write it as a plain statement`, text)
  }

  for (const key of requiredFields) {
    if (!SECTION_TARGETS.some(([k]) => k === key)) continue // stale or hand-edited settings
    if (empty(getSection(doc, key).text))
      block(`required.${key}`, sectionArea(key), `${sectionLabel(key)} is required by the clinic`)
  }

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
