# People and brand (M3, M4): OSS survey

## Scope today

Read from [`spike/packs/people-brand/pack.mjs`](../../spike/packs/people-brand/pack.mjs),
`SKILL.md` and `TOOLS.md`.

- Tier P. Proof kind `evidence`. The pack is passive. It reads a pinned, made-up
  `.test` snapshot. It never looks up real brands or people and never contacts
  an account.
- Wrapped today: dnstwist plus confusables (lookalike names),
  eth-phishing-detect with the MetaMask feed and the BlocklistProject list
  (blocklist match), OPA with unchanged Legitify Rego rules (GitHub org
  posture), and parse5 and Acorn (page and script parsing).
- Read only: URLCrazy and the Legitify CLI.
- Our own crypto checks already run on the snapshot: copied page with foreign
  spender literals, off-brand WalletConnect IDs, claim and airdrop lures, the
  Inferno script-name pattern, and address poisoning (same first six and last
  four hex digits).

## Leading OSS tools

Licenses were read from each repository's LICENSE file on 2026-11-10. See the
[method](README.md#method).

| Tool | What it does | License | Use mode | Coverage | Crypto gap |
|---|---|---|---|---|---|
| [dnstwist](https://github.com/elceef/dnstwist) | Generates lookalike domains and checks if they resolve. Wrapped today. | [Apache-2.0](https://github.com/elceef/dnstwist/blob/HEAD/LICENSE) | lift | Typos, homoglyphs, bitsquats, TLD swaps, fuzzy page hashes. | Does not know crypto words like `claim`, `airdrop`, `migrate` or `app-`. |
| [URLCrazy](https://github.com/urbanadventurer/urlcrazy) | Lookalike domain generator. | No LICENSE file. Custom terms in the [source header](https://github.com/urbanadventurer/urlcrazy/blob/HEAD/urlcrazy). | read only | Overlaps dnstwist. | Same as dnstwist. |
| [Polkadot phishing lists](https://github.com/polkadot-js/phishing) | Curated phishing domains and scam addresses from the Polkadot community. | [Apache-2.0](https://github.com/polkadot-js/phishing/blob/HEAD/LICENSE) | lift | [all.json](https://polkadot.js.org/phishing/all.json) (domains) and [address.json](https://polkadot.js.org/phishing/address.json) (addresses by site). Also on IPNS. | Polkadot-focused. It does not cover EVM drainers well. |
| [eth-phishing-detect](https://github.com/MetaMask/eth-phishing-detect) | MetaMask's phishing domain list and fuzzy matcher. Wrapped today. | [DBAD 1.2](https://github.com/MetaMask/eth-phishing-detect/blob/HEAD/LICENSE) | read only (the pack runs it unmodified and pins the feed) | Large EVM phishing list, plus an allowlist. Fuzzy match on popular brands. | The fuzzy list holds MetaMask's chosen brands, not the customer's. |
| [ScamSniffer scam-database](https://github.com/scamsniffer/scam-database) | Phishing domains and drainer addresses from ScamSniffer. | [GPL-3.0](https://github.com/scamsniffer/scam-database/blob/HEAD/LICENSE) | shell out (fetch and pin data, do not commit) | `blacklist/` has `domains.json`, `address.json`, `all.json` and `combined.json`. | The public list has a 7-day delay. Real time is a paid API. |
| [Phantom blocklist](https://github.com/phantom/blocklist) | Phantom's Solana phishing list. | No license | read only | Solana phishing domains. | Cannot be redistributed. |
| [CryptoScamDB blacklist](https://github.com/CryptoScamDB/blacklist) | Older crypto scam domain list. | No license | skip | Last push 2023. | Stale. |
| [Phishing.Database](https://github.com/Phishing-Database/Phishing.Database) | Large tested list of phishing domains and links. | [MIT](https://github.com/Phishing-Database/Phishing.Database/blob/HEAD/LICENSE) | lift | General phishing with active and inactive status. | Not crypto-specific. |
| [BlocklistProject Lists](https://github.com/blocklistproject/Lists) | DNS blocklists by category. Wrapped today. | [Unlicense](https://github.com/blocklistproject/Lists/blob/HEAD/LICENSE) | lift | General phishing list. | The repo is archived. Plan a replacement source. |
| [phishing_catcher](https://github.com/x0rz/phishing_catcher) | Scores new CT certificates by suspicious words. | [GPL-3.0](https://github.com/x0rz/phishing_catcher/blob/HEAD/LICENSE) | shell out | Live lookalike discovery from Certstream. | Keyword list is general. We supply crypto words and the customer's brands. |
| [certstream-server-go](https://github.com/d-Rickyy-b/certstream-server-go) | Self-hosted CT stream. | [MIT](https://github.com/d-Rickyy-b/certstream-server-go/blob/HEAD/LICENSE) | lift | Feeds new names to dnstwist-style matching. | None specific. |
| [confusables](https://github.com/gc/confusables) | Unicode confusable mapping. Wrapped today. | [MIT](https://github.com/gc/confusables/blob/HEAD/LICENSE.md) | lift | Homoglyph names and handles. | None specific. |
| [Sherlock](https://github.com/sherlock-project/sherlock) | Finds a username across hundreds of sites. | [MIT](https://github.com/sherlock-project/sherlock/blob/HEAD/LICENSE) | lift | Handle reuse and squatting of the team's names on social sites. | No crypto sites by default (Farcaster, Lens, Mirror, Paragraph). It finds exact names, not lookalikes. |
| [Maigret](https://github.com/soxoj/maigret) | Sherlock fork with more sites and profile parsing. | [MIT](https://github.com/soxoj/maigret/blob/HEAD/LICENSE) | lift | About 3,000 sites. Extracts linked IDs. | Same as Sherlock. |
| [holehe](https://github.com/megadose/holehe) | Checks which sites an email is registered on. | [GPL-3.0](https://github.com/megadose/holehe/blob/HEAD/LICENSE.md) | skip | Uses password-reset flows on live sites. | Out of scope. The pack never contacts an account. |
| [theHarvester](https://github.com/laramies/theHarvester) | Gathers emails, names and hosts from public sources. | [GPL-2.0](https://github.com/laramies/theHarvester/blob/HEAD/LICENSE) | shell out | Staff email exposure, which drives spear-phishing risk. | Generic. |
| [Legitify](https://github.com/Legit-Labs/legitify) | GitHub and GitLab org posture checks with Rego rules. Rules wrapped today through OPA. | [Apache-2.0](https://github.com/Legit-Labs/legitify/blob/HEAD/LICENSE) | lift | 2FA enforcement, branch protection, admin counts, stale members. | No rule for deploy-key or release-signing paths to a contract upgrade. |
| [OPA](https://github.com/open-policy-agent/opa) | Policy engine. Wrapped today. | [Apache-2.0](https://github.com/open-policy-agent/opa/blob/HEAD/LICENSE) | lift | Runs Legitify and our own rules offline. | None specific. |
| [gitxray](https://github.com/kulkansecurity/gitxray) | Profiles GitHub contributors for signs of fake accounts. | [AGPL-3.0](https://github.com/kulkansecurity/gitxray/blob/HEAD/LICENSE) | shell out | Key reuse, account age, odd commit times and places. Useful against fake developer applicants. | Needs live GitHub API calls. |
| [Gophish](https://github.com/gophish/gophish) | Phishing simulation platform. | [MIT](https://github.com/gophish/gophish/blob/HEAD/LICENSE) | skip | Sends real mail to staff. | Out of scope for a passive pack. |

## Recommendation

1. **Lift the Polkadot phishing lists.** They are Apache-2.0 and include scam
   addresses, not only domains. That makes them the one permissive crypto feed
   we can commit and join to address poisoning. Run them beside the MetaMask
   feed (DBAD) and pin ScamSniffer (GPL-3.0) at run time.
2. **Wrap Sherlock** (or Maigret) for handle squatting. Seed it with the
   team's handles plus confusables variants. Add crypto social sites to its
   site list. Both are MIT.
3. Next: phishing_catcher over Certstream for live lookalike discovery, with
   our crypto word list. Keep the pack passive. Live discovery belongs to a
   later I tier.

## Biggest crypto gap

**Feeds list known-bad hosts. They do not tie a lookalike to this team's
addresses, handles and claim lures.** Every list above answers "is this host
bad for anyone?" None answers "is this host pretending to be us, and does it
point users at addresses that are not ours?" The scams that hit crypto teams
are brand-specific. Fake claim and migration pages use the team's name and a
drainer kit ([Group-IB, Inferno Drainer](https://www.group-ib.com/blog/inferno-drainer/)).
Address poisoning plants lookalike addresses in a user's history
([Chainalysis](https://www.chainalysis.com/blog/address-poisoning-scam/)).
North Korean IT workers pose as developers to get inside teams
([FBI IC3 PSA, 2025-01-23](https://www.ic3.gov/PSA/2025/PSA250123)).

The pack already runs these brand-specific checks on its pinned snapshot. That
is the Touchstone edge. The missing piece is the input side: no OSS pipeline
joins CT and feed candidates to a team's registry of domains, handles,
contract addresses and WalletConnect IDs. That registry is ours to build.

## Feeds

| Feed | What it gives | URL | Terms or note |
|---|---|---|---|
| Polkadot phishing | Domains and scam addresses | <https://polkadot.js.org/phishing/all.json>, <https://polkadot.js.org/phishing/address.json> | [Apache-2.0](https://github.com/polkadot-js/phishing/blob/HEAD/LICENSE) |
| MetaMask phishing config | EVM phishing domains, allowlist and fuzzy list | [config.json](https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json) | [DBAD 1.2](https://github.com/MetaMask/eth-phishing-detect/blob/HEAD/LICENSE). Pinned today. |
| ScamSniffer | Phishing domains and drainer addresses | [domains.json](https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/domains.json), [address.json](https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json) | [GPL-3.0](https://github.com/scamsniffer/scam-database/blob/HEAD/LICENSE). 7-day delay. Fetch and pin. |
| OpenPhish | General phishing URLs | <https://openphish.com/feed.txt> ([terms](https://openphish.com/phishing_feeds.html)) | Free community feed. Commercial use needs a license. |
| URLhaus | Malware URLs | <https://urlhaus.abuse.ch/api/> | The old CSV and text download URLs now return 410. Use the API. |
| PhishTank | Verified phishing URLs | <https://phishtank.org/developer_info.php> | Needs registration. Data downloads returned 403 to our scripted check. |
| Certstream | Live CT names for lookalike discovery | <https://certstream.calidog.io/> | Public. Self-host with certstream-server-go. |
| Chainabuse | Community scam reports by address and domain | <https://www.chainabuse.com/> | Hosted. We found no public API without a key. |
| SEAL 911 | Emergency help for an active phishing or drainer incident | <https://github.com/security-alliance/seal-911> | Escalation path, not data. |
