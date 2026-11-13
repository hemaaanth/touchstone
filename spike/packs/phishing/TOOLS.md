# Phishing tool selection

Checked on 2026-11-12. Start point: M15 (brand and phishing) in the capability
research. The domains pack TOOLS.md marked dnstwist and openSquat as
"product decision — M15". This pack is that decision.

An earlier People & Brand pack was removed in commit 4849645. Its validation is
cited below where it is the only evidence. No code was copied from it.

Sizes are local, uncompressed Docker image sizes. Every tool call goes through
`runTool()` in `lib/wrap.mjs` with `--pull=never`. Replay uses `--network none`.

Capture has two modes. The lab mode uses an owned Docker `--internal` network
with CoreDNS. The live mode (`live.mjs`) takes its network from `reach`, which
the platform grant fills. Live capture refuses a domain the grant scope does
not cover. dnstwist resolves DNS over UDP, so it cannot use the HTTP gate. The
grant is enforced in code, and later steps read only the pinned snapshot.
`prepareWorkspace` in `lib/targets.mjs` writes `domain`, `reach` and `owned`
for a live phishing target.

## Proof model

This pack is leads only. No phishing result is proven. `prove` returns an
empty list and the only tool is `snapshot_leads`. The two strongest leads are:

1. `registered-lookalike`: dnstwist generates the name again, offline, from the
   official domain, and the pinned DNS row has a routable A or AAAA, or an MX.
   The zone's 3 control rows must be quiet, at most 20% of the zone's names
   may answer, and no value may equal a control
   answer.
2. `known-scam-lookalike`: dnstwist generates the name again, offline, and it is
   an exact entry in a pinned blocklist. The evidence names the list, the
   upstream line and the pin.

Each lead keeps check, where and the snapshotHash in a stable shape, so a later
step can carry it as evidence. Records alone do not show phishing, so neither
lead is a proven finding.

A bare permutation, an NS-only name, a wildcard or non-routable answer, or a
brand word on a list stays a review lead. A tool failure or a bad list is
`unavailable` in coverage and raises a `*-evidence-missing` lead. It is never a
pass. A partial capture (`!ServFail` rows, or generated names with no row) is
`partial` in coverage and raises a `lookalike-evidence-missing` lead with both
counts.

Two checks guard the capture itself:

- Control rows. After the main run, capture asks the same resolver about 3
  random names per zone (`ts-ctl-<12 hex>.<zone>`). They cannot exist. If one
  answers, the resolver wildcards, and rows in that zone are review-only.
  dnstwist gives a timeout and NXDOMAIN the same bare row, so a zone is quiet
  only when all 3 distinct controls ran and came back bare. Anything else is
  unknown, and its rows are review-only. A snapshot with no control rows gives
  no `registered-lookalike` lead.
- Wildcard ratio. If more than 20% of a zone's generated names (at least 20
  names) answer A or AAAA, the zone is treated as a wildcard even with quiet
  controls. Real registrations are far rarer than that.
- Generator fingerprint. Capture stores the sha256 and count of the offline
  `--format list` name set. Replay makes the set again and compares. A
  different set (for example a rebuilt image under the same tag) gives no
  lookalike leads and a `lookalike-evidence-missing` lead.
  This checks the output, not the Docker image ID, so it also holds on a
  remote Docker backend.

