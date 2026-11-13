import { describe, expect, test } from "bun:test"
// Unit tests for the report redaction. Every secret here is synthetic. It has
// the same shape as a value seen in a real record, never the real value.
// @ts-expect-error — plain .mjs module, no types
import { redactSecrets } from "../server/redact.mjs"

const MB = 1 << 20
const text = (s: string): string => redactSecrets({ explanation: s }).explanation

// Time one redaction of a 1 MB string. A linear regex finishes in well under
// a second; a quadratic one takes minutes.
function timeMs(input: string): number {
  const t0 = performance.now()
  redactSecrets({ explanation: input })
  return performance.now() - t0
}

describe("redact: big inputs finish in linear time", () => {
  test("'Bearer token' then 1 MB of spaces", () => {
    expect(timeMs("Bearer token" + " ".repeat(MB) + "!")).toBeLessThan(2000)
  })
  test("the bearer token is still masked after the bound", () => {
    expect(text("Bearer token: Zq7Xv9KpR2mN4tW8yB3cL6")).not.toContain("Zq7Xv9KpR2mN4tW8yB3cL6")
    expect(text("Bearer Zq7Xv9KpR2mN4tW8yB3cL6")).toBe("Bearer [REDACTED]")
  })
})
