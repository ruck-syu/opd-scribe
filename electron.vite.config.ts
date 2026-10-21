import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import type { Plugin } from 'vite'

const shared = { alias: { '@shared': resolve(__dirname, 'src/shared') } }

// Production CSP (file:// responses bypass the session header hook; dev gets the header from main).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "worker-src 'self' blob:; media-src 'self' blob: mediastream:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

const cspMeta = (): Plugin => ({
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
})

export default defineConfig({
  main: { resolve: shared },
  preload: { resolve: shared },
  renderer: { resolve: shared, plugins: [react(), cspMeta()] }
})
