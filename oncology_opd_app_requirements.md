# Oncology OPD Conversation-to-Documentation App

## Product Requirements Document (PRD)

**Document status:** Initial requirements baseline\
**Version:** 1.0\
**Date:** 21 October 2026\
**Target users:** Oncologists and authorized clinic staff\
**Initial deployment:** Offline-first, single-device or local-device
workflow\
**Future direction:** Secure, scalable online synchronization

------------------------------------------------------------------------

## 1. Product Overview

Build an offline-first clinical documentation application that captures
a doctor--patient discussion in an oncology outpatient department (OPD),
transcribes mixed Hindi-English (Hinglish) conversation, accepts
separate doctor-only dictation for examination and clinical decisions,
and compiles the supplied information into an editable OPD visit note
and prescription/plan document.

The application is a **clinical documentation and formatting
assistant**, not an autonomous prescriber. It must not independently
diagnose, recommend medicines, invent findings, infer an unspoken dose,
or create treatment instructions that were not explicitly supplied by
the doctor or selected by an authorized user.

Before any document is printed, exported, shared, or transferred online,
the doctor must review and explicitly verify it.

### 1.1 Primary objectives

-   Reduce the time required to document an oncology OPD consultation.
-   Capture patient answers and doctor dictation with minimal disruption
    to the consultation.
-   Support Hindi-English mixed speech while producing English clinical
    documentation.
-   Organize information into a predictable clinical structure.
-   Preserve oncology-specific longitudinal information between visits.
-   Generate a multi-page A4 PDF aligned with the clinic's existing
    letterhead.
-   Work without internet access during the initial release.
-   Establish an architecture that can support secure online
    synchronization later.

### 1.2 Non-goals for the initial release

-   Autonomous diagnosis or treatment recommendations.
-   Autonomous chemotherapy protocol selection or dose calculation.
-   Automatic signing or finalization of prescriptions.
-   Replacing the clinic's existing reception or hospital information
    system.
-   Cloud-dependent operation.
-   Automatic transfer of documents to patients or external systems
    without doctor verification.
-   Requiring audio to be retained after transcription.

------------------------------------------------------------------------

## 2. Users and Roles

### 2.1 Doctor

The doctor can: - Find and open a registered patient. - Start and stop
conversation recording. - Review and correct the transcript. - Record
doctor-only dictation for examination, assessment, and plan. - Enter or
confirm oncology parameters, vitals, medications, investigations, and
follow-up. - Review and edit the compiled note and prescription. -
Verify and finalize the document. - Print, export, or share the verified
document. - View previous visits and the longitudinal oncology summary.

### 2.2 Reception or authorized clinic staff

Reception staff may: - Register patients or enter demographics if no
existing system integration is available. - Search for a patient and
create an OPD encounter. - Enter demographic information before the
consultation.

Reception staff must not be able to verify or sign the doctor's clinical
note unless explicitly granted a separate authorized clinical role.

### 2.3 Administrator (future capability)

An administrator may manage user access, device settings, clinic
details, templates, and backup policies. Administrative access must not
silently modify finalized clinical records.

------------------------------------------------------------------------

## 3. Core Clinical Workflow

1.  Reception registers the patient or enters demographics in the
    existing reception system.
2.  The doctor searches for the patient using MRN/OPD number or another
    permitted identifier.
3.  The doctor opens a new visit. Patient demographics and the existing
    oncology summary are displayed.
4.  The doctor starts **Conversation Capture** for the doctor--patient
    history-taking discussion.
5.  The application records audio locally and generates a transcript.
    Speaker labels may be suggested, but must be treated as uncertain
    until reviewed.
6.  The doctor reviews and corrects the transcript, especially clinical
    terms, laterality, dates, negations, drug names, and numbers.
7.  The doctor switches to separate **Doctor Dictation** modes for
    examination, assessment, and plan. Each mode labels the captured
    text with its intended section.
8.  The doctor completes structured oncology fields, vitals, toxicity
    checklist, and any other missing information.
9.  The application compiles only the available, explicitly supplied
    information into:
    -   **A. OPD Visit Note** for clinical documentation.
    -   **B. Prescription and Plan Sheet** for the patient.
10. The doctor reviews the structured fields and the rendered multi-page
    A4 preview.
11. The doctor explicitly verifies and finalizes the document.
12. Only after verification can the document be printed, exported,
    shared, or transferred.
13. The finalized visit is saved locally and linked to the patient's
    visit history.

At any time before finalization, the doctor must be able to return to
the transcript or source dictation and correct the generated fields.

------------------------------------------------------------------------

## 4. Functional Requirements

Priority definitions: - **P0:** Required for the first usable release. -
**P1:** Important enhancement after the core workflow is validated. -
**P2:** Later or optional capability.

