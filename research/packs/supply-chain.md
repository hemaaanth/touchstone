# Supply chain and secrets (M13, M14): OSS survey

## Scope today

Read from [`spike/packs/supply-chain/pack.mjs`](../../spike/packs/supply-chain/pack.mjs),
`SKILL.md` and `TOOLS.md`.

- Tier P. Proof kind `evidence`. It audits a pinned Git HEAD tree and never runs
  the target's code.
- Wrapped today: zizmor and poutine (CI workflows), OSV-Scanner (lockfiles),
  TruffleHog and Gitleaks (secrets), plus our own crypto checks (keys and
  mnemonics derived offline with ethers).
- Skipped in the lab: GuardDog (no package payload), Syft, Grype and Kingfisher
  (no extra detections in this lab). Gato-X is read only.
- Out of scope today, per `TOOLS.md` Limits: deleted history, live GitHub
  settings, package registries, installed dependency payloads and image layers.

## Leading OSS tools

Licenses were read from each repository's LICENSE file on 2026-11-10. See the
[method](README.md#method).

| Tool | What it does | License | Use mode | Coverage | Crypto gap |
|---|---|---|---|---|---|
| [OSV-Scanner](https://github.com/google/osv-scanner) | Matches lockfiles, SBOMs and images to OSV advisories. Wrapped today. | [Apache-2.0](https://github.com/google/osv-scanner/blob/HEAD/LICENSE) | lift | npm, PyPI, Go, crates, Maven and more. Reads the MAL- entries from OpenSSF malicious-packages. | No Solidity dependencies (git submodules, Soldeer, npm Solidity packages). No compiler bug data. |
| [OpenSSF malicious-packages](https://github.com/ossf/malicious-packages) | OSV-format reports of malicious packages. | [Apache-2.0](https://github.com/ossf/malicious-packages/blob/HEAD/LICENSE) | lift | npm, PyPI, crates, RubyGems and more. Records are in [`osv/malicious`](https://github.com/ossf/malicious-packages/tree/main/osv/malicious). | Lags the attack. A drainer is listed only after someone reports it. |
| [GuardDog](https://github.com/DataDog/guarddog) | Finds malicious packages with Semgrep and YARA rules plus metadata heuristics. | [Apache-2.0](https://github.com/DataDog/guarddog/blob/HEAD/LICENSE) | lift | npm, PyPI, Go and GitHub Actions. Install hooks, exfiltration, obfuscation, typosquats. | No rules for clipboard address swaps, `eth_sendTransaction` or `signTypedData` hooks, mnemonic or keystore reads, or RPC URL rewrites. |
| [OpenSSF package-analysis](https://github.com/ossf/package-analysis) | Installs packages in a sandbox and records files, network and commands. | [Apache-2.0](https://github.com/ossf/package-analysis/blob/HEAD/LICENSE) | lift | Dynamic behavior during install and import. | Does not drive a wallet or provider object, so a drainer that waits for a signature stays silent. |
| [OpenSSF Scorecard](https://github.com/ossf/scorecard) | Scores a repo's security practices. | [Apache-2.0](https://github.com/ossf/scorecard/blob/HEAD/LICENSE) | lift | Branch protection, pinned deps, token permissions, signed releases. [Site](https://scorecard.dev/). | Generic. It does not weigh a wallet SDK above a test helper. |
| [zizmor](https://github.com/zizmorcore/zizmor) | Static analysis of GitHub Actions workflows. Wrapped today. | [MIT](https://github.com/zizmorcore/zizmor/blob/HEAD/LICENSE) | lift | Template injection, excessive permissions, unpinned actions, cache poisoning. | No check for deploy keys or signer secrets reached by an untrusted trigger. |
| [poutine](https://github.com/boostsecurityio/poutine) | Finds pipeline weaknesses in CI configs. Wrapped today. | [Apache-2.0](https://github.com/boostsecurityio/poutine/blob/HEAD/LICENSE) | lift | GitHub Actions, GitLab CI and more. Rego rules. | Same as zizmor. |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | Regex secret scanner. Wrapped today. | [MIT](https://github.com/gitleaks/gitleaks/blob/HEAD/LICENSE) | lift | Hundreds of token formats. | Raw 64-hex keys and BIP-39 phrases need our own checks to cut noise. |
| [TruffleHog](https://github.com/trufflesecurity/trufflehog) | Secret scanner with live credential checks. Wrapped today. | [AGPL-3.0](https://github.com/trufflesecurity/trufflehog/blob/HEAD/LICENSE) | shell out | 800+ detectors. Git history, S3 and more. | Does not derive the address of a found key or check its on-chain role. |
| [Kingfisher](https://github.com/mongodb/kingfisher) | Secret scanner with validation. | [Apache-2.0](https://github.com/mongodb/kingfisher/blob/HEAD/LICENSE) | lift | Fast, with many rules. A permissive alternative to TruffleHog. | Same as above. |
| [Syft](https://github.com/anchore/syft) and [Grype](https://github.com/anchore/grype) | SBOM generator and vulnerability matcher. | Apache-2.0 ([Syft](https://github.com/anchore/syft/blob/HEAD/LICENSE), [Grype](https://github.com/anchore/grype/blob/HEAD/LICENSE)) | lift | Container image layers. That is a stated gap today. | No Solidity or chain-client knowledge. |
| [Trivy](https://github.com/aquasecurity/trivy) | Scanner for images, filesystems, IaC and secrets. Wrapped in infra-cloud. | [Apache-2.0](https://github.com/aquasecurity/trivy/blob/HEAD/LICENSE) | lift | One binary for image layers here. | Same as Grype. |
| [Dependency-Track](https://github.com/DependencyTrack/dependency-track) | Server that tracks SBOMs over time. | [Apache-2.0](https://github.com/DependencyTrack/dependency-track/blob/HEAD/LICENSE.txt) | lift | Continuous watch at the I tier. | Generic. |
| [LavaMoat](https://github.com/LavaMoat/LavaMoat) | Per-package policy for Node.js and browser bundles. From MetaMask. | [MIT](https://github.com/LavaMoat/LavaMoat/blob/HEAD/LICENSE) | lift | Its generated policy lists the globals and builtins each package uses. | A guard, not a scanner. We can diff the policy over time to find a package that newly asks for `window.ethereum` or the network. |
| [Sigstore cosign](https://github.com/sigstore/cosign) and [slsa-verifier](https://github.com/slsa-framework/slsa-verifier) | Verify signatures and build provenance. | Apache-2.0 ([cosign](https://github.com/sigstore/cosign/blob/HEAD/LICENSE), [slsa-verifier](https://github.com/slsa-framework/slsa-verifier/blob/HEAD/LICENSE)) | lift | Was this artifact built by the expected workflow? See also [npm provenance](https://docs.npmjs.com/generating-provenance-statements). | It proves where a build came from, not that the code is safe. A hijacked maintainer workflow still signs. |
| [Harden-Runner](https://github.com/step-security/harden-runner) | Network egress monitor for GitHub Actions runners. | [Apache-2.0](https://github.com/step-security/harden-runner/blob/HEAD/LICENSE) | lift | Runtime egress during CI. Needs a live runner. | Out of scope for an offline audit. |
| [npq](https://github.com/lirantal/npq) | Checks an npm package before install. | [Apache-2.0](https://github.com/lirantal/npq/blob/HEAD/LICENSE) | lift | Age, downloads, install scripts, known advisories. | Generic. |
| [shai-hulud-detect](https://github.com/Cobenian/shai-hulud-detect) | Script that looks for Shai-Hulud worm indicators. | [MIT](https://github.com/Cobenian/shai-hulud-detect/blob/HEAD/LICENSE) | lift | One campaign's files, hashes and workflow names. | One campaign only. |
| [Semgrep](https://github.com/semgrep/semgrep) | Pattern engine that GuardDog builds on. | [LGPL-2.1](https://github.com/semgrep/semgrep/blob/HEAD/LICENSE) | shell out | Runs our own rules. | Rules are ours to write. |
| [packj](https://github.com/ossillate-inc/packj) | Package risk audit. | [AGPL-3.0](https://github.com/ossillate-inc/packj/blob/HEAD/LICENSE) | shell out | Similar to GuardDog. | GuardDog covers it with a permissive license. |
| [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain) | Blocks known-malicious npm installs. | [AGPL-3.0 plus a commercial clause](https://github.com/AikidoSec/safe-chain/blob/HEAD/LICENSE) | read only | Install-time block from Aikido's feed. | See the [README note](README.md#license-use-modes). |
| [Socket CLI](https://github.com/SocketDev/socket-cli) | Client for Socket's hosted package analysis. | [MIT](https://github.com/SocketDev/socket-cli/blob/HEAD/LICENSE) (client only) | read only | The analysis runs in a hosted service. | Not offline. |
| [Gato-X](https://github.com/AdnaneKhan/gato-x) | GitHub Actions enumeration and attack tool. | [Apache-2.0](https://github.com/AdnaneKhan/gato-x/blob/HEAD/LICENSE) | read only | Live org enumeration. Read only today. | Same as zizmor. |

## Recommendation

1. **Wrap GuardDog and add crypto rules.** It is Apache-2.0, so we can copy its
   Semgrep and YARA rules and add our own. The new rules cover clipboard address
   swaps, wrapped `window.ethereum` or `provider.request`, swapped transaction
   `to` fields, mnemonic and keystore reads, and posts of key-like strings. Run it
   over packed tarballs from the lockfile, never over an install.
2. **Feed OpenSSF malicious-packages into OSV-Scanner.** OSV-Scanner already
   reads MAL- records. Pin a snapshot of the OSV bulk export in the lab image.
3. Next: Syft or Trivy for image layers (a stated gap), Scorecard for upstream
   hygiene, and a LavaMoat policy diff as a second lead source.

## Biggest crypto gap

**Wallet-draining code in a package is missed until someone files an advisory.**
The recent crypto supply-chain attacks were found by people, not by rules. The
Ledger Connect Kit release injected a drainer
([Ledger incident report](https://www.ledger.com/blog/security-incident-report)).
`@solana/web3.js` 1.95.6 and 1.95.7 stole private keys
([CVE-2024-54134](https://nvd.nist.gov/vuln/detail/CVE-2024-54134)). The
September 2025 `debug` and `chalk` releases swapped wallet addresses in browsers
([Aikido](https://www.aikido.dev/blog/npm-debug-and-chalk-packages-compromised),
[CISA](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)).
The Shai-Hulud worm stole tokens and spread
([Unit 42](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/)). OSV
matching is blind before the advisory exists. GuardDog has no wallet rules.
package-analysis never calls a wallet API, so nothing triggers.

A second gap: **no SCA tool reads Solidity dependencies or the compiler bug
list.** Forge submodules and Soldeer pins are not read. Neither is
[solc `bugs.json`](https://raw.githubusercontent.com/argotorg/solidity/develop/docs/bugs.json).
That list has 67 entries and a
[by-version map](https://raw.githubusercontent.com/argotorg/solidity/develop/docs/bugs_by_version.json).
The data is in the GPL-3.0 [solidity repo](https://github.com/argotorg/solidity/blob/HEAD/LICENSE.txt).
Fetch and pin it at run time. Do not commit it.

## Feeds

| Feed | What it gives | URL | Terms or note |
|---|---|---|---|
| OSV bulk export | All advisories per ecosystem as zip | <https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip> (one per ecosystem) | Per source. |
| OpenSSF malicious-packages | MAL- reports | <https://github.com/ossf/malicious-packages/tree/main/osv/malicious> | [Apache-2.0](https://github.com/ossf/malicious-packages/blob/HEAD/LICENSE) |
| GitHub advisories, malware type | npm malware advisories | <https://api.github.com/advisories?type=malware&ecosystem=npm> | [CC-BY-4.0](https://github.com/github/advisory-database/blob/HEAD/LICENSE.md) |
| RustSec | Rust crate advisories | <https://rustsec.org/>, [advisory-db](https://github.com/rustsec/advisory-db) | [CC0-1.0](https://github.com/rustsec/advisory-db/blob/HEAD/LICENSE.txt) |
| Go vulnerability DB | Go module advisories | <https://pkg.go.dev/vuln/>, [vulndb](https://github.com/golang/vulndb) | [BSD-3-Clause](https://github.com/golang/vulndb/blob/HEAD/LICENSE) |
| Solidity known bugs | Compiler bugs and affected versions | [bugs.json](https://raw.githubusercontent.com/argotorg/solidity/develop/docs/bugs.json), [bugs_by_version.json](https://raw.githubusercontent.com/argotorg/solidity/develop/docs/bugs_by_version.json), [docs page](https://docs.soliditylang.org/en/latest/bugs.html) | GPL-3.0 repo. Fetch and pin. |
| Scorecard results | Precomputed scores for popular repos | <https://scorecard.dev/> | [Apache-2.0](https://github.com/ossf/scorecard/blob/HEAD/LICENSE) tool. |
| npm provenance | Build attestations for npm packages | <https://docs.npmjs.com/generating-provenance-statements> | Public registry data. |
| NVD, KEV, GHSA | See the [shared feeds](README.md#feeds-shared-by-several-packs). | | |
