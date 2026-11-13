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
    expect(text(`["Cookie: sid=s3ssionFAKEvalue9"]`)).toBe(`["Cookie: sid=[REDACTED]"]`)
    expect(text(`{"cmd":"curl -H \\"Authorization: Basic dXNlcjpodW50ZXIy\\" x"}`)).toBe(`{"cmd":"curl -H \\"Authorization: Basic [REDACTED]\\" x"}`)
  })

  test("a header line in a recorded HTTP dump is masked", () => {
    const dump = `GET /api/me HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${live}\r\nX-Api-Key: ${live}\r\nCookie: sid=${live}\r\n\r\n`
    expect(text(dump)).toBe("GET /api/me HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer [REDACTED]\r\nX-Api-Key: [REDACTED]\r\nCookie: sid=[REDACTED]\r\n\r\n")
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
    expect(text(`Cookie: theme=dark; sid=${sig}\n`)).toBe("Cookie: theme=[REDACTED]; sid=[REDACTED]\n")
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
    expect(text(`curl -b "sid=s3ssionFAKE9; theme=dark" https://x`)).toBe(`curl -b "sid=[REDACTED]; theme=[REDACTED]" https://x`)
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
    // A value that is secretish by the generic rule but is not a vendor or lab
    // token shape, so only the name or the "===" decides whether it is masked.
    const opaque = "s3cretVALUE9f3a9c2e1"
    for (const s of [
      `if (token === "${opaque}") ok()`,
      "const token = `${t1}`",
      'const apiKey = "$API_KEY"',
      `{ authorization: "Bearer " + t1 }`,
      `{ title: '${opaque}' }`,
      `{ publicKey: '${opaque}' }`,
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
    for (const s of ['api_key = os.environ["API_KEY"]', "api_key = settings.API_KEY", "TOKEN=$TOKEN", "try tokenA in query? /api/me?token=tokenA."]) expect(text(s)).toBe(s)
  })
  test("1 MB of open assignments finishes in linear time", () => {
    expect(timeMs("api_key = " + "a".repeat(MB) + "(")).toBeLessThan(2000)
    expect(timeMs("a=b ".repeat(MB / 4))).toBeLessThan(2000)
    expect(timeMs("token" + " ".repeat(MB) + "=")).toBeLessThan(2000)
  })
})

describe("redact: header lines after a list mark, a table bar, a tab or a comma (delta review 4)", () => {
  const basic = "Basic dXNlcjpzM2NyZXQ="
  test("each lead form is masked", () => {
    expect(text(`Headers:\n- Authorization: ${basic}\n* X-Api-Key: tk_alice_7f3a9c2e`)).toBe("Headers:\n- Authorization: Basic [REDACTED]\n* X-Api-Key: [REDACTED]")
    expect(text(`| Header | Value |\n|---|---|\n| Authorization | ${basic} |\n| Accept | */* |`)).toBe(
      "| Header | Value |\n|---|---|\n| Authorization | Basic [REDACTED] |\n| Accept | */* |",
    )
    expect(text(`| Authorization: ${basic} |`)).toBe("| Authorization: Basic [REDACTED] |")
    expect(text(`12:00:01 GET /x\tAuthorization: ${basic}`)).toBe("12:00:01 GET /x\tAuthorization: Basic [REDACTED]")
    expect(text(`headers Host: lab, Authorization: ${basic}`)).toBe("headers Host: lab, Authorization: Basic [REDACTED]")
  })
  test("list and table prose without a credential stays", () => {
    for (const s of [
      "- Authorization: missing on /api/users/{id}",
      "- token: the session token from step 2",
      "| token | `t1` |",
      "| Check | Result |\n| Authorization | none |",
      "first, token: see above",
    ]) expect(text(s)).toBe(s)
  })
  test("1 MB of leads finishes in linear time", () => {
    expect(timeMs("| a | ".repeat(MB / 6))).toBeLessThan(2000)
    expect(timeMs("\n| token |" + " ".repeat(MB))).toBeLessThan(2000)
    expect(timeMs(", token: " + "a".repeat(MB))).toBeLessThan(2000)
    expect(timeMs("\t- ".repeat(MB / 3))).toBeLessThan(2000)
  })
})

