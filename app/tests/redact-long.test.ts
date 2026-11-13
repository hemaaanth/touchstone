import { describe, expect, test } from "bun:test"
// Long text is redacted in pieces of at most 64 KB, cut at line ends, because
// Bun's regex engine gives up on a match that spans a few hundred KB and then
// returns "no match" with no error. Every secret here is synthetic.
// @ts-expect-error — plain .mjs module, no types
import { redactOnePass, redactSecrets } from "../server/redact.mjs"

const KB = 1024
const MB = 1024 * KB
const text = (s: string): string => redactSecrets({ narrative: s }).narrative
const ms = (f: () => void): number => {
  const t0 = performance.now()
  f()
  return performance.now() - t0
}
// Prose lines at column 0: a cut may fall after any of them.
const LINE = "The server did not check the caller, so the lab returned the record.\n"
// Whole lines only, at most n characters.
const prose = (n: number): string => LINE.repeat(Math.floor(n / LINE.length))
// Whole lines, then one padding line, so the result is exactly n characters.
const fill = (n: number): string => {
  const head = prose(n - 200)
  return head + "p".repeat(n - head.length - 1) + "\n"
}

const HEX64 = "ab12".repeat(16)
const ADDR = "0x" + "cd34".repeat(10)
// One secret of each main shape. `v` makes each value unique.
const shapes = (v: string): [string, string][] => [
  [`Authorization: Basic dXNlcjpw${v}YXNz`, `dXNlcjpw${v}YXNz`],
  [`X-Api-Key: tk_line9${v}`, `tk_line9${v}`],
  [`{"token":"tk_json9${v}"}`, `tk_json9${v}`],
  [`curl -H "Authorization: Bearer tk_bear9${v}" https://lab`, `tk_bear9${v}`],
  [`GET /api/me?token=tk_query9${v} HTTP/1.1`, `tk_query9${v}`],
  [`DB_PASSWORD=tk_env9${v} node poc.mjs`, `tk_env9${v}`],
  [`cast send --private-key 0x${HEX64.slice(0, 60)}${v.slice(0, 4).padEnd(4, "0")} ${ADDR}`, `0x${HEX64.slice(0, 60)}${v.slice(0, 4).padEnd(4, "0")}`],
  [`Cookie: sid=tk_cookie9${v}; theme=dark`, `tk_cookie9${v}`],
  [`{"name":"x-api-key","value":"tk_har9${v}"}`, `tk_har9${v}`],
  [`[["x-api-key","tk_tuple9${v}"]]`, `tk_tuple9${v}`],
  [`const apiKey = 'tk_code9${v}';`, `tk_code9${v}`],
  [`-----BEGIN PRIVATE KEY-----\nMIIEv${v}QIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----`, `MIIEv${v}QIBADANBgkqhkiG9w0B`],
  [`token ghp_${(v + "A".repeat(36)).slice(0, 36)} leaked`, `ghp_${(v + "A".repeat(36)).slice(0, 36)}`],
]

describe("redact: a long text is redacted in pieces and fails closed", () => {
  test("1 MB narrative: one secret of each shape at the start, the middle and the end is masked", () => {
    const block = (v: string) => shapes(v).map(([line]) => line).join("\n") + "\n"
    const s = block("aa11") + prose(MB / 2) + block("bb22") + prose(MB / 2) + block("cc33")
    let out = ""
    const t = ms(() => (out = text(s)))
    for (const v of ["aa11", "bb22", "cc33"]) for (const [, secret] of shapes(v)) expect(out).not.toContain(secret)
    expect(out).toContain(ADDR)
    expect(out).not.toContain("too long to check")
    expect(out).not.toContain("could not be checked")
    // Each of the 3 PEM blocks (3 lines) becomes one [REDACTED].
    expect(out.split("\n").length).toBe(s.split("\n").length - 3 * 2)
    expect(t).toBeLessThan(2000)
  })

  test("a 1 MB single line is replaced whole", () => {
    const s = "X-Api-Key: " + "a1".repeat(MB / 2)
    expect(text(s)).toBe(`[REDACTED: line of ${s.length} characters too long to check]`)
  })

  test("only the line that is too long is replaced; the lines around it are redacted", () => {
    const s = "X-Api-Key: tk_before9z\n" + "x".repeat(100 * KB) + "\nX-Api-Key: tk_after9z\n" + prose(70 * KB)
    const out = text(s)
    expect(out.startsWith(`X-Api-Key: [REDACTED]\n[REDACTED: line of ${100 * KB} characters too long to check]\nX-Api-Key: [REDACTED]\n`)).toBe(true)
    expect(out.endsWith(prose(70 * KB))).toBe(true)
  })

  test("300 KB Solidity testSource: the address stays, the key is masked", () => {
    const body = (n: number) => "        vault.deposit{value: 1 ether}();\n".repeat(Math.ceil(n / 40)).slice(0, n)
    const s = "contract PoC is Test {\n" + body(150 * KB) + `    address token = ${ADDR};\n    uint256 privateKey = 0x${HEX64};\n` + body(150 * KB) + `    address constant TOKEN = ${ADDR};\n    uint256 signerPrivateKey = 0x${HEX64};\n}\n`
    const out = redactSecrets({ testSource: s }).testSource
    expect(out).not.toContain(HEX64)
    expect(out).toContain(`address token = ${ADDR};`)
    expect(out).toContain(`address constant TOKEN = ${ADDR};`)
    expect(out).toContain("uint256 privateKey = [REDACTED];")
    expect(out).toContain("uint256 signerPrivateKey = [REDACTED];")
  })

  test("1 MB text with many short lines finishes under 2000 ms", () => {
    const s = prose(MB)
    let out = ""
    expect(ms(() => (out = text(s)))).toBeLessThan(2000)
    expect(out).toBe(s)
  })
})

