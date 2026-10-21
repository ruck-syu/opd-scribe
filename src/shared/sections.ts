import type { SourceRef, TextSection, Transcript, TranscriptSegment, VisitDocument } from './types'

/** Free-text sections that transcript / dictation text can be inserted into (CMP-02). */
export const SECTION_TARGETS = [
  ['history.chiefComplaints', 'Chief complaints'],
  ['history.hpi', 'History of present illness'],
  ['history.pastHistory', 'Past history'],
  ['history.medicationHistory', 'Medication history'],
  ['oncology.investigationsReviewed', 'Investigations reviewed'],
  ['examination', 'Examination'],
  ['assessment', 'Assessment'],
  ['plan', 'Plan'],
  ['prescription.investigationsAdvised', 'Investigations advised'],
  ['prescription.advice', 'Advice'],
  ['prescription.returnPrecautions', 'Return precautions'],
  ['prescription.followUp', 'Follow-up']
] as const

export type SectionKey = (typeof SECTION_TARGETS)[number][0]

export const sectionLabel = (key: SectionKey): string => SECTION_TARGETS.find(([k]) => k === key)?.[1] ?? key

export function getSection(doc: VisitDocument, key: SectionKey): TextSection {
  const [a, b] = key.split('.') as [string, string | undefined]
  const root = doc as unknown as Record<string, unknown>
  return (b ? (root[a] as Record<string, TextSection>)[b] : root[a]) as TextSection
}

export function setSection(doc: VisitDocument, key: SectionKey, section: TextSection): VisitDocument {
  const [a, b] = key.split('.') as [string, string | undefined]
  const root = doc as unknown as Record<string, unknown>
  if (!b) return { ...doc, [a]: section }
  return { ...doc, [a]: { ...(root[a] as object), [b]: section } }
}

/** Append text verbatim (never rewritten) and record where it came from (CMP-08). */
export function appendToSection(doc: VisitDocument, key: SectionKey, text: string, source: SourceRef): VisitDocument {
  const cur = getSection(doc, key)
  const add = text.trim()
  if (!add) return doc
  const joined = cur.text.trim() ? `${cur.text.replace(/\s+$/, '')}\n${add}` : add
  return setSection(doc, key, { text: joined, sources: [...cur.sources, source] })
}

const SPEAKER_LABEL: Record<TranscriptSegment['speaker'], string> = {
  unlabelled: '',
  doctor: 'Doctor',
  patient: 'Patient',
  attendant: 'Attendant',
  other: 'Other'
}

/** Join segments for insertion; conversation segments keep their speaker label. */
export function segmentsText(t: Transcript, segments: TranscriptSegment[], withSpeakers: boolean): string {
  return segments
    .map((s) => {
      const label = withSpeakers && t.kind === 'conversation' ? SPEAKER_LABEL[s.speaker] : ''
      return label ? `${label}: ${s.text.trim()}` : s.text.trim()
    })
    .filter(Boolean)
    .join(t.kind === 'conversation' ? '\n' : ' ')
}