describe("redact: a cookie value is masked per cookie (delta review 4)", () => {
  const sid = "s3ssionFAKEvalue9"
  test("Set-Cookie keeps its attributes and each cookie name", () => {
    expect(text(`Set-Cookie: sid=${sid}; Path=/; SameSite=None; Secure; HttpOnly\n`)).toBe("Set-Cookie: sid=[REDACTED]; Path=/; SameSite=None; Secure; HttpOnly\n")
    expect(text(`- cookie: token=${sid}; theme=dark`)).toBe("- cookie: token=[REDACTED]; theme=[REDACTED]")
    expect(text(`{"cookie":"sid=${sid}; Path=/"}`)).toBe(`{"cookie":"sid=[REDACTED]; Path=/"}`)
    expect(text(`curl -b sid=${sid} https://x`)).toBe("curl -b sid=[REDACTED] https://x")
  })
  test("a placeholder or empty cookie value stays", () => {
    for (const s of ["- cookie: token=<alice token>", "Cookie: sid=$SID", "Cookie: token=", 'headers: { cookie: "token=" + t }']) expect(text(s)).toBe(s)
  })
  test("a bare cookie value with no name is still masked as a pair value", () => {
    expect(text(`{"cookie":"${sid}"}`)).toBe(`{"cookie":"[REDACTED]"}`)
  })
  test("1 MB of cookie pairs finishes in linear time", () => {
    const MB = 1 << 20
    for (const s of ["Cookie: " + "a=b; ".repeat(MB / 6), "Cookie: a=" + ";".repeat(MB), "Cookie: " + "=".repeat(MB)]) expect(timeMs(s)).toBeLessThan(2000)
  })
})

describe("redact: a HAR or app header cell held as text (delta review 4)", () => {
  const basic = "Basic dXNlcjpwYXNzd29yZDEyMw=="
  test("the value under a secret name is masked", () => {
    expect(text(`{"name":"Authorization","value":"${basic}"}`)).toBe(`{"name":"Authorization","value":"Basic [REDACTED]"}`)
    expect(text(`[{"name":"x-api-key", "value": "tk_live9fakeZ"},{"name":"Accept","value":"*/*"}]`)).toBe(`[{"name":"x-api-key", "value": "[REDACTED]"},{"name":"Accept","value":"*/*"}]`)
    expect(text(`{"name":"X-Api-Key","redacted":false,"value":"tk_live9fakeZ"}`)).toBe(`{"name":"X-Api-Key","redacted":false,"value":"[REDACTED]"}`)
    expect(text(`{\\"name\\":\\"Authorization\\",\\"value\\":\\"${basic}\\"}`)).toBe(`{\\"name\\":\\"Authorization\\",\\"value\\":\\"Basic [REDACTED]\\"}`)
  })
  test("a placeholder, a weak Bearer value and a 0x address stay", () => {
    for (const s of [
      `{"name":"token","value":"<your token>"}`,
      `{"name":"Authorization","value":"Bearer junk"}`,
      `{"name":"token","value":"0x1111111111111111111111111111111111111111"}`,
      `{"name":"Accept","value":"application/json"}`,
    ]) expect(text(s)).toBe(s)
  })
  test("a PoC script that holds a HAR cell still parses", () => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    const script = `const har = JSON.parse('{"name":"Authorization","value":"${basic}"}');\nconst esc = "{\\"name\\":\\"X-Api-Key\\",\\"value\\":\\"tk_live9fakeZ\\"}";`
    const out = text(script)
    expect(out).not.toContain("tk_live9fakeZ")
    expect(() => new AsyncFunction(out)).not.toThrow()
  })
  test("1 MB of cells finishes in linear time", () => {
    const MB = 1 << 20
    for (const s of [
      '"name":"a"'.repeat(MB / 10),
      '{"name":"Authorization"' + ',"x":1'.repeat(MB / 6),
      '{"name":"Authorization","value":"' + "\\\\".repeat(MB / 2),
      '{\\"name\\":\\"token\\"' + ',\\"x\\":true'.repeat(MB / 12),
    ]) expect(timeMs(s)).toBeLessThan(2000)
  })
})

