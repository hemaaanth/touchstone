import { describe, expect, test } from "bun:test"
// Long text is redacted in pieces of at most 64 KB, cut at line ends, because
// Bun's regex engine gives up on a match that spans a few hundred KB and then
// returns "no match" with no error. Every secret here is synthetic.
// @ts-expect-error — plain .mjs module, no types
import { redactOnePass } from "../server/redact.mjs"

const KB = 1024
const ms = (f: () => void): number => {
  const t0 = performance.now()
  f()
  return performance.now() - t0
}

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

