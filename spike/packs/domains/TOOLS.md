# Domains tool selection

Checked on 2026-11-10. Start points: M1 and M2 in the capability research,
crypto coverage rows 3.1 and 3.2, and gap 4 provider rules. The research lives
in the main checkout. It is not part of the Wave 1 baseline.

Sizes below are local, uncompressed Docker image sizes. Scanner calls use
`runTool()` in `lib/wrap.mjs`. Static checks use `--network none`.

Capture has two modes. The lab mode uses an owned Docker `--internal` network.
The live mode (`live.mjs`) takes its network from `reach`, which the platform
fills. Live capture refuses a domain unless `reach.granted` is true and
`reach.scope` covers it. No ungranted target is accepted.

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [dnsx](https://github.com/projectdiscovery/dnsx/tree/v1.2.2) | [MIT](https://github.com/projectdiscovery/dnsx/blob/v1.2.2/LICENSE.md) | projectdiscovery/dnsx:v1.2.2; digest in tools.mjs; 82.8 MiB | Lab: local resolver only. Live: the resolver the grant allows. -duc; no ASN/CDN enrichment | Wordlist and subfinder hosts, then CNAME targets | -json JSONL | Resolution and CNAME records become snapshot evidence; NXDOMAIN rows are dropped except for CNAME targets | evidence; CNAME plus target A and AAAA NXDOMAIN | dnsReaper and Nuclei: compare below | JSONL capture workflow; no code copied | Missing DNSSEC and registry-lock evidence | wrap; small resolver with explicit local DNS |
| [httpx](https://github.com/projectdiscovery/httpx/tree/v1.7.1) | [MIT](https://github.com/projectdiscovery/httpx/blob/v1.7.1/LICENSE.md) | projectdiscovery/httpx:v1.7.1; digest in tools.mjs; 917.4 MiB | Lab: local DNS and HTTP only. Live: scope hosts only. -duc; no redirects, cloud, headless or enrichment | URLs of live hosts, then in-scope script URLs from their pages | -json -irr -irh (body and raw_header fields) | HTTP service, headers, body | evidence; captured bytes and control detector | HTTP capture complements DNS; not a takeover verdict | Structured response capture workflow | Wallet CDN integrity and approval patterns | wrap; gives service leads and raw responses |
| [subfinder](https://github.com/projectdiscovery/subfinder/tree/v2.6.8) | [MIT](https://github.com/projectdiscovery/subfinder/blob/v2.6.8/LICENSE.md) | projectdiscovery/subfinder:v2.6.8; digest in live.mjs; HOME=/tmp | No. Passive sources need the internet. In the lab it runs and finds nothing | Root domain | -oJ JSONL; flags -silent -duc -nW -timeout 5 -max-time 1 | In-scope host candidates become inputs to dnsx. Not a lead by themselves | evidence; only hosts that dnsx and httpx confirm enter the snapshot | Wordlist brute force finds names subfinder does not know. Both run, and the snapshot records which found each host | None | Cannot see private or unlisted names | wrap; passive discovery for live domains. Hosts out of scope are dropped |
| [CSP Evaluator](https://github.com/google/csp-evaluator) | [Apache-2.0](https://github.com/google/csp-evaluator/blob/master/LICENSE) | csp_evaluator 1.1.5 in local touchstone-domains-tools:wave2; 249.1 MiB | Yes; pure policy evaluation | Enforcing CSP header | JSON from CspEvaluator.evaluate | weak-csp at captured page | evidence; rerun evaluator on pinned header | MDN Observatory also grades CSP; evaluator works on saved headers | Upstream parser/evaluator workflow and installed bypass rules; no rule text pasted | Does not inspect wallet scripts | wrap; use upstream rules, not a home-grown CSP parser |
| [Retire.js](https://github.com/RetireJS/retire.js/tree/5.2.5) | [Apache-2.0](https://github.com/RetireJS/retire.js/blob/5.2.5/LICENSE.md) | retire 5.2.5 in the same image | Yes; --jsrepo points at baked data; no remote refresh | Captured JS bodies | --outputformat json | known-vulnerable-js by response URL | evidence; rerun version detector with pinned advisories | Dependency scanners read manifests; this reads served code | Unchanged 5.2.5 advisory data; SHA-256 b6fe6651ee3597dd09ef4cc65ee69329e2f9fb53cc9f23c710669548a83a2277 | Does not prove a wallet approval is malicious | wrap; covers served JS absent from manifests |
| [dnsReaper](https://github.com/punk-security/dnsReaper) | [AGPL-3.0](https://github.com/punk-security/dnsReaper/blob/main/LICENSE); separate process only | punksecurity/dnsreaper at sha256:6bd99203cf59f7137418f676d1dbf69cdc3193a808b2d91b420f5f9f33255649; 231.3 MiB | Lab DNS only with --resolver; signatures can also need HTTP or WHOIS | One lab domain | --out stdout --out-format json; no output when no match | None in this lab | Not a proof of claimability | Same-org dangling record was missed | None; no AGPL source or signatures copied | No wallet/CSP checks | read only; compared but not selected |
| [Nuclei and takeover templates](https://github.com/projectdiscovery/nuclei-templates/tree/v10.1.0/http/takeovers) | [MIT engine](https://github.com/projectdiscovery/nuclei/blob/v3.4.2/LICENSE.md), [MIT templates](https://github.com/projectdiscovery/nuclei-templates/blob/v10.1.0/LICENSE.md) | projectdiscovery/nuclei:v3.4.2; digest in tools.mjs; 1130.8 MiB | Yes for this local HTTP template; -duc -ni; pinned resolver file | All captured page URLs and one pinned GitHub template (templates/github-takeover.yaml) | -jsonl | A hit on a host is a second engine for the takeover fingerprint lead. The lead then lists engines touchstone and nuclei and ranks first | Provider fingerprint is still only a lead; no resource registration. Our own fingerprint check replays on the snapshot | Hits the planted docs record. No match for the generic NXDOMAIN record | GitHub template copied unchanged; MIT notice in NOTICE | Does not prove wallet risk | wrap; corroborates the provider fingerprint. Does not replace our check, because replay must not need a live scan |
| [MDN HTTP Observatory](https://github.com/mdn/mdn-http-observatory) | [MPL-2.0](https://github.com/mdn/mdn-http-observatory/blob/main/LICENSE) | @mdn/mdn-http-observatory 1.7.2 in local touchstone-observatory:1.7.2; Dockerfile.observatory; 531.3 MiB | Local HTTP after HSTS/TLD/CA data is baked at build time | Lab HTTP service | JSON | Missing CSP and SRI corroborate the snapshot checks | Comparison only; not used by replay | Both tools flag missing CSP; Observatory also flags missing SRI | None; separate process only | Does not distinguish wallet libraries or approval semantics | read only; compared successfully; keep the smaller pure snapshot evaluator |
| [genlayer-frontendsentinel](https://github.com/bars26/genlayer-frontendsentinel) | MIT, upstream README and GitHub metadata | No scanner image documented in README; size not measured | Full checks use GenLayer, Cloudflare DoH and an LLM; direct-mode tests use mocks | Domain and reference description | Contract state and boolean verdict | DNS/content drift | No deterministic saved-response proof provided | Content monitoring, not this local capture pipeline | None | Needs a network and model consensus | read only; not suitable for deterministic offline replay |
| [Cloudflare Page Shield](https://developers.cloudflare.com/client-side-security/), [cside](https://cside.com/), [Hypernative](https://www.hypernative.io/products/hypernative-frontend-monitoring), [Blockaid](https://blockaid.io/), [Front Sentinel](https://frontsentinel.com/) | Hosted products; no open-source scanner license established | No local scanner image selected; size not applicable | No offline scanner established | Live sites | Vendor alerts | Not imported | No local oracle established | Script inventory and drainer monitoring | None | Useful coverage references, not vendorable detectors | read only; no service calls or claims of parity |

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

## Comparison on the same lab

Run `node spike/packs/domains/smoke.mjs --lab`. It starts CoreDNS and a small
web server on an internal network. It creates no published ports. It removes its
own services and network when it ends.

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

The smoke also runs the live path on the lab. A scope with `domain` and `reach`
and no snapshot makes the prepass capture the domain with the real tools and
pin the result. It checks that the live capture finds `staging`, the takeover,
the dangling CNAME and the drainer, and that the drainer replays green.

Keep dnsx, httpx and subfinder for capture. Add Nuclei as the second engine for
the takeover lead. Add CSP Evaluator and Retire.js on captured bytes. Do not
ensemble two zero-result takeover tools into a claimed takeover.

## Proof and limits

The snapshot pins the zone text, DNS replies, HTTP headers and bodies, and
optional RDAP and ENS/IPFS evidence. Replay re-runs allowlisted checks. Changed
bytes fail. Unknown checks and wrong locations fail. A pattern in a bundle is a
review-only lead. It cannot pass submit_finding or final replay.

A drainer finding needs behavior. The replay runs the captured scripts in
jsdom with a fake wallet. It clicks each connect, claim, airdrop, mint or verify
control. It decodes approve, increaseAllowance, setApprovalForAll and Permit
requests. Harm means an unlimited amount or all tokens. Connect and verify
controls are critical. Mint, claim and airdrop controls are high, because real
pages may ask for an approval. A text pattern alone
stays a review-only lead. Nothing is signed and nothing is sent.

An NXDOMAIN result proves dangling DNS, not that a provider will let someone
claim the target. Missing DNSSEC or RDAP evidence does not prove a disabled
control. A registry lock is not the same as a registrar transfer lock. No DNS
change, resource registration, wallet signature, or transaction is attempted.
