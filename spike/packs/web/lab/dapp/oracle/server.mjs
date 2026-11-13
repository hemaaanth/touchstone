// Touchstone practice target: a small dApp backend with a SIWE (EIP-4361)
// sign-in flow and a per-user API. Three bugs are planted on purpose, one per
// root cause, for the "web" pack to find and prove:
//
//   1. SIWE nonce replay. /siwe/nonce issues a nonce; /siwe/verify checks it
//      against the signed message but never marks it used. The same signed
//      message + signature pair can be POSTed again, any number of times, to
//      mint fresh sessions for that wallet without the owner signing again.
//   2. Broken object-level authorization (IDOR / BOLA). /api/users/:id and
//      /api/users/:id/wallet check only that the caller has *a* valid
//      session, never that the session's own user id matches :id. Any signed-in
//      user can read any other user's profile and wallet.
//   3. A secret-leaking debug route. /internal/debug/config is undocumented
//      (not in openapi.yaml) and unauthenticated, and returns the chain
//      signer's private key and RPC URL in the response body.
//
//   4. Reflected XSS. /explorer?q= is the lab's public block-explorer page. It
//      writes the q parameter into the HTML page without escaping it. A link
//      with a script payload in q runs that script in the visitor's browser,
//      on the same origin as the signed-in dApp.
//
// This file lives under oracle/ so spike/lib/sandbox.mjs's makeWorkspace()
// never copies it into an agent's run workspace (SKIP_DIRS has "oracle").
// The agent only ever sees this service from the outside, over HTTP, plus
// ../BRIEF.md and ../openapi.yaml, which are its documented inputs.
import express from "express";
import { SiweMessage } from "siwe";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
// EIP-4361 domain/uri this lab expects callers to sign for. The lab is single
// purpose, so these are fixed rather than configurable.
const EXPECT_DOMAIN = "touchstone.lab";
const EXPECT_URI = "http://touchstone.lab/siwe";
const EXPECT_CHAIN_ID = 31337; // Anvil/Hardhat default chain id

// Two seeded test users on the well-known Hardhat/Anvil default accounts.
// These private keys are published test fixtures (Foundry/Hardhat default
// accounts), never used for real funds. They are handed to the agent in
// BRIEF.md as test credentials for this engagement.
const USERS = [
  {
    id: 1,
    name: "alice",
    email: "alice@touchstone.lab",
    wallet: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    apiKey: "tk_alice_9f1c4a2e",
    balanceUsd: 4200,
  },
  {
    id: 2,
    name: "bob",
    email: "bob@touchstone.lab",
    wallet: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    apiKey: "tk_bob_77ab0e31",
    balanceUsd: 900,
  },
];
const BY_WALLET = new Map(USERS.map((u) => [u.wallet, u]));
const BY_ID = new Map(USERS.map((u) => [u.id, u]));

