import { describe, expect, it } from 'vitest'
import { parsePatientCsv } from './csvImport'

const NOW = new Date(2026, 5, 15)

describe('parsePatientCsv', () => {
  it('maps aliases case-insensitively and ignores separators', () => {
    const csv = [
      'UHID, Patient Name, Gender, D.O.B, Mobile No, Age, Address, Notes',
      'OPD-1,Asha Rao,F,12/03/1970,9876543210,54,"12 Main St, Apt 4",follow up'
    ].join('\n')

    const result = parsePatientCsv(csv, NOW)

    expect(result.errors).toEqual([])
    expect(result.rows).toEqual([
      {
        mrn: 'OPD-1',
        name: 'Asha Rao',
        dateOfBirth: '1970-03-12',
        ageDisplay: '54 y',
        sex: 'female',
        phone: '9876543210',
        address: '12 Main St, Apt 4'
      }
    ])
    expect(result.unmappedColumns).toEqual(['Notes'])
  })

  it('strips a UTF-8 BOM', () => {
    const result = parsePatientCsv('\uFEFFMRN,Name\n1,Anil', NOW)
    expect(result.rows.map((row) => row.mrn)).toEqual(['1'])
    expect(result.rows[0].name).toBe('Anil')
  })

  it('accepts the supported date formats', () => {
    const csv = ['MRN,Name,DOB', '1,A,1990-02-28', '2,B,01/03/1990', '3,C,02-03-1990', '4,D,03.03.1990'].join(
      '\n'
    )
    const result = parsePatientCsv(csv, NOW)
    expect(result.errors).toEqual([])
    expect(result.rows.map((row) => row.dateOfBirth)).toEqual([
      '1990-02-28',
      '1990-03-01',
      '1990-03-02',
      '1990-03-03'
    ])
  })

  it('rejects an impossible date and still imports the row', () => {
    const result = parsePatientCsv('MRN,Name,DOB\n1,A,31/02/1990', NOW)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].dateOfBirth).toBeNull()
    expect(result.errors).toEqual([{ line: 2, message: 'Invalid date of birth' }])
  })

  it('rejects a future date', () => {
    const result = parsePatientCsv('MRN,Name,DOB\n1,A,01/01/2030', NOW)
    expect(result.rows[0].dateOfBirth).toBeNull()
    expect(result.errors).toEqual([{ line: 2, message: 'Invalid date of birth' }])
  })

  it('leaves an empty date of birth as null', () => {
    const result = parsePatientCsv('MRN,Name,DOB\n1,A,', NOW)
    expect(result.rows[0].dateOfBirth).toBeNull()
    expect(result.errors).toEqual([])
  })

  it('normalises sex values and never guesses', () => {
    const csv = [
      'MRN,Name,Sex',
      '1,A,m',
      '2,B,Male',
      '3,C,female',
      '4,D,others',
      '5,E,Transgender',
      '6,F,unknown',
      '7,G,'
    ].join('\n')
    const result = parsePatientCsv(csv, NOW)
    expect(result.rows.map((row) => row.sex)).toEqual([
      'male',
      'male',
      'female',
      'other',
      'other',
      '',
      ''
    ])
  })

  it('skips rows missing MRN or name with the correct line numbers', () => {
    const result = parsePatientCsv('MRN,Name\n1,A\n,B\n2,', NOW)
    expect(result.rows.map((row) => row.mrn)).toEqual(['1'])
    expect(result.errors).toEqual([
      { line: 3, message: 'Missing MRN' },
      { line: 4, message: 'Missing name' }
    ])
  })

  it('keeps the first row for a duplicate MRN', () => {
    const result = parsePatientCsv('MRN,Name\n1,A\n1,Duplicate\n2,C', NOW)
    expect(result.rows.map((row) => row.name)).toEqual(['A', 'C'])
    expect(result.errors).toEqual([{ line: 3, message: 'Duplicate MRN in file' }])
  })

  it('reports unmapped columns', () => {
    const result = parsePatientCsv('MRN,Name,Foo Bar\n1,A,x', NOW)
    expect(result.unmappedColumns).toEqual(['Foo Bar'])
  })

  it('parses quoted fields containing commas', () => {
    const result = parsePatientCsv('MRN,Name,Address\n1,"Rao, Asha","12 Main St, Apt 4"', NOW)
    expect(result.rows[0].name).toBe('Rao, Asha')
    expect(result.rows[0].address).toBe('12 Main St, Apt 4')
  })

  it('fails at line 1 when a required column cannot be mapped', () => {
    const missingMrn = parsePatientCsv('Name,Age\nA,54', NOW)
    expect(missingMrn.rows).toEqual([])
    expect(missingMrn.errors).toHaveLength(1)
    expect(missingMrn.errors[0].line).toBe(1)
    expect(missingMrn.errors[0].message).toContain('mrn')

    const missingName = parsePatientCsv('MRN,Age\n1,54', NOW)
    expect(missingName.rows).toEqual([])
    expect(missingName.errors).toHaveLength(1)
    expect(missingName.errors[0].line).toBe(1)
    expect(missingName.errors[0].message).toContain('name')
  })

  it('keeps non-numeric age text as entered', () => {
    const result = parsePatientCsv('MRN,Name,Age\n1,A,54 years\n2,B,  ', NOW)
    expect(result.rows.map((row) => row.ageDisplay)).toEqual(['54 years', ''])
  })

  it('skips blank lines', () => {
    const result = parsePatientCsv('MRN,Name\n1,A\n\n2,B\n\n', NOW)
    expect(result.rows.map((row) => row.mrn)).toEqual(['1', '2'])
    expect(result.errors).toEqual([])
  })
})
