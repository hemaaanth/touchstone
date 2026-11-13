# Domains tool selection

Checked on 2026-11-10. Start points: M1 and M2 in the capability research,
crypto coverage rows 3.1 and 3.2, and gap 4 provider rules. The research lives
in the main checkout. It is not part of the Wave 1 baseline.

Sizes below are local, uncompressed Docker image sizes. Scanner calls use
`runTool()` in `lib/wrap.mjs`. Static checks use `--network none`.

Capture has two modes. The lab mode uses an owned Docker `--internal` network.
The live mode (`live.mjs`) takes its network from `reach`, which a live run
fills when the workspace is built: the egress network, `granted: true`, and the
grant's `scope`. Live capture refuses a domain unless that scope covers it. The
capture tools resolve DNS over UDP, so they cannot use the HTTP gate; the grant
is enforced in code here, and the captured snapshot is what later steps read.

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [dnsx](https://github.com/projectdiscovery/dnsx/tree/v1.2.2) | [MIT](https://github.com/projectdiscovery/dnsx/blob/v1.2.2/LICENSE.md) | projectdiscovery/dnsx:v1.2.2; digest in tools.mjs; 82.8 MiB | Lab: local resolver only. Live: the resolver the grant allows. -duc; no ASN/CDN enrichment | Wordlist and subfinder hosts, then CNAME targets | -json JSONL | Resolution and CNAME records become snapshot evidence; NXDOMAIN rows are dropped except for CNAME targets | evidence; CNAME plus target A and AAAA NXDOMAIN | dnsReaper and Nuclei: compare below | JSONL capture workflow; no code copied | Registry-lock evidence. The DNSSEC chain comes from DNSViz | wrap; small resolver with explicit local DNS |
| [httpx](https://github.com/projectdiscovery/httpx/tree/v1.7.1) | [MIT](https://github.com/projectdiscovery/httpx/blob/v1.7.1/LICENSE.md) | projectdiscovery/httpx:v1.7.1; digest in tools.mjs; 917.4 MiB | Lab: local DNS and HTTP only. Live: scope hosts only. -duc; no redirects, cloud, headless or enrichment | URLs of live hosts, then in-scope script URLs from their pages | -json -irr -irh (body and raw_header fields) | HTTP service, headers, body | evidence; captured bytes and control detector | HTTP capture complements DNS; not a takeover verdict | Structured response capture workflow | Wallet CDN integrity and approval patterns. The TLS handshake comes from testssl.sh | wrap; gives service leads and raw responses |
| [subfinder](https://github.com/projectdiscovery/subfinder/tree/v2.6.8) | [MIT](https://github.com/projectdiscovery/subfinder/blob/v2.6.8/LICENSE.md) | projectdiscovery/subfinder:v2.6.8; digest in live.mjs; HOME=/tmp | No. Passive sources need the internet. In the lab it runs and finds nothing | Root domain | -oJ JSONL; flags -silent -duc -nW -timeout 5 -max-time 1 | In-scope host candidates become inputs to dnsx. Not a lead by themselves | evidence; only hosts that dnsx and httpx confirm enter the snapshot | Wordlist brute force finds names subfinder does not know. Both run, and the snapshot records which found each host | None | Cannot see private or unlisted names | wrap; passive discovery for live domains. Hosts out of scope are dropped |
| [CSP Evaluator](https://github.com/google/csp-evaluator) | [Apache-2.0](https://github.com/google/csp-evaluator/blob/master/LICENSE) | csp_evaluator 1.1.5 in local touchstone-domains-tools:wave2; 249.1 MiB | Yes; pure policy evaluation | Enforcing CSP header | JSON from CspEvaluator.evaluate | weak-csp at captured page | evidence; rerun evaluator on pinned header | MDN Observatory also grades CSP; evaluator works on saved headers | Upstream parser/evaluator workflow and installed bypass rules; no rule text pasted | Does not inspect wallet scripts | wrap; use upstream rules, not a home-grown CSP parser |
| [Retire.js](https://github.com/RetireJS/retire.js/tree/5.2.5) | [Apache-2.0](https://github.com/RetireJS/retire.js/blob/5.2.5/LICENSE.md) | retire 5.2.5 in the same image | Yes; --jsrepo points at baked data; no remote refresh | Captured JS bodies | --outputformat json | known-vulnerable-js by response URL | evidence; rerun version detector with pinned advisories | Dependency scanners read manifests; this reads served code | Unchanged 5.2.5 advisory data; SHA-256 b6fe6651ee3597dd09ef4cc65ee69329e2f9fb53cc9f23c710669548a83a2277 | Does not prove a wallet approval is malicious | wrap; covers served JS absent from manifests |
| [dnsReaper](https://github.com/punk-security/dnsReaper) | [AGPL-3.0](https://github.com/punk-security/dnsReaper/blob/main/LICENSE); separate process only | punksecurity/dnsreaper at sha256:6bd99203cf59f7137418f676d1dbf69cdc3193a808b2d91b420f5f9f33255649; 231.3 MiB | Lab DNS only with --resolver; signatures can also need HTTP or WHOIS | One lab domain | --out stdout --out-format json; no output when no match | None in this lab | Not a proof of claimability | Same-org dangling record was missed | None; no AGPL source or signatures copied | No wallet/CSP checks | read only; compared but not selected |
| [Nuclei and takeover templates](https://github.com/projectdiscovery/nuclei-templates/tree/v10.1.0/http/takeovers) | [MIT engine](https://github.com/projectdiscovery/nuclei/blob/v3.4.2/LICENSE.md), [MIT templates](https://github.com/projectdiscovery/nuclei-templates/blob/v10.1.0/LICENSE.md) | projectdiscovery/nuclei:v3.4.2; digest in tools.mjs; 1130.8 MiB | Yes for this local HTTP template; -duc -ni; pinned resolver file | All captured page URLs and one pinned GitHub template (templates/github-takeover.yaml) | -jsonl | A hit on a host is a second engine for the takeover fingerprint lead. The lead then lists engines touchstone and nuclei and ranks first | Provider fingerprint is still only a lead; no resource registration. Our own fingerprint check replays on the snapshot | Hits the planted docs record. No match for the generic NXDOMAIN record | GitHub template copied unchanged; MIT notice in NOTICE | Does not prove wallet risk | wrap; corroborates the provider fingerprint. Does not replace our check, because replay must not need a live scan |
| [MDN HTTP Observatory](https://github.com/mdn/mdn-http-observatory) | [MPL-2.0](https://github.com/mdn/mdn-http-observatory/blob/main/LICENSE) | @mdn/mdn-http-observatory 1.7.2 in local touchstone-observatory:1.7.2; Dockerfile.observatory; 531.3 MiB | Local HTTP after HSTS/TLD/CA data is baked at build time | Lab HTTP service | JSON | Missing CSP and SRI corroborate the snapshot checks | Comparison only; not used by replay | Both tools flag missing CSP; Observatory also flags missing SRI | None; separate process only | Does not distinguish wallet libraries or approval semantics | read only; compared successfully; keep the smaller pure snapshot evaluator |
| [genlayer-frontendsentinel](https://github.com/bars26/genlayer-frontendsentinel) | MIT, upstream README and GitHub metadata | No scanner image documented in README; size not measured | Full checks use GenLayer, Cloudflare DoH and an LLM; direct-mode tests use mocks | Domain and reference description | Contract state and boolean verdict | DNS/content drift | No deterministic saved-response proof provided | Content monitoring, not this local capture pipeline | None | Needs a network and model consensus | read only; not suitable for deterministic offline replay |
| [Cloudflare Page Shield](https://developers.cloudflare.com/client-side-security/), [cside](https://cside.com/), [Hypernative](https://www.hypernative.io/products/hypernative-frontend-monitoring), [Blockaid](https://blockaid.io/), [Front Sentinel](https://frontsentinel.com/) | Hosted products; no open-source scanner license established | No local scanner image selected; size not applicable | No offline scanner established | Live sites | Vendor alerts | Not imported | No local oracle established | Script inventory and drainer monitoring | None | Useful coverage references, not vendorable detectors | read only; no service calls or claims of parity |

## Evaluated, not wrapped (research-named OSS, M2 + M15)

The table above lists what this pack runs plus the monitors it compared and
rejected. The research (M2 domains/DNS, M15 brand/phishing) and the coverage
audit name more OSS tools in this space. Each gets a verdict here so a deliberate
skip and an un-examined blind spot stop looking the same. Verdict ∈ {wrap,
blocked (a named thing that does not exist yet), backlog (net-new work nobody
has decided against), skip (reason), product decision (belongs to a module this
pack does not own)}. The driving facts: this pack proves two things only — DNS
takeover by fingerprint and the wallet drainer by jsdom replay — and every check
must replay offline against the pinned snapshot. Live capture is wired, so a
live-only tool needs a grant, not a new mode.

| Tool | Space | Verdict | Reason |
|------|-------|---------|--------|
| baddns | Subdomain takeover signatures | skip — overlap (assumed, not tested) | Same fingerprint space as the wrapped Nuclei takeover templates and the compared dnsReaper; our own fingerprint check is the replay proof. baddns was not run, so no distinct lab catch is shown. |
| subzy, subjack | Takeover fingerprint scanners | skip — overlap (assumed, not tested) | Identical fingerprint space to Nuclei takeover templates, which already serve as the second corroborating engine. Neither was run; no new detection was shown. |
| testssl.sh 3.2.5 | Full TLS / cipher audit | wrap — TLS handshake evidence | Was `backlog — TLS findings`; wrapped and green in the lab run. Fills the "Missing TLS" crypto gap flagged on the dnsx and httpx rows. License re-checked on 2026-11-12: GPLv2, from the upstream script header and `LICENSE.txt`; runs as a separate process, no code copied. Image `drwetter/testssl.sh:3.2@sha256:64bab3c1…7e29` (77.8 MiB), digest in `tls.mjs`. `captureTls()` runs it through `runTool()` with the pack limits on each https origin the capture found (max 2), passes the captured A record with `--ip`, and writes `--jsonfile-pretty` with `--severity LOW`. `--phone-out` stays off, so no CRL or OCSP fetch is made. Protocol, cipher, forward-secrecy, certificate, header, vulnerability and grade findings are stored in `snapshot.tls`; per-cipher detail is dropped. Each stored finding below OK becomes a `tls-<id>` lead with the tool's grade as severity. All replay from the pin. Proves the measured handshake and the tool's grade; no exploit is attempted and only one handshake is measured. The lab serves TLS with a committed self-signed cert; on 2026-11-12 the tool graded that chain CRITICAL and the handshake T. |
| SSLyze, tlsx | TLS scan / cert capture | skip — overlap (assumed, not tested) | Assumed to overlap testssl.sh for TLS findings; nothing was run. Pick one TLS engine (testssl.sh) rather than ensemble three. tlsx may return later purely as snapshot cert/SAN capture, not as a finding source. |
| DNSViz | DNSSEC chain validation | wrap — DNSSEC chain evidence | Was `backlog — DNSSEC evidence`; wrapped and green in the lab run. Fills the "Missing DNSSEC evidence" gap named on the dnsx row; `checks.mjs` reported it as `dnssec-evidence-missing`. License re-checked on 2026-11-12: GPLv2, upstream `LICENSE`; two separate processes, no code copied. Image `dnsviz/dnsviz@sha256:5a4c5e82…65932` (463.1 MiB), digest in `dnssec.mjs`. `captureDnssec()` runs `probe` through the granted resolver and then `grok` offline, both through `runTool()` with the pack limits. The `grok` assessment is stored in `snapshot.dnssec` as the chain verdict (`SECURE`, `INSECURE`, bogus), signing state, errors and warnings. Leads: `dnssec-broken-chain` (high), `dnssec-unsigned` (low), `dnssec-warning` (low). All replay from the pin; a signed and valid chain raises no lead. The lab now serves a root and `test` zone, so the offline chain is readable; the lab zone is unsigned and the tool reports `INSECURE`. Proves the measured chain state, not that a resolver can be spoofed. No signature is validated by us: DNSViz does that. No algorithm rollover or key-size check is reported. |
| Zonemaster | DNS / DNSSEC conformance suite | skip — overlap (assumed, not tested) + scope | Assumed to overlap DNSViz for the DNSSEC evidence we would prove; no comparison was run. The rest is broad conformance testing outside this pack's two proof models. |
| checkdmarc 6.0.3 | SPF / DMARC record evaluation | wrap — email-auth record evidence | Was `backlog — email-auth findings`; wrapped and green in the lab run. Fills the email-authentication gap in M2. License re-checked on 2026-11-12: Apache-2.0, upstream `LICENSE`; runs as a separate process, no code copied. Image `letiemble/checkdmarc:6.0.3@sha256:be9d7e82…c90cd` (amd64, 66.9 MiB), digest in `email.mjs`. `checkEmail()` calls it through `runTool()` with the pack limits and `-t 5 --retries 1`; the lab resolver or the grant resolver is passed with `-n`. `parseCheckdmarc()` narrows the JSON to the SPF record and its `all` mechanism, the DMARC record, policy, `rua` presence, MX and DNSSEC flag, and stores it in `snapshot.email`. Leads: `email-dmarc-missing` (medium), `email-dmarc-policy-none`, `email-dmarc-no-reporting`, `email-spf-missing`, `email-spf-allows-all` (low). All replay from the pin. Proves the published records; does not prove a spoofed message reaches an inbox, a DKIM selector, or a receiver's filter decision. A null MX is stored but raises no lead. A tool error is a coverage error and raises `email-auth-evidence-missing`. |
| parsedmarc | Parses DMARC aggregate reports | skip — not a scan | Consumes mailbox aggregate reports, not a scan of the target. It is outside the capture-then-replay pipeline entirely. |
| dnstwist, openSquat | Typosquat / lookalike-domain generation | product decision — M15 | Brand/phishing (M15) is a module this pack does not own (audit Gap kind B). Track the typosquat tooling with that module decision, not inside domains. |

## Shared parsers and lab services

- [dns-zonefile 0.3.2](https://github.com/elgs/dns-zonefile) is ISC.
  It runs only in the tool image. It parses the zone instead of reimplementing BIND.
- [parse5 7.2.1](https://github.com/inikulin/parse5) is MIT.
  It reads script elements without running the page.
- CoreDNS 1.12.0 is Apache-2.0. Its digest is in smoke.mjs. Local size: 90.8 MiB.
- The Node base image is pinned by digest. npm packages are locked. npm only runs
  while Docker builds the tool image. No tool package is installed on the host.
- The locked build reports existing npm audit advisories. No dependency is upgraded.
  The image runs without network, as the host uid, with all capabilities dropped.
- The lab TLS cert and key (`lab/tls-cert.pem`, `lab/tls-key.pem`) are our own
  self-signed files, generated 2026-11-12 for ten years. The key is public and
  covers no real host.
- The lab root and `test` zones (`lab/root.db`, `lab/test.db`) are ours. They
  let DNSViz walk a chain with no internet. Both are unsigned.

## Comparison on the same lab

Run `node spike/packs/domains/smoke.mjs --lab`. It starts CoreDNS and a small
web server on an internal network: plain HTTP on 8080 and the same host over TLS
on 8443 with a committed self-signed cert. CoreDNS also serves a root zone and a
`test` zone, so an offline DNSSEC chain can be walked. It creates no published
ports. It removes its own services and network when it ends.

The lab plants four things a clean scan misses.

- `www` serves a page that builds a wallet approval at run time. No text in the
  bundle shows it. Only running the page in a fake wallet shows it.
- `docs` is a CNAME to a GitHub Pages name and serves the unclaimed-site page.
- `old` is a CNAME to a name that returns NXDOMAIN.
- `staging` is in the zone but in no host list. Only the wordlist finds it.

What each tool did on this lab.

- dnsx returned nine host rows. It saw `old` point to `removed` and the target's
  NXDOMAIN. The wordlist pass found `staging`.
- httpx returned five live HTTP services. The dangling host had no response.
- Nuclei with the GitHub template matched `docs.touchstone.test`. That is the
  provider fingerprint seen by a second engine.
- dnsReaper ran 61 signatures and reported zero takeovers. Its generic dangling
  signature excludes same-organization CNAME targets. This is not a clean bill of health.
- subfinder ran and found nothing. The lab has no public sources.
- CSP Evaluator found missing `script-src` and `object-src`.
- Retire.js found no known-vulnerable version in the inert JS fixtures.
- MDN Observatory graded the local page F. It independently reported missing
  CSP and missing SRI. It needs Node 24 and build-time HSTS/TLD/CA bootstrap.
  CSP Evaluator needs no live HTTP fetch or bootstrap data during replay.
- The jsdom replay (our own check, MIT) clicked the connect control in a fake
  wallet and saw an unlimited ERC-20 approve to an unknown spender.
- checkdmarc ran on the lab resolver. The lab zone has no SPF or DMARC record,
  so it returned `email-spf-missing` and `email-dmarc-missing`. It needs no HTTP.
- testssl.sh measured the lab handshake. It graded the self-signed chain
  CRITICAL, the certificate lifetime HIGH and the handshake T. The grade is the
  tool's opinion of the lab cert, not a defect in the pack.
- DNSViz walked the lab chain through the lab resolver and reported `INSECURE`:
  the zone publishes no DNSKEY and `test` has no DS. That is the unsigned path,
  not a broken one.

The smoke also runs the live path on the lab. A scope with `domain` and `reach`
and no snapshot makes the prepass capture the domain with the real tools and
pin the result. It checks that the live capture finds `staging`, the takeover,
the dangling CNAME and the drainer, and that the drainer replays green.

Keep dnsx, httpx and subfinder for capture. Add Nuclei as the second engine for
the takeover lead. Add CSP Evaluator and Retire.js on captured bytes. Do not
ensemble two zero-result takeover tools into a claimed takeover.

## Proof and limits

The snapshot pins the zone text, DNS replies, HTTP headers and bodies, the SPF
and DMARC records, and optional RDAP and ENS/IPFS evidence. Replay re-runs
allowlisted checks. Changed bytes fail. Unknown checks and wrong locations
fail. A pattern in a bundle is a review-only lead. It cannot pass
submit_finding or final replay.

A drainer finding needs behavior. The replay runs the captured scripts in
jsdom with a fake wallet. It clicks each connect, claim, airdrop, mint or verify
control. It decodes approve, increaseAllowance, setApprovalForAll and Permit
requests. Harm means an unlimited amount or all tokens. Connect and verify
controls are critical. Mint, claim and airdrop controls are high, because real
pages may ask for an approval. A text pattern alone stays a review-only lead.
Nothing is signed and nothing is sent.

An NXDOMAIN result proves dangling DNS, not that a provider will let someone
claim the target. Missing DNSSEC or RDAP evidence does not prove a disabled
control, and an unsigned zone proves only that resolvers cannot validate it. A
registry lock is not the same as a registrar transfer lock. No DNS change,
resource registration, wallet signature, or transaction is attempted.

Email-authentication leads prove the published record only. A valid SPF or
DMARC record does not prove a spoofed message reaches an inbox, and no DKIM
selector or receiver filter is tested.

A TLS lead is the tool's grade of one measured handshake. No exploit is run.
The grade is a judgement, not proof that a weakness is exploitable. CRL and
OCSP are not fetched, so revocation shows as unscanned. At most two https
origins are measured per capture.

A DNSSEC lead is the chain state DNSViz measured once. An unsigned zone is not
spoofable by itself: a resolver must be reached or poisoned first. A bogus chain
only hurts clients that validate. Signatures are checked by DNSViz, not by this
pack.
