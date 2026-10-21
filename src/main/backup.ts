import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export interface BackupEntry {
  name: string
  data: Buffer
}

export const BACKUP_MAGIC = 'OPDBAK01'

const VERSION = 1
const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16
const MAGIC_LENGTH = 8
const AAD_LENGTH = MAGIC_LENGTH + 1 + SALT_LENGTH
const HEADER_LENGTH = AAD_LENGTH + IV_LENGTH + TAG_LENGTH
const MAX_NAME_BYTES = 255
const MIN_PASSPHRASE_LENGTH = 8

const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

const AUTH_ERROR = 'Wrong passphrase or corrupted backup'
const FORMAT_ERROR = 'Not an OPD backup file'

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT_OPTIONS)
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error('Passphrase must be at least 8 characters')
  }
}

function validateEntryName(name: string): void {
  if (name.length === 0) throw new Error('Backup entry name must not be empty')
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new Error('Backup entry name is too long')
  }
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.includes('..')) {
    throw new Error('Invalid backup entry name')
  }
}

function packEntries(entries: BackupEntry[]): Buffer {
  const chunks: Buffer[] = []
  const count = Buffer.alloc(4)
  count.writeUInt32BE(entries.length, 0)
  chunks.push(count)
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const nameLength = Buffer.alloc(4)
    nameLength.writeUInt32BE(name.length, 0)
    const dataLength = Buffer.alloc(4)
    dataLength.writeUInt32BE(entry.data.length, 0)
    chunks.push(nameLength, name, dataLength, entry.data)
  }
  return Buffer.concat(chunks)
}

function unpackEntries(plain: Buffer): BackupEntry[] {
  const readUInt32 = (offset: number): number => {
    if (offset + 4 > plain.length) throw new Error(AUTH_ERROR)
    return plain.readUInt32BE(offset)
  }

  let offset = 0
  const count = readUInt32(offset)
  offset += 4
  const entries: BackupEntry[] = []
  for (let i = 0; i < count; i += 1) {
    const nameLength = readUInt32(offset)
    offset += 4
    if (offset + nameLength > plain.length) throw new Error(AUTH_ERROR)
    const name = plain.subarray(offset, offset + nameLength).toString('utf8')
    offset += nameLength
    const dataLength = readUInt32(offset)
    offset += 4
    if (offset + dataLength > plain.length) throw new Error(AUTH_ERROR)
    const data = Buffer.from(plain.subarray(offset, offset + dataLength))
    offset += dataLength
    entries.push({ name, data })
  }
  if (offset !== plain.length) throw new Error(AUTH_ERROR)
  return entries
}

export function createBackup(entries: BackupEntry[], passphrase: string): Buffer {
  validatePassphrase(passphrase)
  for (const entry of entries) validateEntryName(entry.name)

  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const header = Buffer.concat([Buffer.from(BACKUP_MAGIC, 'ascii'), Buffer.from([VERSION]), salt])

  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(header)
  const ciphertext = Buffer.concat([cipher.update(packEntries(entries)), cipher.final()])
  const authTag = cipher.getAuthTag()

  return Buffer.concat([header, iv, authTag, ciphertext])
}

export function readBackup(file: Buffer, passphrase: string): BackupEntry[] {
  if (file.length < HEADER_LENGTH) throw new Error(FORMAT_ERROR)
  const magic = file.subarray(0, MAGIC_LENGTH).toString('ascii')
  if (magic !== BACKUP_MAGIC || file[MAGIC_LENGTH] !== VERSION) throw new Error(FORMAT_ERROR)

  const salt = file.subarray(MAGIC_LENGTH + 1, AAD_LENGTH)
  const iv = file.subarray(AAD_LENGTH, AAD_LENGTH + IV_LENGTH)
  const authTag = file.subarray(AAD_LENGTH + IV_LENGTH, HEADER_LENGTH)
  const ciphertext = file.subarray(HEADER_LENGTH)

  let plain: Buffer
  try {
    const key = deriveKey(passphrase, salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(file.subarray(0, AAD_LENGTH))
    decipher.setAuthTag(authTag)
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error(AUTH_ERROR)
  }

  try {
    return unpackEntries(plain)
  } catch {
    throw new Error(AUTH_ERROR)
  }
}
