// The console token. Every write to /api/ must carry it in
// x-touchstone-grant-token (the console guard, server/settings.mjs). The dev
// server writes it into the page (vite.config.ts), so only the console's own
// page has it. Never log it or show it.
export function tokenHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {}
  const token = document.querySelector<HTMLMetaElement>('meta[name="touchstone-console-token"]')?.content
  return token ? { "x-touchstone-grant-token": token } : {}
}
