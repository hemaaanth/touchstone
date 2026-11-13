---
name: surface
description: Discover hosts and services in a pinned local zone and hand them on as leads.
tier: P
proof: evidence
tools: [snapshot_leads]
labs: [spike/packs/surface/lab]
---

# Surface

Call snapshot_leads. Return a typed inventory. Keep the source and nextPack on
each entry. Hosts go to Domains. HTTP and advertised TCP services go to Web.

A zone record is not proof of reachability. An HTTP response proves the service
answered when it was captured. A dangling CNAME is a lead for Domains, not an
exploited takeover. A captured RPC path does not prove an exposed signing API.

Each entry says its kind (apex, provider-cname, cname, address, wallet-frontend,
api-endpoint, provider-error-page, web-page, srv-service, route, script,
secret-pattern), what found it (subfinder, wordlist, dns-zonefile, httpx,
katana, jsluice) and its nextPack.
Report these as given. Do not infer a kind the lead does not state.

In a live run, katana crawls the origins httpx found. Its endpoint entries say
where the URL was named. A crawled endpoint proves the URL was named at capture
time. It does not prove the endpoint is reachable, open or vulnerable. An entry
with no status may exist only in the browser. If katana shows as unavailable,
say the crawl did not run and give its reason. Do not report a clean crawl.

jsluice then reads the JavaScript katana and httpx fetched. It sends no request.
Its endpoint entries say how the script used the URL. EXPR in a URL is a part
the script builds at run time. A jsluice endpoint does not prove the endpoint
exists. A secret-pattern entry names the kind, the script and a fingerprint. It
holds no value. It does not prove the secret is real or works. Tell the operator
a human must check it. If jsluice or jsluice-secrets shows as unavailable, say
the scripts were not read and give its reason.

Do not submit vulnerabilities. This pack has no submit_finding tool. Its prove
hook returns no findings. Its detector map can replay inventory evidence through
lib/proof-evidence.mjs. A changed snapshot, unknown check, or wrong location fails.

The lab snapshot is the same capture as ../domains/lab/snapshot.json. The
physical Docker lab and no-spend smoke live in ../domains/. The smoke resolves
local hosts and probes four HTTP origins on an internal network. It uses no
public passive sources and publishes no ports.

For a real domain, the scope holds `domain` and `reach` as in ../domains/SKILL.md.
The prepass captures the domain once, pins it, and builds this inventory from it.

For a live run, use TARGET=./packs/surface/lab/ with node spike/agent-run.mjs.
Use the environment and shared spend limits from WAVE1.md. Offline prepass and
replay need only the locally built domains tool image.
Use PROVIDER=near and ALIAS=qwen-abl for product validation. Keep each run record
before reusing the CLI alias. The coordinator authorizes worktree output reuse.
