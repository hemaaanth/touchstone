# Pack research: OSS tools and feeds for the next packs

This folder holds one survey per pack. Each survey lists the open-source tools
the next capability-expansion work should wrap, the license rule for each, and
the crypto gap that Touchstone adds on top.

The rule comes from [`spike/packs/WAVE1.md`](../../spike/packs/WAVE1.md): "a superset of
the open-source market, packaged for crypto teams. Do not rebuild a tool that
already exists."

Baseline: `main` at `5f7b850`. Research date: 2026-11-10.

## Files

| Pack | Survey | Proof kind | Top tools to wrap next | Biggest crypto gap |
|---|---|---|---|---|
| `chain-watch` | [chain-watch.md](chain-watch.md) | `forge` | cryo (state diffs), OpenZeppelin Monitor (separate program) | Pending multisig transactions are not checked before signers sign them |
| `surface` | [surface.md](surface.md) | `evidence` | Nuclei plus our own chain templates, naabu | No OSS template finds validator, keymanager or non-EVM node services |
| `supply-chain` | [supply-chain.md](supply-chain.md) | `evidence` | GuardDog, OpenSSF malicious-packages through OSV-Scanner | Wallet-draining code in a package is missed until someone files an advisory |
| `domains` | [domains.md](domains.md) | `evidence` | openrdap, checkdmarc | No tool compares the live dapp bundle with an approved list of addresses and script origins |
| `people-brand` | [people-brand.md](people-brand.md) | `evidence` | Polkadot phishing lists, Sherlock | Feeds list known-bad hosts. They do not tie a lookalike to this team's addresses, handles and claim lures |
| `infra-cloud` | [infra-cloud.md](infra-cloud.md) | `evidence`, plus a moto posture check | Cartography, Cloud Custodian | No scanner shows which principal or network path can make the signer sign |

## Method

1. Read each pack's `pack.mjs`, `SKILL.md` and `TOOLS.md` to learn its scope and
   what it wraps today. No pack has a `BRIEF.md`.
2. List the leading OSS tools for the module. Include the tools already wrapped,
   so each survey shows the whole market.
3. Check each license with the GitHub license API
   (`gh api repos/<owner>/<repo>/license`). That API reads the repository's
   actual LICENSE file. When it returned `NOASSERTION` or no license, we read
   the LICENSE file by hand. Each license link in the surveys points at that file.
4. Check each feed URL with an HTTP request on 2026-11-10. A feed that blocks
   scripted requests is marked as such.
5. Check the coverage of Nuclei templates by grepping a shallow clone of
   `projectdiscovery/nuclei-templates` at commit
   `ed7f0bf171ab0eb57f136c43064deb9872e107dc`. No template was run.

No paid research provider was used. Sources are GitHub, vendor docs, and
ordinary web search.

## License use modes

The modes follow rule 2 of [`spike/packs/README.md`](../../spike/packs/README.md).

| Mode | Licenses | What we may do |
|---|---|---|
| **lift** | MIT, MIT-0, BSD, ISC, Apache-2.0, Unlicense, CC0-1.0 | Copy or adapt rules, data, detectors and workflows. Keep the notice. Add a row to `THIRD_PARTY.md`. |
| **lift (data, attribution)** | CC-BY-4.0 | Copy the data. Give attribution. Record the source and version. |
| **shell out** | GPL-2.0, GPL-3.0, AGPL-3.0, LGPL-2.1, MPL-2.0 | Run as a separate program in Docker. Parse its output. Never paste its code or rules. GPL-licensed data is fetched and pinned at run time. It is not committed to our source tree. |
| **read only** | Custom (DBAD, NPSL), source-available (FSL, BUSL), no license file, hosted | Read docs and ideas. Do not paste. Run as a separate program only where the license allows our use. |

Two licenses need care:

- [Nmap's NPSL](https://github.com/nmap/nmap/blob/HEAD/LICENSE) is a custom
  license based on GPL with extra terms for redistribution in commercial
  products. Run it as a separate program only. Ask counsel before shipping it in a product image.
- [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain/blob/HEAD/LICENSE)
  is AGPL-3.0 plus a commercial license. Its LICENSE file says a commercial
  license is needed for commercial activities. Treat it as read only.

## Feeds shared by several packs

| Feed | What it gives | URL | Terms |
|---|---|---|---|
| NVD CVE API 2.0 | All CVEs with CVSS and CPE | <https://services.nvd.nist.gov/rest/json/cves/2.0> ([docs](https://nvd.nist.gov/developers/vulnerabilities)) | Public. An API key raises rate limits. |
| CISA KEV | CVEs exploited in the wild | <https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json> ([mirror repo](https://github.com/cisagov/kev-data)) | [CC0-1.0](https://github.com/cisagov/kev-data/blob/HEAD/LICENSE) |
| GitHub Advisory Database | Reviewed advisories and a malware type | <https://api.github.com/advisories> ([repo](https://github.com/github/advisory-database)) | [CC-BY-4.0](https://github.com/github/advisory-database/blob/HEAD/LICENSE.md) |
| OSV | One schema over GHSA, PyPI, Go, RustSec, malicious packages and more | <https://api.osv.dev/v1/query> (POST), bulk at <https://osv-vulnerabilities.storage.googleapis.com/> | Per source. See the [OSV schema](https://ossf.github.io/osv-schema/). |
| Certificate Transparency | New certificates, for lookalike and asset discovery | <https://crt.sh/?q=example.com&output=json>, [Certstream](https://certstream.calidog.io/) | Public logs. See [certificate.transparency.dev](https://certificate.transparency.dev/). |
| OFAC sanctioned addresses | Addresses on the US SDN list | [0xB10C lists](https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt), [OFAC SDN](https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists) | Tool [MIT](https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses/blob/HEAD/LICENSE). US government data. |

On catalog version 2026.11.10, CISA KEV had 1,779 entries. None had a
blockchain client, wallet or chain vendor in its `vendorProject` or `product`
field. We matched ethereum, geth, solana, bitcoin, metamask, ledger, trezor,
web3, blockchain, cosmos and polygon. Generic feeds do not cover chain software.
Each survey names the chain-specific feeds that fill this gap.

## Limits

- License results are a snapshot of each default branch on 2026-11-10. Before a
  lift, check the license again at the pinned tag.
- Coverage and gap notes come from the tools' docs and our reading. Only the
  Nuclei template check was measured. None of these tools ran on a lab in this
  research.
- Hosted products are named only to mark the edge of the OSS market. We make no
  claim about their coverage.
