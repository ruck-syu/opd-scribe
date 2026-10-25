import type { LlmTemplate } from './types'

/** The two downloadable model files. Fixed by the app; nothing else is ever fetched. */
export type ModelId = 'speech' | 'ai'

export interface ModelSpec {
  id: ModelId
  /** plain-language name shown to the doctor */
  label: string
  /** file name inside userData/models */
  file: string
  /** the only address this model is fetched from (GET, redirects allowed) */
  url: string
  size: number
  sha256: string
  required: boolean
  /** prompt format the model expects; applied when the AI helper is switched on */
  template?: LlmTemplate
}

export const MODEL_CATALOG: ModelSpec[] = [
  {
    id: 'speech',
    label: 'Speech recognition',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    size: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    required: true
  },
  {
    id: 'ai',
    label: 'AI helper that suggests where each sentence goes',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    size: 2497281120,
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    required: false,
    template: 'chatml'
  }
]

interface StatusBase {
  id: ModelId
  /** size of the complete file */
  total: number
  /** bytes present (downloaded so far, or the whole file when ready) */
  bytes: number
}

/** Where one model stands. `missing` with bytes > 0 is a paused download that can be resumed. */
export type ModelStatus =
  | (StatusBase & { state: 'missing' })
  | (StatusBase & { state: 'downloading' })
  | (StatusBase & { state: 'verifying' })
  | (StatusBase & { state: 'ready' })
  | (StatusBase & { state: 'failed'; reason: string })

/** Result of scanning a folder (for example a USB stick) for model files. */
export interface ImportReport {
  /** regular files looked at, including those in one level of subfolders */
  scanned: number
  /** models copied into place by this import */
  imported: ModelId[]
  /** models that were already installed, so their file was not used */
  alreadyInstalled: ModelId[]
  /** files whose size matched a model but whose contents did not, with the reason */
  rejected: { file: string; reason: string }[]
}

/** Plain size for the doctor: "574 MB", "2.5 GB". */
export function fmtSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}
