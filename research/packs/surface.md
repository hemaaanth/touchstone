# Surface (M1): OSS survey

## Scope today

Read from [`spike/packs/surface/pack.mjs`](../../spike/packs/surface/pack.mjs),
`SKILL.md` and `TOOLS.md`.

- Tier P. Proof kind `evidence`. Surface has no `submit_finding` tool. Its
  prove hook returns no vulnerabilities.
- It reads a pinned local zone. It hands on a typed inventory of hosts, HTTP
  origins and SRV services. Each entry names a `nextPack` (Domains or Web).
- Wrapped today: dnsx, httpx and dns-zonefile. subfinder was evaluated and
  skipped, because the lab is offline and passive sources need the network.

## Leading OSS tools

Licenses were read from each repository's LICENSE file on 2026-11-10. See the
[method](README.md#method).

| Tool | What it does | License | Use mode | Coverage | Crypto gap |
|---|---|---|---|---|---|
| [Nuclei](https://github.com/projectdiscovery/nuclei) | Template engine. It sends requests and matches responses from YAML templates. | [MIT](https://github.com/projectdiscovery/nuclei/blob/HEAD/LICENSE.md) | lift | HTTP, DNS, TCP, TLS, file and code checks. [Template docs](https://docs.projectdiscovery.io/templates/introduction). | The engine has no chain knowledge. Chain coverage depends on templates (see below). |
| [nuclei-templates](https://github.com/projectdiscovery/nuclei-templates) | Community template library. | [MIT](https://github.com/projectdiscovery/nuclei-templates/blob/HEAD/LICENSE.md) | lift | Thousands of CVE, exposure and misconfiguration checks. A few EVM node checks (see below). | No consensus, validator, keymanager, signer or non-EVM node checks. |
| [naabu](https://github.com/projectdiscovery/naabu) | Fast port scanner (SYN or CONNECT). | [MIT](https://github.com/projectdiscovery/naabu/blob/HEAD/LICENSE.md) | lift | Finds open ports beyond what DNS advertises. | No port list for chain services. We must supply 8545/8546, 8551, 5052, 9000, 30303, 26656/26657, 8899/8900, 3030 and similar. |
| [dnsx](https://github.com/projectdiscovery/dnsx) | DNS resolver and probe. Wrapped today. | [MIT](https://github.com/projectdiscovery/dnsx/blob/HEAD/LICENSE.md) | lift | A, AAAA, CNAME, MX, TXT, SRV and wildcard filtering. | None specific. |
| [httpx](https://github.com/projectdiscovery/httpx) | HTTP prober. Wrapped today. | [MIT](https://github.com/projectdiscovery/httpx/blob/HEAD/LICENSE.md) | lift | Status, title, tech, TLS and CDN per origin. | Does not send JSON-RPC, so a node RPC looks like a blank 405 or 200. |
| [subfinder](https://github.com/projectdiscovery/subfinder) | Passive subdomain discovery from many sources. | [MIT](https://github.com/projectdiscovery/subfinder/blob/HEAD/LICENSE.md) | lift | CT logs, search engines and paid APIs. Skipped today because the lab is offline. | None specific. |
| [tlsx](https://github.com/projectdiscovery/tlsx) | TLS probe. Reads certificates, SANs and JARM. | [MIT](https://github.com/projectdiscovery/tlsx/blob/HEAD/LICENSE) | lift | Finds more host names from SANs. | None specific. |
| [katana](https://github.com/projectdiscovery/katana) | Web crawler with JS parsing. | [MIT](https://github.com/projectdiscovery/katana/blob/HEAD/LICENSE.md) | lift | Finds API paths and JS bundles to hand to Web and Domains. | Does not pull RPC URLs or keys out of a dapp bundle as typed leads. |
| [asnmap](https://github.com/projectdiscovery/asnmap), [cdncheck](https://github.com/projectdiscovery/cdncheck), [uncover](https://github.com/projectdiscovery/uncover), [chaos-client](https://github.com/projectdiscovery/chaos-client) | ASN to ranges; CDN and cloud detection; search-engine queries (Shodan, Censys and others); the Chaos subdomain dataset. | MIT ([asnmap](https://github.com/projectdiscovery/asnmap/blob/HEAD/LICENSE), [cdncheck](https://github.com/projectdiscovery/cdncheck/blob/HEAD/LICENSE.md), [uncover](https://github.com/projectdiscovery/uncover/blob/HEAD/LICENSE.md), [chaos-client](https://github.com/projectdiscovery/chaos-client/blob/HEAD/LICENSE.md)) | lift | Org-wide scope and online seed data. uncover and chaos need API keys. | None specific. |
| [OWASP Amass](https://github.com/owasp-amass/amass) | Attack-surface mapping with a graph database. | [Apache-2.0](https://github.com/owasp-amass/amass/blob/HEAD/LICENSE) | lift | Deep passive and active enumeration, ASN and WHOIS links. | None specific. Heavy to run offline. |
| [gau](https://github.com/lc/gau) | Fetches known URLs from Wayback, Common Crawl, OTX and URLScan. | [MIT](https://github.com/lc/gau/blob/HEAD/LICENSE) | lift | Old endpoints and old front-end builds. | None specific. |
| [BBOT](https://github.com/blacklanternsecurity/bbot) | Recursive OSINT and recon framework with many modules. | [AGPL-3.0](https://github.com/blacklanternsecurity/bbot/blob/HEAD/LICENSE) | shell out | The widest single recon run in OSS. | No chain modules. |
| [reNgine](https://github.com/yogeshojha/rengine) | Recon web app that chains other tools. | [GPL-3.0](https://github.com/yogeshojha/rengine/blob/HEAD/LICENSE) | skip | Orchestrator with a UI. We already orchestrate. | None specific. |
| [SpiderFoot](https://github.com/smicallef/spiderfoot) | OSINT automation with about 200 modules. | [MIT](https://github.com/smicallef/spiderfoot/blob/HEAD/LICENSE) | lift | Has some crypto-address and blockchain lookup modules. | Lookups are about addresses, not about a team's node services. |
| [Nmap](https://github.com/nmap/nmap) | Port scanner with service and version detection and NSE scripts. | [NPSL 0.95](https://github.com/nmap/nmap/blob/HEAD/LICENSE) | read only (shell out only after counsel review) | Best service fingerprints. | Few chain probes. See the [NPSL note](README.md#license-use-modes). |
| [masscan](https://github.com/robertdavidgraham/masscan) | Internet-scale port scanner. | [AGPL-3.0](https://github.com/robertdavidgraham/masscan/blob/HEAD/LICENSE) | skip | Speed we do not need for one team's scope. naabu covers it. | None specific. |
| [certstream-server-go](https://github.com/d-Rickyy-b/certstream-server-go) | Streams new CT log entries over WebSocket. | [MIT](https://github.com/d-Rickyy-b/certstream-server-go/blob/HEAD/LICENSE) | lift | New host names the moment a certificate is issued. The original [certstream-server](https://github.com/CaliDog/certstream-server) is also [MIT](https://github.com/CaliDog/certstream-server/blob/HEAD/LICENSE). | None specific. Shared with people-brand. |
| [ethereum/node-crawler](https://github.com/ethereum/node-crawler) | Crawls the Ethereum devp2p network and records client versions. | [MIT](https://github.com/ethereum/node-crawler/blob/HEAD/LICENSE) | lift | Execution-layer peers seen on the public network. | Maps the network, not one team. Needs a join from IP to the team's ranges. |
| [Armiarma](https://github.com/migalabs/armiarma) | Crawler for the Ethereum consensus libp2p network. | [MIT](https://github.com/migalabs/armiarma/blob/HEAD/LICENSE) | lift | Consensus-layer peers and client versions. | Same as above. |

### What nuclei-templates covers for chains

We grepped `http/technologies`, `http/misconfiguration`, `http/exposures`,
`http/miscellaneous`, `file/malware` and `network` at commit
[`ed7f0bf`](https://github.com/projectdiscovery/nuclei-templates/tree/ed7f0bf171ab0eb57f136c43064deb9872e107dc).

Present:

- Client detection through `web3_clientVersion`: `geth-server-detect.yaml`,
  `besu-server-detect.yaml`, `erigon-server-detect.yaml`,
  `nethermind-server-detect.yaml` and `openethereum-server-detect.yaml` in
  `http/technologies/`.
- `http/misconfiguration/blockchain-rpc-txpool-exposed.yaml` (`txpool_content`, high).
- `http/misconfiguration/blockchain-rpc-debug-exposure.yaml` (`debug_traceTransaction`, medium).
- `http/miscellaneous/crypto-address-detect.yaml` (info).
- Token checks for Alchemy, Etherscan, Blockchain.com, Tatum and NOWNodes keys.

Absent:

- No `personal_` or `admin_` namespace check on an EVM RPC.
- No Ethereum beacon API (`/eth/v1/node/...`) or Engine API check.
- No [keymanager API](https://ethereum.github.io/keymanager-APIs/) check.
- No web3signer or mev-boost check.
- No Tendermint/CometBFT RPC (26657), Solana RPC (`getHealth`), NEAR RPC or
  bitcoind RPC (`getblockchaininfo`) check.

## Recommendation

1. **Wrap Nuclei and ship our own chain templates.** The engine and the
   community templates are MIT, so we can reuse the five EVM detect templates
   and the two RPC misconfiguration templates. We add our own templates for the
   absent list above. Each template becomes an `evidence` detector: the request,
   the response hash and the matcher replay offline against the lab.
2. **Wrap naabu** with a chain port list. Today the inventory only sees what DNS
   advertises. Node ports are rarely in DNS.
3. Cheap next steps: tlsx for SAN host names, and katana to pull RPC URLs out of
   dapp bundles for the Domains pack. BBOT is the best wide recon run, but it is
   AGPL, so it only runs as a separate program.

## Biggest crypto gap

**No OSS template finds validator, keymanager or non-EVM node services.** The
community set stops at EVM client detection and two RPC namespaces. A team's
worst exposures are elsewhere. An open keymanager API can import or delete
validator keys. An open web3signer can sign. An open beacon or Engine API leaks
peers and can be abused. Solana, Cosmos, NEAR and Bitcoin RPCs are not checked at
all. A second gap follows: no tool maps a found host to its on-chain role, such
as "this IP runs the validator for pubkey X". The specs are public:
[beacon API](https://ethereum.github.io/beacon-APIs/),
[keymanager API](https://ethereum.github.io/keymanager-APIs/),
[web3signer docs](https://docs.web3signer.consensys.io/), and
[geth's security notes](https://geth.ethereum.org/docs/fundamentals/security),
which tell users not to expose the HTTP RPC.

## Feeds

| Feed | What it gives | URL | Terms or note |
|---|---|---|---|
| crt.sh | CT search by domain, JSON output | <https://crt.sh/?q=example.com&output=json> | Public. Rate limited. |
| Certstream | Live CT stream | <https://certstream.calidog.io/> | Public. Self-host with certstream-server-go. |
| Chaos dataset | Public subdomain data for bug bounty programs | <https://chaos.projectdiscovery.io/> | Needs a free API key. |
| Shodan | Internet scan data, including node ports | <https://www.shodan.io/> | Hosted. Needs a key. Terms limit reuse. |
| Censys | Internet scan data | <https://search.censys.io/> | Hosted. It returned 403 to our scripted check. |
| ethernodes.org | Public Ethereum node and client counts | <https://ethernodes.org/> | Hosted. It returned 403 to our scripted check. Self-run node-crawler instead. |
| NVD and CISA KEV | CVEs for found services | See the [shared feeds](README.md#feeds-shared-by-several-packs). | KEV has no chain client entries. |
| Client advisories | CVEs and fixes for found node versions | [go-ethereum](https://github.com/ethereum/go-ethereum/security/advisories), [Prysm](https://github.com/OffchainLabs/prysm/security/advisories), [Lighthouse](https://github.com/sigp/lighthouse/security/advisories), [web3signer](https://github.com/Consensys/web3signer/security/advisories) | GitHub advisories. Join them to the client version from `web3_clientVersion` or the beacon `node/version` endpoint. |
