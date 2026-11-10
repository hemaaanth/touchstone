# Surface tool selection

This pack uses the same offline lab and capture pipeline as Domains.
See [the full comparison](../domains/TOOLS.md). Image digests are in
[tools.mjs](../domains/tools.mjs). Measured sizes are uncompressed.

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [subfinder](https://github.com/projectdiscovery/subfinder/tree/v2.6.8) | [MIT](https://github.com/projectdiscovery/subfinder/blob/v2.6.8/LICENSE.md) | projectdiscovery/subfinder:v2.6.8; registry manifest verified; amd64 digest sha256:22168ca81e051fb928c69a9d4aca48216c760d0ae075cc5dd52364d53a59570a; not pulled; size not measured | No useful offline enumeration; passive sources need internet | Root domain | -oJ JSONL | Passive host candidate | Would need pinned source evidence | dnsx resolves local candidates; subfinder cannot enumerate this private zone | None | No local wallet/RPC service evidence | skip; never call public sources from the lab |
| [dnsx](https://github.com/projectdiscovery/dnsx/tree/v1.2.2) | MIT | projectdiscovery/dnsx:v1.2.2 plus digest; 82.8 MiB | Local DNS only; -duc | Hosts parsed from local zone | -json JSONL | Host and CNAME with source | evidence; replay zone and captured records | dnsReaper/Nuclei comparison found no extra lab assets | JSONL capture workflow | Needs typed crypto leads on top | wrap; bounded resolver over the lab zone |
| [httpx](https://github.com/projectdiscovery/httpx/tree/v1.7.1) | MIT | projectdiscovery/httpx:v1.7.1 plus digest; 917.4 MiB | Local DNS and HTTP; -duc; no redirects or cloud | Fixed lab origins | -json -irr -irh | HTTP service with captured status | evidence; service exists in pinned capture | Complements DNS; no claim of a full port scan | Structured response capture workflow | RPC ownership and signing risk need another pack | wrap; four services observed |
| [dns-zonefile](https://github.com/elgs/dns-zonefile) | ISC | 0.3.2 in touchstone-domains-tools:wave1 | Yes; --network none | Pinned BIND zone | JSON | Host and advertised SRV service | evidence; parse zone again | Unlike passive APIs, it sees this private zone | Installed parser only | Preserve RPC service hints | wrap; do not write a second zone parser |

## Handoff

Each entry has type, where, source engine, scope and nextPack. Hosts go to
Domains. HTTP and SRV services go to Web. The inventory has twelve entries:
seven zone host names, four observed HTTP origins, and one advertised TCP
service. The SRV owner name is a DNS name, not proof of a running host.

Surface has no submit_finding tool. Its prove hook returns no vulnerabilities.
The evidence replay API can still confirm a captured inventory entry through
its detector map. New ownership or active testing needs a separate scope grant.
No CT, passive DNS, cloud API, public port scan, or production scan runs here.
