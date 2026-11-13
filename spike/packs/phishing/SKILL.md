---
name: phishing
description: Check a pinned lookalike-domain snapshot and replay each registered or known-scam lookalike of the client's brand.
tier: P
proof: evidence
tools: [snapshot_leads, submit_finding]
labs: [spike/packs/phishing/lab]
---

# Phishing and brand lookalikes (M15)

This pack looks outward. It finds domains that copy the client's domain and
checks if they are known scams. The domains pack audits the client's own DNS
and front end. This pack does not.

Read only the operator-pinned snapshot. Never open a lookalike site. Never
fetch a page, a banner, WHOIS or a screenshot. Never file a takedown.

1. Call snapshot_leads. Rank the leads by severity.
2. Read each lead's exact check, where and description.
3. Submit each supported lead once, with its exact lead id.
4. Skip reviewOnly leads. A bare permutation, a parked name or a brand word
   on a list is not proof.
5. Continue after each submission. End with coverage and limits. Name every
   `*-evidence-missing` lead.

The gate replays the detector before recording. The prove hook replays again
when the run ends. The evidence holds check, where and snapshotHash. The pack
uses lib/proof-evidence.mjs and passes its allowlisted detector map. Only two
checks can be confirmed: `registered-lookalike` and `known-scam-lookalike`.

## What each lead means

`registered-lookalike` (medium). dnstwist generated the name from the official
domain, and the captured DNS row has an A, AAAA or MX record. The where cells
are the domain, the fuzzer and the records. Replay runs dnstwist again offline
(`--format list`, `--network none`). The name must be in that fresh list, and
the records must match the pin exactly. A resolving name can host a page or
take mail. It does not prove a phishing page exists. Say only what the records
show.

`known-scam-lookalike` (high). dnstwist generated the name, and it is an exact
entry in a pinned blocklist. The where cells are the domain, the list name, the
1-based line in the upstream file, and the pin. The pin is the upstream git
commit. For the synthetic lab list it is `sha256:` and the list hash. Cite the
list, the line and the pin.

`parked-lookalike` (low, reviewOnly). The name has NS records but no A, AAAA or
MX. It is registered but not live. Watch it.

`brand-on-blocklist` (low, reviewOnly). A list entry holds the brand label
(4 characters or more), but dnstwist did not generate it. Examples are
`brand-airdrop.xyz` or `claim-brand.app`. A person must review it.

`lookalike-evidence-missing` and `blocklist-evidence-missing` (informational,
reviewOnly). A tool failed, the capture is empty, the resolver gave no answer
for the official domain, or a list is empty, a stub, changed, or not pinned.
Report it as missing evidence. Never call it a pass and never say "no
lookalikes exist".

Names in `owned` are the client's own defensive registrations. They never
raise a lead. A `!ServFail` answer is not a record.

Write short sentences. Explain the captured risk, not an imagined attack.
End each supported explanation with Fix: and the next step, for example a
registrar or host abuse report, a defensive registration, or a mail filter.

## Run

From the repository root:

    docker build -t touchstone-phishing-dnstwist:20250130 spike/packs/phishing
    cd spike && node --experimental-test-module-mocks --test test/phishing-*.test.mjs

The tests do not need Docker. They replay recorded dnstwist output and refuse
any tool call that is not offline. Real runs need the image. The pack never
pulls or builds it on its own (`--pull=never`). With no image, the dnstwist
coverage row is `unavailable`, the reason names the build command, and a
`lookalike-evidence-missing` lead is raised.

To capture the lab again (needs Docker, the dnstwist image and the pinned
CoreDNS image), remove `evidenceSnapshot` from lab/.touchstone.json and
lab/snapshot.json first, then run from spike/:

    node packs/phishing/lab/capture.mjs

The lab is an `--internal` Docker network with CoreDNS. The official domain is
`tidekeep.test`. `tldekeep.test` is a registered homoglyph (A and MX).
`tidekep.test` is on the synthetic lab blocklist at line 12. `tide-keep.test`
is owned. `tidekeeep.test` is parked (NS only). `tidekeap.test` is a bare
permutation and the negative case.

## Real domains

A scope names a domain. `.touchstone.json` holds `domain`, and optionally
`owned` and `blocklists`. The platform grant fills `reach`: `network`,
`granted`, `scope`, and optionally `resolver`. The prepass runs dnstwist once
through `runTool()` with `--format json`, pins the snapshot, and the checks run
on the pin. Live capture refuses a domain that `reach.scope` does not cover.
With no grant it stops before any tool runs. A lab network must also be
`--internal` in Docker.

The grant covers the client's domain. The permutations belong to other people.
The capture only asks DNS about them (NS, A, AAAA, MX). It never connects to
them.

Each operator blocklist is a file in the workspace with `name`, `format`
(`metamask-config`, `metamask-blacklist-slice` or `json-array`), `source`,
`commit` (40 hex) and `license`. The vendored MetaMask slice is always added.