### 4.1 Patient and encounter management

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  PAT-01                  P0                      Search patients by
                                                  MRN/OPD number and
                                                  available demographic
                                                  fields.

  PAT-02                  P0                      Display
                                                  reception-entered
                                                  demographics, including
                                                  patient name, age/date
                                                  of birth, sex, patient
                                                  identifier, and other
                                                  configured fields.

  PAT-03                  P0                      Create a new encounter
                                                  linked to the correct
                                                  patient.

  PAT-04                  P0                      Clearly display patient
                                                  identity during
                                                  documentation to reduce
                                                  wrong-patient errors.

  PAT-05                  P0                      Support viewing prior
                                                  visits and the
                                                  longitudinal oncology
                                                  summary.

  PAT-06                  P1                      Allow manual patient
                                                  registration if no
                                                  reception-system
                                                  integration is
                                                  available.

  PAT-07                  P1                      Provide a documented
                                                  import/integration path
                                                  for the existing
                                                  reception system.

  PAT-08                  P0                      Prevent one patient's
                                                  transcript or document
                                                  from being accidentally
                                                  attached to another
                                                  patient's visit.
  -----------------------------------------------------------------------

**Integration assumption:** The existing reception system has not yet
been identified. The initial version should use a replaceable
patient-data adapter. CSV import or manual registration can be used
until the existing system's integration options are known. Do not assume
an API exists.

### 4.2 Audio capture and transcription

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  AUD-01                  P0                      Record the
                                                  doctor--patient
                                                  conversation using the
                                                  device microphone or a
                                                  supported external
                                                  microphone.

  AUD-02                  P0                      Provide clear
                                                  recording, paused,
                                                  processing, and stopped
                                                  states.

  AUD-03                  P0                      Capture audio locally
                                                  without requiring
                                                  internet access.

  AUD-04                  P0                      Transcribe
                                                  Hindi-English mixed
                                                  speech and retain
                                                  clinically meaningful
                                                  English terminology.

  AUD-05                  P0                      Show the transcript in
                                                  editable form before
                                                  clinical compilation is
                                                  finalized.

  AUD-06                  P0                      Support separate
                                                  doctor-only dictation
                                                  modes for examination,
                                                  assessment, and plan.

  AUD-07                  P0                      Allow audio recording
                                                  to be paused, resumed,
                                                  stopped, and discarded.

  AUD-08                  P0                      Make speaker labels
                                                  such as Doctor and
                                                  Patient editable and
                                                  visibly uncertain when
                                                  confidence is low.

  AUD-09                  P0                      Do not treat speaker
                                                  diarization as
                                                  perfectly reliable.
                                                  Provide a correction
                                                  workflow.

  AUD-10                  P0                      Allow the user to
                                                  correct transcription
                                                  errors before
                                                  compilation.

  AUD-11                  P0                      Preserve the original
                                                  transcript and track
                                                  subsequent corrections,
                                                  subject to the
                                                  configured retention
                                                  policy.

  AUD-12                  P1                      Support external USB-C,
                                                  Bluetooth, or wired
                                                  microphones where the
                                                  chosen platform
                                                  supports reliable
                                                  capture.

  AUD-13                  P1                      Provide a
                                                  transcription-quality
                                                  indicator and highlight
                                                  low-confidence spans if
                                                  supported by the
                                                  engine.

  AUD-14                  P1                      Support local
                                                  reprocessing of an
                                                  audio segment after the
                                                  user selects a
                                                  different transcription
                                                  model or setting.
  -----------------------------------------------------------------------

**Important behavior:** Conversation transcription is an input source,
not a finalized clinical record. The application must not silently
convert an uncertain word into a definite clinical fact.

### 4.3 Doctor dictation

  ------------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- ------------------------
  DIC-01                  P0                      Provide separate
                                                  controls for
                                                  Examination,
                                                  Assessment/Impression,
                                                  and Plan.

  DIC-02                  P0                      Store each dictation
                                                  under the selected
                                                  section.

  DIC-03                  P0                      Allow text correction
                                                  after transcription.

  DIC-04                  P0                      Clearly distinguish
                                                  doctor dictation from
                                                  patient-reported
                                                  history.

  DIC-05                  P0                      Permit direct typing
                                                  when dictation is
                                                  unavailable or
                                                  inaccurate.

  DIC-06                  P1                      Allow configurable
                                                  additional dictation
                                                  sections, such as
                                                  procedure findings or
                                                  counselling.
  ------------------------------------------------------------------------

