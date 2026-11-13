import { describe, expect, test } from "bun:test"
// A text over 64 KB is masked whole, because Bun's regex engine gives up on a
// match that spans a few hundred KB and then returns "no match" with no error.
// Every secret here is synthetic.
// @ts-expect-error — plain .mjs module, no types
import { redactOnePass, redactSecrets } from "../server/redact.mjs"

const KB = 1024
const MB = 1024 * KB
const CAP = 64 * KB
const text = (s: string): string => redactSecrets({ narrative: s }).narrative
const ms = (f: () => void): number => {
  const t0 = performance.now()
  f()
  return performance.now() - t0
}
const LINE = "The server did not check the caller, so the lab returned the record.\n"
// Whole lines only, at most n characters.
const prose = (n: number): string => LINE.repeat(Math.floor(n / LINE.length))
// Whole lines, then one padding line, so the result is exactly n characters.
const fill = (n: number): string => {
  const head = prose(n - 200)
  return head + "p".repeat(n - head.length - 1) + "\n"
}
const mark = (n: number) => `[REDACTED: text of ${n} characters too long to check]`

describe("redact: a text over 64 KB is masked whole (scope cut, task H2b)", () => {
  const secrets = ["tk_start9fakeZ", "tk_middle9fakeZ", "tk_end9fakeZ"]
  test("a text of 64 KB + 1 characters is replaced whole", () => {
    const s = "X-Api-Key: tk_one9fakeZ\n" + fill(CAP - 23)
    expect(s.length).toBe(CAP + 1)
    expect(text(s)).toBe(mark(CAP + 1))
  })
  test("a 1 MB text with secrets at the start, the middle and the end is replaced whole", () => {
    const s = `X-Api-Key: ${secrets[0]}\n` + prose(MB / 2) + `{"token":"${secrets[1]}"}\n` + prose(MB / 2) + `Bearer ${secrets[2]}\n`
    const out = text(s)
    expect(out).toBe(mark(s.length))
    for (const sec of secrets) expect(out).not.toContain(sec)
    // The same in a nested field and in a list.
    const nested = redactSecrets({ proof: { exchanges: [{ response: { body: s } }] }, testSource: [s] })
    expect(nested).toEqual({ proof: { exchanges: [{ response: { body: mark(s.length) } }] }, testSource: [mark(s.length)] })
  })
  test("a text of exactly 64 KB is redacted normally", () => {
    const s = "X-Api-Key: tk_exact9fakeZ\n" + fill(CAP - 26)
    expect(s.length).toBe(CAP)
    const out = text(s)
    expect(out).toBe("X-Api-Key: [REDACTED]\n" + fill(CAP - 26))
    expect(out).toBe(redactOnePass(s))
  })
  test("the mark holds no part of the text, only its length", () => {
    const s = "a1".repeat(CAP)
    const out = text(s)
    expect(out).toBe(mark(2 * CAP))
    expect(out).not.toContain("a1a1")
  })
})

describe("redact: each rule pass alone is linear at 256 KB (final review B1, no length check)", () => {
  // The same 12 inputs as the B1 block. They are over 64 KB, so redactSecrets
  // masks them whole; here one pass runs on the whole text.
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

describe("redact: why a text over 64 KB is masked whole (Bun)", () => {
  test("a rule that gives up on a 512 KB match also misses a later match of the same rule", () => {
    // The engine fact behind the cap. If a later Bun stops giving up, this
    // test fails, and the 64 KB cap can be revisited.
    const s = '{"name":"x-api-key","value":"' + "a1".repeat(256 * KB) + '"}\n{"name":"x-api-key","value":"tk_after9zz"}'
    expect(redactOnePass(s)).toContain("tk_after9zz")
    expect(redactOnePass(s.slice(s.indexOf("\n") + 1))).not.toContain("tk_after9zz")
  })
})

describe("redact: a text of 64 KB or less is redacted in one pass, as before (review 3 Minor 3)", () => {
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