## Wrapped and vendored

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [dnstwist 20250130](https://github.com/elceef/dnstwist/tree/20250130) | [Apache-2.0](https://github.com/elceef/dnstwist/blob/20250130/LICENSE) | local `touchstone-phishing-dnstwist:20250130`, built from `Dockerfile` on `python:3.12-slim@sha256:5e2bdb1b…4fa5b` with hash-pinned wheels (dnstwist, idna 3.10 BSD-3-Clause, dnspython 2.7.0 ISC); user 65534; 184.4 MiB | Generation: yes, `--format list` with `--network none`. Capture: lab CoreDNS, or the resolver the grant allows. No `-b -w -m --lsh --phash` | Official domain | `--format json` rows (`domain`, `fuzzer`, `dns_ns`, `dns_a`, `dns_aaaa`, `dns_mx`); `--format list` names | `registered-lookalike`, `parked-lookalike`; bare names are only counted | evidence; offline regeneration plus exact pinned records | URLCrazy and openSquat: below | Upstream fuzzers used unchanged; no code copied | Has no crypto words (`claim`, `airdrop`, `migrate`, `app-`) | wrap; widest maintained offline generator, JSON output, Apache-2.0 |
| [MetaMask eth-phishing-detect](https://github.com/MetaMask/eth-phishing-detect/tree/82d3512c593b6d85d24e885bfb19afa7f5e452fa) | [DBAD 1.2](https://github.com/MetaMask/eth-phishing-detect/blob/82d3512c593b6d85d24e885bfb19afa7f5e452fa/LICENSE); attribution in `NOTICE` | Data only. `blocklists/metamask-blacklist-slice.txt` is lines 76-525 of `src/config.json` at commit 82d3512c (2026-11-13T00:44:26Z), sha256 f6d7b2c1…6754696 | Yes | Slice, or an operator-pinned full `config.json` (`metamask-config` format) | Domain entries with their upstream line | `known-scam-lookalike`; `brand-on-blocklist` (review) | evidence; exact entry, upstream line, 40-hex commit, sha256 of the bytes | ScamSniffer and Polkadot lists | Upstream list bytes unchanged; their matcher code is not used | The full list has 120,661 entries; the slice has 450 | wrap (data); the slice proves the format and line math on real data. Pin the full file for real scopes |
| [ScamSniffer scam-database](https://github.com/scamsniffer/scam-database) | [GPL-3.0](https://github.com/scamsniffer/scam-database/blob/main/LICENSE) | Data only, operator-pinned. Not committed here | Yes, after the operator saves a copy | `blacklist/domains.json`, a pretty-printed JSON array (`json-array` format) | Domain entries with their line | `known-scam-lookalike` | evidence; same rule as MetaMask | MetaMask list | None. We do not vendor GPL data next to this code | Crypto drainer domains, fresh | supported format, operator-pinned; `main` was at de283727 on 2026-11-12. Not tested on the real file |

## Compared and not wrapped

Verdicts: wrap, backlog (net-new work nobody decided against), skip (reason),
read only (reference, no service calls), deferred (named out of v1 scope).

| Tool | Space | License | Verdict | Reason |
|------|-------|---------|---------|--------|
| [openSquat](https://github.com/atenreiro/opensquat) | Keyword match on newly registered domains | [GPL-3.0](https://github.com/atenreiro/opensquat/blob/master/LICENSE) | skip — needs a network feed; partial overlap | Its input is a daily newly-registered-domain feed it downloads. With `--network none` it has no input, so its result cannot be replayed from a pin. Its generation side overlaps dnstwist. Its real value is the feed (combosquats like `brand-claim.xyz`), which is the CT/feed gap below. Not run. |
| [certspotter](https://github.com/SSLMate/certspotter) | Certificate Transparency monitor | [MPL-2.0](https://github.com/SSLMate/certspotter/blob/master/LICENSE) | backlog — CT capture | It polls CT logs over the network and keeps state between runs. That is a streaming monitor, not a capture we can pin once. The useful piece is a one-shot capture of certificates whose SANs match the brand, stored in the snapshot and replayed offline. The old People & Brand validation found the Cyrillic homoglyph only through a captured certificate SAN. Not run. |
| [URLCrazy](https://github.com/urbanadventurer/urlcrazy) | Lookalike generator | No LICENSE file; custom terms in the [source header](https://github.com/urbanadventurer/urlcrazy/blob/master/urlcrazy) | skip — overlap and license | Overlaps dnstwist. In the old People & Brand validation it exited 1 with "Invalid domainname" on a `.test` domain, so it cannot run on a lab. Not run in this pack. |
| [confusables](https://github.com/woodgern/confusables) | Unicode confusable characters | [MIT](https://github.com/woodgern/confusables/blob/master/LICENSE) | backlog — homoglyph hole | The old People & Brand validation found the Cyrillic-a host only with confusables plus a certificate SAN. dnstwist did not generate it. This is the fix for the homoglyph hole below. |
| [Polkadot phishing](https://github.com/polkadot-js/phishing) | Curated phishing domains and scam addresses | [Apache-2.0](https://github.com/polkadot-js/phishing/blob/master/LICENSE) | backlog — third list | Apache-2.0, so it could be vendored. It needs a parser for its `all.json` shape and a line test. Not done in v1. |
| [PhishFort lists](https://github.com/phishfort/phishfort-lists) | Crypto phishing domains | [GPL-3.0](https://github.com/phishfort/phishfort-lists/blob/master/LICENSE) | skip — license; last push 2026-03-27 | Same rule as ScamSniffer: an operator may pin it as `json-array` if the shape fits. Not checked. |
| [ChainPatrol](https://chainpatrol.io/), [Doppel](https://www.doppel.com/) | Hosted brand protection and takedown | Hosted products | read only | Reference for coverage only (CT, social, visual, takedown). No service calls. No parity claim. |

## Deferred, named out of v1 scope

- Social account APIs (fake X, Telegram, Discord accounts). They need accounts
  and API keys, and the results cannot be pinned the same way.
- OAuth grant inventory (third-party apps with access to the client's org).
- Visual and screenshot similarity (dnstwist `--lsh`, `--phash`). They fetch
  lookalike pages, which this pack never does.
- CT log streaming.
- Takedown form submission. It is an outward action. It is never automatic.

## Gaps that keep this pack below best-in-class

Scoping choices (decided, not holes):

- No page fetch, banner, WHOIS or screenshot. A resolving name is reported as
  "resolves", never as "hosts phishing".
- The five deferred items above.
- GPL lists are operator-pinned, not shipped.
- The image is not built or pulled on demand. A missing image is reported.

Real holes (work nobody has done yet):

1. No CT capture. Lookalikes with a certificate but no permutation match are
   missed (certspotter backlog).
2. No combosquat generation beyond the brand label. `brand-airdrop.xyz` is
   found only if a pinned list already has it, and then only as a review lead.
   dnstwist has `--dictionary`, but no crypto word list is pinned yet.
3. Missed homoglyphs. In the old People & Brand validation, dnstwist did not
   generate `xn--astralhrbor-4ij.test` (a Cyrillic a). This pack has the same
   generator, so it has the same miss (confusables backlog).
4. No drainer linkage. A lookalike is not tied to a drainer kit, a spender
   address or a wallet request. The domains pack does that for the client's
   own site only.
5. dnstwist drops DNS timeouts without a mark. A slow or rate-limiting
   resolver can make a registered name look bare. `!ServFail` and missing rows
   are counted; timeouts cannot be.
6. The controls miss two cases: a wildcard in a zone below the one the
   controls ask about (for example `*.co.za` when they ask under `za`), and a
   resolver that rewrites only some names and not the controls. All 3 controls
   can still time out and look quiet; the 20% ratio then catches a mass
   wildcard only in a zone with at least 20 names, and not a partial one. A
   sinkhole that answers with routable addresses is not caught either.
7. The vendored MetaMask copy is a 450-entry slice. Real coverage needs the
   operator to pin the full 3.5 MB `config.json` at a commit.
8. No refresh schedule per source. Lists go stale. Nothing re-pins them.
9. No domain age or registrar data, so a new registration and an old one look
   the same.
10. Lookalikes under other TLDs depend on dnstwist's built-in TLD swaps only.
    No custom TLD list is pinned.
11. A live target has no UI field for `owned`. Without it, the client's own
    defensive registrations are reported as lookalikes.

## Runtime notes

- Daytona: `runTool()` now passes `--pull=never`. The Daytona `planRemote` in
  `lib/daytona.mjs` does not know that flag yet, so on this branch every tool
  call stays on local Docker. Two tests in `test/daytona-exec.test.mjs` fail
  for that reason. The fix (accept `--pull`) is on the pack/domains branch.
- The lab CoreDNS image is `coredns/coredns:1.12.0@sha256:40384aa1…`, 90.8 MiB.
  It needs NET_BIND_SERVICE because the binary carries a file capability.
  dnstwist drops every capability. No port is published.
