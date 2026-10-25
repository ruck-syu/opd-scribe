// Suggestions for visit fields, each tied to the exact words it came from.
// Nothing here infers, computes or fills: a suggestion exists only when the value was spoken.
// Suggestions only enter the note when the doctor accepts them (applySuggestion).

import { appendToSection, type SectionKey } from './sections'
import type { Finding, FindingState, Medication, Transcript, TranscriptSegment, VisitDocument, Vitals } from './types'

export type SuggestionTarget =
  | { kind: 'section'; key: SectionKey } // value appended verbatim
  | { kind: 'vital'; key: keyof Vitals } // value e.g. '130/80', '98', '38.2 °C'
  | { kind: 'ecog' } // value '0'..'4'
  | { kind: 'finding'; list: 'symptoms' | 'toxicities'; name: string; state: 'present' | 'absent' }
  | { kind: 'oncology'; key: 'regimen' | 'cycleNumber' | 'cycleDay' | 'lastTreatmentDate' | 'nextPlannedTreatment' }
  | { kind: 'medication'; med: Omit<Medication, 'id'> } // only spoken fields filled; sourceText = quote

export interface Suggestion {
  id: string // deterministic, stable across reruns of the same input
  transcriptId: string
  segmentIds: string[]
  target: SuggestionTarget
  value: string
  quote: string // verbatim substring of the segment text(s) it came from
  engine: 'rules' | 'llm'
  status: 'pending' | 'accepted' | 'dismissed'
  warning: string // '' if none
}

export interface RuleOptions {
  symptoms: string[]
  toxicities: string[]
  formulary: string[]
}

export interface RuleResult {
  suggestions: Suggestion[]
  rejected: { suggestion: Suggestion; reason: string }[]
}

const WORD = '\\p{L}\\p{M}\\p{N}'

/** Lowercase, anything but letters/digits (any script, incl. Devanagari marks) collapsed to single spaces. */
const normalise = (s: string): string => s.toLowerCase().replace(new RegExp(`[^${WORD}]+`, 'gu'), ' ').trim()

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

const numbersIn = (s: string): string[] => s.match(/\d+(?:\.\d+)?/g) ?? []

const inRange = (n: number, lo: number, hi: number): boolean => n >= lo && n <= hi

const unique = <T>(xs: T[]): T[] => [...new Set(xs)]

/** FNV-1a hex; makes suggestion ids depend on content, not position, so decisions survive re-extraction. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

/** Regex that matches only whole words (any script); flags must include 'u'. */
const bounded = (pattern: string, flags: string): RegExp => new RegExp(`(?<![${WORD}])(?:${pattern})(?![${WORD}])`, flags)

/** A phrase matched word by word, any non-word characters allowed between words. */
const phrase = (term: string, flags: string): RegExp =>
  bounded(
    term
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter(Boolean)
      .join(`[^${WORD}]+`),
    flags
  )

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  ek: '1',
  two: '2',
  do: '2',
  three: '3',
  teen: '3',
  four: '4',
  char: '4',
  chaar: '4'
}

const ecogWordsFor = (digit: string): string[] => Object.keys(NUMBER_WORDS).filter((w) => NUMBER_WORDS[w] === digit)

// ---------- Anti-guessing gate (rules and any future LLM engine) ----------

/**
 * Checks that a suggestion is backed by the transcript: its segments exist, its quote is verbatim
 * text from them, and every number it states was actually said in that quote.
 */
