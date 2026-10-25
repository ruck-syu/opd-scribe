# Clinic guide

Setup, data location and backups for the person running OPD Scribe on the clinic laptop. For
development and build instructions see the [README](../README.md).

## First run

1. Install and launch the app. Windows may ask for microphone access; allow it (see the troubleshooting
   section in `docs/SPEECH_MODEL.md`).
2. Complete the setup wizard: clinic name and address, then the doctor's name, qualifications,
   registration number, and a 4-8 digit PIN. This first doctor is the administrator and can verify
   visits and change settings.
3. Open **Settings** (visible to doctors) and walk through the sections:
   - **Clinic & checklists** - clinic name/address/footer, toxicity and symptom checklists (one item per
     line; every item starts as *Not assessed*), the **formulary** (one medicine per line; prescriptions
     naming anything else get a spelling warning, never an automatic correction), auto-lock minutes, and
     audio retention.
   - **Letterhead & printing** - upload the printed letterhead as PDF, PNG, or JPG; set content margins
     and X/Y calibration offsets; choose letterhead on every page or first page only, and one combined
     PDF or two files. Use **Save & test print** and print the calibration page at 100% on the real
     letterhead paper before the first clinic day.
   - **OPD print format** - upload one of the clinic's existing note or
     prescription samples (PDF, PNG, or JPG), then map patient fields and section blocks so output follows
     that format. Preview it, then save. If no custom format is saved, the built-in format is used. Empty
     or unmapped fields still print "Not documented"; verified revisions keep the format version they were
     rendered with.
   - **Downloads** - the speech and AI helper files: progress, pause, resume, retry, or copy them from a USB
     drive. The same rows as the Getting ready screen.
   - **Speech recognition** - language and a vocabulary hint. Under **Advanced** are the manual file paths
     and CPU threads (0 = automatic); leave them empty unless support asks.
   - **Users** - add Staff accounts for registration and drafting, and additional Doctor accounts. Each
     user gets a PIN. Doctors can reset PINs and deactivate users.
   - **Backup & restore** - create a passphrase-encrypted `.opdbackup` file and restore from one.
   - **Audit log** - the latest 300 actions (logins, patient and summary changes, verification, export,
     backup, settings).
4. Then **Getting ready** appears. Press **Download**: speech recognition (about 574 MB, required) and the
   AI helper (about 2.5 GB, optional, ticked by default) are downloaded once. Keep the laptop online until
   both rows say *Installed*; a stopped download can be paused and resumed. With no internet at the clinic,
   press *No internet here?* and choose a USB drive holding the model files. **Later** lets you start
   typing notes; the same screen returns at sign-in until the speech files are installed.
5. Record a short test consultation to check speech recognition.
6. Create the first encrypted backup and store it on a USB drive kept away from the laptop.

## Recording consent

Before a consultation can be recorded, the doctor ticks the patient's consent and confirms it. The
confirmation is written to the audit log and the app refuses to record without it. If the microphone is
unplugged mid-recording, the app stops, keeps what was captured, and transcribes it.

## Where the data lives

Electron's `userData` folder is `%APPDATA%\OPD Scribe` on Windows (typically
`C:\Users\<user>\AppData\Roaming\OPD Scribe`). On macOS it is
`~/Library/Application Support/OPD Scribe`.

```text
%APPDATA%\OPD Scribe\
  opd.db.enc      encrypted SQLite database (patients, visits, revisions, audit, settings, blobs)
  data.key        data key, encrypted with Windows DPAPI via Electron safeStorage
  audio\          one encrypted WAV per transcript; deleted after review unless retention is on
  tmp\            scratch files for speech recognition; recreated at startup
  models\         downloaded (or USB-copied) speech and AI model files (not patient data)
  whisper\        optional whisper-cli.exe + DLLs + ggml model (not patient data)
```

The database file is the whole encrypted database, not a plain SQLite file. Copying it without
`data.key` and the same Windows profile is not enough to read it.

## Backup and recovery

- Use **Settings > Backup & restore**. The passphrase must be at least 8 characters; without it the
  backup cannot be opened. The file contains the database and any retained audio.
- Restoring **replaces all data on the computer** and signs the user out. Restore is intended for a
  replacement laptop or disaster recovery, not for merging two machines.
- `data.key` is tied to the Windows user profile. Losing or recreating that profile (or deleting
  `data.key`) makes the existing database unreadable even if the files are still there. Encrypted
  backups are the recovery path, so take them regularly and test a restore before relying on them.
- Keep backups offline (USB drive in a locked drawer). Enable BitLocker/device encryption on the
  laptop, and keep the backup passphrase somewhere separate from the drive.
- The audit log is append-only inside the app; it is not a substitute for backups.
