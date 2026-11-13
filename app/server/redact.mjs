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
// A whole value that is already a marker: ours, or the engine's own
// "[REDACTED sha256:…]" fingerprint, which must be kept.
const MARKER = /^\[REDACTED[^\]\r\n]{0,80}\]$/
// A value under a secret name that is evidence, not a secret: an empty
// string, or a 0x address such as a token contract. A bare 40-hex value is
// not kept: randomBytes(20).toString("hex") makes tokens of that shape.
const PLAIN_VALUE = /^(?:|0x[0-9a-fA-F]{40})$/
const keepUnder = (v) => MARKER.test(v) || PLAIN_VALUE.test(v)
// A header line whose value starts with a 0x address: "Token: 0x…, amount: 5".
const ADDRESS_LEAD = /^0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/

// Object keys and header-cell names whose value is a credential.
const SECRET_KEY = /^(?:token|bearer|password|passwd|pwd|secret|session(?:id|[-_]id)?|(?:x-)?(?:api[-_]?key|auth(?:orization|[-_]token)|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|proxy-authorization|private[-_]?key|mnemonic|seed[-_]?phrase|cookie|set-cookie))$/i
// Any other name that ends in a secret word: x-goog-api-key, x-csrf-token,
// PRIVATE-TOKEN, DB_PASSWORD, signerPrivateKey. A bare "key" or "signature"
// is not enough; prose says "Key:" and a SIWE body carries its signature.
const SECRET_SUFFIX = /[-_](?:token|key|secret|signature|password|passwd)$/i
const SECRET_CAMEL = /[a-z0-9](?:Token|Key|Secret|Password)$/
const PUBLIC_KEY = /public[-_]?key$/i
// Short words that name a credential only sometimes: { auth: "tk_…" } is a
// secret, credentials: "include" (fetch) and auth: "none" are not. They are
// judged like a suffix name (maskUnder).
const WEAK_KEY = /^(?:auth|credentials?)$/i

function secretName(name) {
  if (SECRET_KEY.test(name) || WEAK_KEY.test(name)) return true
  return (SECRET_SUFFIX.test(name) || SECRET_CAMEL.test(name)) && !PUBLIC_KEY.test(name)
}

// A name that is secret only by its ending, or a WEAK_KEY, is often a plain setting:
// baseToken: "USDC", primaryKey: "id". Under such a name a value is masked
// only when it looks like a secret; a short value of lowercase words joined
// by "-" or "_" (same-origin, created_at) is a setting. That does not hold
// under a name ending in secret or password, nor for 20 or more characters:
// jwt_secret: "my-super-secret-signing-key" is a passphrase. Under a
// SECRET_KEY name every value is masked.
const SETTING = /^[a-z]+(?:[-_][a-z]+)*$/
const WORD_NAME = /(?:secret|password|passwd)$/i
const setting = (name, value) => !SECRET_KEY.test(name) && !WORD_NAME.test(name) && value.length < 20 && SETTING.test(value)
const maskUnder = (name, value) => SECRET_KEY.test(name) || (secretish(value) && !setting(name, value))

