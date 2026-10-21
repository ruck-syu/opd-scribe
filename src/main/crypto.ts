import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const FILE_MAGIC = Buffer.from('OPDENC01', 'ascii')

/** AES-256-GCM: MAGIC | iv(12) | tag(16) | ciphertext */
export function encrypt(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(FILE_MAGIC)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), ct])
}

export function decrypt(key: Buffer, data: Buffer): Buffer {
  if (data.length < 36 || !data.subarray(0, 8).equals(FILE_MAGIC)) throw new Error('Not an encrypted OPD file')
  const iv = data.subarray(8, 20)
  const tag = data.subarray(20, 36)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(FILE_MAGIC)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data.subarray(36)), decipher.final()])
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export function atomicWrite(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
}

export function writeEncrypted(key: Buffer, path: string, plain: Buffer): void {
  atomicWrite(path, encrypt(key, plain))
}

export function readEncrypted(key: Buffer, path: string): Buffer {
  return decrypt(key, readFileSync(path))
}

export interface KeyProtector {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(enc: Buffer): string
}

/**
 * Data-encryption key, generated once and wrapped with the OS keystore
 * (DPAPI on Windows, Keychain on macOS) through Electron safeStorage.
 */
export function loadOrCreateDataKey(keyPath: string, protector: KeyProtector): Buffer {
  if (!protector.isEncryptionAvailable()) throw new Error('OS secure storage is not available; cannot protect patient data')
  if (existsSync(keyPath)) {
    const key = Buffer.from(protector.decryptString(readFileSync(keyPath)), 'base64')
    if (key.length !== 32) throw new Error('Data key is corrupted')
    return key
  }
  const key = randomBytes(32)
  atomicWrite(keyPath, protector.encryptString(key.toString('base64')))
  return key
}

// ---------- PIN hashing ----------

const PIN_PARAMS = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export function hashPin(pin: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pin, salt, 32, PIN_PARAMS)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(pin, Buffer.from(saltB64, 'base64'), expected.length, PIN_PARAMS)
  return timingSafeEqual(expected, actual)
}
