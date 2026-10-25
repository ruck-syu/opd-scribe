// Optional local-LLM extraction. The model only PROPOSES: every item it returns is turned into a
// Suggestion (engine 'llm') and must pass the same verifySuggestion gate as the rules. Failures are
// kept in `rejected`, never dropped. Nothing here computes doses or fills a field that was not said.

import { canonicalJson } from './canonical'
import {
  findingTerms,
  hash,
  spokenMedication,
  normalise,
  polarityOf,
  isQuestion,
  squash,
  verifySuggestion,
  warningsFor,
  type Suggestion,
  type SuggestionTarget
} from './extract'
import type { SectionKey } from './sections'
import type { LlmTemplate, Medication, Speaker, Transcript, TranscriptSegment, Vitals } from './types'

export const LLM_FIELDS = [
  'chiefComplaints',
  'hpi',
  'pastHistory',
  'medicationHistory',
  'examination',
  'investigationsReviewed',
  'assessment',
  'plan',
  'investigationsAdvised',
  'advice',
  'followUp',
  'returnPrecautions',
  'vital.bp',
  'vital.pulse',
  'vital.temperature',
  'vital.spo2',
  'vital.respiratoryRate',
  'vital.weight',
  'vital.height',
  'ecog',
  'regimen',
  'cycleNumber',
  'cycleDay',
  'finding',
  'medication'
] as const
export type LlmField = (typeof LLM_FIELDS)[number]

const MED_KEYS = ['name', 'strength', 'dose', 'route', 'frequency', 'duration', 'instructions'] as const

/** JSON schema for llama.cpp's grammar (no $ref / oneOf). */
export const LLM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        properties: {
          segment: { type: 'integer' },
          quote: { type: 'string' },
          field: { type: 'string', enum: [...LLM_FIELDS] },
          value: { type: 'string' },
          state: { type: 'string', enum: ['present', 'absent', ''] },
          med: {
            type: 'object',
            properties: Object.fromEntries(MED_KEYS.map((k) => [k, { type: 'string' }])),
            required: [...MED_KEYS],
            additionalProperties: false
          }
        },
        // every key required so the grammar makes small models fill state and med instead of
        // folding them into value
        required: ['segment', 'quote', 'field', 'value', 'state', 'med'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
  additionalProperties: false
}

const SECTION_FOR: Partial<Record<LlmField, SectionKey>> = {
  chiefComplaints: 'history.chiefComplaints',
  hpi: 'history.hpi',
  pastHistory: 'history.pastHistory',
  medicationHistory: 'history.medicationHistory',
  examination: 'examination',
  investigationsReviewed: 'oncology.investigationsReviewed',
  assessment: 'assessment',
  plan: 'plan',
  investigationsAdvised: 'prescription.investigationsAdvised',
  advice: 'prescription.advice',
  followUp: 'prescription.followUp',
  returnPrecautions: 'prescription.returnPrecautions'
}

const VITAL_FOR: Partial<Record<LlmField, keyof Vitals>> = {
  'vital.bp': 'bp',
  'vital.pulse': 'pulse',
  'vital.temperature': 'temperature',
  'vital.spo2': 'spo2',
  'vital.respiratoryRate': 'respiratoryRate',
  'vital.weight': 'weight',
  'vital.height': 'height'
}

const ONCOLOGY_FOR: Partial<Record<LlmField, 'regimen' | 'cycleNumber' | 'cycleDay'>> = {
  regimen: 'regimen',
  cycleNumber: 'cycleNumber',
  cycleDay: 'cycleDay'
}

/** Patient, attendant and other speakers can only feed history, never findings, vitals or orders. */
const PATIENT_FIELDS: readonly string[] = ['chiefComplaints', 'hpi', 'pastHistory', 'medicationHistory']


const SPEAKER_NAME: Record<Speaker, string> = {
  unlabelled: 'Unknown',
  doctor: 'Doctor',
  patient: 'Patient',
  attendant: 'Attendant',
  other: 'Other'
}

const MED_FIELD_LABEL = {
  formulationStrength: 'strength',
  dose: 'dose',
  route: 'route',
  frequency: 'frequency',
  duration: 'duration',
  instructions: 'instructions'
} as const

