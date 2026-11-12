# Web and sign-in: integration research

Modules M3 (Web app and sign-in) and M4 (API testing). Same table as
`packs/README.md`. Licenses marked "check" must be confirmed against the
upstream repo before a release. The lab is one small Express service with two
routes worth attacking, one undocumented debug route, and one HTML page that
reflects a query value (planted so an XSS scanner has something real to hit).
It is a narrow, crypto-specific target, not a general web app. That shapes
every verdict below.

Three tools are wrapped through `runTool()` in `scan.mjs`: ZAP, Nuclei and
dalfox. They run in the prepass, in Docker, on a throwaway copy of the lab. Their
output is LEADS. A lead is never a finding: only a replayed request script that
the oracle accepts is a finding.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| `run_request_script` + `lib/proof-http.mjs` (ours) | Ours | The lab image `touchstone/web-lab:dev` runs the target; a throwaway container on the same `--internal` network runs the agent's script through `runRequestScript()`/`httpProof()` | Yes, `--internal` network, no host port, no outbound route | A short JS script calling `request()`/`buildSiwe()`/`signPersonal()` | An independently-recorded `{method, path, reqHeaders, reqBody, status, resHeaders, resBody}` transcript per call | The transcript itself | `http`: the same script replays against a FRESH lab and the named oracle still passes | A manual-proxy workflow (Burp Repeater, Caido Replay) | The harness (`request`/`buildSiwe`/`signPersonal` globals), the fresh-lab replay discipline | This is the delivery mechanism for every other row below | wrap (our own harness; nothing upstream to wrap for in-script request/response replay with an independent transcript) |
| Touchstone SIWE and BOLA oracles (ours) | Ours | Pure functions over a transcript, in `pack.mjs` (`ORACLES`) | Yes | The transcript from a `run_request_script` call or a `httpProof()` replay | `{ pass, detail }` | `siwe-nonce-replay`, `bola-wallet-idor`, `debug-route-signer-key-leak`, `reflected-xss` | `http` | None found: see rows below | None | This is the crypto gap: no open-source tool in M3/M4 ships a SIWE nonce/domain/replay check or treats a SIWE session's own `user.id` as the authorization baseline for a BOLA check | own |
| ZAP baseline (OWASP ZAP 2.16.1) | Apache-2.0 | `runTool()` on `ghcr.io/zaproxy/zaproxy:2.16.1`, `zap-baseline.py` as the image user (uid 1000), scratch dir linked to `/zap/wrk` | Yes, `--internal` network, no outbound route | Base URL; the spider follows links | ZAP JSON report | One lead per alert: missing CSP/anti-clickjacking/nosniff headers, `X-Powered-By` leak. The spider also finds `/explorer?q=...`, the URL dalfox then tests | none: a lead only | Our oracles prove the harm. ZAP baseline is passive and cannot sign in | The baseline rule set and the spider (it feeds dalfox its URLs) | No SIWE awareness. It cannot build or sign an EIP-4361 message, so it never reaches the session or BOLA bugs. A clean ZAP report on this lab still hides 2 of the 4 planted bugs | wrap (leads and URL discovery) |
| Nuclei v3.4.10 | MIT | `runTool()` on `projectdiscovery/nuclei:v3.4.10`, `-t /work/templates -jsonl -or -ot -duc` | Yes: our own template ships in `packs/web/scan/templates/`, so no template download | Base URL + templates | JSONL, one match per line (we drop the raw request and response) | `debug-config-exposed`: an anonymous 200 whose JSON holds a key-shaped field. The lead names the field, never the value | none: a lead only | Our `debug-route-signer-key-leak` oracle proves the harm in the agent's replay; the template only points at it | The template is a cheap start for a shared "debug and config exposure" pack (module M11 has the same gap) | Stock templates know no SIWE or wallet-session checks. We wrote one exposure template ourselves. We did not lift upstream templates | wrap (own templates, offline) |
| dalfox v2.12.0 | MIT | `runTool()` on `hahwul/dalfox:v2.12.0`, binary `/app/dalfox`, `url <u> --format json` | Yes | URLs with a query string, taken from ZAP's spider and from `/path?query` URLs in the brief and `openapi.yaml`. None known: dalfox is not launched and coverage says `no-input` | JSON array (a trailing `{}` is normal) | One lead per URL: `reflected-xss`, verified (`V`) or reflected (`R`) | none: a lead only | Our `reflected-xss` oracle proves the harm: the request's own markup comes back unescaped in a 200 HTML page with no CSP | Payload set and DOM-verification | Not crypto specific. It finds the reflection on `/explorer`, a block-explorer style page | wrap |

