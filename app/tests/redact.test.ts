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

describe("redact: a quoted header line", () => {
  const basic = "dXNlcjpodW50ZXIy" // base64 of a made-up user:pass
  test("Authorization: Basic inside double quotes, single quotes and an array", () => {
    for (const s of [
      `curl -H "Authorization: Basic ${basic}" https://x`,
      `curl -H 'Authorization: Basic ${basic}' https://x`,
      `fetch(u, {headers: ["Authorization: Basic ${basic}"]})`,
      `curl -H "Proxy-Authorization: Basic ${basic}" https://x`,
    ]) expect(text(s)).not.toContain(basic)
  })
  test("a quoted Cookie and X-Api-Key header", () => {
    expect(text(`curl -H "Cookie: sid=s3ssionFAKEvalue9" https://x`)).not.toContain("s3ssionFAKEvalue9")
    expect(text(`curl -H "X-Api-Key: AIzaSyFAKEfake1234" https://x`)).not.toContain("AIzaSyFAKEfake1234")
  })
})

describe("redact: proof text keeps its meaning and its syntax", () => {
  // These lines have the shape of real explanation, prose and PoC text.
  const keep = [
    "A second call with a fake token (`authorization: Bearer junk`) also got 200 and the same body.",
    "3. Documented API authorization: /api/users/{id}, /api/users/{id}/wallet IDOR/api keys;",
    "GET /api/users/1      authorization: Bearer <bob token>  -> 200",
    "Set the header `Authorization: Bearer <token>` to reproduce.",
    "Missing authorization: the endpoint never checks the caller.",
    "The cookie: it is set without HttpOnly or Secure flags.",
    "api-key: missing on /admin, so the route is open",
    "Key: `withdraw()`'s require is `balanceOf[msg.sender] >= amount`.",
    "Then call it with `?token=`, and again with no token.",
    'and again with "authorization: Bearer junk" — a bare 200',
    'const J={"authorization":"Bearer junk"};',
    'const AH = {"authorization": "Bearer " + at};',
    "- GET /api/me?token=t1 (no header)",
    "token in query ?token=.",
    "works for auth: as bearer, X-API-Key, ?apiKey=.",
  ]
  test("prose, placeholders and lab values stay as written", () => {
    for (const s of keep) expect(text(s)).toBe(s)
  })

  // An async PoC script in the same style as the real run_poc scripts.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const live = "Zq7Xv9KpR2mN4tW8yB3cL6"
  const script = [
    'const v = await request("POST", "/siwe/verify", { body: JSON.stringify({ message: msg, signature: sig }) });',
    "const t1 = JSON.parse(v.resBody).token;",
    'const me = await request("GET","/api/me",{headers:{authorization:"Bearer "+t1}});',
    "let dec=\"[]\";",
    'const junk = await request("GET", "/api/me", { headers: { authorization: "Bearer junk" } });',
    `const fixed = await request("GET", "/api/me", { headers: { authorization: "Bearer ${live}", "x-api-key": "${live}" } });`,
    "const h = {",
    `  authorization: "Bearer ${live}",`,
    "  token: t1,",
    "};",
    `const q = await request("GET", "/api/me?token=${live}");`,
    "return { me, junk, fixed, h, q, dec };",
  ].join("\n")

  test("a redacted PoC script still parses and loses only the live values", () => {
    expect(() => new AsyncFunction(script)).not.toThrow()
    const out = text(script)
    expect(() => new AsyncFunction(out)).not.toThrow()
    expect(out).not.toContain(live)
    expect(out).toContain('{headers:{authorization:"Bearer "+t1}}')
    expect(out).toContain('authorization: "Bearer junk"')
    expect(out).toContain("  token: t1,")
  })

  test("a quoted header keeps its closing quote", () => {
    expect(text(`curl -H 'X-Api-Key: AIzaSyFAKEfake1234' https://x`)).toBe(`curl -H 'X-Api-Key: [REDACTED]' https://x`)
    expect(text(`curl -H "Authorization: Basic dXNlcjpodW50ZXIy" https://x`)).toBe(`curl -H "Authorization: Basic [REDACTED]" https://x`)
    expect(text(`["Cookie: sid=s3ssionFAKEvalue9"]`)).toBe(`["Cookie: [REDACTED]"]`)
    expect(text(`{"cmd":"curl -H \\"Authorization: Basic dXNlcjpodW50ZXIy\\" x"}`)).toBe(`{"cmd":"curl -H \\"Authorization: Basic [REDACTED]\\" x"}`)
  })

  test("a header line in a recorded HTTP dump is masked", () => {
    const dump = `GET /api/me HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${live}\r\nX-Api-Key: ${live}\r\nCookie: sid=${live}\r\n\r\n`
    expect(text(dump)).toBe("GET /api/me HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer [REDACTED]\r\nX-Api-Key: [REDACTED]\r\nCookie: [REDACTED]\r\n\r\n")
    expect(text(`> Authorization: Bearer ${live}\n< HTTP/1.1 200 OK`)).toBe("> Authorization: Bearer [REDACTED]\n< HTTP/1.1 200 OK")
    expect(text(`"HTTP/1.1 200\\r\\nx-session-token: ${live}\\r\\n"`)).toBe(`"HTTP/1.1 200\\r\\nx-session-token: [REDACTED]\\r\\n"`)
  })

  test("a query secret keeps the text after it", () => {
    expect(text(`see \`/api/me?token=${live}\`, then`)).toBe("see `/api/me?token=[REDACTED]`, then")
    expect(text(text(`/a?token=${live}&b=1`))).toBe("/a?token=[REDACTED]&b=1")
  })
})
