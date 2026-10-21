/**
 * Microphone capture → 16 kHz mono 16-bit PCM WAV (the format whisper.cpp expects).
 * ScriptProcessorNode is used instead of an AudioWorklet so no extra module has to be
 * loaded under the strict CSP / file:// origin.
 */
export class PcmRecorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private chunks: Int16Array[] = []
  private samples = 0
  paused = false
  level = 0
  readonly sampleRate = 16000

  async start(deviceId?: string): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    this.ctx = new AudioContext({ sampleRate: this.sampleRate })
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(4096, 1, 1)
    this.node.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0)
      let sum = 0
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
      this.level = Math.sqrt(sum / input.length)
      if (this.paused) return
      const pcm = new Int16Array(input.length)
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      this.chunks.push(pcm)
      this.samples += pcm.length
    }
    src.connect(this.node)
    this.node.connect(this.ctx.destination)
  }

  get durationMs(): number {
    return (this.samples / this.sampleRate) * 1000
  }

  async stop(): Promise<{ wav: ArrayBuffer; durationMs: number }> {
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    await this.ctx?.close()
    const out = { wav: encodeWav(this.chunks, this.samples, this.sampleRate), durationMs: this.durationMs }
    this.chunks = []
    this.samples = 0
    return out
  }

  async cancel(): Promise<void> {
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    await this.ctx?.close()
    this.chunks = []
    this.samples = 0
  }
}

function encodeWav(chunks: Int16Array[], samples: number, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string): void => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples * 2, true)
  let off = 44
  for (const c of chunks) {
    new Int16Array(buf, off, c.length).set(c)
    off += c.length * 2
  }
  return buf
}