### 4.4 Structured OPD note compilation

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  CMP-01                  P0                      Compile the transcript,
                                                  doctor dictation,
                                                  manually entered
                                                  values, and selected
                                                  checklists into
                                                  structured fields.

  CMP-02                  P0                      Generate both an OPD
                                                  Visit Note and a
                                                  Prescription/Plan
                                                  Sheet.

  CMP-03                  P0                      Use only explicitly
                                                  supplied information or
                                                  values explicitly
                                                  selected by an
                                                  authorized user.

  CMP-04                  P0                      Never invent symptoms,
                                                  negative findings,
                                                  examination findings,
                                                  diagnoses, medications,
                                                  doses, routes,
                                                  frequencies, durations,
                                                  investigations, or
                                                  follow-up dates.

  CMP-05                  P0                      Preserve the
                                                  distinction between
                                                  patient-reported
                                                  information, observed
                                                  examination findings,
                                                  prior-record
                                                  information, and
                                                  doctor's assessment.

  CMP-06                  P0                      Represent missing
                                                  information as blank,
                                                  "Not documented," or a
                                                  review warning
                                                  according to the
                                                  template; do not fill
                                                  it by guessing.

  CMP-07                  P0                      Allow the doctor to
                                                  edit every generated
                                                  field.

  CMP-08                  P0                      Keep a link from
                                                  compiled fields to the
                                                  source transcript,
                                                  dictation, or manual
                                                  entry where practical.

  CMP-09                  P0                      Flag conflicting
                                                  statements, uncertain
                                                  speaker attribution,
                                                  unclear negation, and
                                                  ambiguous numbers for
                                                  review.

  CMP-10                  P0                      Re-render the document
                                                  when fields change and
                                                  clearly indicate when
                                                  the document has
                                                  unverified edits.

  CMP-11                  P1                      Provide configurable
                                                  clinical templates for
                                                  common visit types
                                                  without autonomously
                                                  selecting treatment.

  CMP-12                  P1                      Support English output
                                                  from Hinglish input
                                                  while retaining
                                                  standard medical
                                                  terminology.

  CMP-13                  P1                      Allow approved
                                                  abbreviations and
                                                  clinic-specific
                                                  terminology to be
                                                  configured.
  -----------------------------------------------------------------------

### 4.5 Doctor verification and finalization

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  VER-01                  P0                      Require doctor review
                                                  before printing,
                                                  exporting, sharing, or
                                                  online transfer.

  VER-02                  P0                      Require an explicit
                                                  verification action,
                                                  not merely opening the
                                                  preview.

  VER-03                  P0                      Show the patient
                                                  identity, note,
                                                  prescription, and all
                                                  medication details in
                                                  the review screen.

  VER-04                  P0                      Require review of
                                                  medication name,
                                                  strength, dose, route,
                                                  frequency, duration,
                                                  and instructions when
                                                  applicable.

  VER-05                  P0                      Show unresolved
                                                  warnings and ambiguous
                                                  or missing fields
                                                  before verification.

  VER-06                  P0                      Invalidate verification
                                                  when clinically
                                                  relevant content is
                                                  edited after
                                                  verification.

  VER-07                  P0                      Record the verifying
                                                  user and verification
                                                  time.

  VER-08                  P0                      Do not apply a digital
                                                  signature
                                                  automatically. Any
                                                  signature mechanism
                                                  must be explicitly
                                                  configured and approved
                                                  by the doctor.

  VER-09                  P0                      Allow the doctor to
                                                  reopen a finalized
                                                  visit through a
                                                  controlled amendment
                                                  workflow rather than
                                                  silently overwriting
                                                  the signed/finalized
                                                  record.

  VER-10                  P1                      Provide a final
                                                  confirmation screen
                                                  before any external
                                                  transfer or sharing
                                                  action.
  -----------------------------------------------------------------------

### 4.6 Prescription and plan sheet

The prescription/plan sheet is a formatted rendering of the doctor's
documented instructions. It is not an AI-generated treatment
recommendation.

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  RX-01                   P0                      Support multiple
                                                  medication entries.

  RX-02                   P0                      Provide fields for drug
                                                  name,
                                                  formulation/strength,
                                                  dose, route, frequency,
                                                  duration, quantity if
                                                  specified, and
                                                  instructions.

  RX-03                   P0                      Preserve the doctor's
                                                  wording when structured
                                                  extraction is
                                                  uncertain.

  RX-04                   P0                      Never infer missing
                                                  dose, frequency,
                                                  duration, or quantity.

  RX-05                   P0                      Display an explicit
                                                  review warning for
                                                  incomplete or ambiguous
                                                  medication
                                                  instructions.

  RX-06                   P0                      Support investigations,
                                                  advice, follow-up, and
                                                  return precautions.

  RX-07                   P0                      Separate medicines from
                                                  investigations and
                                                  non-drug advice.

  RX-08                   P0                      Allow a prescription to
                                                  span multiple A4 pages
                                                  without cutting off
                                                  content.

  RX-09                   P0                      Prevent printing or
                                                  sharing of an
                                                  unverified
                                                  prescription.

  RX-10                   P1                      Support reusable
                                                  doctor-approved text
                                                  snippets for common
                                                  instructions, with
                                                  explicit selection by
                                                  the doctor.
  -----------------------------------------------------------------------

### 4.7 Oncology-specific information

#### Longitudinal oncology summary

The patient profile should support a configurable cancer summary,
including:

