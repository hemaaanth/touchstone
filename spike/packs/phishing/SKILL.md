---
name: phishing
description: Check a pinned lookalike-domain snapshot and report registered or known-scam lookalikes of the client's brand as leads. Leads only; nothing is proven.
tier: P
proof: evidence
tools: [snapshot_leads]
labs: [spike/packs/phishing/lab]
---

# Phishing and brand lookalikes (M15)

This pack looks outward. It finds domains that copy the client's domain and
checks if they are known scams. The domains pack audits the client's own DNS
and front end. This pack does not.

Read only the operator-pinned snapshot. Never open a lookalike site. Never
fetch a page, a banner, WHOIS or a screenshot. Never file a takedown.

This pack is leads only. Nothing it reports is proven, and nothing from it
enters a proven count. `prove` returns an empty list. There is no submit tool.

1. Call snapshot_leads. Rank the leads by severity.
2. Read each lead's exact check, where and description.
3. Report each lead once as a lead, with its exact lead id, check, severity and
   where cells.
4. Mark reviewOnly leads as needing review by hand. A bare permutation, a
   parked name, a wildcard answer or a brand word on a list is weaker than a
   registered or known-scam lead.
5. End with coverage and limits. Name every `*-evidence-missing` lead.

Each lead keeps its evidence in a stable shape: check, where and the
snapshotHash of the pin. The detectors in checks.mjs can rebuild the scan from
the pin and match a where exactly. They are not a proof path.

## What each lead means

`registered-lookalike` (medium). dnstwist generated the name from the official
domain, and the captured DNS row has an A, AAAA or MX record. The where cells
are the domain, the fuzzer and the records. The scan runs dnstwist again offline
(`--format list`, `--network none`). The fresh name set must have the same
sha256 as the generator fingerprint stored at capture. The name must be in it,
and the records must match the pin exactly. Only routable addresses count.
The zone's 3 control names (below) must all be quiet, fewer than 20% of the
zone's generated names may answer, and no record value may equal a control
answer. An A or AAAA record means the name can serve a page. An MX
record means it can receive mail. Neither proves a phishing page exists. Say
only what the records show.

`known-scam-lookalike` (high). dnstwist generated the name, and it is an exact
entry in a pinned blocklist. The where cells are the domain, the list name, the
1-based line in the upstream file, and the pin. The pin is the upstream git
commit. For the synthetic lab list it is `sha256:` and the list hash. Cite the
list, the line and the pin.

`unverified-lookalike` (low, reviewOnly). The name answers, but the answer is
not proof of a registration. The `reason` cell says why: `wildcard` (a
control name in the zone answers, the value equals a control answer, or more
than 20% of the zone's generated names answer), `no-control` (the zone does
not have 3 distinct quiet control rows), or `non-routable` (only
0.0.0.0/8, 127.0.0.0/8, `::` or `::1`, which is often a sinkhole).

`parked-lookalike` (low, reviewOnly). The name has NS records but no A, AAAA or
MX. It is registered but not live. Watch it.

`brand-on-blocklist` (low, reviewOnly). A list entry holds the brand label
(4 characters or more), but dnstwist did not generate it. Examples are
`brand-airdrop.xyz` or `claim-brand.app`. A person must review it.

`own-host-on-blocklist` (low, reviewOnly). A list entry is an official or
owned name, or a host under one. It is not a lookalike. Check why the list
flags it.

`lookalike-host-on-blocklist` (low, reviewOnly). A list entry is a host under a
generated lookalike, for example `www.tidekep.test`. The list names the host,
not the lookalike itself.

`lookalike-evidence-missing` and `blocklist-evidence-missing` (informational,
reviewOnly). A tool failed, the capture is empty, the resolver gave no answer
for the official domain, the generator fingerprint is missing or different,
the capture has no control rows, a zone lacks 3 quiet controls, a control
answers (resolver wildcards), more than 20% of a zone's names answer (where
`{wildcard: 'ratio', zones}`), or a
list is empty, a stub, changed, or not pinned. A partial capture also raises
one: rows that answered `!ServFail` or generated names with no row. Its where
cell holds both counts, and the `dnstwist-capture` coverage row is `partial`.
dnstwist drops DNS timeouts without a mark, so a slow resolver can still hide
names.
Report it as missing evidence. Never call it a pass and never say "no
lookalikes exist".

Names in `owned` are the client's own defensive registrations. They never
raise a lead. Names are compared in ASCII form (`url.domainToASCII`), so a
Unicode owned name matches its `xn--` row. A `!ServFail` answer is not a
record.

## Control rows

After the main run, capture asks the same resolver about 3 random names per
zone, `ts-ctl-<12 hex>.<zone>`. They cannot exist. If one answers, the resolver
wildcards (a wildcard TLD, or an ISP that rewrites NXDOMAIN), and every row in
that zone is review-only.

dnstwist writes the same bare row for NXDOMAIN and for a DNS timeout. So a
timed-out control looks quiet. Two guards cover this. A zone is quiet only if
3 distinct controls ran with exit code 0 and all 3 rows are bare. A failed
run, a missing row, a `!ServFail` row or fewer than 3 controls make the zone
unknown: its resolving rows are `no-control` and a gap lead names the zone.
Second, if a zone has at least 20 generated names and more than 20% of them
answer A or AAAA, the zone is a wildcard whatever the controls say. Its rows
are review-only and a `{wildcard: 'ratio', zones}` gap lead is raised.

Capture then runs dnstwist offline once more and stores the sha256 and count
of the name set as `generator`.

Write short sentences. Explain the captured risk, not an imagined attack.
End each lead with Fix: and the next step, for example a
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
permutation and the negative case. An empty `com` zone answers NXDOMAIN for the
two `.com` permutations, so the lab capture has no `!ServFail` row.

## Real domains

A scope names a domain. `.touchstone.json` holds `domain`, and optionally
`owned` and `blocklists`. For a live target, `prepareWorkspace` in
`lib/targets.mjs` writes `domain` (the first host), `owned` (from the target)
and `reach`. The platform grant fills `reach`: `network`,
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
The pack checks its commit, sha256 and first line against constants. The name
`metamask-eth-phishing-detect` and the format `metamask-blacklist-slice` are
reserved for it. An operator list must use another name, even at the same
upstream commit. The
pack checks only an operator list's sha256 against its bytes; the lead text
calls its commit "operator-stated".
