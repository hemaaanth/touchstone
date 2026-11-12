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
| [katana](https://github.com/projectdiscovery/katana/tree/v1.2.2) | [MIT](https://github.com/projectdiscovery/katana/blob/v1.2.2/LICENSE.md) | projectdiscovery/katana:v1.2.2 plus digest in ../domains/live.mjs; 1167.8 MiB | No. Live surface runs only, behind the grant. Standard mode with -jc, not headless. -duc. In the lab it does not run | Origins httpx confirmed | -jsonl | Route, script or API endpoint named in a crawled page, robots.txt, sitemap.xml or served JavaScript | evidence; the endpoint is in the pinned crawl | httpx probes only origins and script tags. katana follows links and reads paths out of JavaScript | Single-page app routes httpx cannot see | Needs web to test the endpoint | wrap; live surface only, behind the grant |

## Handoff

Each entry has type, where, kind, foundBy, source engine, scope and nextPack.
The kind comes from the records or the response: apex, provider-cname, cname,
address, wallet-frontend, api-endpoint, provider-error-page, web-page or
srv-service. A katana endpoint entry has kind route, script or api-endpoint.
A provider-cname, a provider error page and a wallet frontend go to Domains.
Other services and all endpoints go to Web. The prepass lists every tool that
ran, with its lead count. A tool that failed shows as unavailable with its cause.

The lab inventory has sixteen entries: nine hosts (six addresses, one apex, one
provider CNAME, one plain CNAME), six observed HTTP origins, and one advertised
TCP service. The SRV owner name is a DNS name, not proof of a running host.

Surface has no submit_finding tool. Its prove hook returns no vulnerabilities.
The evidence replay API can still confirm a captured inventory entry through
its detector map. New ownership or active testing needs a separate scope grant.
No CT, passive DNS, cloud API, public port scan, or production scan runs here.

## katana crawl (live surface runs)

katana runs only in a live surface run, after httpx. Its seeds are the origins
httpx confirmed. Domains live runs do not crawl. Lab runs use the pinned
snapshot, so katana does not run and the lab inventory does not change.

Mode: standard crawl with JavaScript parsing (`-jc`). Headless mode is off.
The image has Chromium, but live runs use the `bridge` network. That network
reaches the internet. Chromium makes its own background calls to hosts outside
the grant, so headless is not offline-safe. Headless was not tested.

Limits match httpx: 5 requests a second, 2 at a time, 10 s timeout, 1 retry.
Depth 3. Crawl stops after 120 s. The container stops after 180 s. Bodies over
2 MiB are not read. Images, fonts, styles and video are not fetched.

Scope: the `-cs` regex allows only granted hosts, their subdomains, and the
granted scheme and port pairs. katana's default host scope also applies. The
parser drops any row whose host or port is outside the grant.
Query strings and fragments are removed. At most 100 endpoints enter the
inventory. The coverage line keeps the true count.

What a katana entry proves: the URL was linked or named in a page, robots.txt,
sitemap.xml or JavaScript that the grant covers, at capture time. If the entry
has a status, the endpoint answered with that status at capture time.

What it does not prove: that the endpoint is reachable now, needs no login,
exposes data, or is vulnerable. It is a lead for Web.

Known limits, seen on the local SPA lab ([spa-lab/](spa-lab/)):
- The `-jc` regex misses one-segment routes such as `/dashboard` in a routes object.
- Routes built at run time from variables are not found.
- An SPA fallback route (the server returns index.html) often has no status.
  katana saw the same body before and kept only the headers. The entry says so.
- Links to a host outside the grant are not followed. This holds even when it is
  the same server under another name.

A missing image, a non-zero exit or a timeout puts katana in coverage as
unavailable with its cause. Docker exit 125 reads "Docker could not run the
image ...". It is never a clean empty crawl. The rest of the inventory still
stands.

Tests: test/surface-katana.test.mjs runs the real image against the SPA lab on
127.0.0.1 and parses the recorded output in test/fixtures/katana-spa.jsonl.
test/surface-katana-wiring.test.mjs runs a live surface prepass with recorded
tool output and checks the leads, the coverage, the run view, the replay and
the error cases. No test sends a request off the machine.

## Evaluated, not wrapped (research-named OSS, M1)

The capture set is subfinder + dnsx + httpx + dns-zonefile, plus katana in live
surface runs. The M1
asset-inventory research and the coverage audit name more OSS discovery tools.
Each gets a verdict so a deliberate skip and an un-examined gap differ. The
driving facts: this is a leads-only pack (no proof, no active testing), the lab
origins are fixed, and any active scan or new ownership needs a separate grant.

| Tool | Space | Verdict | Reason |
|------|-------|---------|--------|
| naabu | Port scanner | skip — out of scope by design | This pack deliberately runs no port scan (stated above); the lab advertises services through SRV records, and active port scanning needs a separate scope grant. An SRV name is a DNS name, not a running host. |
| katana | Active crawler | wrapped — see the main table and "katana crawl" above | Live surface runs only, behind the grant. Standard mode with -jc, not headless. It adds nothing offline because the lab snapshot is pinned. |
| jsluice, LinkFinder | Endpoint/secret extraction from JS | backlog — JS-derived endpoint leads | Could enrich the inventory with endpoints taken from served JS. Surface parses script elements with parse5 and nothing else. Decide the extraction adapter in web, which owns script handling. Surface builds its inventory from the shared DNS and HTTP snapshot today. |
| Amass | Passive + active recon framework | skip — overlap (assumed, not tested) | The passive half is assumed to overlap wrapped subfinder; Amass was not run. The active half needs network and a grant. subfinder (passive) + dnsx (brute) already cover this space with tighter offline and grant control. |
| BBOT, reconFTW | Recursive recon orchestration frameworks | skip — orchestration overlap | Both bundle and drive the same underlying tools surface already runs individually (subfinder, httpx, dnsx). Running the orchestrator duplicates them and gives up the per-tool offline and grant enforcement this pack depends on. |
