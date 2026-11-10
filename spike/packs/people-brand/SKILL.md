---
name: people-brand
description: Compare a made-up project's pinned brand, people, pages and organization export with its approved registry.
tier: P
proof: evidence
tools: [snapshot_leads, submit_finding]
labs: [spike/packs/people-brand/lab]
---

# People and brand

This pack is passive. Audit only the pinned made-up .test snapshot.
Never look up real brands or people. Never contact an account. Never execute
page code, request a signature, send a message, or submit a transaction.

1. Call snapshot_leads. Read coverage as well as the leads.
2. Review every root, worst first. One host has one grouped finding.
3. Submit supported roots with the exact lead id. Skip reviewOnly leads.
4. Keep claims within the captured evidence. Do not claim criminal ownership,
   a working drainer, compromised wallets, or current live DNS.
5. Use short sentences. End each explanation with Fix: and a concrete fix.
6. Continue after each submission. Finish with coverage and limits.

Do not recommend claiming or registering an observed domain. Availability and
ownership are unknown. Recommend ownership review and authorized takedown.
Recovery phrases must never be shared, even with an approved support contact.

The gate takes check, where, severity and title from the canonical lead.
It replays shared lib/proof-evidence.mjs before recording. The prove hook
replays again at the end. Evidence is { check, where, snapshotHash }.
A changed snapshot, wrong location, unknown check, review-only root or duplicate
root cannot pass. Parsing is cached by snapshot content hash within a process.

The three Inferno script names form a review-only pattern inside the grouped
host lead. They do not prove malware. A synthetic list match is labeled as such.
MetaMask and eth-phishing-detect are not two independent engines. The bundled
public lists are small pinned fixtures, not current or complete blocklists.

Legitify's unchanged Rego rules run through OPA on the pinned export. The CLI
does not run. No GitHub token is needed. Missing fields and social 2FA are
unknown, not disabled. An export for another organization is ignored.

## Build and verify

From the repository root:

    docker build -t touchstone-people-analysis:wave2 spike/packs/people-brand
    docker build -f spike/packs/people-brand/Dockerfile.dnstwist -t touchstone-people-dnstwist:20250130 spike/packs/people-brand
    docker pull openpolicyagent/opa:0.63.0-static@sha256:b181f9f31a5544870a96ae69ad3613d8d07f7757c4ab32f774bd4e9f4cb305d9
    node --test spike/test/people-brand.test.mjs
    node spike/packs/people-brand/smoke.mjs

No server is needed. Every scan and replay uses network none. The snapshot
contains DNS answers, a fixture certificate, profiles, HTML, inert bundle
bytes, public-list subsets, an approved registry and a GitHub JSON export.
The plain lab folder is intentional. There are no fresh secrets to generate.
Its title and blurb appear in the New run dialog.

The smoke calls the actual prepass, tools, submission gate and final proof.
It checks all 11 planted roots and rejects altered bytes. It spends no money.

URLCrazy is comparison only. Do not build or run it as part of a commercial
domain-protection service without checking its custom license. The recorded
comparison uses its unmodified pinned source in Dockerfile.permutations.

## Live model run

Use the environment in WAVE1.md. Keep the shared ledger and cap unchanged.
Preserve any earlier result files before reusing the model alias.
Use PROVIDER=near, ALIAS=qwen-abl, RUN_BUDGET_USD=1 and
TARGET=./packs/people-brand/lab/ with node spike/agent-run.mjs.
Only the model call is live. The pack's tools remain offline.
