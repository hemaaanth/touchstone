// The console token. A Settings write, a live website scope, a grant change and
// a folder by path must carry it in x-touchstone-grant-token. The server writes
// it into the page (vite.config.ts), so only the console's own page has it.
export function tokenHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {}
  const token = document.querySelector<HTMLMetaElement>('meta[name="touchstone-console-token"]')?.content
  return token ? { "x-touchstone-grant-token": token } : {}
}