/** What a value must look like before an AI-proposed medication field is kept. */
const FIELD_SHAPE: Record<'formulationStrength' | 'dose' | 'route' | 'frequency' | 'duration' | 'instructions', (v: string) => boolean> = {
  formulationStrength: (v) => /^\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|gm|ml|%|iu|units?)$/i.test(v.trim()),
  dose: (v) => /^\d+(?:\.\d+)?\s*(?:tabs?|tablets?|caps?|capsules?|ml|drops?|puffs?|sachets?|vials?|amps?|units?)$/i.test(v.trim()),
  route: (v) => /^(?:oral|orally|po|iv|sc|im|by mouth|intravenous|subcutaneous|intramuscular|topical|inhaled|sublingual)$/i.test(v.trim()),
  frequency: (v) => /^(?:od|bd|bid|tds|tid|qid|hs|sos|prn|stat|\d-\d-\d|once daily|twice daily|thrice daily|daily|once a day|twice a day|three times a day|at night|as needed)$/i.test(v.trim()),
  duration: (v) => /^(?:for\s+)?\d+\s*(?:days?|weeks?|months?|din|hafte|mahine)$/i.test(v.trim()),
  // free words only: a number here is someone else's dose
  instructions: (v) => !/\d/.test(v) && v.trim().split(/\s+/).length <= 8
}

const isPatientSpeech = (seg: TranscriptSegment): boolean =>
  seg.speaker === 'patient' || seg.speaker === 'attendant' || seg.speaker === 'other'