-   Primary cancer site and laterality, where relevant.
-   Histology and relevant pathology details.
-   Date of diagnosis.
-   Stage and staging system/date where recorded.
-   Biomarkers and molecular/pathology results as applicable (for
    example ER, PR, HER2, EGFR, ALK, or other relevant markers).
-   Prior surgery, radiotherapy, systemic therapy, and other major
    treatments.
-   Current line of therapy.
-   Protocol/regimen name, if entered by the doctor.
-   Cycle number, cycle day, and relevant dates, where applicable.
-   Relevant devices, such as a port or central line, if documented.
-   Comorbidities, allergies, and relevant prior complications.
-   Links or references to relevant pathology, imaging, and laboratory
    reports when supported.

The application must not assume that every biomarker applies to every
cancer type. Fields should be configurable and should not force
irrelevant values.

#### Visit-specific oncology information

  ------------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- ------------------------
  ONC-01                  P0                      Record the cancer
                                                  summary separately from
                                                  the current visit note.

  ONC-02                  P0                      Support ECOG Performance
                                                  Status 0--4, with an
                                                  option for not recorded.

  ONC-03                  P0                      Provide a configurable
                                                  toxicity checklist,
                                                  including
                                                  nausea/vomiting,
                                                  mucositis, diarrhea,
                                                  neuropathy, fever,
                                                  bleeding, and dyspnea.

  ONC-04                  P0                      Allow relevant positive
                                                  and negative symptoms to
                                                  be documented without
                                                  assuming unasked
                                                  symptoms are absent.

  ONC-05                  P0                      Record vitals and
                                                  relevant investigations
                                                  reviewed.

  ONC-06                  P0                      Support documentation of
                                                  treatment/chemotherapy
                                                  clearance as a
                                                  doctor-entered decision,
                                                  including Yes, No, or
                                                  Defer where appropriate,
                                                  and a reason.

  ONC-07                  P0                      Allow the doctor to
                                                  record regimen, cycle,
                                                  day, last treatment
                                                  date, and next planned
                                                  treatment when
                                                  applicable.

  ONC-08                  P0                      Display previous
                                                  oncology information
                                                  with its source/date to
                                                  avoid presenting stale
                                                  information as current.

  ONC-09                  P0                      Never calculate or
                                                  authorize chemotherapy
                                                  dosing autonomously.

  ONC-10                  P0                      Do not automatically
                                                  insert clinical
                                                  thresholds or emergency
                                                  instructions unless they
                                                  have been approved and
                                                  configured by the
                                                  clinic.

  ONC-11                  P1                      Support configurable
                                                  cancer-specific
                                                  templates and toxicity
                                                  grading scales selected
                                                  by the clinic.

  ONC-12                  P1                      Support structured
                                                  review of pathology,
                                                  imaging, and laboratory
                                                  trends when source data
                                                  are available.
  ------------------------------------------------------------------------

### 4.8 Letterhead, PDF, printing, and export

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  PDF-01                  P0                      Generate A4 PDF output.

  PDF-02                  P0                      Support the clinic's
                                                  existing letterhead as
                                                  a PDF or suitable image
                                                  background.

  PDF-03                  P0                      Support multiple pages
                                                  and automatic page
                                                  breaks.

  PDF-04                  P0                      Avoid clipping,
                                                  overlapping text, and
                                                  splitting medication
                                                  instructions in unsafe
                                                  ways.

  PDF-05                  P0                      Include patient
                                                  demographics and the
                                                  visit date/time in
                                                  configured positions.

  PDF-06                  P0                      Generate both the OPD
                                                  Visit Note and
                                                  Prescription/Plan
                                                  Sheet. They may be
                                                  separate documents or
                                                  sections of a combined
                                                  multi-page PDF, based
                                                  on clinic
                                                  configuration.

  PDF-07                  P0                      Provide a preview of
                                                  the actual rendered
                                                  output before
                                                  finalization.

  PDF-08                  P0                      Support local save and
                                                  printing.

  PDF-09                  P0                      Permit sharing/export
                                                  only after doctor
                                                  verification.

  PDF-10                  P0                      Preserve the clinic's
                                                  configured footer,
                                                  registration details,
                                                  and signature area.

  PDF-11                  P1                      Support template
                                                  configuration for page
                                                  numbering, margins,
                                                  font sizes, and whether
                                                  the letterhead appears
                                                  on every page.

  PDF-12                  P1                      Provide a print test
                                                  page or template
                                                  alignment workflow to
                                                  calibrate the
                                                  letterhead.
  -----------------------------------------------------------------------

**Template dependency:** The actual letterhead and an anonymized example
of the desired note/prescription are needed to finalize the exact page
layout. No patient-identifiable data should be included in test
examples.

