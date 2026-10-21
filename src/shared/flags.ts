import type { Patient, ReviewFlag, Transcript, VisitDocument } from './types'

/**
 * Deterministic review flags (REV-03..05). Blocking flags prevent verification;
 * warnings must each be acknowledged by the doctor before verification.
 * Nothing here infers or fills clinical content.
 */
export function computeFlags(patient: Patient, doc: VisitDocument, transcripts: Transcript[]): ReviewFlag[] {
  const flags: ReviewFlag[] = []
  const block = (id: string, area: ReviewFlag['area'], message: string): void => {
    flags.push({ id, severity: 'blocking', area, message })
  }
  const warn = (id: string, area: ReviewFlag['area'], message: string): void => {
    flags.push({ id, severity: 'warning', area, message })
  }
  const empty = (s: string | null | undefined): boolean => !s || !s.trim()

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
  })

  const { decision, reason } = doc.oncology.clearance
  if ((decision === 'no' || decision === 'defer') && empty(reason))
    block('onc.clearance.reason', 'oncology', 'Treatment not cleared / deferred without a documented reason')

  for (const t of transcripts) {
    const what = t.kind === 'conversation' ? 'Conversation transcript' : `Dictation (${t.section ?? 'unassigned'})`
    const area = t.kind === 'conversation' ? 'transcript' : 'dictation'
    if (t.status === 'transcribing') block(`tx.${t.id}.pending`, area, `${what} is still transcribing`)
    if (t.status === 'failed') warn(`tx.${t.id}.failed`, area, `${what} failed to transcribe: ${t.error || 'unknown error'}`)
    if (t.status !== 'ready') continue
    if (!t.reviewed) warn(`tx.${t.id}.unreviewed`, area, `${what} has not been marked reviewed`)
    if (t.kind === 'conversation' && t.segments.some((s) => s.speakerUncertain))
      warn(`tx.${t.id}.speakers`, area, `${what} has segments with unconfirmed speaker`)
    const warned = t.segments.filter((s) => s.warning)
    if (warned.length)
      warn(`tx.${t.id}.warnings`, area, `${what} has ${warned.length} segment(s) flagged as possibly unreliable`)
  }

  if (doc.oncology.ecog === null) warn('onc.ecog', 'oncology', 'ECOG performance status not recorded')
  if (doc.oncology.clearance.decision === 'not_documented' && !empty(doc.oncology.regimen))
    warn('onc.clearance', 'oncology', 'Patient is on a regimen but treatment clearance is not documented')
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
  return flags.filter((f) => f.severity === 'warning' && !ack.has(f.id))
}

/** True when the doctor is allowed to verify. */
export function canVerify(flags: ReviewFlag[], acknowledged: string[]): boolean {
  return blockingFlags(flags).length === 0 && unacknowledgedWarnings(flags, acknowledged).length === 0
}