describe("redact: a letters-only key under a header that is always secret (delta review 4)", () => {
  const key = "abcdefghijklmnop"
  test("12 or more letters are masked", () => {
    expect(text(`X-Api-Key: ${key}`)).toBe("X-Api-Key: [REDACTED]")
    expect(text(`Authorization: Bearer ${key}`)).toBe("Authorization: Bearer [REDACTED]")
    expect(text(`Authorization: Basic ${key}\n`)).toBe("Authorization: Basic [REDACTED]\n")
    expect(text(`curl -H "Authorization: Bearer ${key}" https://x`)).toBe(`curl -H "Authorization: Bearer [REDACTED]" https://x`)
    expect(text(`send Bearer ${key}`)).toBe("send Bearer [REDACTED]")
    expect(text(`Bearer tk_live9fakeZ.`)).toBe("Bearer [REDACTED].")
  })
  test("prose, short placeholders and other headers stay", () => {
    for (const s of [
      "The API uses Bearer authentication.",
      "uses Bearer authentication for all calls",
      "Authorization: Bearer junk",
      "Authorization: Bearer placeholder",
      "X-Api-Key: missing",
      `X-Request-Id: ${key}`,
    ]) expect(text(s)).toBe(s)
  })
  test("1 MB of Bearer text finishes in linear time", () => {
    const MB = 1 << 20
    for (const s of ["Bearer " + ".".repeat(MB) + "a", ("Bearer " + "a".repeat(11) + " ").repeat(MB / 19), "X-Api-Key: " + "a".repeat(MB)]) expect(timeMs(s)).toBeLessThan(2000)
  })
})

describe("redact: a header quoted inside other quotes (delta review 4)", () => {
  const basic = "Basic dXNlcjpwYXNzd29yZDEyMw=="
  test("the inner header is masked and the quotes stay", () => {
    expect(text(`'Note: send "Authorization: ${basic}"'`)).toBe(`'Note: send "Authorization: Basic [REDACTED]"'`)
    expect(text(`"Note: send 'X-Api-Key: tk_live9fakeZ' twice"`)).toBe(`"Note: send 'X-Api-Key: [REDACTED]' twice"`)
    expect(text("'Step: run `curl -H \"Authorization: " + basic + "\"`'")).toBe("'Step: run `curl -H \"Authorization: Basic [REDACTED]\"`'")
  })
  test("plain quoted prose stays", () => {
    for (const s of [`'Note: send "Authorization: Bearer junk"'`, `"Step: open 'Settings: Tokens' page"`]) expect(text(s)).toBe(s)
  })
  test("1 MB of nested quotes finishes in linear time", () => {
    const MB = 1 << 20
    for (const s of [`'a: "b: \`c: `.repeat(MB / 12), `'a: ` + `"b: `.repeat(MB / 4), `"a: 'b: x' `.repeat(MB / 11)]) expect(timeMs(s)).toBeLessThan(2000)
  })
})

