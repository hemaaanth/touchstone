# Surface tool selection

This pack uses the same offline lab and capture pipeline as Domains.
See [the full comparison](../domains/TOOLS.md). Image digests are in
[tools.mjs](../domains/tools.mjs). Measured sizes are uncompressed.

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [subfinder](https://github.com/projectdiscovery/subfinder/tree/v2.6.8) | [MIT](https://github.com/projectdiscovery/subfinder/blob/v2.6.8/LICENSE.md) | projectdiscovery/subfinder:v2.6.8 plus digest in ../domains/live.mjs | No. Passive sources need the internet. In the lab it runs and finds nothing | Root domain | -oJ JSONL | Passive host candidate, kept only if in scope and confirmed by dnsx | evidence; the host must resolve in the pinned capture | dnsx brute force finds names subfinder does not know. Both run and the inventory shows which found each host | None | No wallet/RPC service evidence | wrap; live domains only, behind the grant |
| [dnsx](https://github.com/projectdiscovery/dnsx/tree/v1.2.2) | MIT | projectdiscovery/dnsx:v1.2.2 plus digest; 82.8 MiB | Lab: local DNS only. Live: the grant's resolver. -duc | Wordlist and subfinder hosts | -json JSONL | Host and CNAME with source | evidence; replay zone and captured records | dnsReaper/Nuclei comparison found no extra lab assets | JSONL capture workflow | Needs typed crypto leads on top | wrap; bounded resolver over the lab zone |
| [httpx](https://github.com/projectdiscovery/httpx/tree/v1.7.1) | MIT | projectdiscovery/httpx:v1.7.1 plus digest; 917.4 MiB | Local DNS and HTTP; -duc; no redirects or cloud | Fixed lab origins | -json -irr -irh | HTTP service with captured status | evidence; service exists in pinned capture | Complements DNS; no claim of a full port scan | Structured response capture workflow | RPC ownership and signing risk need another pack | wrap; four services observed |
| [dns-zonefile](https://github.com/elgs/dns-zonefile) | ISC | 0.3.2 in touchstone-domains-tools:wave2 | Yes; --network none | Pinned BIND zone | JSON | Host and advertised SRV service | evidence; parse zone again | Unlike passive APIs, it sees this private zone | Installed parser only | Preserve RPC service hints | wrap; do not write a second zone parser |

## Handoff

Each entry has type, where, kind, foundBy, source engine, scope and nextPack.
The kind comes from the records or the response: apex, provider-cname, cname,
address, wallet-frontend, api-endpoint, provider-error-page, web-page or
srv-service. A provider-cname, a provider error page and a wallet frontend go to
Domains. Other services go to Web. The prepass lists every tool that ran.

The lab inventory has sixteen entries: nine hosts (six addresses, one apex, one
provider CNAME, one plain CNAME), six observed HTTP origins, and one advertised
TCP service. The SRV owner name is a DNS name, not proof of a running host.

Surface has no submit_finding tool. Its prove hook returns no vulnerabilities.
The evidence replay API can still confirm a captured inventory entry through
its detector map. New ownership or active testing needs a separate scope grant.
No CT, passive DNS, cloud API, public port scan, or production scan runs here.

## Evaluated, not wrapped (research-named OSS, M1)

The capture set is subfinder + dnsx + httpx + dns-zonefile by design. The M1
asset-inventory research and the coverage audit name more OSS discovery tools.
Each gets a verdict so a deliberate skip and an un-examined gap differ. The
driving facts: this is a leads-only pack (no proof, no active testing), the lab
origins are fixed, and any active scan or new ownership needs a separate grant.

| Tool | Space | Verdict | Reason |
|------|-------|---------|--------|
| naabu | Port scanner | skip — out of scope by design | This pack deliberately runs no port scan (stated above); the lab advertises services through SRV records, and active port scanning needs a separate scope grant. An SRV name is a DNS name, not a running host. |
| katana | Active crawler | backlog — live URL breadth | Live surface capture already points at the real domain (`pack.mjs:5` advertises `live: true`, and the prepass is Domains'). Wiring katana behind the grant takes the image, a `runTool()` call, a URL parser, and tests. It closes URL breadth beyond the wordlist. The lab origins are fixed, so it adds nothing offline. Wired leads still go to httpx and web. |
| jsluice, LinkFinder | Endpoint/secret extraction from JS | backlog — JS-derived endpoint leads | Could enrich the inventory with endpoints taken from served JS. Surface parses script elements with parse5 and nothing else. Decide the extraction adapter in web, which owns script handling. Surface builds its inventory from the shared DNS and HTTP snapshot today. |
| Amass | Passive + active recon framework | skip — overlap (assumed, not tested) | The passive half is assumed to overlap wrapped subfinder; Amass was not run. The active half needs network and a grant. subfinder (passive) + dnsx (brute) already cover this space with tighter offline and grant control. |
| BBOT, reconFTW | Recursive recon orchestration frameworks | skip — orchestration overlap | Both bundle and drive the same underlying tools surface already runs individually (subfinder, httpx, dnsx). Running the orchestrator duplicates them and gives up the per-tool offline and grant enforcement this pack depends on. |
