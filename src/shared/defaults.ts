import type { AppSettings, Finding, TextSection, VisitDocument } from './types'
import { SCHEMA_VERSION } from './types'

export const DEFAULT_TOXICITIES = [
  'Nausea / vomiting',
  'Mucositis',
  'Diarrhea',
  'Neuropathy',
  'Fever',
  'Bleeding',
  'Dyspnea',
  'Fatigue',
  'Skin / hand-foot changes'
]

export const DEFAULT_SYMPTOMS = ['Pain', 'Cough', 'Breathlessness', 'Weight loss', 'Loss of appetite']

export function uid(): string {
  return globalThis.crypto.randomUUID()
}

export const emptySection = (): TextSection => ({ text: '', sources: [] })

export const findingsFrom = (names: string[]): Finding[] =>
  names.map((name) => ({ id: uid(), name, state: 'not_assessed', grade: '', note: '' }))

export function emptyDocument(settings: AppSettings, visitDateTime: string): VisitDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    visitDateTime,
    visitType: 'Follow-up',
    history: {
      chiefComplaints: emptySection(),
      hpi: emptySection(),
      pastHistory: emptySection(),
      medicationHistory: emptySection(),
      allergiesReviewed: 'not_assessed',
      symptoms: findingsFrom(settings.symptomChecklist)
    },
    vitals: { bp: '', pulse: '', temperature: '', spo2: '', respiratoryRate: '', weight: '', height: '', other: '' },
    oncology: {
      ecog: null,
      toxicities: findingsFrom(settings.toxicityChecklist),
      regimen: '',
      cycleNumber: '',
      cycleDay: '',
      lastTreatmentDate: '',
      nextPlannedTreatment: '',
      clearance: { decision: 'not_documented', reason: '' },
      investigationsReviewed: emptySection()
    },
    examination: emptySection(),
    assessment: emptySection(),
    plan: emptySection(),
    prescription: {
      medications: [],
      investigationsAdvised: emptySection(),
      advice: emptySection(),
      returnPrecautions: emptySection(),
      followUp: emptySection()
    },
    acknowledgedFlags: []
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  clinic: { clinicName: '', clinicAddress: '', footerText: '' },
  layout: {
    marginTopMm: 40,
    marginBottomMm: 25,
    marginLeftMm: 15,
    marginRightMm: 15,
    offsetXMm: 0,
    offsetYMm: 0,
    letterheadEveryPage: true,
    combinedPdf: true,
    fontSizePt: 10.5
  },
  asr: { binaryPath: '', modelPath: '', language: 'hi', threads: 6, initialPrompt: '' },
  retainAudio: false,
  autoLockMinutes: 10,
  toxicityChecklist: DEFAULT_TOXICITIES,
  symptomChecklist: DEFAULT_SYMPTOMS,
  formulary: [],
  letterheadType: '',
  formats: { note: null, prescription: null }
}

/** "Not documented" is how missing information is rendered (CMP-06). */
export const NOT_DOCUMENTED = 'Not documented'