describe("redact: a cut never splits a rule that reads across a line end", () => {
  test("a pretty-printed HAR header list over several pieces keeps every cell whole", () => {
    // Every line is indented, so only a cut after "}," keeps a cell whole.
    let s = "[\n"
    for (let i = 0; s.length < 200 * KB; i++) s += `  {\n    "name": "Authorization",\n    "value": "Basic dXNl${String(i).padStart(5, "0")}cjpw"\n  },\n  {\n    "name": "Accept",\n    "value": "*/*"\n  },\n`
    s += "]\n"
    const out = text(s)
    expect(out).not.toMatch(/dXNl\d{5}cjpw/)
    expect(out).toContain('"value": "Basic [REDACTED]"')
    expect(out).toContain('"value": "*/*"')
  })

  test("a PEM block across the 64 KB mark is not cut", () => {
    const pemBody = Array.from({ length: 60 }, (_, i) => `MIIEv${String(i).padStart(3, "0")}QIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ`).join("\n")
    const s = fill(64 * KB - 1500) + `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n` + prose(20 * KB)
    const out = text(s)
    expect(out).not.toContain("QIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ")
    expect(out).toContain("[REDACTED]")
  })

  test("a JSON pair split over two lines at the 64 KB mark is not cut", () => {
    // The line end inside the pair is the last one before 64 KB.
    const s = fill(64 * KB - 12) + '{"token":\n  "tk_split9fakeZ"}\n' + prose(20 * KB)
    expect(s.indexOf('"token":\n') + 9).toBeLessThan(64 * KB)
    expect(s.indexOf("tk_split9fakeZ")).toBeGreaterThan(64 * KB)
    const out = text(s)
    expect(out).not.toContain("tk_split9fakeZ")
    expect(out).toContain('{"token":\n  "[REDACTED]"}')
  })

  test("a piece whose last line holds an unclosed pair is replaced, never returned unmasked", () => {
    // The unclosed value runs into the canary after the piece; the check sees it.
    const s = fill(64 * KB - 200) + '{"token":"tk_open9fakeZ\n' + "x".repeat(70 * KB) + "\n" + prose(KB)
    const out = text(s)
    expect(out).not.toContain("tk_open9fakeZ")
    expect(out).toMatch(/^\[REDACTED: \d+ characters could not be checked\]/)
  })
})

describe("redact: each rule pass alone is linear at 256 KB (final review B1, no pieces)", () => {
  // The same 12 inputs as the B1 block. They are single lines over 64 KB, so
  // redactSecrets now replaces them whole; here one pass runs on the whole text.
  const N = 256 * KB
  const cases: [string, string][] = [
    ["HAR cells", '"name":"a",'.repeat(N / 11)],
    ["escaped HAR cells", '\\"name\\":\\"a\\",'.repeat(N / 17)],
    ["table row with spaces", "| token | a" + " ".repeat(N) + "y |"],
    ["table row with semicolons", "| token | a" + ";".repeat(N) + "x"],
    ["header with spaces", "Host: a" + " ".repeat(N) + "y"],
    ["header with commas", "X-Api-Key: " + ",".repeat(N) + "x"],
    ["query with stops", "?token=" + ".".repeat(N) + "x"],
    ["header with semicolons", "X-Api-Key: " + ";".repeat(N) + "x"],
    ["tuple with spaces", '[["token","' + " ".repeat(N) + "x"],
    ["tuple with tabs", '[["token","' + "\t".repeat(N) + '"'],
    ["assignments", "token=".repeat(N / 6) + '"'],
    ["assignments with colons", "token=:".repeat(N / 7) + '"'],
  ]
  for (const [label, s] of cases) test(label, () => expect(ms(() => redactOnePass(s))).toBeLessThan(2000))
})

