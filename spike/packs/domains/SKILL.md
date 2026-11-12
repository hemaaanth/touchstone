---
name: domains
description: Check a pinned DNS and front-end snapshot and replay each supported control gap.
tier: P
proof: evidence
tools: [snapshot_leads, submit_finding]
labs: [spike/packs/domains/lab]
---

# Domains and front end

Read only the operator-pinned snapshot. Never run front-end code. Never sign a
wallet message. Never claim a DNS resource or alter a DNS record.

1. Call snapshot_leads. Rank the root causes by severity.
2. Read each lead's exact check, where and description.
3. Submit each supported root cause once, with its exact lead id.
4. Skip reviewOnly leads. Approval patterns alone do not prove malware.
5. Continue after each submission. End with coverage and limits.

The gate replays the detector before recording. The prove hook replays again
when the run ends. The evidence contains check, where and snapshotHash. The
pack uses lib/proof-evidence.mjs and passes its allowlisted detector map.

A dangling CNAME is stale DNS. It is not proof of a claimable provider account.
SRI and CSP are separate controls with separate fixes. Identical captured HTML
is checked once. Missing registry-lock, DNSSEC and content-pin evidence is an
informational evidence gap. Do not say these controls are disabled.

The drainer check is behavior. The analyzer ran the captured scripts in a fake
wallet and clicked each connect, claim, airdrop, mint or verify control. A lead
`wallet-drainer-behavior` means that click asked the wallet for an unlimited
approval, setApprovalForAll or a Permit signature. The where cells show the
control, the request, the asset, the spender and the amount. Cite them.
The severity depends on the label. A Connect or Verify control never needs an
approval, so it is critical. A Mint, Claim or Airdrop control may ask for one
on a real site, so it is high. Say that a person must read the spender.

A takeover fingerprint lead means a CNAME to a known provider plus that
provider's unclaimed-resource page. The page is the root HTML or XML response.
It has the provider's real status (404), its real markup and a small body.
The same words in a script, a blog or a 200 page are not a takeover.
It does not prove a claim would succeed.
A second engine (nuclei) may agree. Say so when the lead lists it.

The bundle pattern check (an approval API, an unlimited allowance and a spender
marker) only raises a review lead. Real dApps can have the same pattern. Never
submit it. Scripts that load other scripts at run time are covered only when
the capture holds those scripts. SRI checks cover captured static script elements.
A page without X-Frame-Options or CSP frame-ancestors that has a connect
control is a low lead: another site can frame it.

Write short sentences. Explain the captured risk, not an imagined exploit.
End each supported explanation with Fix: and the control to change.

## Run

From the repository root:

    docker build -t touchstone-domains-tools:wave2 spike/packs/domains
    docker build -f spike/packs/domains/Dockerfile.observatory -t touchstone-observatory:1.7.2 spike/packs/domains
    node --test spike/test/domains.test.mjs spike/test/surface.test.mjs
    node spike/packs/domains/smoke.mjs --lab

The smoke checks fresh lab responses against lab/snapshot.json. It checks the
live capture path on the lab. It also checks submission, final replay,
inventory handoff and tamper rejection without a model. The image builds
itself on first use when it is missing.

## Real domains

A scope names a domain. `.touchstone.json` holds `domain` and `reach`. The
platform grant fills `reach`: `network`, `granted`, `scope`, and optionally
`resolver`, `ports` and `env`. The prepass then captures the domain through
`runTool()` (subfinder, dnsx, httpx, nuclei), pins the snapshot, and the
checks run on the pin. Live capture refuses a domain that is not covered by
`reach.scope`. With no grant it stops before any tool runs. A network name is
never a grant. A lab network must also be `--internal` in Docker, and the tools
check that with `docker network inspect`.
CoreDNS needs NET_BIND_SERVICE because the upstream binary carries a file
capability. Scanners still drop every capability. No port is published.

For a live model run, source the authorized environment as WAVE1.md requires.
Keep the shared ledger and cap unchanged. Set PROVIDER=near. Choose a model
alias whose run output files do not exist, or preserve the previous record.
Product validation uses ALIAS=qwen-abl. The base-Qwen check is also preserved.
Use TARGET=./packs/domains/lab/ with node spike/agent-run.mjs. The workspace is
copied from the lab. No server is needed for replay.
