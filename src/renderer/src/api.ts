import type { ApiMap, Channel, EventMap, EventName, PreloadBridge } from '../../shared/api'

declare global {
  interface Window {
    opd: PreloadBridge
  }
}

export async function call<C extends Channel>(channel: C, ...args: Parameters<ApiMap[C]>): Promise<ReturnType<ApiMap[C]>> {
  const r = await window.opd.invoke(channel, ...args)
  if (!r.ok) throw new Error(r.error)
  return r.value as ReturnType<ApiMap[C]>
}

export function on<E extends EventName>(event: E, cb: (payload: EventMap[E]) => void): () => void {
  return window.opd.on(event, (p) => cb(p as EventMap[E]))
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