describe("redact: the engine fact the canary relies on (Bun)", () => {
  test("a rule that gives up on a 512 KB match also misses a later match of the same rule", () => {
    // Why a canary line after each piece shows a give-up. If a later Bun
    // stops giving up, this test fails, and the 64 KB cap can be revisited.
    const s = '{"name":"x-api-key","value":"' + "a1".repeat(256 * KB) + '"}\n{"name":"x-api-key","value":"tk_after9zz"}'
    expect(redactOnePass(s)).toContain("tk_after9zz")
    expect(redactOnePass(s.slice(s.indexOf("\n") + 1))).not.toContain("tk_after9zz")
  })
})

describe("redact: a cut is proven safe, not ranked safe (review 3 B1)", () => {
  const TOK = "tk_live_9fQ2xLmZ81aBcD"
  // Each construct holds a line end; the line after it starts at column 0.
  const rows: [string, string, string][] = [
    ["Bearer at a line end", `The client sends Authorization: Bearer\n${TOK} in each call.\n`, TOK],
    ["Bearer token at a line end", `It used Bearer token\n${TOK} for the call.\n`, TOK],
    ["a JSON value with a raw line end", `{"password": "correct horse\n${TOK} battery"}\n`, "correct horse"],
    ["a JSON value that starts with a line end", `{"token": "\n${TOK}"}\n`, TOK],
    ["a mnemonic over two lines", `"mnemonic": "abandon abandon abandon abandon abandon abandon\nzebra zoo wolf ${TOK} about"\n`, "zebra zoo wolf"],
    ["a HAR cell value with a raw line end", `{"name":"x-api-key","value":"part-one\n${TOK}"}\n`, "part-one"],
    ["an escaped JSON value with a raw line end", `{\\"token\\":\\"part-one\n${TOK}\\"}\n`, "part-one"],
  ]
  for (const [label, construct, part] of rows) {
    test(`${label}, across the 64 KB mark, is masked`, () => {
      const inner = construct.indexOf("\n")
      // The inner line end is the last one before 64 KB; the next is after it.
      const s = fill(64 * KB - inner - 8) + construct + prose(20 * KB)
      expect(s.indexOf("\n", 64 * KB - inner - 8 + inner + 1)).toBeGreaterThan(64 * KB)
      const out = text(s)
      expect(out).not.toContain(TOK)
      expect(out).not.toContain(part)
      expect(out).not.toContain("could not be checked")
      expect(out).not.toContain("too long to check")
    })
  }

  test("when no cut can be proven safe, the text is held and masked, never returned", () => {
    // Every line ends in "Bearer" and the next starts with its token.
    let s = ""
    for (let i = 0; s.length < 150 * KB; i++) s += `tk_hold9${String(i).padStart(6, "0")} then use Bearer\n`
    const out = text(s)
    expect(out).not.toMatch(/tk_hold9\d{6}/)
    expect(out).toContain("could not be checked")
  })

  test("a too-long line whose line end is not safe is held with what follows", () => {
    const s = "x".repeat(100 * KB) + " Bearer\n" + TOK + " ok\n" + prose(70 * KB)
    const out = text(s)
    expect(out).not.toContain(TOK)
    expect(out).toContain("could not be checked")
  })
})

describe("redact: CR, LF and CRLF are all line ends for the cut (review 3 Minor 1)", () => {
  for (const [label, eol] of [["CR", "\r"], ["CRLF", "\r\n"]] as const) {
    test(`a 200 KB text with ${label} line ends is cut, not replaced whole`, () => {
      const lines = prose(200 * KB).split("\n")
      lines[1000] = "X-Api-Key: tk_eol9fakeZ1"
      lines[2000] = '{"token":"tk_eol9fakeZ2"}'
      const s = lines.join(eol)
      const out = text(s)
      expect(out).not.toContain("tk_eol9fakeZ")
      expect(out).not.toContain("too long to check")
      expect(out).not.toContain("could not be checked")
      expect(out.split(eol).length).toBe(lines.length)
      expect(out).toBe(redactOnePass(s))
    })
  }
})

describe("redact: a text of 64 KB or less gets no canary and no cut (review 3 Minor 3)", () => {
  test("the result is byte-identical to one pass", () => {
    const open = '{"token":"tk_open9fakeZ'
    for (const s of [
      "",
      "X-Api-Key: tk_small9z",
      prose(64 * KB - open.length - 1) + "\n" + open,
      fill(64 * KB),
      "a1".repeat(32 * KB),
      prose(30 * KB) + "Bearer\ntk_line9fakeZ\n" + prose(30 * KB),
    ]) {
      expect(s.length).toBeLessThanOrEqual(64 * KB)
      expect(text(s)).toBe(redactOnePass(s))
    }
  })
})
