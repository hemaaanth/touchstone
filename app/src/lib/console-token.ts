// The console token. The server prints it once at start. A Settings write
// must carry it in x-touchstone-grant-token, so a page on another site or
// port cannot change Settings. The operator pastes it on the Settings page.
// It is kept in sessionStorage: it lasts for this tab only.
const KEY = "touchstone.consoleToken"

export function getConsoleToken(): string {
  try {
    return sessionStorage.getItem(KEY) ?? ""
  } catch {
    return ""
  }
}

export function setConsoleToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(KEY, token)
    else sessionStorage.removeItem(KEY)
  } catch {
    // No storage (a private window that blocks it): writes will be refused.
  }
}

export function tokenHeaders(): Record<string, string> {
  const t = getConsoleToken()
  return t ? { "x-touchstone-grant-token": t } : {}
}