describe("redact: header tuples (delta review 4)", () => {
  const basic = "Basic dXNlcjpwYXNzd29yZDEyMw=="
  test("the value of a secret tuple is masked in text", () => {
    expect(text(`headers: [["x-api-key","tk_live9fakeZ"],["Accept","*/*"]]`)).toBe(`headers: [["x-api-key","[REDACTED]"],["Accept","*/*"]]`)
    expect(text(`headers=[("Authorization", "${basic}")]`)).toBe(`headers=[("Authorization", "Basic [REDACTED]")]`)
    expect(text(`new Headers([['x-api-key', 'tk_live9fakeZ']])`)).toBe(`new Headers([['x-api-key', '[REDACTED]']])`)
  })
  test("the value of a secret tuple is masked in an object", () => {
    const out = redactSecrets({ headers: [["x-api-key", "tk_live9fakeZ"], ["Accept", "*/*"]] }) as { headers: string[][] }
    expect(out.headers).toEqual([["x-api-key", "[REDACTED]"], ["Accept", "*/*"]])
  })
  test("a word list and a placeholder tuple stay", () => {
    for (const s of [`["token", "password"].includes(k)`, `[["token","<your token>"]]`, `[("Authorization", "Bearer junk")]`]) expect(text(s)).toBe(s)
    const words = { tags: ["token", "reset"] }
    expect(redactSecrets(words)).toEqual(words)
  })
  test("a PoC script with tuples still parses", () => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    const out = text(`await fetch(u, { headers: new Headers([["x-api-key", "tk_live9fakeZ"]]) })`)
    expect(out).not.toContain("tk_live9fakeZ")
    expect(() => new AsyncFunction(out)).not.toThrow()
  })
  test("1 MB of tuples finishes in linear time", () => {
    const MB = 1 << 20
    for (const s of ["[" + " ".repeat(MB) + '"a",', '["token","' + "\\".repeat(MB), '[("a", "b"'.repeat(MB / 10)]) expect(timeMs(s)).toBeLessThan(2000)
  })
})

describe("redact: a name secret only by its ending keeps a plain value (delta review 4)", () => {
  test("plain settings stay in objects and text", () => {
    const plain = { baseToken: "USDC", quoteToken: "WETH", rewardToken: "NEAR", sort_key: "created_at", storageKey: "auth-state", cache_key: "user:42", primaryKey: "id", nextToken: "", tokenKey: "sub", storageKey: "theme", tags: { authToken: undefined } }
    expect(redactSecrets(plain)).toEqual(plain)
    for (const s of [`{"baseToken":"USDC","primaryKey":"id"}`, `const q = { quoteToken: 'WETH', sort_key: "name" }`]) expect(text(s)).toBe(s)
  })
  test("a secret-shaped value under such a name, and any value under a secret word, is masked", () => {
    const out = redactSecrets({ signerPrivateKey: "0x" + "ab12".repeat(16), dbPassword: "hunter22pass", "x-goog-api-key": "AIzaFAKEkey123", token: "short", password: "letmein" })
    expect(out).toEqual({ signerPrivateKey: "[REDACTED]", dbPassword: "[REDACTED]", "x-goog-api-key": "[REDACTED]", token: "[REDACTED]", password: "[REDACTED]" })
    expect(text(`{"nextToken":"eyJwYWdlIjoyfQ=="}`)).toBe(`{"nextToken":"[REDACTED]"}`)
  })
})

describe("redact: the keys auth, credentials and pwd (delta review 4)", () => {
  const tk = "tk_live9fakeZ"
  test("a secret value under them is masked", () => {
    expect(redactSecrets({ auth: tk, credentials: tk, pwd: "hunter2" })).toEqual({ auth: "[REDACTED]", credentials: "[REDACTED]", pwd: "[REDACTED]" })
    expect(text(`{"auth":"${tk}","pwd":"hunter2"}`)).toBe(`{"auth":"[REDACTED]","pwd":"[REDACTED]"}`)
    expect(text(`const c = { credentials: '${tk}' }`)).toBe(`const c = { credentials: '[REDACTED]' }`)
  })
  test("a plain setting under auth or credentials stays", () => {
    for (const s of [`fetch(u, { credentials: "include" })`, `{"auth":"none"}`, "PWD=/home/lab/run", `- auth: required on /api/me`]) expect(text(s)).toBe(s)
    const plain = { auth: "basic", credentials: "same-origin" }
    expect(redactSecrets(plain)).toEqual(plain)
  })
})