## Evaluated, not wrapped

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| Schemathesis | check (core was MIT; confirm current split before any release use) | `schemathesis/schemathesis` CLI against `openapi.yaml` | Yes | `openapi.yaml` + base URL | JUnit/JSON | Schema-conformance bugs (wrong status code, type mismatch) | none wired | None of our three bugs are schema-conformance bugs; all three are authorization/session-logic bugs a conformance fuzzer does not model | Property-based case generation from a spec is a real asset for a bigger OpenAPI surface | No concept of a second identity or a "is this field someone else's" check; it only knows what the schema states, not who is allowed to see what | skip for this lab; keep for a future pack with a richer OpenAPI surface |
| ffuf | MIT | `ffuf/ffuf` CLI, wordlist against the lab host | Yes | Wordlist + base URL | JSON | Hidden paths (could in principle discover `/internal/debug/config` by brute force) | none wired | Overlaps the "undocumented route" part of our own audit instructions; our agent found the debug route by reasoning from the brief's own hint, not by brute force, and the oracle proves the harm either way | A small crypto-flavored debug/internal-path wordlist (`/internal/*`, `/_debug`, `/debug/config`, `/.well-known/*`) would be a cheap lift for a bigger target | None beyond path discovery; still needs our oracle to tell "found a path" from "found a leak" | skip for this lab (the planted debug route is already found by the agent); `wrap` as a lead generator once a target has more than a handful of routes |
| jwt_tool | MIT | `ticarpi/jwt_tool` CLI | Yes | A captured token | Attack report (alg confusion, weak secret, etc.) | n/a | n/a | n/a | n/a | Not applicable: the lab's bearer tokens are opaque random hex, never JWTs. A pack targeting a real JWT-based session (many dashboards are) should wire this in | skip (not applicable to this lab) |
| Arjun | MIT | `s0md3v/Arjun` CLI | Yes | Base URL/endpoint | JSON | Hidden GET/POST parameters | none wired | Overlaps ffuf's path-discovery role at the parameter level | None | The lab's two documented routes take no hidden parameters worth mining; this would matter on a wider API | skip for this lab |
| Caido / Burp Suite (+ Burp AI, Burp MCP) | Proprietary (commercial) | Interactive proxy, not a CLI we call from `runTool()` | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Interactive human-in-the-loop tools, not something a fully automated pack tool wraps. Their SIWE-aware replay and multi-account diffing workflows (Caido's Replay, Burp's session handling) are a useful design reference for `run_request_script`'s own shape | read only (design reference) |

## Gaps in our wrapping

- The scanners (zap, nuclei, dalfox) run before sign-in, so they see only the
  anonymous surface. They cannot see the two session bugs (nonce replay, BOLA).
  A scan that signs in with the test wallets (ZAP with a SIWE auth script) is
  not built.
- **A granted live target is wired** (pack flag `live: true`). The scan is aimed
  at the real base URL on the bridge network, `run_request_script` sends real
  requests from a container confined to the grant, and the proof replays at the
  site again. The lab image is still the script runtime (it carries ethers and
  siwe); no lab is started. The oracles are lab-shaped, so a non-SIWE site will
  rarely prove more than reflected XSS.
- ZAP runs the passive baseline only. The active scan is not wired.
- Strix runs as a fourth, much broader engine on a LIVE target only (headless,
  quick, budget-capped; results are leads, never findings). It brings its own
  Docker sandbox and browser, so its traffic does not pass the scope gate — the
  target list is what keeps it on the granted host. Its model calls go through a
  loopback shim that drops one parameter the gateway rejects.
- No JWT-session lab exists in this pack, so `jwt_tool` has nothing to run
  against. A dashboard-style target with JWT sessions is a natural case for
  a second lab under this same pack.
- CORS-with-credentials, open redirects in wallet-connect flows, and CSRF on
  signing endpoints (named in `03-capabilities.md` M3) are not covered by any
  of our three oracles and have no planted bug in the lab to prove against.
- Nuclei's own node/RPC exposure gap (`03-capabilities.md` M11) and a
  SIWE/debug-route template pack are the same missing piece named from two
  different modules; building it once in `lib/` would serve both M3/M4 here
  and M11 (Nodes and RPC).

## Candidates from the research (03-capabilities.md M3/M4, 04-crypto-coverage.md §3.3)

| Tool | Why | Open questions |
|------|-----|-----------------|
| XBOW, Strix, Shannon, Novee | Full agentic web/API pentest platforms; several are hosted-only (XBOW) or need an LLM-heavy multi-agent loop (Strix, PentAGI-style) | Closed or heavyweight; none ships a SIWE-specific attack pack (confirmed: "No product we found ships one" in `03-capabilities.md` M3) — that gap is what this pack's own oracles fill |
| Wiz Red Agent | Validated-impact BOLA case studies for generic APIs | Hosted, closed; its BOLA framing matches our own oracle's design (read your own id from the session, compare against the id in the path) but is not reusable code |
| Detectify API Scanning, Escape | REST/GraphQL dynamic fuzzing with reproducible seeds | Hosted, closed; no SIWE awareness |
| ERC-7730, EIP-1271 verification checks | Clear-signing metadata and contract-wallet (Safe) signature verification for a SIWE login | This lab's two test wallets are plain EOAs; an EIP-1271/Safe-signer SIWE flow needs its own lab and is a real gap for a future pack revision |
| Session fixation / replay across subdomains | Named in `03-capabilities.md` M3's technique list | No planted bug for this in the current lab; a natural fourth oracle if the lab grows a second subdomain-like scope |
- Lab image: built by `npm run build:labs` (`scripts/build-labs.sh`) from a
  lockfile. A missing image makes the prepass fail loudly.
- The recorded transcript `path` is the raw request path with the query and fragment cut off (not normalised); `url` keeps the query.