/** Lines the model may cite. The number is the real index in the transcript, so it stays stable. */
function numberedLines(t: Transcript): Map<number, TranscriptSegment> {
  const lines = new Map<number, TranscriptSegment>()
  t.segments.forEach((seg, i) => {
    const text = seg.text.trim()
    if (text && !/^\[untranscribed audio/i.test(text)) lines.set(i + 1, seg)
  })
  return lines
}

const SYSTEM = [
  'You extract facts from a transcript of an oncology outpatient (OPD) consultation, for the doctor to review.',
  'Reply with JSON only, matching the schema {"items": [...]}. No prose, no markdown.',
  'Each item cites one transcript line by its number ("segment") and copies "quote" exactly from that line.',
  'Extract ONLY what is explicitly said. Never infer, calculate or complete a dose, frequency, duration, value or date that was not said; leave such a field as an empty string.',
  'A symptom or toxicity is "present" or "absent" only if that line explicitly affirms or denies it. Questions are not statements: produce nothing for them.',
  'Speech from the patient, attendant or other person may only feed chiefComplaints, hpi, pastHistory or medicationHistory.',
  'For field "finding", value must be one of the checklist names given, spelled exactly, and state must be "present" or "absent".',
  'Every item has all keys. state is "" unless field is "finding". med has all keys as "" unless field is "medication".',
  'For field "medication", value is "" and med holds the medicine name and each detail as it was said; a detail not said is "".',
  'Example: line [7] "Tab Paracetamol 650 mg SOS for fever" gives {"segment":7,"quote":"Tab Paracetamol 650 mg SOS for fever","field":"medication","value":"","state":"","med":{"name":"Paracetamol","strength":"650 mg","dose":"","route":"","frequency":"SOS","duration":"","instructions":"for fever"}}.',
  'Example: line [3] "no vomiting since yesterday" gives {"segment":3,"quote":"no vomiting","field":"finding","value":"Nausea / vomiting","state":"absent","med":{...all ""}} when "Nausea / vomiting" is a checklist name.',
  'For vital.* fields, value is the number as said, for example "130/80". For ecog, value is a single digit from 0 to 4.',
  'For free-text sections, value is "" and quote is the whole line; you only choose the section.',
  'Never write a number that is not in the quote.',
  'Results the doctor reviewed (blood counts, scans, reports) go to investigationsReviewed, not examination.',
  '"Come back / return immediately if ..." goes to returnPrecautions.',
  'One line may give several items: a line starting a medicine is both a plan item and a medication item.',
  'If nothing qualifies, reply {"items": []}.'
].join('\n')

/** The chat turn wrapper for the chosen model family. llama.cpp adds the BOS token itself. */
function wrap(template: LlmTemplate, system: string, user: string): string {
  switch (template) {
    case 'gemma':
      return `<start_of_turn>user\n${system}\n\n${user}<end_of_turn>\n<start_of_turn>model\n`
    case 'llama3':
      return `<|start_header_id|>system<|end_header_id|>\n\n${system}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n${user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`
    case 'chatml':
      return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`
  }
}

/** Full prompt for one transcript. Contains PHI: callers must write it only to a temp file and delete it. */
export function buildPrompt(
  t: Transcript,
  opts: { symptoms: string[]; toxicities: string[]; template: LlmTemplate }
): string {
  const names = [...opts.symptoms, ...opts.toxicities].map((n) => n.trim()).filter(Boolean)
  const lines = [...numberedLines(t)].map(([n, seg]) => `[${n}] ${SPEAKER_NAME[seg.speaker]}: ${seg.text.trim()}`)
  const user = [
    `Checklist names for "finding": ${names.length ? names.join('; ') : 'none'}`,
    `Fields: ${LLM_FIELDS.join(', ')}`,
    'Transcript, one numbered line per segment:',
    ...lines
  ].join('\n')
  return wrap(opts.template, SYSTEM, user)
}

export interface ParseOptions {
  symptoms: string[]
  toxicities: string[]
}

export interface ParseResult {
  suggestions: Suggestion[]
  rejected: { quote: string; value: string; reason: string }[]
}

interface RawItem {
  segment?: unknown
  quote?: unknown
  field?: unknown
  value?: unknown
  state?: unknown
  med?: unknown
}

const text = (x: unknown): string => (typeof x === 'string' ? x.trim() : '')

/**
 * Turns the model's output into suggestions. Tolerates text around the JSON. Each item is mapped to a
 * target and checked by verifySuggestion (with paraphrase allowed for section wording only).
 */
export function parseLlmOutput(raw: string, t: Transcript, opts: ParseOptions): ParseResult {
  const suggestions: Suggestion[] = []
  const rejected: ParseResult['rejected'] = []
  const invalid = (reason: string): ParseResult => ({ suggestions, rejected: [{ quote: '', value: '', reason }] })

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  let parsed: unknown = null
  try {
    parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null
  } catch {
    parsed = null
  }
  if (parsed === null || typeof parsed !== 'object') return invalid('model output was not valid JSON')
  const items = (parsed as { items?: unknown }).items
  if (!Array.isArray(items)) return invalid('model output had no items list')

  const lines = numberedLines(t)
  const symptoms = opts.symptoms.map((n) => n.trim())
  const toxicities = opts.toxicities.map((n) => n.trim())
  const used = new Map<string, number>()

  const add = (partial: Pick<Suggestion, 'segmentIds' | 'target' | 'value' | 'quote' | 'warning'>): void => {
    const base = `${t.id}:llm:${hash(JSON.stringify([partial.target, partial.value, partial.quote]))}`
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    const s: Suggestion = { ...partial, id: n ? `${base}.${n}` : base, transcriptId: t.id, engine: 'llm', status: 'pending' }
    const verdict = verifySuggestion(s, t)
    if (verdict.ok) suggestions.push(s)
    else rejected.push({ quote: s.quote, value: s.value, reason: verdict.reason })
  }

  for (const entry of items) {
    const item: RawItem = typeof entry === 'object' && entry !== null ? (entry as RawItem) : {}
    const quote = text(item.quote)
    const value = text(item.value)
    const reject = (reason: string): void => {
      rejected.push({ quote, value, reason })
    }

    const seg = typeof item.segment === 'number' ? lines.get(item.segment) : undefined
    if (!seg) {
      reject('segment is not a numbered transcript line')
      continue
    }
    const field = typeof item.field === 'string' ? item.field : ''
    if (!(LLM_FIELDS as readonly string[]).includes(field)) {
      reject('unknown field')
      continue
    }
    if (isQuestion(seg.text)) {
      reject('questions are not statements')
      continue
    }
    if (isPatientSpeech(seg) && !PATIENT_FIELDS.includes(field)) {
      reject('patient speech can only feed history fields')
      continue
    }
    const segmentIds = [seg.id]
    const f = field as LlmField
    // an item with no value proposes nothing: not a rejection, just no suggestion
    if (!value && f !== 'medication' && !SECTION_FOR[f]) continue

    const section = SECTION_FOR[f]
    if (section) {
      // the model only chooses the section; the note gets the doctor's own words, never the model's
      // (a 4B model rendered "ulti" (vomiting) as "Urticaria")
      if (!squash(seg.text).includes(squash(quote))) {
        reject('quote is not in the source segment')
        continue
      }
      const line = seg.text.trim()
      add({ segmentIds, target: { kind: 'section', key: section }, value: line, quote: line, warning: warningsFor(t, seg) })
    } else if (f === 'finding') {
      const state = item.state
      if (state !== 'present' && state !== 'absent') {
        reject('finding needs state present or absent')
        continue
      }
      const list = symptoms.includes(value) ? 'symptoms' : toxicities.includes(value) ? 'toxicities' : null
      if (!list) {
        reject(`"${value}" is not a checklist name`)
        continue
      }
      if (polarityOf(quote) !== state) {
        reject(`the quote does not say ${value} is ${state}`)
        continue
      }
      const qn = ` ${normalise(quote)} `
      if (!findingTerms(value).some((term) => qn.includes(` ${term} `))) {
        reject(`the quote does not mention ${value}`)
        continue
      }
      const target: SuggestionTarget = { kind: 'finding', list, name: value, state }
      add({ segmentIds, target, value: state, quote, warning: warningsFor(t, seg) })
    } else if (f === 'medication') {
      const med = typeof item.med === 'object' && item.med !== null ? (item.med as Record<string, unknown>) : {}
      const name = text(med.name)
      if (!name) {
        reject('medication has no name')
        continue
      }
      const detail: Omit<Medication, 'id'> = {
        name,
        formulationStrength: text(med.strength),
        dose: text(med.dose),
        route: text(med.route),
        frequency: text(med.frequency),
        duration: text(med.duration),
        quantity: '',
        instructions: text(med.instructions),
        sourceText: seg.text.trim()
      }
      // A small model misplaces details ("twice daily" as the dose, the next medicine's "40 mg OD" as
      // instructions) and the quote check cannot see that. So the fields are read by the rules from this
      // medicine's own stretch of the line; the model contributes the name (medicines outside the
      // formulary) and only fills a field the rules left empty when its value has the right shape and is
      // said in that stretch.
      const spoken = spokenMedication(name, seg.text)
      if (!spoken) {
        reject(`${name} is not named in the line`)
        continue
      }
      const scope = ` ${normalise(spoken.scope)} `
      const unsupported: string[] = []
      for (const key of ['formulationStrength', 'dose', 'route', 'frequency', 'duration', 'instructions'] as const) {
        const proposed = detail[key]
        detail[key] = spoken.med[key]
        if (proposed && detail[key] && normalise(proposed) !== normalise(detail[key]) && /\d/.test(proposed + detail[key]))
          unsupported.push(`${MED_FIELD_LABEL[key]} "${proposed}" (the line says "${detail[key]}")`)
        if (!proposed || detail[key]) continue
        if (scope.includes(` ${normalise(proposed)} `) && FIELD_SHAPE[key](proposed)) detail[key] = proposed
        else unsupported.push(`${MED_FIELD_LABEL[key]} "${proposed}"`)
      }
      const blanked = unsupported.length ? [`AI proposed ${unsupported.join(', ')} — not said that way in the line, so not used`] : []
      // the summary is built from the spoken fields, never from free model text
      const summary = [name, detail.formulationStrength, detail.dose, detail.route, detail.frequency, detail.duration]
        .filter(Boolean)
        .join(', ')
      add({ segmentIds, target: { kind: 'medication', med: detail }, value: summary, quote, warning: warningsFor(t, seg, blanked) })
    } else if (VITAL_FOR[f]) {
      add({ segmentIds, target: { kind: 'vital', key: VITAL_FOR[f]! }, value, quote, warning: warningsFor(t, seg) })
    } else if (f === 'ecog') {
      add({ segmentIds, target: { kind: 'ecog' }, value, quote, warning: warningsFor(t, seg) })
    } else if (ONCOLOGY_FOR[f]) {
      add({ segmentIds, target: { kind: 'oncology', key: ONCOLOGY_FOR[f]! }, value, quote, warning: warningsFor(t, seg) })
    }
  }

  return { suggestions, rejected }
}

/** Same target and same value: the rules already propose it, so the model's copy is dropped. */
export function sameProposal(a: Suggestion, b: Suggestion): boolean {
  if (canonicalJson(a.target) !== canonicalJson(b.target)) return false
  // "97 percent" and "97" are the same reading
  if (a.target.kind === 'vital') return (a.value.match(/\d+(?:\.\d+)?/g) ?? []).join('/') === (b.value.match(/\d+(?:\.\d+)?/g) ?? []).join('/')
  return a.value === b.value
}