export function verifySuggestion(s: Suggestion, t: Transcript): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
  if (s.transcriptId !== t.id) return fail('suggestion belongs to another transcript')
  if (!s.segmentIds.length) return fail('no source segment')
  const segs: TranscriptSegment[] = []
  for (const id of s.segmentIds) {
    const seg = t.segments.find((x) => x.id === id)
    if (!seg) return fail(`unknown segment ${id}`)
    segs.push(seg)
  }
  const quote = squash(s.quote)
  if (!quote) return fail('empty quote')
  if (!squash(segs.map((x) => x.text).join(' ')).includes(quote)) return fail('quote is not in the source segment')

  const { target } = s
  if (target.kind === 'finding' && !s.value) {
    // a conflict: no state, but the warning must say why
    return s.warning ? { ok: true } : fail('empty value without a warning')
  }
  if (!s.value.trim()) return fail('empty value')

  const quoteNumbers = new Set(numbersIn(s.quote))
  const numbersSaid = (text: string): boolean => numbersIn(text).every((n) => quoteNumbers.has(n))
  const quoteTokens = new Set(normalise(s.quote).split(' '))

  switch (target.kind) {
    case 'section':
      return squash(segs.map((x) => x.text).join(' ')).includes(squash(s.value))
        ? { ok: true }
        : fail('value is not verbatim segment text')
    case 'vital':
      return numbersSaid(s.value) ? { ok: true } : fail(`${target.key}: a number in the value was not said`)
    case 'ecog': {
      if (!/^[0-4]$/.test(s.value)) return fail('ECOG must be 0 to 4')
      const said = quoteTokens.has(s.value) || ecogWordsFor(s.value).some((w) => quoteTokens.has(w))
      return said ? { ok: true } : fail('ECOG value is not in the quote')
    }
    case 'finding':
      if (s.value !== 'present' && s.value !== 'absent') return fail('finding value must be present or absent')
      return s.value === target.state ? { ok: true } : fail('finding value does not match its state')
    case 'oncology':
      if (!squash(s.quote).includes(squash(s.value))) return fail(`${target.key} is not in the quote`)
      return numbersSaid(s.value) ? { ok: true } : fail(`${target.key}: a number in the value was not said`)
    case 'medication': {
      const { med } = target
      if (!normalise(med.name)) return fail('medication has no name')
      if (!` ${normalise(s.quote)} `.includes(` ${normalise(med.name)} `)) return fail(`medication name ${med.name} is not in the quote`)
      const fields = [s.value, med.formulationStrength, med.dose, med.route, med.frequency, med.duration, med.quantity, med.instructions]
      return fields.every((f) => numbersSaid(f)) ? { ok: true } : fail(`${med.name}: a number in a field was not said`)
    }
  }
}

// ---------- Rules engine ----------

type Polarity = 'present' | 'absent' | 'both'

interface Mention {
  seg: TranscriptSegment
  start: number
  text: string
  polarity: Polarity
}

const warningsFor = (t: Transcript, seg: TranscriptSegment, extra: string[] = []): string => {
  const unconfirmed = t.kind === 'conversation' && (seg.speakerUncertain || seg.speaker === 'unlabelled')
  const speaker = unconfirmed ? ['Speaker not confirmed'] : []
  return [...speaker, ...extra, seg.warning].filter(Boolean).join('; ')
}

// Vitals: value only when the numbers are in the spoken form and in a plausible range.
const VITALS: { key: keyof Vitals; re: RegExp; value: (m: RegExpMatchArray) => string | null }[] = [
  {
    key: 'bp',
    re: /\b(?:bp|blood\s+pressure)\s*(?:is|was|:|=|hai|tha)?\s*(\d{2,3})\s*(?:\/|by|over|upon|x)\s*(\d{2,3})\b/giu,
    value: ([, a, b]) => (inRange(+a, 60, 260) && inRange(+b, 30, 160) && +a > +b ? `${a}/${b}` : null)
  },
  {
    key: 'pulse',
    re: /\b(?:pulse(?:\s+rate)?|heart\s+rate|hr|nabz)\s*(?:is|was|:|=|hai|tha)?\s*(\d{2,3})\b/giu,
    value: ([, n]) => (inRange(+n, 30, 220) ? n : null)
  },
  {
    key: 'temperature',
    re: /\b(?:temp|temperature|bukhar|bukhaar)\s*(?:is|was|:|=|hai|tha|of)?\s*(\d{2,3}(?:\.\d)?)(?!\d|\s*(?:din|days?|hafte|weeks?|mahine|months?|saal|years?)\b)(\s*(?:°\s*|degrees?\s*)?(fahrenheit|celsius|f|c)\b)?/giu,
    value: ([, n, , unit]) => {
      const u = unit?.toLowerCase()
      if (u === 'f' || u === 'fahrenheit') return inRange(+n, 85, 115) ? `${n} °F` : null
      if (u === 'c' || u === 'celsius') return inRange(+n, 30, 45) ? `${n} °C` : null
      return inRange(+n, 30, 45) || inRange(+n, 85, 115) ? n : null
    }
  },
  {
    key: 'spo2',
    re: /\b(?:spo\s*2|sp\s*o2|sp02|saturation|o2\s+sat(?:uration)?|oxygen\s+saturation)\s*(?:is|was|:|=|hai|tha)?\s*(\d{2,3})\b(?:\s*%)?/giu,
    value: ([, n]) => (inRange(+n, 50, 100) ? n : null)
  },
  {
    key: 'respiratoryRate',
    re: /\b(?:rr|respiratory\s+rate|resp\s+rate|respiration\s+rate)\s*(?:is|was|:|=)?\s*(\d{1,2})\b/giu,
    value: ([, n]) => (inRange(+n, 6, 60) ? n : null)
  },
  {
    key: 'weight',
    re: /\b(?:weight|wt|wajan|vajan|vazan)\s*(?:is|was|:|=|hai|tha)?\s*(\d{1,3}(?:\.\d{1,2})?)(\s*(?:kilograms?|kilos?|kgs?|kg)\b)?/giu,
    value: ([, n, unit]) => (inRange(+n, 1, 300) ? `${n}${unit ? ' kg' : ''}` : null)
  },
  {
    key: 'height',
    re: /\b(?:height|lambai|qad)\s*(?:is|was|:|=|hai|tha)?\s*(\d{2,3}(?:\.\d)?)(\s*(?:cm|centimet(?:er|re)s?)\b)?/giu,
    value: ([, n, unit]) => (inRange(+n, 40, 250) ? `${n}${unit ? ' cm' : ''}` : null)
  }
]

