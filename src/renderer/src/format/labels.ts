import { FIELD_CATALOG, type FieldKey } from '../../../shared/formTemplate'

export const fieldCatalogLabel = (key: FieldKey): string => FIELD_CATALOG.find(([k]) => k === key)?.[1] ?? key

/** Sensible starting labels; the doctor can edit each one. */
export const DEFAULT_FIELD_LABELS: Record<FieldKey, string> = {
  'patient.name': 'Name: ',
  'patient.mrn': 'MRN: ',
  'patient.ageSex': 'Age / Sex: ',
  'patient.age': 'Age: ',
  'patient.sex': 'Sex: ',
  'patient.phone': 'Phone: ',
  'patient.address': 'Address: ',
  'visit.date': 'Date: ',
  'visit.dateTime': 'Date & time: ',
  'visit.type': 'Visit: ',
  'doctor.name': 'Doctor: ',
  'doctor.qualifications': 'Qualifications: ',
  'doctor.registrationNo': 'Reg. no.: ',
  'clinic.name': 'Clinic: ',
  static: 'Text'
}
