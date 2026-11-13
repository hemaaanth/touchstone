# Web and sign-in: integration research

Modules M3 (Web app and sign-in) and M4 (API testing). Same table as
`packs/README.md`. Licenses marked "check" must be confirmed against the
upstream repo before a release. The lab is one small Express service with two
routes worth attacking, two undocumented routes (one debug route linked to a
nuclei template, one unlinked `/internal/metrics` with no template), one public
`/healthz` route that also honours an undocumented `debug` query parameter (not
in any page or spec), and one HTML page that reflects a query value (planted so
an XSS scanner has something real to hit). It is a narrow, crypto-specific
target, not a general web app. That shapes every verdict below.

Seven tools are wrapped through `runTool()` in the prepass, in Docker, on a
throwaway copy of the lab: ZAP, Nuclei and dalfox (in `scan.mjs`), and ffuf,
Arjun, Schemathesis and jwt_tool (in `ffuf.mjs`, `arjun.mjs`,
`schemathesis.mjs` and `jwt.mjs`, collected by `discovery.mjs`). Their output
is LEADS. A lead is never a finding: only a replayed request script that
the oracle accepts is a finding.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| `run_request_script` + `lib/proof-http.mjs` (ours) | Ours | The lab image `touchstone/web-lab:dev` runs the target; a throwaway container on the same `--internal` network runs the agent's script through `runRequestScript()`/`httpProof()` | Yes, `--internal` network, no host port, no outbound route | A short JS script calling `request()`/`buildSiwe()`/`signPersonal()` | An independently-recorded `{method, path, reqHeaders, reqBody, status, resHeaders, resBody}` transcript per call | The transcript itself | `http`: the same script replays against a FRESH lab and the named oracle still passes | A manual-proxy workflow (Burp Repeater, Caido Replay) | The harness (`request`/`buildSiwe`/`signPersonal` globals), the fresh-lab replay discipline | This is the delivery mechanism for every other row below | wrap (our own harness; nothing upstream to wrap for in-script request/response replay with an independent transcript) |
| Touchstone SIWE and BOLA oracles (ours) | Ours | Pure functions over a transcript, in `pack.mjs` (`ORACLES`) | Yes | The transcript from a `run_request_script` call or a `httpProof()` replay | `{ pass, detail }` | `siwe-nonce-replay`, `bola-wallet-idor`, `debug-route-signer-key-leak`, `reflected-xss` | `http` | None found: see rows below | None | This is the crypto gap: no open-source tool in M3/M4 ships a SIWE nonce/domain/replay check or treats a SIWE session's own `user.id` as the authorization baseline for a BOLA check | own |
| ZAP baseline (OWASP ZAP 2.16.1) | Apache-2.0 | `runTool()` on `ghcr.io/zaproxy/zaproxy:2.16.1`, `zap-baseline.py` as the image user (uid 1000), scratch dir linked to `/zap/wrk` | Yes, `--internal` network, no outbound route | Base URL; the spider follows links | ZAP JSON report | One lead per alert: missing CSP/anti-clickjacking/nosniff headers, `X-Powered-By` leak. The spider also finds `/explorer?q=...`, the URL dalfox then tests | none: a lead only | Our oracles prove the harm. ZAP baseline is passive and cannot sign in | The baseline rule set and the spider (it feeds dalfox its URLs) | No SIWE awareness. It cannot build or sign an EIP-4361 message, so it never reaches the session or BOLA bugs. A clean ZAP report on this lab still hides 2 of the 4 planted bugs | wrap (leads and URL discovery) |
| Nuclei v3.4.10 | MIT | `runTool()` on `projectdiscovery/nuclei:v3.4.10`, `-t /work/templates -jsonl -or -ot -duc` | Yes: our own template ships in `packs/web/scan/templates/`, so no template download | Base URL + templates | JSONL, one match per line (we drop the raw request and response) | `debug-config-exposed`: an anonymous 200 whose JSON holds a key-shaped field. The lead names the field, never the value | none: a lead only | Our `debug-route-signer-key-leak` oracle proves the harm in the agent's replay; the template only points at it | The template is a cheap start for a shared "debug and config exposure" pack (module M11 has the same gap) | Stock templates know no SIWE or wallet-session checks. We wrote one exposure template ourselves. We did not lift upstream templates | wrap (own templates, offline) |
| dalfox v2.12.0 | MIT | `runTool()` on `hahwul/dalfox:v2.12.0`, binary `/app/dalfox`, `url <u> --format json` | Yes | URLs with a query string, taken from ZAP's spider and from `/path?query` URLs in the brief and `openapi.yaml`. None known: dalfox is not launched and coverage says `no-input` | JSON array (a trailing `{}` is normal) | One lead per URL: `reflected-xss`, verified (`V`) or reflected (`R`) | none: a lead only | Our `reflected-xss` oracle proves the harm: the request's own markup comes back unescaped in a 200 HTML page with no CSP | Payload set and DOM-verification | Not crypto specific. It finds the reflection on `/explorer`, a block-explorer style page | wrap |
| ffuf v2.3.0 | MIT | `runTool()` on our own pinned local image `touchstone/web-ffuf:2.3.0` (`Dockerfile.ffuf`, binary verified by SHA-256 at build, `--pull never`, runs as uid 1000 on the lab's `--internal` network), `ffuf -u <base>/FUZZ -w /work/content.txt -of json -s` | Yes, `--internal` network, no outbound route (build fetches the pinned binary; run has no network out) | Base URL + a 32-entry content wordlist shipped in `scan/wordlists/content.txt` (ours). One entry, `internal/metrics`, is lab-specific: it names the lab's own planted unlinked route, so the demo has a real hit; the rest are generic discovery words. A real target would drop that entry and lean on the generic list | ffuf JSON (`results[]`); we keep only `{path, status}`, never a response body | One `content-discovery` lead per served path: sensitive reachable paths (`/internal/*`, `admin`, `.env`, …) rank Medium, other reachable Low, gated (status ≥ 400) Informational | none: a lead only. A path is not a leak; our `debug-route-signer-key-leak` oracle is what proves harm on a replay | ZAP's spider finds linked paths; ffuf finds UNLINKED ones. On this lab ffuf is the only engine that reaches `/internal/metrics` (unlinked, no nuclei template, no query), so it adds a lead the other three miss | A crypto-flavored `/internal/*`, `/_debug`, `/.well-known/*` wordlist is a cheap lift for a bigger target | None beyond path discovery; still needs an oracle to tell "found a path" from "found a leak" | wrap (lead generator; the planted unlinked route is found only by ffuf) |
| Arjun v2.2.7 | AGPL-3.0 (LICENSE + OSI classifier; setup.py/PyPI free-text mislabels it "GPLv3") | `runTool()` on our own pinned local image `touchstone/web-arjun:2.2.7` (`Dockerfile.arjun`, sdist verified by SHA-256 at build, `--pull never`, runs as uid 1000 on the lab's `--internal` network), `arjun -u <base><ep> -oJ /work/arjun.json -m GET -t 10`, one container per documented endpoint | Yes, `--internal` network, no outbound route (build fetches and verifies the pinned sdist; run has no network out; Arjun's parameter wordlists ship inside the package) | Base URL + a short list of documented public endpoints (`/healthz`, `/`); Arjun's bundled name wordlist | Arjun JSON (`{ "<url>": {method, params:[...]} }`); we keep only `{path, param, method}`, never a response body | One `hidden-parameter` lead per undocumented param; sensitive names (`debug`, `admin`, `internal`, …) rank Medium, others Low | none: a lead only. A hidden param is not a leak; an oracle on the replayed request is what proves harm | ffuf finds hidden PATHS, Arjun finds hidden PARAMS on known paths. On this lab Arjun is the only engine that sends `?debug=` to `/healthz` (unlinked, untemplated, no scanner guesses the name), so it adds a lead the other four miss | A crypto-flavored parameter wordlist (`signer`, `chainId`, `raw`, `impersonate`, …) is a cheap lift for a bigger API | None beyond parameter discovery; still needs an oracle to tell "found a param" from "found a leak" | wrap (lead generator; the planted hidden `debug` param is found only by Arjun) |
| Schemathesis 4.33.4 | MIT (sdist verified by SHA-256 at build) | `runTool()` on our own pinned local image `touchstone/web-schemathesis:4.33.4` (`Dockerfile.schemathesis`, sdist verified by SHA-256 at build, `--pull never`, runs as uid 1000 on the lab's `--internal` network), `schemathesis run /work/openapi.yaml -u <base> -c not_a_server_error --phases coverage,fuzzing -n 10 --seed 1 --max-time 30 --report json --report-json-path /work/report.json` | Yes, `--internal` network, no outbound route (build fetches and verifies the pinned sdist; run talks only to the lab) | The pack's documented `openapi.yaml` + base URL. It drives every documented operation with schema-valid and boundary inputs. The schema is copied read-write into the run scratch; a real engagement would point this at the target's own published schema | Schemathesis JSON run report (`report.json`: `complete`, `operations.tested`, `failures[]`); we keep only `{code, title, operations}`, never a response body | One `schema-fuzz:<code>` lead per operation a check flagged; a `not_a_server_error` server error (ST101) ranks Medium, any other conformance code Low | none: a lead only, with no oracle yet. A 500 is not yet a proven finding; no oracle replays this bug, so the agent must reproduce it in a replayed script and show real impact by hand | No other engine drives a TYPED path or query parameter against the schema. On this lab Schemathesis is the only engine that trips the HTTP 500 on `GET /api/block/{height}` (a schema-valid but out-of-range integer height that the handler reads without a range check), so it adds a lead the other five miss | Property-based case generation from a spec is a real asset for any richer OpenAPI surface | No SIWE or second-identity awareness; it only knows what the schema states, not who may see what. It finds robustness/conformance faults, never authorization or session-logic bugs | wrap (lead generator; the planted 500 on a typed path param is found only by Schemathesis) |
| jwt_tool 2.3.0 | GPL-3.0 (source tarball verified by SHA-256 at build) | Two containers. Capture: `node:20-slim` on the lab's `--internal` network GETs one token from `GET /api/v2/token`. Crack: `runTool()` on our own pinned local image `touchstone/web-jwt-tool:2.3.0` (`Dockerfile.jwt_tool`, tarball verified by SHA-256 at build, `--pull never`, runs as uid 1000) with `--network none`, `python3 /opt/jwt_tool/jwt_tool.py <token> -C -d /opt/jwt_tool/jwt-common.txt` | Yes. The crack has NO network at all (`--network none`); only the capture step touches the lab, and only to read the public token endpoint | One captured HS256 JWT + jwt_tool's bundled `jwt-common.txt` dictionary | jwt_tool stdout; we read only the "CORRECT key" / "Key not in dictionary" markers (jwt_tool always exits 1, so the text is the verdict, never the code), and keep only `{check, impact, path}` plus the recovered key word — never a response body | One `jwt-weak-hmac-key` High lead when the signing key is a dictionary word; a completed crack that misses is `ran` with zero leads | none: a lead only, with no oracle yet. A cracked key is not yet a finding; no oracle replays this bug, so the agent must forge an admin token, replay it against `/api/v2/admin/summary`, and show the escalation by hand | No other engine cracks a signing KEY. On this lab jwt_tool is the only tool that recovers the weak HS256 secret behind `GET /api/v2/token`, so it adds a lead the other six miss | Offline HMAC-key cracking is a real asset for any JWT-session target (many dashboards) | None: it only cracks the key. Proving the privilege escalation it buys still needs a forged-token replay, and no oracle ships for it yet | wrap (lead generator; the planted weak HS256 key is found only by jwt_tool) |

## Evaluated, not wrapped

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
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
  quick, budget- and turn-capped; results are leads, never findings — the
  fields say `proven: false`). It runs in its own container through runDocker(),
  with the standard caps, and that container mounts the Docker socket because it
  starts its own sandbox. Its traffic does NOT pass the scope gate: the target
  list is what keeps it on the granted host, and a followed link can leave it.
  This is the one deliberate networked, non-offline engine; `lib/strix.mjs`
  says why. Its model calls go through a loopback shim inside the same container
  that drops one parameter the gateway rejects. Build the image with
  `bash scripts/build-labs.sh strix`.
- The JWT-session surface (`GET /api/v2/token` + `GET /api/v2/admin/summary`,
  BUG 8) is only a small HS256 fixture on the same lab. A dashboard-style target
  with a richer JWT session (refresh tokens, `kid`/`jku` headers for alg-confusion
  and key-injection attacks) is a natural second lab; `jwt_tool` here uses only
  the offline weak-secret crack path.
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