const ECOG_RE =
  /\b(?:ecog(?:\s+ps)?(?:\s+performance\s+status)?|performance\s+status(?:\s+ecog)?)\s*(?:is|was|of|:|=|score|hai|tha)?\s*(\d+|zero|one|two|three|four|ek|do|teen|chaar|char)\b/giu
const CYCLE_DAY_RE = /\bc\s*(\d{1,2})\s*d\s*(\d{1,2})\b/giu
const CYCLE_RE = /\bcycle\s*(?:no\.?|number|#)?\s*(\d{1,2})\b/giu
const DAY_RE = /\bday\s*(\d{1,2})\b/giu
const CHEMO_CONTEXT = /\b(?:cycle|chemo\w*|regimen|c\s*\d{1,2}\s*d)\b/iu

// Short regimen tokens are matched case-sensitively so ordinary words ("back", "chop") never match.
const REGIMENS = ['FOLFOXIRI', 'FOLFOX', 'FOLFIRI', 'CAPOX', 'XELOX', 'R-CHOP', 'CHOP', 'ABVD', 'TCH', 'TPF', 'AC', 'TC', 'gem-cis', 'carbo-paclitaxel']
const CASE_SENSITIVE = new Set(['CHOP', 'TCH', 'TPF', 'AC', 'TC'])

// Symptom / toxicity concepts: the first word is the canonical term; an entry matches a concept when one of its terms appears in the entry name.
const CONCEPTS: string[][] = [
  ['nausea', 'vomiting', 'vomit', 'ulti', 'ji machalna', 'jee machalna', 'ji michlana', 'machalna'],
  ['mucositis', 'mouth ulcer', 'mouth ulcers', 'mouth sore', 'mouth sores', 'chhale', 'chhala'],
  ['diarrhea', 'diarrhoea', 'loose motion', 'loose motions', 'loose stool', 'dast'],
  ['neuropathy', 'tingling', 'numbness', 'jhanjhanahat'],
  ['fever', 'bukhar', 'bukhaar'],
  ['dyspnea', 'dyspnoea', 'breathlessness', 'breathless', 'shortness of breath', 'saans phoolna', 'saans phoolti'],
  ['fatigue', 'weakness', 'kamzori', 'thakan', 'tiredness'],
  ['bleeding', 'bleed', 'khoon aana'],
  ['pain', 'dard'],
  ['cough', 'khansi'],
  ['weight loss', 'wajan kam', 'vajan kam'],
  ['loss of appetite', 'appetite loss', 'bhookh kam'],
  ['constipation', 'kabz'],
  ['skin', 'rash', 'skin changes', 'hand foot', 'palmar', 'peeling', 'khujli', 'itching'],
  ['headache']
]

const findingTerms = (name: string): string[] => {
  const norm = normalise(name)
  const matched = CONCEPTS.filter((c) => c.some((term) => ` ${norm} `.includes(` ${term} `)))
  return unique([norm, ...matched.flat()]).filter(Boolean)
}

const NEGATION = bounded('no|not|never|denies|denied|deny|without|nahi|nahin|nhi|(?<!(?:hai|hain)\\s+)na', 'iu')
const NEGATED_COPULA = bounded('(?:nahi|nahin|nhi|na)(?:\\s+(?:hai|hain|hoti|hota|hi))?', 'giu')
const AFFIRMATION = bounded('has|have|having|hai|hain|present|positive|complains?|complaining|c\\s*\\/\\s*o|with|raha|rahi|rahe', 'iu')
// clause boundaries: a negation only applies within its own clause
const CLAUSE_BREAK = /[.,;:!?\n]+|\s+(?:but|however|lekin|par|aur|and|or|ya|also|plus|although|though)\s+|\s-\s/giu

function clauseAt(text: string, at: number): { start: number; text: string } {
  let start = 0
  for (const b of text.matchAll(CLAUSE_BREAK)) {
    const bi = b.index ?? 0
    if (bi >= at) return { start, text: text.slice(start, bi).trim() }
    start = bi + b[0].length
  }
  return { start, text: text.slice(start).trim() }
}

// "Bukhar hai kya?", "Do you have vomiting", "any fever" ask about a finding; they state nothing
const QUESTION = /\?|^(?:do|does|did|any|koi)\b|^(?:is|are|was|were)\s+there\b|^(?:have|has)\s+(?:you|he|she|they|the\s+patient)\b|\b(?:kya|kyaa)\b/iu

function polarityOf(clause: string): Polarity | null {
  if (QUESTION.test(clause.trim())) return null
  const negated = NEGATION.test(clause)
  // "nahi hai" is a negation, not an affirmation
  const affirmed = AFFIRMATION.test(clause.replace(NEGATED_COPULA, ' '))
  if (negated && affirmed) return 'both'
  if (negated) return 'absent'
  if (affirmed) return 'present'
  return null
}

const FREQUENCY: [string, RegExp][] = [
  ['OD', /\bod\b|\bonce\s+(?:a\s+|per\s+)?day\b|\bonce\s+daily\b|(?<!\b(?:twice|thrice|times)\s+)\bdaily\b|\b(?:din|roz)\s+(?:me|mein|men)?\s*ek\s+baar\b/i],
  ['BD', /\bbd\b|\bbid\b|\btwice\s+(?:a\s+|per\s+)?day\b|\btwice\s+daily\b|\b(?:din|roz)\s+(?:me|mein|men)?\s*do\s+baar\b/i],
  ['TDS', /\btds\b|\btid\b|\bthrice\b|\bthree\s+times\s+(?:a\s+|per\s+)?day\b|\b(?:din|roz)\s+(?:me|mein|men)?\s*teen\s+baar\b/i],
  ['QID', /\bqid\b|\bfour\s+times\s+(?:a\s+|per\s+)?day\b|\b(?:din|roz)\s+(?:me|mein|men)?\s*(?:char|chaar)\s+baar\b/i],
  ['HS', /\bhs\b|\bat\s+(?:night|bedtime)\b|\bbedtime\b|\braat\s+ko\b/i],
  ['SOS', /\bsos\b|\bas\s+needed\b|\bif\s+required\b|\bprn\b|\bzarurat\b/i]
]
const ROUTES: [string, RegExp][] = [
  ['oral', /\b(?:oral(?:ly)?|by\s+mouth|per\s+oral|po)\b/i],
  ['IV', /\b(?:iv|intravenous(?:ly)?)\b/i],
  ['SC', /\b(?:sc|subcutaneous(?:ly)?|subq)\b/i],
  ['IM', /\b(?:im|intramuscular(?:ly)?)\b/i]
]
const STRENGTH = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|gm|g)\b/i
const DOSE = /\b\d+(?:\.\d+)?\s*(?:tabs?|tablets?|caps?|capsules?|ml|drops?|puffs?|sachets?|vials?|amps?|ampoules?|injections?)\b/i
const DURATION = /\b(\d+)\s*(days?|din|weeks?|hafte|hafta|hafton|months?|mahine|mahina)\b(?!\s*(?:ago|back|pehle|baad|se)\b)/i
const MED_CONJ = /\s+(?:and|aur|with|plus|lekin|but)\s+/i