// A "key":"value" pair inside a JSON string, such as a recorded HTTP body
// or tool output. The second form is the same pair escaped one level deeper,
// as in a JSON string that holds JSON. The key is tested with SECRET_KEY.
const JSON_PAIR = /"([^"\\\r\n]{1,64})"(\s*:\s*)"((?:\\.|[^"\\])*)"/g
const JSON_PAIR_ESC = /\\"([^"\\\r\n]{1,64})\\"(\s*:\s*)\\"((?:[^"\\]|\\(?!"))*)\\"/g
// The same pair escaped two or more levels deep, as in a JSON string that
// holds a JSON string that holds JSON. Each JSON.stringify doubles the
// backslashes, so the run before every quote is 1, 3, 7, 15 … characters.
// JSON_PAIR and JSON_PAIR_ESC handle depth 0 and 1; this one run of 3 or more
// backslashes (\\{3,}), tied across the four quotes by the backreference,
// handles every deeper level in one rule, not one rule per depth. The run is
// a single greedy group, so it is linear. The name and the value are plain
// text at any depth (a value with its own escaped quote is a rare edge the
// run does not reach into).
const JSON_PAIR_DEEP = /(\\{3,})"([^"\\\r\n]{1,64})\1"(\s*:\s*)\1"([^"\\\r\n]*)\1"/g
// A HAR or app header cell held as text: {"name":"Authorization",
// "value":"Basic …"}, maybe with short fields between them, such as
// "redacted":false. The value is judged under the name. The second form is
// the same cell escaped one level deeper.
function namedValue(q, body) {
  const field = String.raw`${q}(?!value${q})[\w-]{1,32}${q}\s*:\s*(?:true|false|null|-?\d{1,20}|${q}[^"\\\r\n]{0,64}${q})`
  return new RegExp(String.raw`(${q}name${q}\s*:\s*${q})([^"\\\r\n]{1,64})(${q}(?:\s*,\s*${field}){0,8}\s*,\s*${q}value${q}\s*:\s*${q})(${body})${q}`, "g")
}
const NAMED_VALUE = namedValue('"', String.raw`(?:\\.|[^"\\])*`)
const NAMED_VALUE_ESC = namedValue(String.raw`\\"`, String.raw`(?:[^"\\]|\\(?!"))*`)

// A header tuple in text: [["x-api-key","tk_…"]] or [("Authorization",
// "Basic …")]. The pair sits right inside a bracket and closes it, and that
// bracket is an item of a list, so ["token", "password"] stays. The spaces
// in the lookbehind are bounded: an unbounded run there is scanned again at
// every position of a long run of spaces.
const TUPLE = /(?<=[[,][ \t]{0,8}[[(][ \t]{0,8})(["'])([A-Za-z][\w-]{0,63})\1([ \t]*,[ \t]*)(["'])((?:\\[^\r\n]|(?!\4)[^\\\r\n])*)\4(?=[ \t]*[\])])/g

// The same pair in JS, Python or a config file: the key is unquoted or in
// ', ` or " quotes, the separator is ":" or "=", and the value is in ', ` or
// " quotes. { apiKey: 'tk_…' }, headers={'Authorization': 'Basic …'} and
// const token = "…" all match. A key never starts inside a word or right
// after a quote or backslash, so each value scan starts once. The value
// stops at its own closing quote or a line break. The second form is a
// \"…\" value one escape level deeper. == and === never match.
const CODE_PAIR = /(?<![\w$"'`\\])(["'`]?)([A-Za-z_$][\w$-]{0,63})\1([ \t]*[:=][ \t]*)(["'`])((?:\\[^\r\n]|(?!\4)[^\\\r\n])*)\4/g
const CODE_PAIR_ESC = /(?<![\w$"'`\\])([A-Za-z_$][\w$-]{0,63})([ \t]*[:=][ \t]*)\\"((?:[^"\\\r\n]|\\(?!")[^\r\n])*)\\"/g

// A header in text: "Name: value" where Name passes secretName. It counts
// only in a header context: at the start of a line (a real line break or an
// escaped "\n", with an optional curl -v "> " or "< "), or right after an
// opening quote or backtick, as in curl -H "Authorization: Basic …". Prose
// such as "Missing authorization: the endpoint …" is not a header.
// The value runs to the end of the header, so every part of an AWS4 or
// Digest value is covered. On a line it stops at a line break (real or
// escaped), a quote, a backslash or a bracket; a quoted Digest parameter
// (name="…" or name=\"…\") is part of the value. After a quote it stops at
// the same closing quote or a line break. A trailing comma, semicolon or
// space stays outside the mask, so the text around it keeps its syntax.
const HEADER_NAME = String.raw`([A-Za-z][\w-]{0,63})([ \t]*:[ \t]*)`
const LINE_VALUE = String.raw`((?:=(?:"[^"\\\r\n]*"|\\"[^"\\\r\n]*\\")|\[REDACTED[^\]\r\n]{0,80}\]|[^\r\n\\"'` + "`" + String.raw`()\[\]{}<>]|\\[^rn"\r\n])+)`
const QUOTE_VALUE = String.raw`((?:=\\"[^"\\\r\n]*\\"|(?!\1)[^\\\r\n]|\\(?![rn]|\1)[^\r\n])+)`
// The lead may also be a list mark ("- ", "* "), a table bar ("| "), or a
// tab or ", " inside a log line: "Host: lab, Authorization: Basic …".
const LINE_HEADER = new RegExp(String.raw`((?<=^|[\r\n]|\\n)[ \t]*(?:[<>*-] |\| )?|(?<=\t|, ))` + HEADER_NAME + LINE_VALUE, "g")
// A markdown table row: "| Authorization | Basic … |". The value cell
// stops at the next bar.
const TABLE_HEADER = /((?<=^|[\r\n]|\\n)[ \t]*\|[ \t]*)([A-Za-z][\w-]{0,63})([ \t]*\|[ \t]*)([^|\r\n\\`]+)/g
const QUOTE_HEADER = new RegExp(String.raw`(["'` + "`" + String.raw`])` + HEADER_NAME + QUOTE_VALUE, "g")

// Each optional part has one way to match a run of spaces. Two adjacent
// \s* / \s+ that can split the same run made this quadratic (ReDoS).
const BEARER = /\bBearer\s+(?:token(?:\s*[:=]\s*|\s+))?([A-Za-z0-9\-._~+/=]{8,})/gi
// The value stops at a quote, backtick, bracket, comma or backslash, so
// "`?token=`," keeps its backtick and comma.
// Any query name that passes secretName counts (session, X-Amz-Signature,
// X-Amz-Security-Token), and so do a few short names that are secret only
// in a URL: key, sig, code (an OAuth code) and auth.
const QUERY = /([?&#]([A-Za-z][\w.-]{0,63})=)([^&\s#"'`,;()[\]{}<>\\]+)/g
const QUERY_NAME = /^(?:key|sig|code|auth)$/i

// An RPC or API key in a URL path on a known provider host:
// https://eth-mainnet.g.alchemy.com/v2/<key>, https://mainnet.infura.io/v3/<key>,
// https://rpc.ankr.com/eth/<key>. The host and the fixed path parts (/v2/) stay;
// a path segment that looks like a key becomes the mark. The Goldsky form
// (…?key=<key>) is a query, so QUERY already masks it. Provider list and the
// key-segment test are the same as the replay bundle (spike/lib/replay-bundle.mjs).
const RPC_NAMES = "alchemy|infura|ankr|quiknode|quicknode|blastapi|chainstack|getblock|nodereal|drpc|tenderly|moralis|blockpi|pokt"
const RPC_URL = new RegExp(String.raw`(https?:\/\/[a-zA-Z0-9.-]*(?:${RPC_NAMES})[a-zA-Z0-9.-]*)((?:\/[^\s"'\`\\?#]*)+)`, "gi")
// A URL path segment is a key when it is long and mixes letters and digits.
// A placeholder (${RPC_KEY}) or an already-redacted part stays.
const keySegment = (seg) => seg.length >= 16 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) && !seg.startsWith("${") && !seg.startsWith("[REDACTED")
function maskRpcUrl(m, host, path) {
  let hit = false
  const out = path.replace(/[^/?#]+/g, (seg) => (keySegment(seg) ? ((hit = true), MARK) : seg))
  return hit ? host + out : m
}

// A password in a URL (https://user:pass@host), a curl -u user:pass, a
// curl -b cookie list, and an env assignment such as DB_PASSWORD=… whose
// name passes secretName. Only the secret part is masked.
const URL_USERINFO = /(\/\/[^\s/:@"'`]{1,64}:)([^\s/@"'`]{1,256})(?=@)/g
const CURL_USER = /((?:^|\s)(?:-u|--user)[ =]?["']?[^\s:"'@]{1,64}:)([^\s"']{1,256})/g
const CURL_COOKIE = /((?:^|\s)(?:-b|--cookie)[ =]?)(?:(["'])([^"'\r\n]*)\2|([^\s"']+))/g
// A command-line flag whose name passes secretName: cast send
// --private-key 0x…, --api-key=…, --token "…".
const CLI_FLAG = /(?<![\w-])(--([A-Za-z][\w-]{0,63})(?:=|[ \t]+))(?:(["'])([^"'\r\n]*)\3|([^\s"'`;&|()<>]+))/g
// An assignment in a shell, an .env file or a config file: DB_PASSWORD=…,
// export api_key=…, aws_secret_access_key = …. The name may be any case and
// "=" may have spaces around it. A bare value must end at a space, a
// separator or the end; so a call such as get_token() and an index such as
// os.environ["X"] never match. == never matches either. A query pair
// (?token=…) is left to QUERY.
// The bare value is taken whole, (?=(…))\5, so the regex never scans it
// again: in "token=token=…" each "token" would start a new scan to the end.
// maskEnv then checks what follows it.
const ENV_ASSIGN = /(?<![\w$.?&#/-])([A-Za-z_][\w]{1,63})([ \t]*=[ \t]*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(?=([^\s"'`;&|()[\]{}<>=][^\s"'`;&|()[\]{}<>]*))\5)/g
// A code reference such as settings.API_KEY or res.body.token, not a value.
const MEMBER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/

// Shapes that are a secret wherever they sit: in prose, in a file name, in a
// path segment. Each is a vendor prefix plus the vendor's own length and
// alphabet, so the prefix alone is not enough to fire. A match starts at a
// non-identifier boundary (\b or a lookbehind), so "file_ghp_x" (one
// identifier) stays and "/x/ghp_x" (a path segment) is masked.
// Deliberately NOT bare hex: a snapshot hash or a commit is 40/64 hex and the
// proof needs it. pk_live_/pk_test_ (Stripe PUBLISHABLE keys) are public and
// are not here, so they stay.
// Sources for the format of each (prefix, length, alphabet):
//   AKIA/ASIA + 16 upper base32   AWS, "IAM identifiers" docs
//   gh[pousr]_ + 36 base62        GitHub, "token formats" (ghp/gho/ghu/ghs/ghr)
//   github_pat_ + base62/_        GitHub, fine-grained PAT
//   glpat- + 20                   GitLab, personal access token
//   xox[baprs]- + 10              Slack, "token types and scopes"
//   (sk|rk)_(live|test)_ + 10     Stripe, "API keys" (secret/restricted)
//   sk- + 20                      OpenAI, "API keys"
//   eyJ + "." + "." parts           JWT, RFC 7519 (base64url header.payload.sig)
//   npm_ + 36 base62              npm, "about access tokens"
//   tk_<name>_<hex>               this project's lab token (oracle lab dapp)
const SHAPES = [
  // The body is bounded: an unended BEGIN must not rescan the rest of the text.
  /-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY-----[\s\S]{0,10000}?-----END [A-Z0-9 ]{0,32}PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9\-_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bsk-[A-Za-z0-9-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bnpm_[A-Za-z0-9]{36,}\b/g,
  // The lab token is tk_<name>_<suffix>: tk_alice_9f1c4a2e, tk_live_<20 hex>.
  // The suffix is 6+ hex, so a plain word such as tk_live_run stays.
  /\btk_[a-z][a-z0-9]*_[0-9a-fA-F]{6,}\b/g,
]

// True when one word looks like a credential and not like a lab placeholder
// ("junk", "<bob token>", "$TOKEN"), a route or an English word.
function secretish(tok, min = 8) {
  if (tok.length < min || tok.startsWith("[REDACTED") || /^[<$/{]/.test(tok)) return false
  if (/[0-9_\-./+=]/.test(tok)) return true
  if (tok.length >= 12 && /[a-z]/.test(tok) && /[A-Z]/.test(tok)) return true
  return tok.length >= 20
}

// The index where the run of the given characters at the end of s starts.
// A regex such as /[ ,;]+$/ is quadratic on a long run that is not at the
// end: it scans the run again from each start. This loop is linear.
function tailStart(s, chars) {
  let end = s.length
  while (end > 0 && chars.includes(s[end - 1])) end--
  return end
}

// True when any word of a header value is a credential.
function credential(value) {
  if (/^\s*</.test(value)) return false
  // A sentence stop after a word is not part of it: "is required." is prose.
  return value.split(/[\s,]+/).some((w) => secretish(w.slice(0, tailStart(w, "\"'),;.:!?")).replace(/^["'(]+/, "")))
}

// Under a header that always holds a credential, one word of 12 or more
// letters is a credential too: "X-Api-Key: abcdefghijklmnop". So is such a
// word after "Bearer" when it ends the header (a quote or the line end).
const ALWAYS_SECRET = /^(?:(?:proxy-)?authorization|(?:x-)?api[-_]?key|(?:x-)?auth[-_]token)$/i
const LETTER_KEY = /^[A-Za-z]{12,}$/
const HEADER_END = /^(?:$|["'`\r\n]|\\[rn"])/

function maskBearer(m, tok, offset, str) {
  // A sentence stop is not part of the token: "uses Bearer authentication."
  let end = tok.length
  while (end > 0 && tok[end - 1] === ".") end--
  const t = tok.slice(0, end)
  const after = tok.slice(t.length) + str.slice(offset + m.length, offset + m.length + 2)
  return secretish(t) || (LETTER_KEY.test(t) && HEADER_END.test(after)) ? `Bearer ${MARK}${tok.slice(t.length)}` : m
}

// A quoted header whose name is not secret may hold a quoted secret header
// in the other quote kind: 'Note: send "Authorization: Basic …"'. Its value
// is searched again. The inner value cannot hold the outer quote, so this
// nests at most three deep (', ", `) and stays linear.
function maskQuoteHeader(m, lead, name, sep, raw) {
  if (secretName(name)) return maskHeader(m, lead, name, sep, raw)
  return lead + name + sep + raw.replace(QUOTE_HEADER, maskQuoteHeader)
}

// The masked header value, or null to keep the value as it is. An
// Authorization value keeps its scheme word: "Bearer [REDACTED]".
// The supply-chain pack names a leaked secret by its file and sha256:
// "secret:<file>:<sha256>". That is a fingerprint, not the secret.
const FINGERPRINT = /^[^\s:]{1,512}:[0-9a-f]{64}$/

function maskHeaderValue(name, value) {
  if (!secretName(name) || value.startsWith("[REDACTED") || keepUnder(value) || ADDRESS_LEAD.test(value)) return null
  if (/^secret$/i.test(name) && FINGERPRINT.test(value)) return null
  if (/authorization$/i.test(name)) {
    const m = /^([A-Za-z][\w-]*)([ \t]+)([\s\S]+)$/.exec(value)
    if (m) return credential(m[3]) || LETTER_KEY.test(m[3]) ? `${m[1]}${m[2]}${MARK}` : null
  }
  if (/cookie$/i.test(name)) return maskCookie(value)
  return credential(value) || (ALWAYS_SECRET.test(name) && LETTER_KEY.test(value)) ? MARK : null
}

// Each name=value in a Cookie or Set-Cookie value. Every cookie value is
// masked: a cookie value has no reliable secret shape. The cookie names,
// the Set-Cookie attributes (Path=/, SameSite=None) and an empty or
// placeholder value ("token=<alice token>", "sid=$SID") stay. Null when
// nothing was masked.
const COOKIE_PAIR = /(^|;[ \t]*)([^=;\s]+)=([^;]*)/g
const COOKIE_ATTR = /^(?:path|domain|expires|max-age|samesite|priority|partitioned)$/i
function maskCookie(value) {
  let hit = false
  COOKIE_PAIR.lastIndex = 0
  const out = value.replace(COOKIE_PAIR, (m, lead, name, v) => {
    const t = v.trimEnd()
    if (COOKIE_ATTR.test(name) || /^(?:$|[\s<$[{])/.test(t) || keepUnder(t)) return m
    hit = true
    return `${lead}${name}=${MARK}${v.slice(t.length)}`
  })
  return hit ? out : null
}

function maskHeader(m, lead, name, sep, raw, offset, str) {
  // After a tab or ", " inside a log line the value ends at the next ", " or
  // tab: "method=GET, X-Api-Key: …, status=200" keeps ", status=200".
  // That lead is empty and follows a space or a tab.
  let end = raw.length
  if (lead === "" && typeof str === "string" && (str[offset - 1] === " " || str[offset - 1] === "\t")) {
    const cut = raw.search(/, |\t/)
    if (cut >= 0) end = cut
  }
  // In a table row the closing bar stays outside the mask.
  const value = raw.slice(0, tailStart(raw.slice(0, end), lead.includes("|") ? " \t,;|" : " \t,;"))
  const masked = value && maskHeaderValue(name, value)
  return masked ? `${lead}${name}${sep}${masked}${raw.slice(value.length)}` : m
}

// The masked value of a "key":"value" pair, or null to keep it. An
// authorization value is judged like the header: "Bearer junk" and
// "Bearer " + t stay.
// A code value that is a template or a variable stays: `${t}`, "$TOKEN".
// So does a "value" that starts or ends with a space or a comma. That is
// the text between two markdown code spans, as in "`?token=`, `Bearer`".
// A cookie with no value, such as "token=" + t, stays too (maskCookie).
function maskCodeValue(name, value) {
  if (/^[<$\s,;:)\]}]|\s$|\$\{/.test(value)) return null
  return maskPairValue(name, value)
}

function maskNamed(m, head, name, mid, value) {
  const masked = maskCodeValue(name, value)
  return masked == null ? m : `${head}${name}${mid}${masked}${m.slice(head.length + name.length + mid.length + value.length)}`
}

function maskPairValue(name, value) {
  if (!secretName(name) || keepUnder(value)) return null
  if (/authorization$/i.test(name)) return maskHeaderValue(name, value)
  if (/cookie$/i.test(name) && value.includes("=")) return maskCookie(value)
  return maskUnder(name, value) ? MARK : null
}

// A query value: trailing sentence punctuation stays outside the mask, and
// a short variable name such as ?token=t1 is not a credential.
function maskQuery(m, head, name, value) {
  if (!secretName(name) && !QUERY_NAME.test(name)) return m
  const v = value.slice(0, tailStart(value, ".:!?"))
  return secretish(v, 6) && !keepUnder(v) ? head + MARK + value.slice(v.length) : m
}

function maskCookieArg(m, head, q, quoted, bare) {
  const masked = maskCookie(quoted ?? bare)
  if (masked == null) return m
  return q ? `${head}${q}${masked}${q}` : head + masked
}

function maskFlag(m, head, name, q, quoted, bare) {
  const v = quoted ?? bare
  if (!secretName(name) || !secretish(v, 6) || keepUnder(v)) return m
  return q ? `${head}${q}${MARK}${q}` : head + MARK
}

// A bare value must end at a space, ";", "&", "|" or the end. When a quote
// or a bracket follows it, the value ends at its last comma instead, or the
// match is kept as it is.
function maskEnv(m, name, sep, dq, sq, bare, offset, str) {
  let v = dq ?? sq ?? bare
  let rest = ""
  if (bare != null && offset + m.length < str.length && !/[\s;&|]/.test(str[offset + m.length])) {
    const cut = bare.lastIndexOf(",")
    if (cut < 1) return m
    v = bare.slice(0, cut)
    rest = bare.slice(cut)
  }
  if (!secretName(name) || !secretish(v, 6) || keepUnder(v) || setting(name, v) || (bare != null && MEMBER_PATH.test(v))) return m
  const q = dq != null ? '"' : sq != null ? "'" : ""
  return `${name}${sep}${q}${MARK}${q}${rest}`
}

function redactText(text) {
  if (!text || MARKER.test(text)) return text
  for (const re of [JSON_PAIR, JSON_PAIR_ESC, JSON_PAIR_DEEP, NAMED_VALUE, NAMED_VALUE_ESC, TUPLE, CODE_PAIR, CODE_PAIR_ESC, LINE_HEADER, TABLE_HEADER, QUOTE_HEADER, BEARER, QUERY, RPC_URL, URL_USERINFO, CURL_USER, CURL_COOKIE, CLI_FLAG, ENV_ASSIGN, ...SHAPES]) re.lastIndex = 0
  let out = text
  out = out.replace(JSON_PAIR, (m, name, sep, v) => {
    const masked = maskPairValue(name, v)
    return masked == null ? m : `"${name}"${sep}"${masked}"`
  })
  out = out.replace(JSON_PAIR_ESC, (m, name, sep, v) => {
    const masked = maskPairValue(name, v)
    return masked == null ? m : `\\"${name}\\"${sep}\\"${masked}\\"`
  })
  out = out.replace(JSON_PAIR_DEEP, (m, bs, name, sep, v) => {
    const masked = maskPairValue(name, v)
    return masked == null ? m : `${bs}"${name}${bs}"${sep}${bs}"${masked}${bs}"`
  })
  out = out.replace(NAMED_VALUE, maskNamed)
  out = out.replace(NAMED_VALUE_ESC, maskNamed)
  out = out.replace(TUPLE, (m, kq, name, sep, q, v) => {
    const masked = maskCodeValue(name, v)
    return masked == null ? m : `${kq}${name}${kq}${sep}${q}${masked}${q}`
  })
  out = out.replace(CODE_PAIR, (m, kq, name, sep, q, v) => {
    const masked = maskCodeValue(name, v)
    return masked == null ? m : `${kq}${name}${kq}${sep}${q}${masked}${q}`
  })
  out = out.replace(CODE_PAIR_ESC, (m, name, sep, v) => {
    const masked = maskCodeValue(name, v)
    return masked == null ? m : `${name}${sep}\\"${masked}\\"`
  })
  out = out.replace(LINE_HEADER, maskHeader)
  out = out.replace(TABLE_HEADER, maskHeader)
  out = out.replace(QUOTE_HEADER, maskQuoteHeader)
  out = out.replace(BEARER, maskBearer)
  out = out.replace(QUERY, maskQuery)
  out = out.replace(RPC_URL, maskRpcUrl)
  out = out.replace(URL_USERINFO, (m, head, pw) => (secretish(pw, 6) ? head + MARK : m))
  out = out.replace(CURL_USER, (m, head, pw) => (secretish(pw, 6) ? head + MARK : m))
  out = out.replace(CURL_COOKIE, maskCookieArg)
  out = out.replace(CLI_FLAG, maskFlag)
  out = out.replace(ENV_ASSIGN, maskEnv)
  for (const re of SHAPES) out = out.replace(re, MARK)
  return out
}

// LONG TEXT. Bun's regex engine gives up on one match that spans a few
// hundred KB (336 KB at the least, measured): it returns "no match" with no
// error, so a secret would stay. So a text over MAX_TEXT is masked whole.
// Cutting it into pieces was tried and dropped: a cut can split a match (task
// H2b). The in-app finding view still shows the stored text.
const MAX_TEXT = 64 * 1024
const tooLong = (n) => `[REDACTED: text of ${n} characters too long to check]`

function copyRedactedCell(value) {
  const copy = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === "sha256") copy[k] = v
    else if (k === "value" && typeof v === "string") copy[k] = MARK
    else copy[k] = walk(v, k)
  }
  return copy
}

const isTuple = (t) => Array.isArray(t) && t.length === 2 && typeof t[0] === "string" && typeof t[1] === "string"

function walk(value, key) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (MARKER.test(value)) return value
    if (key && secretName(key)) {
      if (PLAIN_VALUE.test(value)) return value
      if (maskUnder(key, value)) return MARK
    }
    return value.length > MAX_TEXT ? tooLong(value.length) : redactText(value)
  }
  if (Array.isArray(value)) {
    // A list of [name, value] header tuples: [["x-api-key", "tk_…"]].
    if (value.length && value.every(isTuple)) return value.map(([name, v]) => [name, walk(v, name)])
    const blank = key && secretName(key)
    return value.map((item) => (blank && typeof item === "string" && !keepUnder(item) && maskUnder(key, item) ? MARK : walk(item, "")))
  }
  if (typeof value !== "object") return value
  if (value.redacted === true && typeof value.sha256 === "string") return copyRedactedCell(value)
  if (typeof value.name === "string" && typeof value.value === "string" && value.redacted !== true && secretName(value.name) && !keepUnder(value.value)) {
    const copy = {}
    for (const [k, v] of Object.entries(value)) copy[k] = k === "value" ? MARK : walk(v, k)
    return copy
  }
  const copy = {}
  for (const [k, v] of Object.entries(value)) copy[k] = walk(v, k)
  return copy
}

// One pass of every rule over a whole text, with no length check. Only the
// timing tests use it: they must prove each rule linear on its own.
export { redactText as redactOnePass }

// A deep copy of a report or finding with secret values masked.
export function redactSecrets(value) {
  return walk(value, "")
}
