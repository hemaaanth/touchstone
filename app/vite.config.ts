import path from 'node:path'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
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
      // The streamed browser is framed through this origin, because a
      // cross-site iframe does not carry the tunnel's sign-in cookie.
      // /preview/<loopback port>/... proxies to the viewer's pipe; websockets
      // take the same route through the upgrade handler below.
      const proxy = (req: IncomingMessage, socket: Duplex, head = Buffer.alloc(0)) => {
        const m = /^\/preview\/(\d{2,5})(\/.*)?$/.exec(req.url ?? "")
        if (!m) return false
        const target = httpRequest({ host: "127.0.0.1", port: Number(m[1]), path: m[2] || "/", method: req.method, headers: { ...req.headers, host: `127.0.0.1:${m[1]}` } }, (up: IncomingMessage) => {
          socket.write(`HTTP/1.1 ${up.statusCode} ${up.statusMessage}\r\n` + Object.entries(up.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\r\n") + "\r\n\r\n")
          up.pipe(socket); up.on("end", () => socket.end())
        })
        target.on("error", () => { if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n") })
        socket.on("error", () => target.destroy())
        if (head.length) target.write(head)
        return true
      }
      server.httpServer?.on("upgrade", (req, socket, head) => { if (proxy(req, socket, head)) return })
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").startsWith("/preview/")) {
          const m = /^\/preview\/(\d{2,5})(\/.*)?$/.exec(req.url ?? "")
          if (m) {
            const prefix = `/preview/${m[1]}`
            const target = httpRequest({ host: "127.0.0.1", port: Number(m[1]), path: m[2] || "/", method: req.method, headers: { ...req.headers, host: `127.0.0.1:${m[1]}` } }, (up: IncomingMessage) => {
              // The streamed page and its own viewer use root-absolute URLs. Under
              // the preview prefix those must stay inside it, so rewrite them.
              const html = /text\/html/.test(String(up.headers["content-type"] ?? ""))
              const fix = (b: string) => b.replace(/((?:src|href)=")\/(?!\/)/g, `$1${prefix}/`)
              if (!html) {
                res.statusCode = up.statusCode ?? 502
                for (const [k, v] of Object.entries(up.headers)) if (v != null) res.setHeader(k, v as string | string[])
                up.pipe(res)
                return
              }
              const chunks: Buffer[] = []
              up.on("data", (c: Buffer) => chunks.push(c))
              up.on("end", () => {
                const body = fix(Buffer.concat(chunks).toString("utf8"))
                res.statusCode = up.statusCode ?? 502
                for (const [k, v] of Object.entries(up.headers)) if (v != null && k !== "content-length") res.setHeader(k, v as string | string[])
                res.setHeader("content-length", Buffer.byteLength(body))
                res.end(body)
              })
            })
            target.on("error", () => { res.statusCode = 502; res.end("Bad gateway") })
            if (req.readable) req.pipe(target); else target.end()
            return
          }
        }
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