interface FormularyHit {
  name: string
  at: number
  end: number
}

/**
 * Text that belongs to one medication: from its name up to the next formulary medicine, conjunction
 * or sentence end. Details of a medicine outside the formulary must never attach to this one.
 */
function medicationScope(text: string, hits: FormularyHit[], i: number): string {
  const h = hits[i]
  const next = i + 1 < hits.length ? hits[i + 1].at : text.length
  const rest = text.slice(h.end, next)
  const stop = [MED_CONJ.exec(rest)?.index, /[.;\n]/.exec(rest)?.index].filter((x): x is number => x !== undefined)
  return text.slice(h.at, stop.length ? h.end + Math.min(...stop) : next)
}

const onlyOne = (values: string[]): string => {
  const distinct = unique(values)
  return distinct.length === 1 ? distinct[0] : ''
}

function medicationFrom(name: string, scope: string): Omit<Medication, 'id'> {
  const freq = FREQUENCY.filter(([, re]) => re.test(scope)).map(([v]) => v)
  const pattern = /\b([01])\s*-\s*([01])\s*-\s*([01])\b/.exec(scope)
  if (pattern) freq.push(`${pattern[1]}-${pattern[2]}-${pattern[3]}`)
  const dur = DURATION.exec(scope)
  let duration = ''
  if (dur) {
    const unit = dur[2].toLowerCase()
    const base = /^(day|din)/.test(unit) ? 'day' : /^(week|hafte|hafta|hafton)/.test(unit) ? 'week' : 'month'
    duration = `${dur[1]} ${dur[1] === '1' ? base : `${base}s`}`
  }
  return {
    name,
    formulationStrength: STRENGTH.exec(scope)?.[0] ?? '',
    dose: DOSE.exec(scope)?.[0] ?? '',
    route: onlyOne(ROUTES.filter(([, re]) => re.test(scope)).map(([v]) => v)),
    frequency: onlyOne(freq),
    duration,
    quantity: '',
    instructions: '',
    sourceText: ''
  }
}

