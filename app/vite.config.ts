import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
// @ts-expect-error — plain .mjs module, no types needed
import { handleApi } from './server/api.mjs'
// @ts-expect-error — plain .mjs module, no types needed
import { handleRuns, handleModels, handleFindings, handleScopes, handleSettings, handleGrants } from './server/runs-http.mjs'
// @ts-expect-error — plain .mjs module, no types needed
import { consoleToken, consoleWriteRefusal, foreignOrigin, handleConsoleToken } from './server/settings.mjs'
// @ts-expect-error — plain .mjs module
import { demoConfig } from './server/demo-config.mjs'

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
    // The dev server writes the console token into the page, and the page sends
    // it back on each write (src/lib/console-token.ts). The operator never sees
    // it. Only the dev server does this (ctx.server): a build output never
    // holds the token. A page on another origin cannot read this page: CORS is
    // off (server.cors below) and the middleware refuses a foreign Origin.
    // The token is read when the page is served, so a page loaded after a rotate
    // gets the new one.
    transformIndexHtml: (_html, ctx) => (ctx.server ? [{ tag: 'meta', attrs: { name: 'touchstone-console-token', content: consoleToken() }, injectTo: 'head' }] : []),
    configureServer(server) {
      if (demoConfig()) throw new Error('Public demo uses node server/start.mjs and built assets, never Vite.')
      server.middlewares.use((req, res, next) => {
        const refuse = (status: number, error: string) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error }))
        }
        // The page, its modules and the API answer only the console's own
        // origin. This covers reads too.
        if (foreignOrigin(req)) return refuse(403, 'This console answers only its own page. Open the console in its own tab.')
        if (!req.url || !req.url.startsWith('/api/')) return next()
        // The console guard, before dispatch, for every write under /api/. A
        // route with no handler of its own is covered too.
        const refusal: { status: number; error: string } | null = consoleWriteRefusal(req)
        if (refusal) return refuse(refusal.status, refusal.error)
        Promise.resolve()
          .then(async () => {
            if (handleModels(req, res)) return
            if (handleConsoleToken(req, res)) return
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
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  // Bind IPv4 loopback so the bb Connect tunnel (which dials 127.0.0.1) can
  // reach it — vite's default "localhost" resolves to IPv6 ::1 only.
  // allowedHosts lets the getbb.app share host through vite's host check.
  // cors is off: Vite's default lets a page on any localhost port read this
  // server's answers, the token-bearing page included.
  server: { host: '127.0.0.1', allowedHosts: ['.getbb.app'], cors: false },
})
