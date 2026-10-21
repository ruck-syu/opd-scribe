/** Deterministic JSON (sorted keys) used for content hashing (VER-07, VER-06). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/**
 * Content that affects the rendered document. Acknowledgements are review metadata,
 * not clinical content, so they are excluded from the hash.
 */
export function clinicalContent<T extends { acknowledgedFlags: string[] }>(doc: T): Omit<T, 'acknowledgedFlags'> {
  const { acknowledgedFlags: _ignored, ...rest } = doc
  return rest
}