describe("redact: evidence under a secret header name stays (delta review 4)", () => {
  const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
  test("a 0x address and a secret fingerprint stay", () => {
    for (const s of [
      "Token: 0x1111111111111111111111111111111111111111",
      "- token: 0x1111111111111111111111111111111111111111",
      `secret:contracts/deploy.env:${sha}`,
      `rootCause secret:src/keys.ts:${sha}\nsecret:a.env:${sha}`,
    ]) expect(text(s)).toBe(s)
    expect(redactSecrets({ rootCause: `secret:contracts/deploy.env:${sha}` })).toEqual({ rootCause: `secret:contracts/deploy.env:${sha}` })
  })
  test("a secret value next to them is still masked", () => {
    expect(text(`Secret: ${sha}`)).toBe("Secret: [REDACTED]")
    expect(text(`secret: prod key ${sha}`)).toBe("secret: [REDACTED]")
    expect(text("Token: 0x" + "ab".repeat(32))).toBe("Token: [REDACTED]")
  })
})

describe("redact: a long run in the middle of the input finishes in linear time (final review B1)", () => {
  // The run is not at the end, so an end-anchored /X+$/ would scan it again
  // from each start. Each case runs at 256 KB and at 1 MB. Above about 400 KB
  // Bun's regex engine gives up on some rules (it returns no match), so the
  // 256 KB size is the one that proves the rule itself is linear.
  const cases = (MB: number): [string, string][] => [
    ["HAR cells", '"name":"a",'.repeat(MB / 11)],
    ["escaped HAR cells", '\\"name\\":\\"a\\",'.repeat(MB / 17)],
    ["table row with spaces", "| token | a" + " ".repeat(MB) + "y |"],
    ["table row with semicolons", "| token | a" + ";".repeat(MB) + "x"],
    ["header with spaces", "Host: a" + " ".repeat(MB) + "y"],
    ["header with commas", "X-Api-Key: " + ",".repeat(MB) + "x"],
    ["query with stops", "?token=" + ".".repeat(MB) + "x"],
    ["header with semicolons", "X-Api-Key: " + ";".repeat(MB) + "x"],
    ["tuple with spaces", '[["token","' + " ".repeat(MB) + "x"],
    ["tuple with tabs", '[["token","' + "\t".repeat(MB) + '"'],
    ["assignments", "token=".repeat(MB / 6) + '"'],
    ["assignments with colons", "token=:".repeat(MB / 7) + '"'],
  ]
  for (const size of [1 << 18, 1 << 20]) for (const [label, s] of cases(size)) test(`${label}, ${size >> 10} KB`, () => expect(timeMs(s)).toBeLessThan(2000))
  test("an assignment followed by a quote still ends at its last comma", () => {
    expect(text(`x("DB_PASSWORD=s3cret12,next")`)).toBe(`x("DB_PASSWORD=[REDACTED],next")`)
    expect(text(`x("DB_PASSWORD=s3cret12")`)).toBe(`x("DB_PASSWORD=s3cret12")`)
  })
})

describe("redact: a 0x address stays in code, flags, queries and header lines (final review B2)", () => {
  const ADDR = "0x" + "ab12".repeat(10)
  const KEY = "0x" + "ab12".repeat(16)
  test("each address row stays as written", () => {
    for (const s of [
      `address token = ${ADDR};`,
      `address constant TOKEN = ${ADDR};`,
      `const rewardToken = "${ADDR}";`,
      `TOKEN=${ADDR} forge test`,
      `node poc.mjs --token ${ADDR} --amount 5`,
      `curl "http://lab/api/price?token=${ADDR}"`,
      `Token: ${ADDR}, amount: 5`,
      `Pool created, token: ${ADDR} and the attacker drains it`,
    ]) expect(text(s)).toBe(s)
  })
  test("a 64-hex private key under a secret name stays masked", () => {
    expect(text(`cast send --private-key ${KEY} ${ADDR}`)).toBe(`cast send --private-key [REDACTED] ${ADDR}`)
    expect(text(`PRIVATE_KEY=${KEY} forge script`)).toBe("PRIVATE_KEY=[REDACTED] forge script")
    expect(text(`Token: ${KEY}`)).toBe("Token: [REDACTED]")
  })
})