### 4.9 Local storage and visit history

  -----------------------------------------------------------------------
  ID                      Priority                Requirement
  ----------------------- ----------------------- -----------------------
  STO-01                  P0                      Store patient records,
                                                  visits, structured
                                                  fields, transcripts,
                                                  and document metadata
                                                  locally.

  STO-02                  P0                      Use a local database
                                                  with a defined schema
                                                  and migration strategy.

  STO-03                  P0                      Encrypt sensitive
                                                  clinical data at rest
                                                  using
                                                  platform-appropriate
                                                  secure storage and key
                                                  management.

  STO-04                  P0                      Provide a configurable
                                                  audio-retention policy;
                                                  default to deleting raw
                                                  audio after successful
                                                  transcription and
                                                  confirmation unless
                                                  retention is explicitly
                                                  enabled.

  STO-05                  P0                      Make audio retention
                                                  and deletion behavior
                                                  clear to the user.

  STO-06                  P0                      Support controlled
                                                  local backup and
                                                  restore.

  STO-07                  P0                      Do not store sensitive
                                                  clinical data in
                                                  ordinary logs,
                                                  analytics, crash
                                                  reports, or debug
                                                  output.

  STO-08                  P0                      Show visit status, such
                                                  as Draft, Needs Review,
                                                  Verified, or Amended.

  STO-09                  P0                      Preserve finalized
                                                  records and amendments
                                                  in a traceable way.

  STO-10                  P1                      Support encrypted
                                                  export/import for
                                                  device migration.
  -----------------------------------------------------------------------

### 4.10 Future online synchronization

Online functionality is not required for the first release, but the
architecture must avoid making it difficult to add later.

-   Separate local data access from UI logic.
-   Use stable patient, encounter, and document identifiers.
-   Version structured records and templates.
-   Design synchronization around explicit record states and conflict
    handling.
-   Do not upload audio by default.
-   Require authentication, role-based authorization, encrypted
    transport, and audit logs before enabling sync.
-   Provide a clear indication of sync status and errors.
-   Resolve concurrent edits without silently overwriting clinical data.
-   Require explicit doctor verification before transferring finalized
    documents to external systems.
-   Keep offline creation and editing possible during network outages.
-   Document a future integration interface for the reception system or
    an EMR.

------------------------------------------------------------------------

## 5. Required Screens

1.  **Lock / Access Screen** --- PIN or platform biometric unlock, where
    supported.
2.  **Patient Search** --- search by MRN/OPD number and configured
    demographic fields.
3.  **Patient Profile** --- demographics, oncology summary, allergies,
    and prior visits.
4.  **New Visit** --- confirm patient identity, visit date, vitals, and
    relevant encounter details.
5.  **Conversation Capture** --- start, pause, resume, stop, discard,
    and view transcript.
6.  **Transcript Review** --- edit transcript, correct speaker labels,
    flag uncertainty, and confirm history.
7.  **Doctor Dictation** --- separate Examination, Assessment, and Plan
    modes, plus typing fallback.
8.  **Oncology Review** --- cancer summary, ECOG, toxicity checklist,
    regimen/cycle fields, and investigations reviewed.
9.  **Structured Note Editor** --- editable sections and source
    traceability.
10. **Prescription Editor** --- medication entries, investigations,
    advice, and follow-up.
11. **Review and Verification** --- unresolved warnings, patient
    identity, full document preview, and explicit verification.
12. **PDF Preview and Export** --- A4 multi-page preview, print, local
    save, and verified sharing.
13. **Visit History** --- prior notes, prescriptions, amendments, and
    status.
14. **Settings** --- clinic details, letterhead, transcription model,
    audio-retention policy, local backup, and template preferences.

------------------------------------------------------------------------

## 6. Clinical Data Structure

The implementation should maintain structured data independently of the
rendered PDF. A versioned JSON representation is recommended.

### 6.1 Example schema (illustrative, not a final API contract)

``` json
{
  "schema_version": "1.0",
  "patient": {
    "patient_id": "local-stable-id",
    "mrn": "",
    "name": "",
    "date_of_birth": null,
    "age_display": "",
    "sex": ""
  },
  "encounter": {
    "encounter_id": "local-stable-id",
    "visit_datetime": "",
    "status": "draft",
    "doctor_id": "",
    "source_system": ""
  },
  "oncology_summary": {
    "primary_site": "",
    "laterality": "",
    "histology": "",
    "diagnosis_date": null,
    "stage": "",
    "staging_system_and_date": "",
    "biomarkers": [],
    "prior_treatments": [],
    "current_line_of_therapy": "",
    "regimen": "",
    "cycle_number": null,
    "cycle_day": null,
    "last_treatment_date": null,
    "relevant_devices": [],
    "comorbidities": [],
    "allergies": []
  },
  "visit_note": {
    "chief_complaints": [],
    "history_of_present_illness": "",
    "associated_symptoms": [],
    "pertinent_positives": [],
    "pertinent_negatives": [],
    "past_medical_history": "",
    "past_surgical_history": "",
    "medication_history": "",
    "allergies_reviewed": false,
    "vitals": {},
    "ecog_performance_status": null,
    "toxicity_review": [],
    "examination": "",
    "assessment_as_documented_by_doctor": "",
    "investigations_reviewed": [],
    "plan_as_documented_by_doctor": "",
    "follow_up": ""
  },
  "prescription": {
    "medications": [
      {
        "name": "",
        "formulation_strength": "",
        "dose": "",
        "route": "",
        "frequency": "",
        "duration": "",
        "quantity": "",
        "instructions": "",
        "source_text": "",
        "review_required": true
      }
    ],
    "investigations_advised": [],
    "advice": [],
    "return_precautions": [],
    "follow_up": ""
  },
  "sources": {
    "conversation_transcript_id": "",
    "dictation_ids": [],
    "manual_entry_fields": []
  },
  "verification": {
    "verified": false,
    "verified_by": null,
    "verified_at": null,
    "document_hash": null
  },
  "audit": {
    "created_at": "",
    "updated_at": "",
    "amendments": []
  }
}
```