/** Speech from anyone but the doctor (or an unconfirmed speaker, which is warned) can only become history. */
function sectionFor(t: Transcript, seg: TranscriptSegment, text: string): SectionKey | null {
  if (seg.speaker === 'patient' || seg.speaker === 'attendant' || seg.speaker === 'other') {
    if (PATIENT_COMPLAINT.test(text)) return 'history.chiefComplaints'
    return PATIENT_ONSET.test(text) ? 'history.hpi' : null
  }
  const cue = SECTION_CUES.find(([, re]) => re.test(text))
  if (cue) return cue[0]
  // a dictation was recorded for one section
  if (t.kind === 'dictation' && t.section) return t.section
  return INVESTIGATION_CUE.test(text) && TEST_NAME.test(text) ? 'prescription.investigationsAdvised' : null
}

const SECTION_CUES: [SectionKey, RegExp][] = [
  ['examination', /^(?:on\s+exam(?:ination)?|examination|o\s*\/\s*e)\b/i],
  ['assessment', /^(?:impression|assessment|diagnosis\s+is)\b/i],
  ['prescription.followUp', /^(?:follow[\s-]?up|review\s+(?:after|in)|come\s+back)\b/i],
  ['plan', /^(?:plan|we\s+will|we'll)\b/i],
  ['prescription.advice', /^(?:advice|advised|advise)\b/i]
]
const INVESTIGATION_CUE = /\b(?:investigations?|send|sent|get\s+(?:\S+\s+)?done|karwa\w*|karva\w*)\b/i
const TEST_NAME = /\b(?:CBC|LFT|RFT|KFT|CT|PET(?:-?CT)?|MRI|USG|ultrasound|x-?ray|CEA|CA\s?125|tumou?r\s+markers?)\b/i
const PATIENT_COMPLAINT = /\b(?:problem|complain\w*|pareshani|takleef|mujhe|mujhko)\b/i
const PATIENT_ONSET = /\b(?:since|from|\d+\s*(?:days?|weeks?|months?|din|hafte|hafta|mahine)\s*(?:se|ago|back|pehle)|se)\b/i

/**
 * Deterministic extraction from a ready transcript. Every candidate passes verifySuggestion;
 * failures are returned in `rejected`, never dropped.
 */
export function extractRules(t: Transcript, opts: RuleOptions): RuleResult {
  const suggestions: Suggestion[] = []
  const rejected: RuleResult['rejected'] = []
  if (t.status !== 'ready') return { suggestions, rejected }

  const used = new Map<string, number>()
  const emit = (partial: Pick<Suggestion, 'segmentIds' | 'target' | 'value' | 'quote' | 'warning'>): void => {
    const base = `${t.id}:rules:${hash(JSON.stringify([partial.target, partial.value, partial.quote]))}`
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    const s: Suggestion = {
      ...partial,
      id: n ? `${base}.${n}` : base,
      transcriptId: t.id,
      engine: 'rules',
      status: 'pending'
    }
    const verdict = verifySuggestion(s, t)
    if (verdict.ok) suggestions.push(s)
    else rejected.push({ suggestion: s, reason: verdict.reason })
  }

  const live = t.segments.filter((s) => s.text.trim() && !/^\[untranscribed audio/i.test(s.text.trim()))
  const formulary = opts.formulary.map((f) => f.trim()).filter((f) => normalise(f))

  for (const seg of live) {
    const text = seg.text
    const trimmed = text.trim()
    const fromPatient = seg.speaker === 'patient' || seg.speaker === 'attendant' || seg.speaker === 'other'
    const clinical = fromPatient ? ['Not stated by the doctor'] : []
    const ids = [seg.id]

    for (const v of VITALS)
      for (const m of text.matchAll(v.re)) {
        const value = v.value(m)
        if (value) emit({ segmentIds: ids, target: { kind: 'vital', key: v.key }, value, quote: m[0], warning: warningsFor(t, seg, clinical) })
      }

    for (const m of text.matchAll(ECOG_RE)) {
      const word = m[1].toLowerCase()
      emit({ segmentIds: ids, target: { kind: 'ecog' }, value: NUMBER_WORDS[word] ?? word, quote: m[0], warning: warningsFor(t, seg, clinical) })
    }

    for (const name of REGIMENS)
      for (const m of text.matchAll(phrase(name, CASE_SENSITIVE.has(name) ? 'gu' : 'giu')))
        emit({ segmentIds: ids, target: { kind: 'oncology', key: 'regimen' }, value: m[0], quote: m[0], warning: warningsFor(t, seg, clinical) })

    for (const m of text.matchAll(CYCLE_DAY_RE)) {
      emit({ segmentIds: ids, target: { kind: 'oncology', key: 'cycleNumber' }, value: m[1], quote: m[0], warning: warningsFor(t, seg, clinical) })
      emit({ segmentIds: ids, target: { kind: 'oncology', key: 'cycleDay' }, value: m[2], quote: m[0], warning: warningsFor(t, seg, clinical) })
    }
    for (const m of text.matchAll(CYCLE_RE))
      emit({ segmentIds: ids, target: { kind: 'oncology', key: 'cycleNumber' }, value: m[1], quote: m[0], warning: warningsFor(t, seg, clinical) })
    // "every day 2 tablets" is not cycle day 2
    if (CHEMO_CONTEXT.test(text))
      for (const m of text.matchAll(DAY_RE))
        emit({ segmentIds: ids, target: { kind: 'oncology', key: 'cycleDay' }, value: m[1], quote: m[0], warning: warningsFor(t, seg, clinical) })

    const hits: FormularyHit[] = formulary
      .flatMap((name) => [...text.matchAll(phrase(name, 'giu'))].map((m) => ({ name, at: m.index ?? 0, end: (m.index ?? 0) + m[0].length })))
      .sort((a, b) => a.at - b.at)
    hits.forEach((h, i) => {
      const med = { ...medicationFrom(h.name, medicationScope(text, hits, i)), sourceText: trimmed }
      const summary = [med.name, med.formulationStrength, med.dose, med.route, med.frequency, med.duration].filter(Boolean).join(', ')
      emit({ segmentIds: ids, target: { kind: 'medication', med }, value: summary, quote: trimmed, warning: warningsFor(t, seg) })
    })

    const section = sectionFor(t, seg, trimmed)
    if (section) emit({ segmentIds: ids, target: { kind: 'section', key: section }, value: trimmed, quote: trimmed, warning: warningsFor(t, seg) })
  }

  // Symptoms and toxicities: one state per checklist entry across the whole transcript.
  for (const [list, names] of [
    ['symptoms', opts.symptoms],
    ['toxicities', opts.toxicities]
  ] as const) {
    for (const name of names.map((n) => n.trim()).filter(Boolean)) {
      const regexes = findingTerms(name).map((term) => phrase(term, 'giu'))
      const mentions: Mention[] = []
      for (const seg of live) {
        const at = unique(regexes.flatMap((re) => [...seg.text.matchAll(re)].map((m) => m.index ?? 0))).sort((a, b) => a - b)
        for (const pos of at) {
          const clause = clauseAt(seg.text, pos)
          const polarity = seg.text.includes('?') ? null : polarityOf(clause.text)
          if (polarity && !mentions.some((x) => x.seg === seg && x.start === clause.start))
            mentions.push({ seg, start: clause.start, text: clause.text, polarity })
        }
      }
      if (!mentions.length) continue
      const first = mentions[0]
      const seen = new Set(mentions.map((m) => m.polarity))
      const state: 'present' | 'absent' = first.polarity === 'absent' ? 'absent' : 'present'
      const target: SuggestionTarget = { kind: 'finding', list, name, state }
      if (seen.has('both') || (seen.has('present') && seen.has('absent'))) {
        emit({
          segmentIds: unique(mentions.map((m) => m.seg.id)),
          target,
          value: '',
          quote: first.text,
          warning: warningsFor(t, first.seg, [`${name}: stated both as present and absent; no state suggested`])
        })
      } else {
        emit({ segmentIds: [first.seg.id], target, value: state, quote: first.text, warning: warningsFor(t, first.seg) })
      }
    }
  }

  return { suggestions, rejected }
}

// ---------- Applying an accepted suggestion ----------

/**
 * Returns a new document with the suggestion applied. Never overwrites: a field that already
 * holds a different value throws. The input document is not mutated.
 */
export function applySuggestion(doc: VisitDocument, s: Suggestion, kind: 'conversation' | 'dictation'): VisitDocument {
  const { target } = s
  if (target.kind === 'finding' && !s.value)
    throw new Error(`${target.name}: conflicting statements, no state to apply`)
  if (!s.value.trim()) throw new Error('suggestion has no value')

  switch (target.kind) {
    case 'section':
      return appendToSection(doc, target.key, s.value, {
        kind,
        refId: `${s.transcriptId}:${s.segmentIds.join(',')}`,
        at: new Date().toISOString()
      })
    case 'vital': {
      const current = doc.vitals[target.key]
      if (current && current !== s.value) throw new Error(`vitals.${target.key} already has a value`)
      return { ...doc, vitals: { ...doc.vitals, [target.key]: s.value } }
    }
    case 'ecog': {
      const next = Number(s.value)
      if (!Number.isInteger(next) || next < 0 || next > 4) throw new Error('ECOG must be 0 to 4')
      if (doc.oncology.ecog !== null && doc.oncology.ecog !== next) throw new Error('oncology.ecog already has a value')
      return { ...doc, oncology: { ...doc.oncology, ecog: next } }
    }
    case 'oncology': {
      const current = doc.oncology[target.key]
      if (current && current !== s.value) throw new Error(`oncology.${target.key} already has a value`)
      return { ...doc, oncology: { ...doc.oncology, [target.key]: s.value } }
    }
    case 'finding': {
      if (s.value !== 'present' && s.value !== 'absent') throw new Error('finding value must be present or absent')
      const state: FindingState = s.value
      const list: Finding[] = target.list === 'symptoms' ? doc.history.symptoms : doc.oncology.toxicities
      const i = list.findIndex((f) => f.name.trim().toLowerCase() === target.name.trim().toLowerCase())
      if (i < 0) throw new Error(`${target.name} is not in the ${target.list} checklist`)
      if (list[i].state !== 'not_assessed' && list[i].state !== state) throw new Error(`${target.name} already has a value`)
      const next = list.map((f, j) => (j === i ? { ...f, state } : { ...f }))
      return target.list === 'symptoms'
        ? { ...doc, history: { ...doc.history, symptoms: next } }
        : { ...doc, oncology: { ...doc.oncology, toxicities: next } }
    }
    case 'medication': {
      if (!target.med.name.trim()) throw new Error('medication has no name')
      const med: Medication = { ...target.med, id: globalThis.crypto.randomUUID() }
      return { ...doc, prescription: { ...doc.prescription, medications: [...doc.prescription.medications, med] } }
    }
  }
}
