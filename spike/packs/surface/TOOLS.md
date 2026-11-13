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
| [jsluice](https://github.com/BishopFox/jsluice/tree/0ddfab153e060a9eeaded4d8669233f7c071e7e4) | [MIT](https://github.com/BishopFox/jsluice/blob/0ddfab153e060a9eeaded4d8669233f7c071e7e4/LICENSE) | touchstone-jsluice:0ddfab1, built from [jsluice/Dockerfile](jsluice/Dockerfile); 117.8 MiB. No official image exists | Yes; --network none, also in a live run. File paths only | JavaScript bodies katana and httpx fetched | urls and secrets JSONL | Endpoint named in a script, with method and use. Secret pattern match, with no value kept | evidence; the row is in the pinned snapshot | Parses the code (tree-sitter), not a regex. Finds one-segment routes and paths built at run time that katana misses | SPA routes and API paths katana cannot see | Needs web to test the endpoint. A secret match needs a human to check it | wrap; live surface only, after katana |

## Handoff

Each entry has type, where, kind, foundBy, source engine, scope and nextPack.
The kind comes from the records or the response: apex, provider-cname, cname,
address, wallet-frontend, api-endpoint, provider-error-page, web-page or
srv-service. A katana or jsluice endpoint entry has kind route, script or
api-endpoint. A jsluice secret entry has kind secret-pattern.
A provider-cname, a provider error page and a wallet frontend go to Domains.
Other services, all endpoints and all secret patterns go to Web. The prepass lists every tool that
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
A live crawl runs on the run's confined network. Its only way out is the run's
scope proxy, and katana sends every request through it (`-proxy`). katana looks
each name up again by itself; the proxy checks the address and connects to that
same address, so a name that changes its address after the capture's check is
still stopped. A live run with no scope proxy does not crawl: katana's coverage
row is unavailable with the reason. The image has Chromium. Chromium makes its own
background calls to hosts outside the grant, so headless is not offline-safe.
Headless was not tested.

Limits match httpx: 5 requests a second, 2 at a time, 10 s timeout, 1 retry.
Depth 3. Crawl stops after 120 s. The container stops after 180 s. Bodies over
2 MiB are not read. Images, fonts, styles and video are not fetched.

Scope: in a live crawl the `-cs` regex allows only the exact hosts the capture
checked, and the granted scheme and port pairs. A subdomain is in scope only
through a `*.` grant entry, and only when the capture checked it. katana follows
no redirect (`-dr`); a redirect to a checked host and port becomes a new seed.
katana's default host scope also applies. The parser drops any row whose host or
port is outside the grant.
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
test/surface-live-wiring.test.mjs runs a live surface prepass with recorded
tool output and checks the leads, the coverage, the run view, the replay and
the error cases. No test sends a request off the machine.

## jsluice (live surface runs)

jsluice runs only in a live surface run, after katana. It reads the JavaScript
bodies katana fetched and the scripts httpx fetched. It makes no request. It
runs with `--network none`, even on a granted run. Lab runs use the pinned
snapshot, so jsluice does not run and the lab inventory does not change.

Two runs: `jsluice urls` (coverage engine `jsluice`) and `jsluice secrets`
(engine `jsluice-secrets`). Concurrency 2. Each run stops after 120 s.

Input: only answers with HTTP 200 that are JavaScript (by content type or a
`.js`/`.mjs` path), on a granted host and port. One body per URL. At most 50
scripts and 2 MiB per script. The bodies are written as files, and jsluice gets
only the file paths. jsluice fetches any argument that starts with http(s)://,
so it never gets a URL.

Image: there is no official image. [jsluice/Dockerfile](jsluice/Dockerfile)
builds commit 0ddfab1 (2024-01-10, the latest). Both base images are pinned by
digest. The Go checksum database checks the module source. The build checks the
binary's sha256. A rebuild with no cache gave the same binary hash. The image ID
is not reproducible across builds, so the pin is the commit and the binary hash,
not a registry digest. The capture builds the image once if it is missing. The
build needs the network to fetch Go modules. If it fails, both engines show as
unavailable with "Could not build the image ...".

URLs: a relative URL is read against the script that names it. Rows on a host
or port outside the grant are dropped. Query strings and fragments are removed.
`EXPR` marks a part the script builds at run time, for example
`/api/v1/users/EXPR/wallets`. It stays in the URL. When katana found the same
URL, the lead names both tools. It does not make a second lead.

Secrets: the lead keeps the jsluice kind (for example AWSAccessKey), the jsluice
severity, the script URL, the field names with their lengths, and a 12-character
sha256 fingerprint. It keeps no value. jsluice's `context` field holds raw
values and is not read. The lead severity stays informational, like every
Surface lead.

What a jsluice entry proves: a script on a granted host named this URL, or held
a string shaped like this secret kind, at capture time.

What it does not prove: that the endpoint exists or answers (jsluice sent no
request), or that the secret is real, live or usable. A secret lead needs a
human to check it. It is a lead for Web.

Known limits, seen on the local SPA lab:
- String parts of a built URL also show up on their own, for example
  `/api/v1/users/` and `/wallets` next to `/api/v1/users/EXPR/wallets`.
- Only scripts katana or httpx fetched are read. Scripts loaded only at run time
  by the browser are not.
- httpx already stores the bodies of the scripts it fetched in `snapshot.http`.
  So a secret in such a script is in the pinned snapshot as raw text. That is
  how the shared capture works today. jsluice adds no value to the snapshot.
- A short or guessable secret value could be found again from its fingerprint.

A missing image, a non-zero exit, a timeout, or any `error:` line on stderr puts
the engine in coverage as unavailable with its cause. jsluice exits 0 when it
cannot read a file, so stderr is checked. It is never a clean empty read. The
rest of the inventory still stands.

Tests: test/surface-jsluice.test.mjs runs the real image offline on the lab
JavaScript from the katana fixture. It parses the recorded output in
test/fixtures/jsluice-urls.jsonl and jsluice-secrets.jsonl. The lab key is the
AWS documentation example key, not a real key. test/surface-live-wiring.test.mjs
checks the leads, the merge with katana, that no secret value reaches the result
or the pinned discovery, the coverage, the run view, the replay and the error
cases.

## Evaluated, not wrapped (research-named OSS, M1)

The capture set is subfinder + dnsx + httpx + dns-zonefile, plus katana and
jsluice in live surface runs. The M1
asset-inventory research and the coverage audit name more OSS discovery tools.
Each gets a verdict so a deliberate skip and an un-examined gap differ. The
driving facts: this is a leads-only pack (no proof, no active testing), the lab
origins are fixed, and any active scan or new ownership needs a separate grant.

| Tool | Space | Verdict | Reason |
|------|-------|---------|--------|
| naabu | Port scanner | skip — out of scope by design | This pack deliberately runs no port scan (stated above); the lab advertises services through SRV records, and active port scanning needs a separate scope grant. An SRV name is a DNS name, not a running host. |
| katana | Active crawler | wrapped — see the main table and "katana crawl" above | Live surface runs only, behind the grant. Standard mode with -jc, not headless. It adds nothing offline because the lab snapshot is pinned. |
| jsluice | Endpoint/secret extraction from JS | wrapped — see the main table and "jsluice" above | Live surface runs only, offline on the JavaScript katana and httpx fetched. Secret values are not kept. |
| LinkFinder | Endpoint extraction from JS | skip — overlap with jsluice (assumed, not run) | A regex over JavaScript, like katana's -jc. jsluice parses the code and also finds paths built at run time. Neither runs on the lab (it is a snapshot; jsluice is live only), so no side-by-side exists. LinkFinder was not run. |
| Amass | Passive + active recon framework | skip — assumed, not run | The passive half is assumed to overlap wrapped subfinder; the lab has no public sources (subfinder finds nothing there), so the lab cannot check it. The active half needs network and a grant. subfinder (passive) + dnsx (brute) cover this space with tighter offline and grant control. Amass was not run. |
| BBOT, reconFTW | Recursive recon orchestration frameworks | skip — orchestration overlap | Both bundle and drive the same underlying tools surface already runs individually (subfinder, httpx, dnsx). Running the orchestrator duplicates them and gives up the per-tool offline and grant enforcement this pack depends on. |
