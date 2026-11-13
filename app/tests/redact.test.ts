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

describe("redact: secrets inside a JSON string", () => {
  // Same shape as the real /siwe/verify response: {"token":"<48 hex>"}.
  const hex48 = "5f0c1e2d3a4b".repeat(4)
  const alice = "tk_alice_0a1b2c3d"
  const bob = "tk_bob_4e5f6a7b"

  test("a body's token and apiKey are masked; the rest of the body stays", () => {
    const out = redactSecrets({
      request: { body: `{"address":"0xabc","apiKey":"${alice}"}` },
      response: { body: `{"token":"${hex48}"}` },
    })
    expect(out.response.body).toBe(`{"token":"[REDACTED]"}`)
    expect(out.request.body).toBe(`{"address":"0xabc","apiKey":"[REDACTED]"}`)
  })

  test("the escaped form inside a JSON string is masked", () => {
    const s = `{"resBody":"{\\"id\\":2,\\"apiKey\\":\\"${bob}\\",\\"token\\": \\"${hex48}\\"}"}`
    const out = text(s)
    expect(out).not.toContain(bob)
    expect(out).not.toContain(hex48)
    expect(out).toContain(`\\"id\\":2`)
    expect(out).toContain(`\\"apiKey\\":\\"[REDACTED]\\"`)
    expect(JSON.parse(JSON.parse(out).resBody).token).toBe("[REDACTED]")
  })

  test("other secret keys in a JSON string are masked", () => {
    for (const key of ["access_token", "password", "api_key", "client_secret", "refresh_token", "authorization", "cookie"]) {
      expect(text(`{"user":"a","${key}": "Zq7Xv9KpR2mN4tW8yB3cL6"}`)).toBe(`{"user":"a","${key}": "[REDACTED]"}`)
    }
  })

  test("an empty value and plain keys stay", () => {
    expect(text(`{"token":"","name":"alice","tokens":12}`)).toBe(`{"token":"","name":"alice","tokens":12}`)
  })
})

describe("redact: secret header names by suffix", () => {
  const v = "tok-Zq7Xv9KpR2mN4tW8yB3cL6"
  const names = ["x-goog-api-key", "x-csrf-token", "x-amz-security-token", "Ocp-Apim-Subscription-Key", "x-session-token", "PRIVATE-TOKEN", "X-Hub-Signature", "DB_PASSWORD"]

  test("a header cell with a secret-suffix name is masked", () => {
    for (const name of names) {
      expect(redactSecrets({ name, redacted: false, value: v }).value).toBe("[REDACTED]")
    }
  })
  test("an object key with a secret suffix is masked", () => {
    const out = redactSecrets({ signerPrivateKey: v, sessionToken: v, client_api_key: v })
    expect(JSON.stringify(out)).not.toContain(v)
  })
  test("a public key, a bare key and a SIWE signature stay", () => {
    const keep = { publicKey: "0x04ab", public_key: "0x04ab", key: "users/2", signature: "0xd8f1", tokens: 3, monkey: "m" }
    expect(redactSecrets(keep)).toEqual(keep)
    expect(redactSecrets({ name: "Content-Type", redacted: false, value: "application/json" }).value).toBe("application/json")
  })
})
