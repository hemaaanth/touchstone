import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
// @ts-expect-error — plain .mjs module, no types needed
import { handleApi } from './server/api.mjs'
// @ts-expect-error — plain .mjs module, no types needed
import { handleRuns, handleModels, handleFindings, handleScopes, handleSettings, handleGrants } from './server/runs-http.mjs'
// @ts-expect-error — plain .mjs module, no types needed
import { SETTINGS_TOKEN } from './server/settings.mjs'

// The whole backend, in-process inside Vite's dev server. The Vite dev server
// is a real long-lived Node process, so it can spawn the agent engine, hold an
// SSE stream open, and keep the live run registry in memory — no second
// process, no proxy, no new dependency.
//
// Order matters: the runs routes (POST bodies, SSE) and the models route are
// (req,res)-aware and claim their paths first; everything else that starts with
// /api/ falls through to the URL-only findings reader.
function touchstoneApi(): Plugin {
  return {
    name: 'touchstone-api',
    // The server writes the console token into the page, and the page sends it
    // back on each write (src/lib/console-token.ts). The operator never sees
    // it. A page on another site cannot read this page, so it has no token.
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'touchstone-console-token', content: SETTINGS_TOKEN }, injectTo: 'head' }],
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) return next()
        Promise.resolve()
          .then(async () => {
            if (handleModels(req, res)) return
            if (await handleRuns(req, res)) return
            if (await handleScopes(req, res)) return
            if (await handleGrants(req, res)) return
            if (await handleSettings(req, res)) return
            if (await handleFindings(req, res)) return
            const result: { status: number; json: unknown } = await handleApi(req.url)
            res.statusCode = result.status
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(result.json))
          })
          .catch((err: unknown) => {
            if (res.headersSent) {
              res.end()
              return
            }
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: String(err) }))
          })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), touchstoneApi()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Bind IPv4 loopback so the bb Connect tunnel (which dials 127.0.0.1) can
  // reach it — vite's default "localhost" resolves to IPv6 ::1 only.
  // allowedHosts lets the getbb.app share host through vite's host check.
  server: { host: '127.0.0.1', allowedHosts: ['.getbb.app'] },
})
