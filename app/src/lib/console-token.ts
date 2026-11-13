// The console token. Every write to /api/ must carry it in
// x-touchstone-grant-token (the console guard, server/settings.mjs). The dev
// server writes it into the page (vite.config.ts), so only the console's own
// page has it. Never log it or show it.
const META = 'meta[name="touchstone-console-token"]'

export function tokenHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {}
  const token = document.querySelector<HTMLMetaElement>(META)?.content
  return token ? { "x-touchstone-grant-token": token } : {}
}

// After a rotate (Settings), the page that rotated takes the new token, so its
// next write carries it. Only the page's meta tag holds it.
export function setConsoleToken(token: string): void {
  if (typeof document === "undefined" || !token) return
  let meta = document.querySelector<HTMLMetaElement>(META)
  if (!meta) {
    meta = document.createElement("meta")
    meta.name = "touchstone-console-token"
    document.head.appendChild(meta)
  }
  meta.content = token
}

// A write the server refused with 403: this page's token is old (another tab
// rotated it, or the server started with a new one). Every write reports it
// here, so the app can say so once, even for a write that shows no error of
// its own. `message` is the server's own sentence.
const STALE_EVENT = "touchstone:stale-page"

export function reportStalePage(message: string): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<string>(STALE_EVENT, { detail: message }))
}

export function onStalePage(listener: (message: string) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const handle = (e: Event) => listener((e as CustomEvent<string>).detail)
  window.addEventListener(STALE_EVENT, handle)
  return () => window.removeEventListener(STALE_EVENT, handle)
}
