---
name: web
description: Audit a dApp backend's SIWE sign-in and REST API, and prove each bug by replaying a request script against a fresh copy of the lab.
tier: P
proof: http
tools: [web_leads, run_request_script, submit_finding]
labs: [lab/dapp]
---

# Web and sign-in (modules M3 Web app and sign-in, M4 API testing)

The agent audits a black-box dApp backend: a SIWE (EIP-4361) login flow and a
small REST API over two user accounts. It never sees the server source, only
`openapi.yaml`, `BRIEF.md`, and two seeded test wallets. It proves each real
bug by replaying a request script. The replay runs in Docker, on a private
network with no route to the internet.

## Inputs

- A lab: `lab/dapp/` is a small Express server plus its `oracle/` seed data.
  It is built into the image `touchstone/web-lab:dev` and started fresh for
  the run, and again, fresh, for every proof replay.
- `lab/dapp/openapi.yaml`: the documented routes.
- `lab/dapp/BRIEF.md`: scope, the base URL, and the two test wallets (seeded
  Hardhat/Anvil accounts 0 and 1, never used for real funds).

## Pre-pass

Before the agent starts, `prepass` starts the lab container on a fresh,
`--internal` Docker network (no host port, no outbound route) and writes the
live handle to the workspace so the agent's tool calls can reach it across
the child-process boundary.

Then it scans a second, throwaway copy of the lab with three open-source
tools, each run in Docker through `runTool()` (see `scan.mjs`):

- ZAP baseline: header and info-leak alerts, and a spider that finds URLs
  that take input.
- Nuclei: our own template for an exposed debug or config route.
- dalfox: reflected XSS on the URLs that take input: the ones ZAP found and the
  `/path?query` URLs the brief and `openapi.yaml` document. With none known,
  dalfox does not run. The coverage line says `no-input`, with a reason. That is
  not a clean result.

The result is a prepass record (`coverage` and `leads`). It shows in the run
view as a fold: which tool ran, and the leads. The agent gets the leads in its
first message and can read them again with `web_leads`. A lead is a hint,
never a finding. The scan cannot sign in, so it never sees the session bugs.

## Steps

1. Read `BRIEF.md` and `openapi.yaml` (handed to the agent in the kickoff
   message). List every suspect worst first: the sign-in flow itself, every
   documented route's ownership check, and whether an undocumented route
   exists.
2. For each suspect, write a short JS script and run it with
   `run_request_script`. Use the three injected globals: `request(method,
   path, { headers, body })`, `buildSiwe({...})`, `signPersonal(privateKeyHex,
   message)`. Use at most 3 attempts per suspect.
3. The tool replies with the exact recorded transcript, and whether it tripped
   one of the engine's own harm checks (never trust the script's own
   `console.log`). The moment it reports a MATCH, call `submit_finding` with
   the same label right away, then move to the next suspect.
4. One finding per root cause: if two routes share one missing check, that is
   one finding. `submit_finding` refuses a second submission for the same
   underlying oracle.
5. End with one coverage line per suspect: proven, not exploitable, or not
   tried.

## Writing a request script

- Sign in: `GET /siwe/nonce` → `buildSiwe({ domain: "touchstone.lab", address,
  uri: "http://touchstone.lab/siwe", version: "1", chainId: 31337, nonce,
  issuedAt })` → `signPersonal(privateKeyHex, message)` → `POST /siwe/verify`
  with `{ message, signature }` → a 200 carries `{ token, user: { id, name
  } }`. Send `authorization: Bearer <token>` on later calls.
- Two wallets only, fixed in the lab: alice (id 1) and bob (id 2). Never
  invent a third identity's key; the oracle checks need both real sessions.
- The transcript the tool returns is recorded independently of the script. A
  script that prints "it worked!" proves nothing; only the transcript's own
  request/response pairs do.

## Oracle

Each submitted finding names the attempt's label and the request script that
tripped a pattern. `submit_finding` refuses a label that never matched.
When the run settles, the engine (`prove()`) tears down the live lab,
starts a brand-new one, and replays each finding's exact script against it
through `lib/proof-http.mjs`'s `httpProof()`. The same named oracle reads the
fresh transcript. A finding is real only when the oracle still passes on that
independent replay — this is why `prove()` never reuses the agent's own
session: by the time the run ends, nonces are already spent and tokens
already issued, so a stale transcript could look like a false pass.

The four oracles, each pure functions over a transcript (`pack.mjs`
`ORACLES`):

| Oracle | Impact | What it means |
|--------|--------|----------------|
| `siwe-nonce-replay` | High | The identical signed SIWE message and signature, POSTed to `/siwe/verify` twice, mint two different sessions. A captured signature is a forever session-minting credential, not a one-time login. |
| `bola-wallet-idor` | High | Signed in as one user, a call to `/api/users/:id` or `/api/users/:id/wallet` for a DIFFERENT id returns that user's wallet or API key. The route checks only that some session exists, never that it is the caller's own id. |
| `debug-route-signer-key-leak` | Critical | An unauthenticated route returns the chain signer's private key. "Unauthenticated" is proven from the transcript: a call with no credential header returns the key, a second call with a junk token returns the same body, and the key is a real 64-hex key whose derived address equals the `signerAddress` the route reports. |
| `reflected-xss` | Medium | A page writes a query value into its HTML in an executable place (not in a comment, an attribute value, a `<textarea>`, a `<title>` or other inert state), with no script-limiting CSP. The oracle parses the CSP (`script-src`, falling back to `default-src`, with `'unsafe-inline'`, nonces and hashes) and reads the query from the full URL. |

## Secrets in proofs

Oracles read the raw transcript. Their `detail` and the stored `proof.log` never
carry a raw secret (a signer key, an API key, a session token). `detail` names a
secret by its fingerprint (`[REDACTED sha256:...]`). `prove()` scrubs the stored
log with `scrubProof` (`redact.mjs`) right after the replay.
`test/proof-redaction.test.mjs` renders each proof through `proofView` and
checks this.

## Limits

- Two seeded wallets, one lab server, one Docker image. The agent does not
  discover new wallets or scan a route list the lab does not have.
- Local, offline Docker only. No fork, no live network, no real keys.
- A live (non-lab) target is not wired yet. It waits for the platform scope
  proxy and grant. `prepass(ws, { target: { net, baseUrl } })` is the hook.
- JWT-attack breadth (alg confusion, weak secrets), CORS/CSRF, and open-ended
  fuzzing are not covered by our own oracles; see TOOLS.md for what a wrapped
  scanner could still add as a lead (never a finding on its own — this pack
  has no `forge`-style second proof path for anything outside the three
  shipped oracles).

## Building the lab image

`npm run build:labs` (or `bash scripts/build-labs.sh [web|ai-mcp|inspector]`)
builds `touchstone/web-lab:dev` from `lab/dapp/oracle/package-lock.json`. This
pack has no source to fall back on. If the image is missing, the prepass fails
at once with an error that names this script. The scanner images (zaproxy,
nuclei, dalfox) are pulled by tag on first use.