### 6.2 Schema rules

-   Empty strings, nulls, and empty arrays must not be interpreted as
    clinical negatives.
-   A field may carry source metadata, confidence, and review status.
-   Distinguish reported history from observed findings and doctor's
    assessment.
-   Preserve source text for medication details where extraction may be
    ambiguous.
-   Use stable internal identifiers rather than patient names as record
    keys.
-   Keep the schema versioned for future migrations and cloud
    synchronization.
-   The example above is a starting point and must be reviewed by the
    implementing developer and clinician.

------------------------------------------------------------------------

## 7. Compilation and AI Guardrails

AI may assist with transcription, translation/normalization, section
classification, and extraction into structured fields. It must not act
as a prescribing or diagnostic authority.

### 7.1 Permitted behavior

-   Transcribe speech.
-   Normalize mixed Hindi-English speech into clear English while
    preserving the original clinical meaning.
-   Place explicit statements into appropriate sections.
-   Extract explicitly spoken medicine details into editable fields.
-   Identify missing or ambiguous details for review.
-   Flag conflicting statements for human resolution.
-   Format approved content into the clinic template.

### 7.2 Prohibited behavior

-   Invent a diagnosis, symptom, negative finding, examination result,
    or history.
-   Assume an unasked symptom is absent.
-   Guess drug names, strength, dose, route, frequency, duration, or
    quantity.
-   Calculate chemotherapy doses or select a chemotherapy protocol.
-   Infer stage, biomarkers, or treatment line from incomplete
    information.
-   Convert uncertainty into certainty.
-   Automatically add clinical advice or emergency thresholds that have
    not been approved and configured by the clinic.
-   Finalize, sign, print, or send an unverified document.

### 7.3 Review flags

The app should flag, where detectable: - Unclear drug name or
formulation. - Missing medication dose, route, frequency, or duration
when applicable. - Ambiguous number, date, laterality, or negation. -
Uncertain speaker attribution. - Contradictions between transcript,
dictation, prior records, and manually entered values. - Incomplete
patient identity or encounter association. - Missing required
clinic-configured fields. - Edits made after verification.

A warning is not a clinical decision. The doctor must resolve or
explicitly acknowledge it according to the clinic's approved workflow.

------------------------------------------------------------------------

## 8. Suggested Technical Architecture

### 8.1 Initial platform

**Recommended first target:** Android tablet or smartphone, with a
laptop/desktop workflow considered if clinic hardware and
operating-system needs favor it.

The final platform should be confirmed after testing microphone quality,
offline transcription speed, printing, and letterhead alignment on the
actual clinic device.

### 8.2 Suggested components

-   **Application:** Native Android (Kotlin) is a practical first option
    for device audio, local storage, and printing. A cross-platform
    framework may be considered if iOS/desktop support is required
    early.
-   **Local database:** SQLite, accessed through a
    repository/data-access layer.
-   **Audio capture:** Platform audio APIs with support for an external
    microphone.
-   **Offline speech recognition:** Evaluate an on-device model/runtime
    such as whisper.cpp and suitable multilingual models. Benchmark
    Hindi-English code-switching on representative, consented clinical
    audio before selecting a model.
-   **Structured extraction:** A locally runnable model or deterministic
    rules may be evaluated. The app must work with manual correction if
    extraction is unavailable or unreliable.
-   **PDF rendering:** A layout engine that supports A4 pages,
    background letterhead, font embedding where needed, and reliable
    page breaks.
-   **Security:** Platform secure storage for keys, encrypted clinical
    storage, app lock, and minimal logging.
-   **Future backend:** A separately defined API and synchronization
    service; no backend is required for the initial offline MVP.

### 8.3 Hardware

