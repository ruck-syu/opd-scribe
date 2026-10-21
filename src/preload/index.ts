import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, EVENTS, type PreloadBridge } from '../shared/api'

const channels = new Set<string>(CHANNELS)
const events = new Set<string>(EVENTS)

const bridge: PreloadBridge = {
  invoke(channel, ...args) {
    if (!channels.has(channel)) return Promise.resolve({ ok: false, error: 'Unknown channel' })
    return ipcRenderer.invoke(channel, ...args)
  },
  on(event, cb) {
    if (!events.has(event)) return () => undefined
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(`event:${event}`, listener)
    return () => ipcRenderer.removeListener(`event:${event}`, listener)
  }
}

contextBridge.exposeInMainWorld('opd', bridge)
