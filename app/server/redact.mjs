// Strip operator secrets out of a shareable report.
//
// A live AI/MCP run carries a bearer token. The agent's explanation and the
// HTTP exchanges it recorded can quote that token, an Authorization / Cookie /
// X-API-Key header, or another value that is obviously a secret. The report is
// the thing people save and send, so the secret values come out here.
//
// Only the secret value changes. Header names, status codes, URLs (aside from
// a secret query value), oracle text, and an already-redacted sha256 fingerprint
// stay, because a reader needs those to check the proof. The same string
// redacts to the same marker, so running this twice does not nest markers.

const MARK = "[REDACTED]"

// Object keys and header-cell names whose value is a credential.
const SECRET_KEY = /^(?:token|bearer|password|passwd|secret|session(?:id|[-_]id)?|(?:x-)?(?:api[-_]?key|auth(?:orization|[-_]token)|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|proxy-authorization|private[-_]?key|cookie|set-cookie))$/i

const QUOTED_HEADER = /"((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-apikey|api-key|x-auth-token|x-access-token))"(\s*:\s*)"((?:\\.|[^"\\])*)"/gi

// One or two words: "Bearer <token>" and "Basic <blob>" are both the secret.
const AUTH_HEADER = /(?<!["'])\b(authorization|proxy-authorization)\s*:\s*\S+(?:\s+\S+)?/gi
const APIKEY_HEADER = /(?<!["'])\b(x-api-key|x-apikey|api-key|x-auth-token|x-access-token)\s*:\s*[^\s,;"]+/gi
const COOKIE_HEADER = /(?<!["'])\b(cookie|set-cookie)\s*:\s*[^\s;"]+(?:;\s*[^\s;"]+)*/gi

const BEARER = /\bBearer\s+(?:token\s*[:=]?\s+)?([A-Za-z0-9\-._~+/=]{8,})/gi
const QUERY = /([?&#](?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password|token)=)([^&\s#"']+)/gi

// Shapes that are a secret wherever they sit. Deliberately not bare hex:
// snapshot hashes and commits are 40/64 hex and the proof needs them.
const SHAPES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9\-_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bsk-[A-Za-z0-9-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bnpm_[A-Za-z0-9]{36,}\b/g,
]

function secretish(tok) {
  if (tok.startsWith(MARK)) return false
  if (/[0-9_\-./+=]/.test(tok)) return true
  return tok.length >= 20
}

function redactText(text) {
  if (!text || text.startsWith(MARK)) return text
  for (const re of [QUOTED_HEADER, AUTH_HEADER, APIKEY_HEADER, COOKIE_HEADER, BEARER, QUERY, ...SHAPES]) re.lastIndex = 0
  let out = text
  out = out.replace(QUOTED_HEADER, (_m, name, sep) => `"${name}"${sep}"${MARK}"`)
  out = out.replace(AUTH_HEADER, (_m, name) => `${name}: ${MARK}`)
  out = out.replace(APIKEY_HEADER, (_m, name) => `${name}: ${MARK}`)
  out = out.replace(COOKIE_HEADER, (_m, name) => `${name}: ${MARK}`)
  out = out.replace(BEARER, (m, tok) => (secretish(tok) ? `Bearer ${MARK}` : m))
  out = out.replace(QUERY, `$1${MARK}`)
  for (const re of SHAPES) out = out.replace(re, MARK)
  return out
}

function copyRedactedCell(value) {
  const copy = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === "sha256") copy[k] = v
    else if (k === "value" && typeof v === "string") copy[k] = MARK
    else copy[k] = walk(v, k)
  }
  return copy
}

function walk(value, key) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (value.startsWith(MARK)) return value
    if (key && SECRET_KEY.test(key)) return MARK
    return redactText(value)
  }
  if (Array.isArray(value)) {
    const blank = key && SECRET_KEY.test(key)
    return value.map((item) => (blank && typeof item === "string" ? MARK : walk(item, "")))
  }
  if (typeof value !== "object") return value
  if (value.redacted === true && typeof value.sha256 === "string") return copyRedactedCell(value)
  if (typeof value.name === "string" && typeof value.value === "string" && value.redacted !== true && SECRET_KEY.test(value.name)) {
    const copy = {}
    for (const [k, v] of Object.entries(value)) copy[k] = k === "value" ? MARK : walk(v, k)
    return copy
  }
  const copy = {}
  for (const [k, v] of Object.entries(value)) copy[k] = walk(v, k)
  return copy
}

// A deep copy of a report or finding with secret values masked.
export function redactSecrets(value) {
  return walk(value, "")
}
