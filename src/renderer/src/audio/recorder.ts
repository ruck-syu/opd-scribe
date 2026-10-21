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
  private released = false
  private interrupted = false
  paused = false
  level = 0
  readonly sampleRate = 16000
  /** Called once when the mic disappears or the audio context closes underneath us. */
  onInterrupted?: (reason: string) => void

  async start(deviceId?: string): Promise<void> {
    this.released = false
    this.interrupted = false
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener('ended', () => this.notifyInterrupted('Microphone disconnected'))
    }
    this.ctx = new AudioContext({ sampleRate: this.sampleRate })
    this.ctx.onstatechange = () => {
      const state = this.ctx?.state as string | undefined
      if (state === 'closed' || state === 'interrupted') this.notifyInterrupted('Microphone disconnected')
    }
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

  /** Fire the interruption callback at most once, and never for our own teardown. */
  private notifyInterrupted(reason: string): void {
    if (this.interrupted || this.released) return
    this.interrupted = true
    this.onInterrupted?.(reason)
  }

  /** Release the mic / audio graph exactly once. */
  private release(): void {
    if (this.released) return
    this.released = true
    if (this.node) {
      this.node.onaudioprocess = null
      this.node.disconnect()
      this.node = null
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    const ctx = this.ctx
    this.ctx = null
    if (ctx) {
      ctx.onstatechange = null
      void ctx.close().catch(() => undefined)
    }
  }

  /** Idempotent: a second call returns an empty WAV instead of throwing. */
  async stop(): Promise<{ wav: ArrayBuffer; durationMs: number }> {
    const out = { wav: encodeWav(this.chunks, this.samples, this.sampleRate), durationMs: this.durationMs }
    this.release()
    this.chunks = []
    this.samples = 0
    this.paused = false
    return out
  }

  /** Idempotent: safe to call after stop() or more than once. */
  async cancel(): Promise<void> {
    this.release()
    this.chunks = []
    this.samples = 0
    this.paused = false
  }
}

/** Exported for the WAV header tests; no browser APIs are used. */
export function encodeWav(chunks: Int16Array[], samples: number, rate: number): ArrayBuffer {
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
