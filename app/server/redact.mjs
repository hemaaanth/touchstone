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
// Any other name that ends in a secret word: x-goog-api-key, x-csrf-token,
// PRIVATE-TOKEN, DB_PASSWORD, signerPrivateKey. A bare "key" or "signature"
// is not enough; prose says "Key:" and a SIWE body carries its signature.
const SECRET_SUFFIX = /[-_](?:token|key|secret|signature|password|passwd)$/i
const SECRET_CAMEL = /[a-z0-9](?:Token|Key|Secret|Password)$/
const PUBLIC_KEY = /public[-_]?key$/i

function secretName(name) {
  if (SECRET_KEY.test(name)) return true
  return (SECRET_SUFFIX.test(name) || SECRET_CAMEL.test(name)) && !PUBLIC_KEY.test(name)
}

// A "key":"value" pair inside a JSON string, such as a recorded HTTP body
// or tool output. The second form is the same pair escaped one level deeper,
// as in a JSON string that holds JSON. The key is tested with SECRET_KEY.
const JSON_PAIR = /"([^"\\\r\n]{1,64})"(\s*:\s*)"((?:\\.|[^"\\])*)"/g
const JSON_PAIR_ESC = /\\"([^"\\\r\n]{1,64})\\"(\s*:\s*)\\"((?:[^"\\]|\\(?!"))*)\\"/g

// A header in text: "Name: value" where Name passes secretName. It counts
// only in a header context: at the start of a line (a real line break or an
// escaped "\n", with an optional curl -v "> " or "< "), or right after an
// opening quote or backtick, as in curl -H "Authorization: Basic …". Prose
// such as "Missing authorization: the endpoint …" is not a header.
// The value is one or two words. It never takes a quote, a backslash, a
// bracket, a comma or a semicolon, so the text around it keeps its syntax.
const HEADER_NAME = String.raw`([A-Za-z][\w-]{0,63})([ \t]*:[ \t]*)`
const WORD = String.raw`[^\s"'` + "`" + String.raw`\\,;()\[\]{}<>]+`
const HEADER_VALUE = `(${WORD}(?:[ \\t]+${WORD})?)`
const LINE_HEADER = new RegExp(String.raw`(?<=^|[\r\n]|\\n)([ \t]*(?:[<>] )?)` + HEADER_NAME + HEADER_VALUE, "g")
const QUOTE_HEADER = new RegExp(String.raw`(["'` + "`" + String.raw`])` + HEADER_NAME + HEADER_VALUE, "g")

// Each optional part has one way to match a run of spaces. Two adjacent
// \s* / \s+ that can split the same run made this quadratic (ReDoS).
const BEARER = /\bBearer\s+(?:token(?:\s*[:=]\s*|\s+))?([A-Za-z0-9\-._~+/=]{8,})/gi
// The value stops at a quote, backtick, bracket, comma or backslash, so
// "`?token=`," keeps its backtick and comma.
const QUERY = /([?&#](?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password|token)=)([^&\s#"'`,;()[\]{}<>\\]+)/gi

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

// True when one word looks like a credential and not like a lab placeholder
// ("junk", "<bob token>", "$TOKEN"), a route or an English word.
function secretish(tok, min = 8) {
  if (tok.length < min || tok.startsWith("[REDACTED") || /^[<$\/{]/.test(tok)) return false
  if (/[0-9_\-./+=]/.test(tok)) return true
  if (tok.length >= 12 && /[a-z]/.test(tok) && /[A-Z]/.test(tok)) return true
  return tok.length >= 20
}

// True when any word of a header value is a credential.
function credential(value) {
  if (/^\s*</.test(value)) return false
  return value.split(/[\s,]+/).some((w) => secretish(w.replace(/^["'(]+|["'),;]+$/g, "")))
}

// The masked header value, or null to keep the value as it is. An
// Authorization value keeps its scheme word: "Bearer [REDACTED]".
function maskHeaderValue(name, value) {
  if (!secretName(name) || value.startsWith("[REDACTED")) return null
  if (/authorization$/i.test(name)) {
    const m = /^([A-Za-z][\w-]*)([ \t]+)([\s\S]+)$/.exec(value)
    if (m) return credential(m[3]) ? `${m[1]}${m[2]}${MARK}` : null
  }
  if (/cookie$/i.test(name)) return value.includes("=") ? MARK : null
  return credential(value) ? MARK : null
}

function maskHeader(m, lead, name, sep, value) {
  const masked = maskHeaderValue(name, value)
  return masked == null ? m : `${lead}${name}${sep}${masked}`
}

// The masked value of a "key":"value" pair, or null to keep it. An
// authorization value is judged like the header: "Bearer junk" and
// "Bearer " + t stay.
function maskPairValue(name, value) {
  if (!secretName(name) || value === "" || value.startsWith("[REDACTED")) return null
  if (/authorization$/i.test(name)) return maskHeaderValue(name, value)
  return MARK
}

// A query value: trailing sentence punctuation stays outside the mask, and
// a short variable name such as ?token=t1 is not a credential.
function maskQuery(m, head, value) {
  const v = value.replace(/[.:!?]+$/, "")
  return secretish(v, 6) ? head + MARK + value.slice(v.length) : m
}

function redactText(text) {
  if (!text || text.startsWith(MARK)) return text
  for (const re of [JSON_PAIR, JSON_PAIR_ESC, LINE_HEADER, QUOTE_HEADER, BEARER, QUERY, ...SHAPES]) re.lastIndex = 0
  let out = text
  out = out.replace(JSON_PAIR, (m, name, sep, v) => {
    const masked = maskPairValue(name, v)
    return masked == null ? m : `"${name}"${sep}"${masked}"`
  })
  out = out.replace(JSON_PAIR_ESC, (m, name, sep, v) => {
    const masked = maskPairValue(name, v)
    return masked == null ? m : `\\"${name}\\"${sep}\\"${masked}\\"`
  })
  out = out.replace(LINE_HEADER, maskHeader)
  out = out.replace(QUOTE_HEADER, maskHeader)
  out = out.replace(BEARER, (m, tok) => (secretish(tok) ? `Bearer ${MARK}` : m))
  out = out.replace(QUERY, maskQuery)
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
    if (key && secretName(key)) return MARK
    return redactText(value)
  }
  if (Array.isArray(value)) {
    const blank = key && secretName(key)
    return value.map((item) => (blank && typeof item === "string" ? MARK : walk(item, "")))
  }
  if (typeof value !== "object") return value
  if (value.redacted === true && typeof value.sha256 === "string") return copyRedactedCell(value)
  if (typeof value.name === "string" && typeof value.value === "string" && value.redacted !== true && secretName(value.name)) {
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