describe("redact: a passphrase of lowercase words under a secret name (final review B3)", () => {
  const pairs: [string, string][] = [
    ["jwt_secret", "my-super-secret-signing-key"],
    ["db_password", "correct-horse-battery-staple"],
    ["adminPassword", "letmein-please"],
    ["signing_key", "development-only-key"],
  ]
  test("each pair is masked at JSON level 0 and level 1, in code and in an object", () => {
    for (const [k, v] of pairs) {
      expect(text(`{"${k}":"${v}"}`)).toBe(`{"${k}":"[REDACTED]"}`)
      expect(text(`{\\"${k}\\":\\"${v}\\"}`)).toBe(`{\\"${k}\\":\\"[REDACTED]\\"}`)
      expect(text(`const cfg = { ${k}: '${v}' }`)).toBe(`const cfg = { ${k}: '[REDACTED]' }`)
      expect(redactSecrets({ [k]: v })).toEqual({ [k]: "[REDACTED]" })
    }
  })
  test("a short setting stays", () => {
    for (const s of [`{"sort_key":"created_at"}`, `{"cache_key":"user_profile"}`, `{"grant_type":"client_credentials"}`, `{\\"sort_key\\":\\"created_at\\"}`]) expect(text(s)).toBe(s)
    const plain = { sort_key: "created_at", cache_key: "user_profile", grant_type: "client_credentials" }
    expect(redactSecrets(plain)).toEqual(plain)
  })
})

describe("redact: prose after Auth: or Credentials:, and a log line keeps its fields (final review M1)", () => {
  test("a plain sentence stays", () => {
    for (const s of ["- Auth: no authentication is required.", "* Credentials: none needed for the exploit.", "Auth: not checked!"]) expect(text(s)).toBe(s)
  })
  test("a log line keeps the fields after the masked header", () => {
    expect(text("method=GET, X-API-Key: tk_live9fakeZ, status=200")).toBe("method=GET, X-API-Key: [REDACTED], status=200")
    expect(text("method=GET\tX-API-Key: tk_live9fakeZ\tstatus=200")).toBe("method=GET\tX-API-Key: [REDACTED]\tstatus=200")
    expect(text("method=GET, X-API-Key: <value>, status=200")).toBe("method=GET, X-API-Key: <value>, status=200")
  })
  test("a real key with a stop after it is still masked", () => {
    expect(text("- Auth: tk_live9fakeZ.")).toBe("- Auth: [REDACTED]")
    expect(text("Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==.\n")).toBe("Authorization: Basic [REDACTED]\n")
  })
})

describe("redact: an assignment keeps a short setting like the JSON pair (final review Minor 3)", () => {
  test("a setting stays and a secret is still masked", () => {
    for (const s of [`const sortKey = "created_at";`, "CACHE_KEY=user_profile"]) expect(text(s)).toBe(s)
    expect(text(`const dbPassword = "letmein-please";`)).toBe(`const dbPassword = "[REDACTED]";`)
    expect(text("DB_PASSWORD=abc123 node x")).toBe("DB_PASSWORD=[REDACTED] node x")
  })
})

