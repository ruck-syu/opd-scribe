import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BACKUP_MAGIC, createBackup, readBackup } from './backup'

const PASSPHRASE = 'correct horse battery'

describe('createBackup / readBackup', () => {
  it('round-trips multiple entries including empty and large buffers', () => {
    const large = randomBytes(1024 * 1024)
    const entries = [
      { name: 'opd.sqlite', data: Buffer.from('database bytes') },
      { name: 'empty.bin', data: Buffer.alloc(0) },
      { name: 'nested/large.bin', data: large }
    ]

    const file = createBackup(entries, PASSPHRASE)
    expect(file.subarray(0, 8).toString('ascii')).toBe(BACKUP_MAGIC)

    const restored = readBackup(file, PASSPHRASE)
    expect(restored.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name))
    expect(restored[0].data.toString('utf8')).toBe('database bytes')
    expect(restored[1].data).toHaveLength(0)
    expect(restored[2].data.equals(large)).toBe(true)
  })

  it('rejects a wrong passphrase with the exact message', () => {
    const file = createBackup([{ name: 'a.txt', data: Buffer.from('x') }], PASSPHRASE)
    expect(() => readBackup(file, 'wrong passphrase')).toThrow('Wrong passphrase or corrupted backup')
  })

  it('rejects a tampered ciphertext byte', () => {
    const file = createBackup([{ name: 'a.txt', data: Buffer.from('hello') }], PASSPHRASE)
    const tampered = Buffer.from(file)
    tampered[tampered.length - 1] ^= 0xff
    expect(() => readBackup(tampered, PASSPHRASE)).toThrow('Wrong passphrase or corrupted backup')
  })

  it('rejects a tampered salt in the authenticated header', () => {
    const file = createBackup([{ name: 'a.txt', data: Buffer.from('hello') }], PASSPHRASE)
    const tampered = Buffer.from(file)
    tampered[12] ^= 0xff
    expect(() => readBackup(tampered, PASSPHRASE)).toThrow('Wrong passphrase or corrupted backup')
  })

  it('rejects a bad magic', () => {
    const file = createBackup([{ name: 'a.txt', data: Buffer.from('hello') }], PASSPHRASE)
    const tampered = Buffer.from(file)
    tampered[0] = 0x58
    expect(() => readBackup(tampered, PASSPHRASE)).toThrow('Not an OPD backup file')
    expect(() => readBackup(Buffer.from('nope'), PASSPHRASE)).toThrow('Not an OPD backup file')
  })

  it('requires a passphrase of at least 8 characters', () => {
    expect(() => createBackup([], 'short')).toThrow('Passphrase must be at least 8 characters')
    expect(() => createBackup([], '1234567')).toThrow('Passphrase must be at least 8 characters')
  })

  it('rejects invalid entry names', () => {
    const badNames = ['', '../escape', '/absolute', 'a\\b', 'a\0b', 'x'.repeat(256)]
    for (const name of badNames) {
      expect(() => createBackup([{ name, data: Buffer.alloc(0) }], PASSPHRASE)).toThrow()
    }
  })
})
