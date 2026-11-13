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

describe("redact: a long header value finishes in linear time", () => {
  test("1 MB of PEM BEGIN lines with no END (review Minor 2)", () => {
    expect(timeMs("-----BEGIN PRIVATE KEY-----\n".repeat(MB / 28))).toBeLessThan(2000)
  })

  test("a PEM private key is still masked", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIFAKE" + "A".repeat(1600) + "\n-----END RSA PRIVATE KEY-----"
    expect(text(`key:\n${pem}\nend`)).toBe("key:\n[REDACTED]\nend")
  })

  test("1 MB of open quoted parameters after a header name", () => {
    expect(timeMs("Authorization: Digest " + 'a="b, '.repeat(MB / 6))).toBeLessThan(2000)
    expect(timeMs('"Authorization: Digest ' + 'a=\\"b, '.repeat(MB / 7))).toBeLessThan(2000)
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

describe("redact: an Authorization value with several parts", () => {
  // A synthetic 64-hex signature and a fake key id, the shapes in a signed
  // AWS request and a Digest response.
  const sig = "9f" + "3a".repeat(31)
  const aws = `AWS4-HMAC-SHA256 Credential=AKIDFAKEEXAMPLE/20260101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${sig}`
  const digest = `Digest username="alice", realm="lab", nonce="n0nceFAKE42", uri="/api/me", response="${sig}"`

  test("an AWS4 header line is masked to the end of the line", () => {
    const out = text(`GET / HTTP/1.1\r\nAuthorization: ${aws}\r\nHost: x`)
    expect(out).toBe("GET / HTTP/1.1\r\nAuthorization: AWS4-HMAC-SHA256 [REDACTED]\r\nHost: x")
    expect(text(out)).toBe(out)
  })

  test("a Digest header line keeps no quoted part", () => {
    expect(text(`Authorization: ${digest}\nnext line`)).toBe("Authorization: Digest [REDACTED]\nnext line")
    const esc = digest.replaceAll('"', '\\"')
    expect(text(`"GET /\\nAuthorization: ${esc}\\nHost: x"`)).toBe(`"GET /\\nAuthorization: Digest [REDACTED]\\nHost: x"`)
  })

  test("a quoted AWS4 or Digest header is masked to its closing quote", () => {
    expect(text(`curl -H 'Authorization: ${aws}' https://x`)).toBe(`curl -H 'Authorization: AWS4-HMAC-SHA256 [REDACTED]' https://x`)
    expect(text(`curl -H 'Authorization: ${digest}' https://x`)).toBe(`curl -H 'Authorization: Digest [REDACTED]' https://x`)
    const esc = digest.replaceAll('"', '\\"')
    expect(text(`curl -H "Authorization: ${esc}" https://x`)).toBe(`curl -H "Authorization: Digest [REDACTED]" https://x`)
  })

  test("every cookie in a Cookie header is masked", () => {
    expect(text(`Cookie: theme=dark; sid=${sig}\n`)).toBe("Cookie: [REDACTED]\n")
  })

  test("a PoC script that sends these headers still parses", () => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    const script = [
      `const h1 = 'Authorization: ${aws}';`,
      "const h2 = `Authorization: " + digest + "`;",
      `const h3 = "Cookie: sid=${sig}; theme=dark";`,
      `const h4 = {"Authorization": "${digest.replaceAll('"', '\\"')}"};`,
      `const raw = "GET / HTTP/1.1\\r\\nAuthorization: ${digest.replaceAll('"', '\\"')}\\r\\n\\r\\n";`,
    ].join("\n")
    const out = text(script)
    expect(() => new AsyncFunction(script)).not.toThrow()
    expect(() => new AsyncFunction(out)).not.toThrow()
    expect(out).not.toContain(sig)
    expect(out).not.toContain("nonceFAKE")
  })
})

describe("redact: secrets in commands and URLs (review Minor 1)", () => {
  test("a ?key= query value is masked", () => {
    expect(text("GET /v1/x?key=AIzaSyFAKEfake1234&q=1")).toBe("GET /v1/x?key=[REDACTED]&q=1")
  })

  test("a URL password is masked; a placeholder or a port trick stays", () => {
    expect(text("clone https://alice:s3cretFAKE99@git.lab/x")).toBe("clone https://alice:[REDACTED]@git.lab/x")
    for (const keep of ["accepts `http://user:pass@host`. Fine.", "- `http://metadata.ens.domains:80@evil...` fine."]) expect(text(keep)).toBe(keep)
  })

  test("curl -u and curl -b values are masked", () => {
    expect(text("curl -u alice:s3cretFAKE99 https://x")).toBe("curl -u alice:[REDACTED] https://x")
    expect(text("curl --user 'alice:s3cretFAKE99' https://x")).toBe("curl --user 'alice:[REDACTED]' https://x")
    expect(text(`curl -b "sid=s3ssionFAKE9; theme=dark" https://x`)).toBe(`curl -b "[REDACTED]" https://x`)
    expect(text("curl --cookie sid=s3ssionFAKE9 https://x")).toBe("curl --cookie [REDACTED] https://x")
  })

  test("a secret env assignment is masked; a variable reference stays", () => {
    const cmd = `DB_PASSWORD=hunt3r2 AWS_SECRET_ACCESS_KEY="wJalrFAKEKEY/K7MDENG/bPxRfiCYFAKEKEY" node x.js`
    expect(text(cmd)).toBe(`DB_PASSWORD=[REDACTED] AWS_SECRET_ACCESS_KEY="[REDACTED]" node x.js`)
    expect(text("DB_PASSWORD=$DB_PASSWORD node x.js")).toBe("DB_PASSWORD=$DB_PASSWORD node x.js")
  })

  test("a mnemonic under its own key is masked", () => {
    expect(redactSecrets({ mnemonic: "test test test test test test test test test test test junk" }).mnemonic).toBe("[REDACTED]")
    expect(text(`{"mnemonic":"test test test test test test test test test test test junk"}`)).toBe(`{"mnemonic":"[REDACTED]"}`)
  })
})

describe("redact: an existing marker (review Minor 3)", () => {
  const fp = "[REDACTED sha256:abcdef123456]"

  test("a sha256 fingerprint under a secret key is kept", () => {
    expect(redactSecrets({ token: fp, password: [fp] })).toEqual({ token: fp, password: [fp] })
    expect(text(fp)).toBe(fp)
  })

  test("text that starts with a marker is still redacted after it", () => {
    expect(text("[REDACTED] then Authorization: Bearer FAKEtoken1234567")).toBe("[REDACTED] then Authorization: Bearer [REDACTED]")
  })
})

describe("redact: evidence under a secret name (review Minor 4)", () => {
  const addr = "0x" + "5fbdb2315678afecb367f032d93f642f64180aa3"

  test("a 40-hex address or an empty string under a secret key stays", () => {
    expect(redactSecrets({ token: addr, password: "", list: { token: [addr] } })).toEqual({ token: addr, password: "", list: { token: [addr] } })
    expect(redactSecrets({ name: "token", value: addr })).toEqual({ name: "token", value: addr })
    expect(text(`{"token":"${addr}","password":""}`)).toBe(`{"token":"${addr}","password":""}`)
  })

  test("a real secret under the same keys is still masked", () => {
    expect(redactSecrets({ token: "tk_alice_0a1b2c3d", privateKey: "0x" + "ab".repeat(32) })).toEqual({ token: "[REDACTED]", privateKey: "[REDACTED]" })
    expect(redactSecrets({ name: "token", value: "tk_alice_0a1b2c3d" })).toEqual({ name: "token", value: "[REDACTED]" })
  })
  test("a bare 40-hex token under a secret name is masked (delta review 1)", () => {
    const hex = "9c2e" + "4f1a".repeat(9)
    expect(redactSecrets({ token: hex, apiKey: hex, sessionId: hex })).toEqual({ token: "[REDACTED]", apiKey: "[REDACTED]", sessionId: "[REDACTED]" })
    expect(redactSecrets({ name: "x-api-key", value: hex })).toEqual({ name: "x-api-key", value: "[REDACTED]" })
    expect(text(`{"token":"${hex}","apiKey":"${hex}"}`)).toBe('{"token":"[REDACTED]","apiKey":"[REDACTED]"}')
    expect(redactSecrets({ token: [hex, addr] })).toEqual({ token: ["[REDACTED]", addr] })
  })
})

describe("redact: a secret pair in JS or Python code (delta review 2)", () => {
  const basic = "Basic dXNlcjpzM2NyZXQ="
  const key = "tk_alice_7f3a9c2e"

  test("the six code forms are masked and keep their quotes", () => {
    expect(text(`{ Authorization: '${basic}' }`)).toBe("{ Authorization: 'Basic [REDACTED]' }")
    expect(text(`headers={'Authorization': '${basic}'}`)).toBe("headers={'Authorization': 'Basic [REDACTED]'}")
    expect(text(`headers: { 'x-api-key': '${key}' }`)).toBe("headers: { 'x-api-key': '[REDACTED]' }")
    expect(text(`{ apiKey: '${key}' }`)).toBe("{ apiKey: '[REDACTED]' }")
    expect(text(`const token = "${key}"`)).toBe('const token = "[REDACTED]"')
    expect(text(`api_key = "${key}"`)).toBe('api_key = "[REDACTED]"')
  })

  test("backtick values and the escaped form are masked", () => {
    expect(text("const apiKey = `" + key + "`")).toBe("const apiKey = `[REDACTED]`")
    expect(text(`{\\"script\\":\\"fetch(u,{headers:{apiKey: \\"${key}\\"}})\\"}`)).not.toContain(key)
  })

  test("comparisons, templates, variables and plain names stay", () => {
    for (const s of [
      `if (token === "${key}") ok()`,
      "const token = `${t1}`",
      'const apiKey = "$API_KEY"',
      `{ authorization: "Bearer " + t1 }`,
      `{ title: '${key}' }`,
      `{ publicKey: '${key}' }`,
      `{ token: '0x5fbdb2315678afecb367f032d93f642f64180aa3' }`,
    ]) expect(text(s)).toBe(s)
  })

  test("a PoC script with code pairs still parses after redaction", () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const script = [
      `const apiKey = '${key}'`,
      `const r = await fetch("http://lab/x", { headers: { Authorization: '${basic}', 'x-api-key': apiKey } })`,
      "return r.status",
    ].join("\n")
    const out = text(script)
    expect(out).not.toContain(key)
    expect(out).not.toContain("dXNlcjpzM2NyZXQ=")
    expect(() => new AsyncFunction(out)).not.toThrow()
  })

  test("1 MB of open code pairs finishes in linear time", () => {
    expect(timeMs("a:'" + "b:\"c:`".repeat(MB / 6))).toBeLessThan(2000)
    expect(timeMs("token = '" + "\\'".repeat(MB / 2))).toBeLessThan(2000)
    expect(timeMs("apiKey: \\\"" + "x\\\\".repeat(MB / 3))).toBeLessThan(2000)
    expect(timeMs("a".repeat(MB) + ":")).toBeLessThan(2000)
  })
})

describe("redact: code pairs keep markdown and empty cookies (delta review 2)", () => {
  test("text between two markdown code spans stays", () => {
    for (const s of [
      "tried `?apiKey=`, `authorization` and `?token=`, `Bearer` forms",
      "`/api/me?access_token=` 401 and `/api/me` 200",
      'request("GET", "/api/me", { headers: { cookie: "token=" + t } })',
    ]) expect(text(s)).toBe(s)
  })
})

describe("redact: secret query names (delta review 4)", () => {
  const v = "Zq7Xv9KpR2mN4tW8yB3cL6"
  test("session, code, sig and presigned S3 values are masked", () => {
    expect(text(`GET /cb?session=${v}&code=${v}&state=abc`)).toBe("GET /cb?session=[REDACTED]&code=[REDACTED]&state=abc")
    expect(text(`https://lab/f?sv=2024&sig=${v}`)).toBe("https://lab/f?sv=2024&sig=[REDACTED]")
    expect(text(`https://b.s3.amazonaws.com/k?X-Amz-Security-Token=${v}&X-Amz-Signature=${"ab12".repeat(16)}&X-Amz-Expires=300`)).toBe(
      "https://b.s3.amazonaws.com/k?X-Amz-Security-Token=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Expires=300",
    )
  })
  test("plain query names and short values stay", () => {
    for (const s of ["/api/items?page=2&sort=Zq7Xv9KpR2mN4tW8", "/oauth?code=200", "/x?token=t1"]) expect(text(s)).toBe(s)
  })
})

describe("redact: secret command-line flags (delta review 4)", () => {
  const pk = "0x" + "ac0974bec39a17e3".repeat(4)
  test("--private-key, --api-key= and a quoted --token are masked", () => {
    expect(text(`cast send --private-key ${pk} --rpc-url http://127.0.0.1:8545 0xabc`)).toBe(
      "cast send --private-key [REDACTED] --rpc-url http://127.0.0.1:8545 0xabc",
    )
    expect(text("tool --api-key=tk_alice_7f3a9c2e run")).toBe("tool --api-key=[REDACTED] run")
    expect(text(`tool --token "Zq7Xv9KpR2mN4tW8"`)).toBe('tool --token "[REDACTED]"')
  })
  test("a variable, a plain flag and a short value stay", () => {
    for (const s of ['cast send --private-key "$PK"', "forge test --match-test testExploit", "tool --token t1"]) expect(text(s)).toBe(s)
  })
  test("1 MB of flags finishes in linear time", () => {
    expect(timeMs("--private-key".repeat(MB / 13))).toBeLessThan(2000)
    expect(timeMs("--token " + " ".repeat(MB))).toBeLessThan(2000)
  })
})

describe("redact: assignments in any case (delta review 4)", () => {
  const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKEKEY99"
  test("lowercase names, spaces around = and export are masked", () => {
    expect(text(`[default]\naws_secret_access_key = ${aws}\nregion = us-east-1`)).toBe("[default]\naws_secret_access_key = [REDACTED]\nregion = us-east-1")
    expect(text("PASSWORD = hunter2hunter2")).toBe("PASSWORD = [REDACTED]")
    expect(text("export api_key=tk_alice_7f3a9c2e && run")).toBe("export api_key=[REDACTED] && run")
  })
  test("code that reads a secret stays and still parses", () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const script = "let token = res.body.token\nconst api_key = get_token(1)\nif (token == x_9) token = auth_token2;\nreturn token"
    const out = text(script)
    expect(out).toContain("res.body.token")
    expect(out).toContain("get_token(1)")
    expect(out).toContain("token == x_9")
    expect(() => new AsyncFunction(out)).not.toThrow()
    for (const s of ['api_key = os.environ["API_KEY"]', "api_key = settings.API_KEY", "TOKEN=$TOKEN"]) expect(text(s)).toBe(s)
  })
  test("1 MB of open assignments finishes in linear time", () => {
    expect(timeMs("api_key = " + "a".repeat(MB) + "(")).toBeLessThan(2000)
    expect(timeMs("a=b ".repeat(MB / 4))).toBeLessThan(2000)
    expect(timeMs("token" + " ".repeat(MB) + "=")).toBeLessThan(2000)
  })
})
