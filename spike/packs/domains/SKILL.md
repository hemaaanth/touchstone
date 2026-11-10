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

The bundle check requires a signing or approval API, an unlimited allowance,
and a spender or operator marker. It only raises a review lead. Real dApps can
have the same pattern. Obfuscated, dynamically loaded and runtime-generated
scripts are not covered. SRI checks cover captured static HTTP script elements.

Write short sentences. Explain the captured risk, not an imagined exploit.
End each supported explanation with Fix: and the control to change.

## Run

From the repository root:

    docker build -t touchstone-domains-tools:wave1 spike/packs/domains
    docker build -f spike/packs/domains/Dockerfile.observatory -t touchstone-observatory:1.7.2 spike/packs/domains
    node --test spike/test/domains.test.mjs spike/test/surface.test.mjs
    node spike/packs/domains/smoke.mjs --lab

The smoke checks fresh lab responses against lab/snapshot.json. It also checks
submission, final replay, inventory handoff and tamper rejection without a model.
CoreDNS needs NET_BIND_SERVICE because the upstream binary carries a file
capability. Scanners still drop every capability. No port is published.

For a live model run, source the authorized environment as WAVE1.md requires.
Keep the shared ledger and cap unchanged. Set PROVIDER=near. Choose a model
alias whose run output files do not exist, or preserve the previous record.
Product validation uses ALIAS=qwen-abl. The base-Qwen check is also preserved.
Use TARGET=./packs/domains/lab/ with node spike/agent-run.mjs. The workspace is
copied from the lab. No server is needed for replay.