// Bug 3 fixture: a fake "chain signer" key, reusing the same well-known Anvil
// test key family (Account #2) so it is unmistakably lab data, never a real
// secret. The finding is that this route exists and leaks it at all, not the
// value of the key itself.
const LEAKED_SIGNER = {
  rpcUrl: "https://mainnet.infura.io/v3/00000000000000000000000000000000",
  chainId: 1,
  signerAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  signerPrivateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

// BUG 7 fixture: a fixed-size in-memory "chain". Heights 0..CHAIN_HEAD-1 are
// real blocks; anything else is out of range. The block-lookup route below
// reads this array without a range check, which is the planted fault.
const CHAIN_HEAD = 128;
const BLOCKS = Array.from({ length: CHAIN_HEAD }, (_, h) => ({
  height: h,
  hash: "0x" + h.toString(16).padStart(64, "0"),
  txCount: (h * 7) % 13,
}));

// BUG 8 fixture: a "v2" session API that signs its own JWTs instead of the
// opaque random tokens below. The JWTs are HS256-signed with a weak,
// dictionary-crackable secret ("secret123" is a word in jwt_tool's bundled
// jwt-common.txt). That is the planted fault: the HMAC key is guessable
// OFFLINE, so anyone who captures one issued token can recover the key with a
// dictionary and then forge a token with any claims -- e.g. role:"admin" -- to
// reach the admin-only route. An offline JWT analyser (jwt_tool) cracks the
// secret from a single captured token with no further requests to the lab;
// none of the HTTP scanners in the prepass crack a signing key. The opaque
// SIWE sessions below are unchanged, so this is purely additive.
const JWT_SECRET = "secret123"; // weak on purpose; in jwt_tool's default wordlist
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function jwtSign(payload) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

// Verify an HS256 JWT against JWT_SECRET. Fully defensive: any malformed input
// returns null (served as a 401), never throws -- so fuzzing the Authorization
// header can never turn into a 500 here. The hole is the weak key, not a crash.
function jwtVerify(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  let expected;
  try {
    expected = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// --- Nonce store. Bug 1: a nonce is never invalidated after a successful
// verify, so the same signed message replays indefinitely.
const nonces = new Map(); // nonce -> issuedAt (ms)
const NONCE_TTL_MS = 10 * 60 * 1000;

function freshNonce() {
  const nonce = randomBytes(12).toString("hex");
  nonces.set(nonce, Date.now());
  return nonce;
}

function nonceIsLive(nonce) {
  const issuedAt = nonces.get(nonce);
  if (issuedAt == null) return false;
  if (Date.now() - issuedAt > NONCE_TTL_MS) {
    nonces.delete(nonce);
    return false;
  }
  return true; // intentionally never deleted on successful use -- bug 1
}

// --- Sessions. Bearer tokens, in memory, keyed to a wallet.
const sessions = new Map(); // token -> wallet

function tokenFor(wallet) {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, wallet);
  return token;
}

function requireSession(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  const wallet = token && sessions.get(token);
  if (!wallet || !BY_WALLET.has(wallet)) return res.status(401).json({ error: "no_session" });
  req.sessionWallet = wallet;
  req.sessionUser = BY_WALLET.get(wallet);
  next();
}

const app = express();
app.use(express.json());

// BUG 6: /healthz is a documented, public, unauthenticated route, but it also
// honours an UNDOCUMENTED `debug` query parameter. With no `debug`, it is the
// plain health probe operators expect. With `debug` present it reflects the
// value back and adds internal detail (the staging build tag and the signer
// address, not the key). No page or spec mentions the parameter, so the prepass
// scanners (zap spider, nuclei templates, dalfox, ffuf path discovery) never
// send it -- only a parameter-mining tool (Arjun) that guesses the NAME finds
// it. This models a leftover debug flag / hidden feature on a shipped endpoint.
// Plain `/healthz` behaviour is unchanged, so this is additive for other tools.
app.get("/healthz", (req, res) => {
  const out = { ok: true };
  if ("debug" in req.query) {
    out.debug = String(req.query.debug); // reflected -> a param miner flags it
    out.build = "staging";
    out.signerAddress = LEAKED_SIGNER.signerAddress; // internal detail, not the key
  }
  res.json(out);
});

app.get("/siwe/nonce", (_req, res) => {
  res.json({ nonce: freshNonce() });
});

app.post("/siwe/verify", async (req, res) => {
  const { message, signature } = req.body || {};
  if (typeof message !== "string" || typeof signature !== "string") {
    return res.status(400).json({ error: "message and signature are required" });
  }
  let siwe;
  try {
    siwe = new SiweMessage(message);
  } catch {
    return res.status(400).json({ error: "malformed SIWE message" });
  }
  if (siwe.domain !== EXPECT_DOMAIN || siwe.uri !== EXPECT_URI || siwe.chainId !== EXPECT_CHAIN_ID) {
    return res.status(401).json({ error: "domain, uri, or chainId mismatch" });
  }
  if (!nonceIsLive(siwe.nonce)) {
    return res.status(401).json({ error: "unknown or expired nonce" });
  }
  try {
    await siwe.verify({ signature, domain: EXPECT_DOMAIN, nonce: siwe.nonce });
  } catch {
    return res.status(401).json({ error: "signature verification failed" });
  }
  // BUG 1: no nonces.delete(siwe.nonce) here. The nonce stays live, so this
  // exact (message, signature) pair can be replayed to mint more sessions.
  const wallet = siwe.address.toLowerCase();
  const user = BY_WALLET.get(wallet);
  if (!user) return res.status(401).json({ error: "wallet has no account" });
  const token = tokenFor(wallet);
  res.json({ token, user: { id: user.id, name: user.name } });
});

app.get("/api/me", requireSession, (req, res) => {
  const u = req.sessionUser;
  res.json({ id: u.id, name: u.name, email: u.email, wallet: u.wallet, balanceUsd: u.balanceUsd });
});

// BUG 2: any authenticated session can read ANY user id's profile, not just
// its own. The only check is "is there a session", never "does the session's
// user id match :id".
app.get("/api/users/:id", requireSession, (req, res) => {
  const u = BY_ID.get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json({ id: u.id, name: u.name, email: u.email, wallet: u.wallet, balanceUsd: u.balanceUsd });
});

// Same root cause as above (missing owner check), same fix: this route must
// share one finding with GET /api/users/:id, not report as a second bug.
app.get("/api/users/:id/wallet", requireSession, (req, res) => {
  const u = BY_ID.get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json({ id: u.id, wallet: u.wallet, apiKey: u.apiKey });
});

// BUG 7: a documented, public block-lookup endpoint (in openapi.yaml, no
// security). It assumes the requested height is in range and reads the chain
// array directly. An out-of-range or negative height -- the kind a schema
// fuzzer generates from the integer path parameter -- indexes past the array,
// so the handler dereferences `undefined` and Express turns the thrown
// TypeError into an unhandled HTTP 500, instead of the 404 a missing block
// should get. A 500 on a well-typed but out-of-range input is a server-error /
// schema-conformance bug. None of the other prepass tools fuzz a typed path
// parameter against the schema, so only Schemathesis trips it. Valid heights
// (0..CHAIN_HEAD-1) return 200 with the block, so the route is genuinely
// functional. This is additive: no existing route changes.
app.get("/api/block/:height", (req, res) => {
  const height = Number(req.params.height);
  const block = BLOCKS[height]; // undefined when out of range or negative
  // Bug: no `if (!block) return res.status(404)...`. Reading .hash of
  // undefined throws synchronously, which Express serves as a 500.
  res.json({ height: block.height, hash: block.hash, txCount: block.txCount });
});

// BUG 8: a documented v2 session API backed by JWTs. GET /api/v2/token hands
// any caller a signed guest token; GET /api/v2/admin/summary verifies the JWT
// and serves data only to role:"admin". The signature IS checked, so a random
// forged token is rejected -- but the HS256 secret is weak and dictionary-
// crackable, so the check is worthless: crack the key offline from one captured
// token, forge an admin token, read the summary. jwt_tool produces the lead
// ("this token's signing key is crackable"); proving impact means forging an
// admin token and getting a 200 from the admin route. Additive: no existing
// route changes.
app.get("/api/v2/token", (_req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const token = jwtSign({ sub: "guest", role: "guest", iat: now, exp: now + 3600 });
  res.json({ token, tokenType: "Bearer" });
});

app.get("/api/v2/admin/summary", (req, res) => {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  const claims = token ? jwtVerify(token) : null;
  if (!claims) return res.status(401).json({ error: "no_token" });
  if (claims.role !== "admin") return res.status(403).json({ error: "forbidden" });
  res.json({ ok: true, adminOf: String(claims.sub ?? ""), users: USERS.length, sessionsOpen: sessions.size });
});

// BUG 3: undocumented, unauthenticated, leaks the chain signer's key. Not
// listed in openapi.yaml -- meant to be found by path discovery (ffuf), not
// by reading the spec.
app.get("/internal/debug/config", (_req, res) => {
  res.json(LEAKED_SIGNER);
});

// BUG 3b: a second undocumented, unauthenticated operations route. Unlike
// /internal/debug/config it carries no nuclei template and is not linked from
// any page, so the prepass scanners (zap spider, nuclei templates, dalfox)
// never reach it. It is here to be found only by brute-force path discovery
// (ffuf) against a wordlist. It leaks internal counters and the signer address
// (not the key) -- a real, if lower-severity, information exposure.
let requestCount = 0;
app.use((_req, _res, next) => { requestCount += 1; next(); });
app.get("/internal/metrics", (_req, res) => {
  res.json({
    service: "touchstone-dapp-oracle",
    uptimeSec: Math.round(process.uptime()),
    requests: requestCount,
    sessionsOpen: sessions.size,
    noncesLive: nonces.size,
    signerAddress: LEAKED_SIGNER.signerAddress,
    buildEnv: "staging",
  });
});

// The public landing page. It links to the explorer so a crawler can find it.
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><title>touchstone dApp</title></head><body>
<h1>touchstone dApp</h1>
<p>Sign in with Ethereum, then use the API. Look up an address or a transaction in the <a href="/explorer?q=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266">explorer</a>.</p>
<form action="/explorer" method="get"><input name="q" value=""><button>Search</button></form>
</body></html>`);
});

// BUG 4: q is written into the page as raw HTML. No escaping, no CSP.
app.get("/explorer", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.type("html").send(`<!doctype html><html><head><title>explorer</title></head><body>
<h1>Explorer</h1>
<p>No results for <b>${q}</b></p>
<a href="/">back</a>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`touchstone-web-lab listening on :${PORT}`);
});
