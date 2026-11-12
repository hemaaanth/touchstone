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
api-endpoint, provider-error-page, web-page, srv-service), what found it
(subfinder, wordlist, dns-zonefile, httpx) and its nextPack. Report these as
given. Do not infer a kind the lead does not state.

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