Minimum practical setup to evaluate: - A supported Android phone/tablet
or laptop. - Built-in microphone for initial tests. - Preferably a
close-talk or lapel microphone for improved speech capture. - Sufficient
local storage for the app, transcription model, and clinical records. -
A printer or PDF workflow compatible with A4 output.

Hardware performance requirements must be determined by benchmarking on
the selected device. Do not promise a transcription speed or accuracy
level before testing.

### 8.4 Modular boundaries

Keep these modules separate: - Patient/encounter repository. - Audio
capture. - Speech recognition. - Transcript and speaker-label editor. -
Clinical data compiler. - Oncology fields and checklists. -
Verification/audit workflow. - PDF and print renderer. - Local
backup/restore. - Future synchronization adapter.

This separation will allow transcription engines, storage, and backend
services to be changed without rewriting the clinical workflow.

------------------------------------------------------------------------

## 9. Privacy, Security, and Compliance

The app will handle highly sensitive health information. Privacy and
security are release requirements, not optional enhancements.

-   Obtain appropriate patient consent and follow clinic policy before
    recording.
-   Provide a visible recording indicator and clear start/stop controls.
-   Minimize data collected and retained.
-   Keep the initial workflow local and functional without internet.
-   Encrypt sensitive data at rest and protect encryption keys using
    platform facilities.
-   Require device access control and prevent casual access to patient
    records.
-   Avoid patient details in logs, telemetry, crash reports, and
    notifications.
-   Use a defined retention and deletion policy for audio, transcripts,
    PDFs, and backups.
-   Make backup files encrypted and access-controlled.
-   Maintain audit history for verification, amendments, exports, and
    later synchronization.
-   Do not enable cloud transfer until authentication, authorization,
    encrypted transport, audit logging, consent/notice, and conflict
    handling have been implemented and reviewed.
-   Assess applicable Indian data protection, health-record,
    professional, and electronic-prescription requirements before
    clinical deployment. Obtain appropriate legal/compliance advice;
    this document is not a legal determination.
-   Conduct a security review and clinical workflow validation before
    routine patient use.

------------------------------------------------------------------------

## 10. Acceptance Criteria for the Initial Release

The first release is acceptable only when the following tests pass:

1.  A registered patient can be found and opened without internet
    access.
2.  A new visit is linked to the correct patient and carries the
    expected demographics.
3.  Conversation audio can be recorded locally, stopped, and transcribed
    offline.
4.  A Hinglish transcript can be viewed and manually corrected.
5.  Doctor-only examination, assessment, and plan dictations can be
    captured separately.
6.  Speaker attribution can be corrected manually.
7.  The app can compile a structured note without inventing missing
    clinical facts.
8.  Missing or ambiguous medication details are visibly flagged.
9.  Oncology summary fields, ECOG, toxicity checklist, vitals,
    regimen/cycle fields, and treatment-clearance documentation are
    available.
10. The doctor can edit every generated section.
11. The OPD note and prescription/plan sheet render as readable
    multi-page A4 PDFs on the clinic letterhead.
12. Page breaks do not clip or omit clinical content.
13. Printing, exporting, and sharing are blocked until explicit doctor
    verification.
14. A clinically relevant edit after verification invalidates the
    verification state.
15. The app records who verified the document and when.
16. Records persist after the app is closed and reopened.
17. Audio-retention settings work as documented.
18. Sensitive data do not appear in ordinary application logs.
19. Backup and restore work using an encrypted backup.
20. Core patient and documentation workflows continue to function with
    the network disabled.

Clinical acceptance testing should use synthetic or properly
de-identified test cases and include errors involving medication names,
negation, numbers, dates, laterality, and speaker attribution.

------------------------------------------------------------------------

## 11. Delivery Phases

### Phase 0 --- Workflow and device validation

-   Obtain an anonymized sample of the current letterhead and
    note/prescription.
-   Confirm the existing reception software and available
    integration/export options.
-   Select the target device and microphone.
-   Test offline transcription with representative Hindi-English speech.
-   Define required fields for the clinic's oncology workflow.
-   Agree on audio-retention and consent policy.

**Exit criteria:** A validated device/model choice and an agreed
document template.

### Phase 1 --- Offline MVP

-   Patient search and encounter creation.
-   Local database and secure storage.
-   Conversation recording and offline transcription.
-   Editable transcript.
-   Separate doctor-only dictation for exam, assessment, and plan.
-   Oncology summary and visit fields.
-   Structured note and prescription editors.
-   Mandatory doctor verification.
-   Multi-page A4 letterhead PDF generation.
-   Local print/export and encrypted backup.

**Exit criteria:** All P0 requirements and acceptance criteria pass.

### Phase 2 --- Workflow improvements

-   Better speaker separation and confidence indicators.
-   Clinic-approved templates and terminology.
-   Faster correction controls and source-to-field traceability.
-   Improved import from reception software.
-   More comprehensive oncology-specific forms and longitudinal views.

### Phase 3 --- Secure online capabilities