describe("redact: a bare vendor or lab token in prose or a path (H2b item 1)", () => {
  // Synthetic values with the published length and alphabet of each vendor.
  const g36 = "ab12CD34ef56GH78ij90KL12mn34OP56qr78"
  test("each vendor prefix is masked in prose and inside a path", () => {
    const cases: [string, string][] = [
      [`returned token tk_live_9f8e7d6c5b4a39281706 to the caller`, "tk_live_9f8e7d6c5b4a39281706"],
      [`the lab key tk_alice_9f1c4a2e was used`, "tk_alice_9f1c4a2e"],
      [`saved to /var/log/tk_bob_77ab0e31.json`, "tk_bob_77ab0e31"],
      [`secret sk_live_${g36.slice(0, 24)} here`, `sk_live_${g36.slice(0, 24)}`],
      [`token ghp_${g36} leaked`, `ghp_${g36}`],
      [`see /tmp/ghp_${g36}.txt`, `ghp_${g36}`],
      [`gho_${g36} oauth`, `gho_${g36}`],
      [`github_pat_11ABCDE0y${g36.slice(0, 20)} fine`, `github_pat_11ABCDE0y${g36.slice(0, 20)}`],
      [`slack xoxb-111111111-222222222-${g36.slice(0, 24)} ok`, `xoxb-111111111-222222222-${g36.slice(0, 24)}`],
      [`key id AKIAFAKEFAKEFAKE1234 rotated`, "AKIAFAKEFAKEFAKE1234"],
      [`glpat-${g36.slice(0, 20)} token`, `glpat-${g36.slice(0, 20)}`],
      [`npm_${g36} registry`, `npm_${g36}`],
    ]
    for (const [s, secret] of cases) {
      expect(text(s)).not.toContain(secret)
      expect(text(s)).toContain("[REDACTED]")
    }
  })
  test("a publishable key, an embedded identifier and a short label stay", () => {
    for (const s of [
      `pk_live_${g36.slice(0, 24)} is publishable`,
      `var file_ghp_${g36} = 1`,
      "tk_live_run is a label",
      "tk_x_1 short",
    ]) expect(text(s)).toBe(s)
  })
  test("a lab token in the middle of 1 MB finishes in linear time", () => {
    expect(timeMs("tk_live_" + "9".repeat(MB) + " tail")).toBeLessThan(2000)
    expect(timeMs("ghp_" + "a".repeat(MB) + " tail")).toBeLessThan(2000)
  })
})

describe("redact: an RPC or API key in a URL path (H2b item 2)", () => {
  const K = "FAKE0fake1FAKE2fake3FAKE4fake5fa"
  test("the key in a provider URL path is masked, the host stays", () => {
    const cases: [string, string][] = [
      [`rpc https://eth-mainnet.g.alchemy.com/v2/${K} call`, "rpc https://eth-mainnet.g.alchemy.com/v2/[REDACTED] call"],
      [`https://mainnet.infura.io/v3/${K}`, "https://mainnet.infura.io/v3/[REDACTED]"],
      [`https://rpc.ankr.com/eth/${K}`, "https://rpc.ankr.com/eth/[REDACTED]"],
      [`https://nd-1.quiknode.pro/${K}/`, "https://nd-1.quiknode.pro/[REDACTED]/"],
      [`https://edge.goldsky.com/standard/evm/1?key=${K}`, "https://edge.goldsky.com/standard/evm/1?key=[REDACTED]"],
    ]
    for (const [s, want] of cases) expect(text(s)).toBe(want)
  })
  test("a provider host with no key, a placeholder and a doc path stay", () => {
    for (const s of [
      "https://polygon-rpc.com/",
      "https://eth.llamarpc.com/eth",
      "https://eth-mainnet.g.alchemy.com/v2/${RPC_KEY}",
      "https://docs.alchemy.com/reference/eth-getbalance",
    ]) expect(text(s)).toBe(s)
  })
  test("a provider URL with a 1 MB path finishes in linear time", () => {
    expect(timeMs("https://rpc.ankr.com/eth/" + "a1".repeat(MB / 2) + " x")).toBeLessThan(2000)
    expect(timeMs("https://x.alchemy.com" + "/seg".repeat(MB / 4) + " x")).toBeLessThan(2000)
  })
})
