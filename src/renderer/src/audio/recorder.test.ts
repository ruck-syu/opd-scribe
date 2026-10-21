import { describe, expect, it } from 'vitest'
import { encodeWav } from './recorder'

const ascii = (buf: ArrayBuffer, offset: number, length: number): string =>
  String.fromCharCode(...new Uint8Array(buf, offset, length))

describe('encodeWav', () => {
  it('writes a 16 kHz mono 16-bit PCM header', () => {
    const wav = encodeWav([Int16Array.from([1, -2, 3]), Int16Array.from([4, 5])], 5, 16000)
    const v = new DataView(wav)

    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 5 * 2)
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 12, 4)).toBe('fmt ')
    expect(v.getUint32(16, true)).toBe(16)
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000)
    expect(v.getUint16(32, true)).toBe(2)
    expect(v.getUint16(34, true)).toBe(16)
    expect(ascii(wav, 36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(5 * 2)
    expect(wav.byteLength).toBe(44 + 5 * 2)
  })

  it('lays out samples in order', () => {
    const wav = encodeWav([Int16Array.from([1, -2]), Int16Array.from([3])], 3, 16000)
    expect([...new Int16Array(wav, 44, 3)]).toEqual([1, -2, 3])
  })

  it('produces a valid empty WAV', () => {
    const wav = encodeWav([], 0, 16000)
    expect(wav.byteLength).toBe(44)
    expect(new DataView(wav).getUint32(4, true)).toBe(36)
    expect(new DataView(wav).getUint32(40, true)).toBe(0)
  })
})