-   Authentication and role-based access.
-   Encrypted synchronization and conflict handling.
-   Audit logging and sync-status display.
-   Approved integrations with the reception system or EMR.
-   Controlled transfer of verified documents.
-   Cloud backup or multi-device access according to clinic policy.

**Cloud functionality must not be enabled simply by adding an upload
button; the security and governance requirements above must be met
first.**

------------------------------------------------------------------------

## 12. Risks and Mitigations

  -----------------------------------------------------------------------
  Risk                                Mitigation
  ----------------------------------- -----------------------------------
  Hindi-English code-switching causes Benchmark real-world, consented
  transcription errors                samples; allow transcript
                                      correction and doctor dictation.

  Doctor and patient are mislabeled   Treat speaker labels as
                                      suggestions; provide manual
                                      correction and separate doctor-only
                                      dictation.

  AI extraction changes clinical      Preserve source text, show editable
  meaning                             fields, flag ambiguity, and require
                                      doctor verification.

  Medicine details are incomplete     Never guess; highlight
                                      missing/ambiguous fields and block
                                      finalization where clinic policy
                                      requires it.

  Letterhead alignment is incorrect   Use a calibration workflow and
                                      validate on the actual printer and
                                      paper.

  Device is too slow for offline      Benchmark candidate devices and
  transcription                       models before committing to
                                      hardware.

  Patient record is attached to the   Display identity prominently and
  wrong encounter                     validate patient/encounter linkage
                                      throughout the workflow.

  Audio or records are exposed        Local encryption, access control,
                                      minimal retention, secure backups,
                                      and no sensitive logs.

  Future sync creates conflicting     Version records, preserve audit
  edits                               history, and require explicit
                                      conflict resolution.

  Old oncology data appears current   Show source and date for
                                      longitudinal fields and require
                                      confirmation when appropriate.
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 13. Open Decisions

These decisions should be confirmed before implementation is locked:

1.  **Reception software:** Product name, vendor, and whether it
    supports API, CSV, or another export method.
2.  **Target device:** Android phone, Android tablet, Windows laptop,
    macOS laptop, or a combination.
3.  **Letterhead:** An anonymized letterhead PDF/image and a sample
    output layout.
4.  **Document arrangement:** Separate OPD note and prescription PDFs or
    one combined multi-page PDF.
5.  **Audio retention:** Default deletion after transcription or a
    clinic-approved retention period.
6.  **Consent workflow:** How consent to record will be obtained and
    documented.
7.  **Doctor identity and signature:** Printed name/registration details
    and whether a signature image or another approved method is
    required.
8.  **Required oncology fields:** Which fields are mandatory for each
    visit type and which cancer-specific templates are needed first.
9.  **Language behavior:** Whether the source transcript should remain
    Hinglish while the compiled note is English.
10. **Sharing policy:** Which local export methods are permitted and
    which channels, if any, may be enabled later.
11. **Backup location:** Encrypted local removable storage, another
    approved device, or a future managed service.
12. **Clinical review rules:** Which warnings block finalization and
    which can be acknowledged by the doctor.

------------------------------------------------------------------------

## 14. Definition of Done

The initial project is complete when the clinic can run an end-to-end
consultation workflow offline, correct the transcript and structured
note, record doctor dictation, maintain the oncology summary, generate
readable multi-page A4 documents on the actual letterhead, verify the
complete output, and print/export only the verified version---without
the application inventing clinical content.

The application must be validated in a controlled pilot before it is
relied on for routine clinical care.

------------------------------------------------------------------------

## Appendix A --- Example Workflow

**Patient discussion (illustrative):** - Doctor: "What is your main
complaint and for how long?" - Patient: "Teen din se cough hai, aur
thoda sa breathlessness on exertion." - Doctor: "Any fever?" - Patient:
"No fever."

**Doctor dictation (illustrative):** - Examination: "Document the
examination findings dictated by the doctor." - Assessment: "Enter the
doctor's stated assessment." - Plan: "Enter the investigations,
medication instructions, and follow-up explicitly dictated by the
doctor."

The app may place the reported cough and duration, exertional
breathlessness, and reported absence of fever into the appropriate
history fields after review. It must not invent examination findings, a
diagnosis, medicines, doses, or treatment advice. The doctor corrects
and verifies the final note and plan before printing.

------------------------------------------------------------------------

## Appendix B --- Suggested Status Model

-   **Draft:** Encounter created; documentation in progress.
-   **Transcribing:** Audio is being processed locally.
-   **Needs Review:** Transcript or structured fields require review.
-   **Ready for Verification:** Required sections are present, but the
    doctor has not verified the output.
-   **Verified:** Doctor has explicitly verified the current version.
-   **Amended:** A previously verified record has been changed through a
    traceable amendment workflow.
-   **Exported/Printed:** Record of output activity, stored in the audit
    history.

A status must never imply that clinical content is correct merely
because transcription or compilation completed successfully.
