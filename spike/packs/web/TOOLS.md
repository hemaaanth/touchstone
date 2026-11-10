# Web and sign-in: integration research

Modules M3 (Web app and sign-in) and M4 (API testing). Same table as
`packs/README.md`. Licenses marked "check" must be confirmed against the
upstream repo before a release. The lab is one small Express service with two
routes worth attacking and one undocumented debug route: a narrow,
crypto-specific target, not a general web app. That shapes every verdict
below — most general-purpose scanners have little surface to bite into here,
even where they would earn their place on a bigger target.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| `run_request_script` + `lib/proof-http.mjs` (ours) | Ours | The lab image `touchstone/web-lab:dev` runs the target; a throwaway container on the same `--internal` network runs the agent's script through `runRequestScript()`/`httpProof()` | Yes, `--internal` network, no host port, no outbound route | A short JS script calling `request()`/`buildSiwe()`/`signPersonal()` | An independently-recorded `{method, path, reqHeaders, reqBody, status, resHeaders, resBody}` transcript per call | The transcript itself | `http`: the same script replays against a FRESH lab and the named oracle still passes | A manual-proxy workflow (Burp Repeater, Caido Replay) | The harness (`request`/`buildSiwe`/`signPersonal` globals), the fresh-lab replay discipline | This is the delivery mechanism for every other row below | wrap (our own harness; nothing upstream to wrap for in-script request/response replay with an independent transcript) |
| Touchstone SIWE and BOLA oracles (ours) | Ours | Pure functions over a transcript, in `pack.mjs` (`ORACLES`) | Yes | The transcript from a `run_request_script` call or a `httpProof()` replay | `{ pass, detail }` | `siwe-nonce-replay`, `bola-wallet-idor`, `debug-route-signer-key-leak` | `http` | None found: see rows below | None | This is the crypto gap: no open-source tool in M3/M4 ships a SIWE nonce/domain/replay check or treats a SIWE session's own `user.id` as the authorization baseline for a BOLA check | own |

## Evaluated, not wrapped

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| ZAP (OWASP ZAP) | Apache-2.0 | `ghcr.io/zaproxy/zaproxy:stable`, baseline or active scan | Yes, points at the lab container on the same network | Target URL, optional OpenAPI import | JSON/HTML report | Generic DAST findings (missing headers, reflected params, spidered paths) | none wired | Our `bola-wallet-idor` oracle does the same job ZAP's Access Control Testing add-on targets, but needs two real signed-in sessions, which ZAP does not script out of the box | ZAP's baseline-scan ruleset and header checks are useful on a bigger target | Has no SIWE awareness: cannot build or sign an EIP-4361 message, so it never gets past `/siwe/verify` to reach the two routes that matter | skip for this lab (2 real routes, no HTML, no generic-header surface worth a report); candidate `ensemble` lead-generator on a larger web app in this module |
| Nuclei | MIT | `projectdiscovery/nuclei` CLI, `-im openapi` or server mode | Yes, scope regex to the lab host | OpenAPI/HAR/URL list | JSONL per match | Template matches (generic CVEs, exposed debug endpoints via its built-in exposure templates) | none wired | Its stock `exposed-panels`/`exposures` templates could in principle flag `/internal/debug/config` by path heuristics; our `debug-route-signer-key-leak` oracle proves the actual harm (the body carries a signer key), which a nuclei template does not check for | A "crypto node/debug exposure" template pack is exactly module M11's own gap note; worth building once, shared across packs | Ships no SIWE or wallet-session templates (confirmed: `04-crypto-coverage.md` names this as an open gap, "ASVS; EIP-4361" with no product match) | skip for this lab's 3 root causes; `wrap` later as a first-pass lead generator once a template pack exists |
| Schemathesis | check (core was MIT; confirm current split before any release use) | `schemathesis/schemathesis` CLI against `openapi.yaml` | Yes | `openapi.yaml` + base URL | JUnit/JSON | Schema-conformance bugs (wrong status code, type mismatch) | none wired | None of our three bugs are schema-conformance bugs; all three are authorization/session-logic bugs a conformance fuzzer does not model | Property-based case generation from a spec is a real asset for a bigger OpenAPI surface | No concept of a second identity or a "is this field someone else's" check; it only knows what the schema states, not who is allowed to see what | skip for this lab; keep for a future pack with a richer OpenAPI surface |
| ffuf | MIT | `ffuf/ffuf` CLI, wordlist against the lab host | Yes | Wordlist + base URL | JSON | Hidden paths (could in principle discover `/internal/debug/config` by brute force) | none wired | Overlaps the "undocumented route" part of our own audit instructions; our agent found the debug route by reasoning from the brief's own hint, not by brute force, and the oracle proves the harm either way | A small crypto-flavored debug/internal-path wordlist (`/internal/*`, `/_debug`, `/debug/config`, `/.well-known/*`) would be a cheap lift for a bigger target | None beyond path discovery; still needs our oracle to tell "found a path" from "found a leak" | skip for this lab (the planted debug route is already found by the agent); `wrap` as a lead generator once a target has more than a handful of routes |
| jwt_tool | MIT | `ticarpi/jwt_tool` CLI | Yes | A captured token | Attack report (alg confusion, weak secret, etc.) | n/a | n/a | n/a | n/a | Not applicable: the lab's bearer tokens are opaque random hex, never JWTs. A pack targeting a real JWT-based session (many dashboards are) should wire this in | skip (not applicable to this lab) |
| Arjun | MIT | `s0md3v/Arjun` CLI | Yes | Base URL/endpoint | JSON | Hidden GET/POST parameters | none wired | Overlaps ffuf's path-discovery role at the parameter level | None | The lab's two documented routes take no hidden parameters worth mining; this would matter on a wider API | skip for this lab |
| dalfox | MIT | `hahwul/dalfox` CLI | Yes | URL/param list | JSON | Reflected/DOM XSS | n/a | n/a | n/a | Not applicable: this is a JSON API with no HTML rendering surface, so there is nothing for an XSS scanner to reflect into | skip (not applicable to this lab) |
| Caido / Burp Suite (+ Burp AI, Burp MCP) | Proprietary (commercial) | Interactive proxy, not a CLI we call from `runTool()` | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Interactive human-in-the-loop tools, not something a fully automated pack tool wraps. Their SIWE-aware replay and multi-account diffing workflows (Caido's Replay, Burp's session handling) are a useful design reference for `run_request_script`'s own shape | read only (design reference) |

## Gaps in our wrapping

- The lab has one fixed sign-in flow, two documented routes, and one
  undocumented debug route. The agent finds all three by auditing, not by
  brute force. A real (I-tier) engagement against a bigger admin console or
  dashboard would need an actual spidering/fuzzing first pass (ZAP spider,
  ffuf, Arjun) before the SIWE- and BOLA-specific oracles have anything new
  to check — none of that is wired yet.
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
