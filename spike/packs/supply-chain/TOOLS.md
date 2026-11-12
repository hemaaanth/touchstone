# Supply chain and Secrets: tool choices

Checked upstream repositories, release tags, licenses, and image manifests on 2026-11-10.
Sizes below use decimal MB. Selected images use Docker's installed size.
Unselected images use the amd64 compressed layer size from their manifest.
The image digest in `scanners.mjs` pins every selected tool.
All scans and replays use `runTool()` with `--network none`.
No scanner receives the model key, Docker socket, host home, or other host secrets.

Research starts at M13 and M14 in `03-capabilities.md`, the supply-chain and secrets rows in `04-crypto-coverage.md`, and `07-gap-5.md` / `07-gap-6.md` in the main checkout's research folder.
That research folder is not tracked in this worktree.

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [zizmor](https://github.com/zizmorcore/zizmor) | MIT | `ghcr.io/zizmorcore/zizmor:1.32.0`; 65.0 MB | Yes: `--offline`; no remote rules | Workflow files | `--format sarif` | Rule, file, line, impact; no source excerpts | `evidence`: rerun the same rule at the same line | Poutine found the execution chain; zizmor added permissions, persistence and pins | No copied code; upstream rules stay in the image | Does not derive leaked signer addresses | **ensemble** with poutine; complementary workflow rules |
| [poutine](https://github.com/boostsecurityio/poutine) | Apache-2.0 | `ghcr.io/boostsecurityio/poutine:1.1.6`; 113.5 MB. The `v1.1.6` image tag does not exist | Yes: `analyze_local`; version checks disabled; network blocked | Local repo files | `--format sarif` | Rule, workflow file, line, impact | `evidence`: rerun matching rule and location | Found `untrusted_checkout_exec`, which zizmor did not report as that chain | No copied Rego; rules stay in image | No crypto signer context | **ensemble** with zizmor; confirms the PR-head execution path |
| [Gato-X](https://github.com/AdnaneKhan/gato-x) | Apache-2.0 | Release `v1.4.0` Python wheel. No Docker image is documented in its README; no container files at repo root. Size not measured | Its documented search and enumeration modes need GitHub and a PAT | GitHub orgs, repos, workflow history | JSON / text | Would need a captured remote result and provenance; no adapter here | No proof adapter in this pack | Workflow overlap with zizmor/poutine, but its strength is cross-repo remote enumeration | Read only; no copied attack code | No offline wallet derivation | **read only**; remote enumeration and attack modes are outside this offline lab |
| [OSV-Scanner](https://github.com/google/osv-scanner) | Apache-2.0 | `ghcr.io/google/osv-scanner:v2.7.1`; 475.3 MB | Yes: `--offline --no-call-analysis --no-resolve`; cached npm `all.zip` supplied | Pinned `package-lock.json` and advisory slice | `--format json` | Advisory ID, package/version, lockfile, package-entry line | `evidence`: rerun the offline version match | Alternative to Grype for this lockfile lab | One unmodified GitHub advisory through OSV; CC-BY-4.0; see THIRD_PARTY.md | Name similarity is not an advisory | **wrap**; matched the planted Lodash version without network |
| [GuardDog](https://github.com/DataDog/guarddog) | Apache-2.0 | Manifest checked: `ghcr.io/datadog/guarddog:3.2.0`; 114.7 MB compressed | Local package source scans can run offline. Registry metadata and remote package scans need network | Package directory/archive, registry metadata | `--output-format=json`; SARIF for verify | Would need a source location from a local package scan | No proof adapter in this pack | Overlaps package-risk review; this lab has a lockfile, not installed package source | Read only; no copied Semgrep or YARA | Adds our explicit crypto-name watchlist instead | **skip**; no local package payload to assess; do not install suspect dependencies |
| [Syft](https://github.com/anchore/syft) | Apache-2.0 | `anchore/syft@sha256:03215d0e…` (v1.57.1); 31.7 MB compressed | Yes for local directories; update checks disabled; network blocked | The pinned snapshot, materialized in a scratch folder | `-o syft-json` | Inventory only. It feeds Grype as an SBOM and never leads on its own | None. It is not a scanner, so it has no detector | Complements Grype; OSV reads lockfiles directly | Read only | Does not see wallet-secret impact | **wrap** (through Grype); its SBOM is how Grype sees packages in every ecosystem, not only npm |
| [Grype](https://github.com/anchore/grype) | Apache-2.0 | `anchore/grype@sha256:13113eec…` (v0.121.3); 32.9 MB compressed. Database v6: 3.4 GB | Yes with a preloaded database. `GRYPE_DB_AUTO_UPDATE=false`, `GRYPE_DB_VALIDATE_AGE=false`, `GRYPE_CHECK_FOR_APP_UPDATE=false`, network blocked | Syft SBOM of the snapshot | `-o json -q` | Advisory ID, package, version, lockfile and line, impact from the advisory severity | `evidence`: `tool:grype` reruns Syft and Grype on the pinned snapshot and matches file, line and advisory | Agreed with OSV on all four Lodash 4.17.20 advisories. Grype has the full database; OSV has the one-record lab slice. They corroborate and rank first | Read only | No crypto package-name or signer context; does not know the planted `ethres` | **wrap**; the only tool with a full vulnerability database. An operator runs `refresh-db.mjs` once (the only network step). The cache is hard linked into each scan, so a scan never downloads. (A read-only mount would be safer. Noted, not done.) A missing database is a coverage gap, never a clean result |
| [Semgrep](https://github.com/semgrep/semgrep) | LGPL-2.1 engine; separate program only | `semgrep/semgrep@sha256:cc1b6826…`; image size not measured | Yes: `--metrics off --disable-version-check`, own rules by path, network blocked | The pinned snapshot, including vendored `node_modules/`. We write a `.semgrepignore` because the default skips `node_modules/` | `--sarif` | Rule id, file, line, impact. Rule ids lose Semgrep's folder prefix | `evidence`: `tool:semgrep` reruns the same rules on the pinned snapshot | Our taint rules see the key leaving through `https.request` in vendored code. OSV, Grype and gitleaks do not | None. The registry rules use the Semgrep Rules License, which is not open for this use. GuardDog's rules are YARA now. We wrote three rules ourselves in `rules/crypto-supply-chain.yml` | `process.env` secrets and signer fields (`privateKey`, `mnemonic`, `signingKey`) that reach a network call, and `eval` of base64 text. Both are what a malicious wallet dependency does | **wrap**; own rules only, offline, run in Docker |
| [TruffleHog](https://github.com/trufflesecurity/trufflehog) | AGPL-3.0; separate program only | `trufflesecurity/trufflehog:3.99.8`; 117.6 MB | Yes: `filesystem --no-verification --no-update`; network blocked | Snapshot files, not `.git` internals | `--json` JSONL | Detector and file/line; Raw becomes a hash and `[REDACTED]` in memory; drop all other raw fields | `evidence`: repeat detection; never a live credential claim | Found Alchemy where Gitleaks did not; own RPC check corroborates it | No copied AGPL code or rules | Missed the deployer scalar and mnemonic in this lab | **ensemble** with Gitleaks and crypto checks; provider-specific coverage |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | MIT | `ghcr.io/gitleaks/gitleaks:v8.30.1`; 78.1 MB | Yes: `dir`; no provider verification | Snapshot files | `--report-format json --report-path /dev/stdout` | Rule and file/line; Secret becomes a hash; Match and source excerpts are discarded | `evidence`: rerun detector and secret fingerprint at the line | Found generic wallet key; missed Alchemy and unlabeled `accounts` value | MIT PEM private-key rule and default-rule extension workflow; retained notice | Add EVM key validation/address, BIP-39, keystore and provider URL checks | **ensemble** with TruffleHog; generic and provider-specific coverage differ |
| [Kingfisher](https://github.com/mongodb/kingfisher) | Apache-2.0 | `ghcr.io/mongodb/kingfisher:2.18.1`; 113.2 MB. Tag has no `v` prefix | Yes: `--no-validate --no-update-check --git-history none`; network blocked | Files / Git | `--format json` emitted a report and a summary as separate JSON lines in this version; `--redact` hashes values | No findings in this lab under its default medium confidence | No retained proof adapter | Compared with Gitleaks and TruffleHog on the same generated lab | No copied rules | Did not add coverage for these planted crypto cases | **skip**; no extra detections in this lab, not a general claim about its quality |

## Evaluated, not wrapped (research-named OSS, M13–M14)

The table above lists what this pack runs plus the three it compared and rejected
(Gato-X, GuardDog, Kingfisher). The M13/M14 research and the coverage audit name
more OSS tools. Each gets a verdict so a deliberate skip and an un-examined gap
differ. The driving facts: this pack audits a **pinned offline snapshot** and
never touches live GitHub settings or an SCM API; workflow security is carried by
the zizmor + poutine ensemble; Gato-X is already the read-only reference for the
remote-enumeration class.

| Tool | Space | Verdict | Reason |
|------|-------|---------|--------|
| OSSF Scorecard | Repo posture scored via GitHub API | skip — not offline | Needs the GitHub API and a token to read live repo settings (branch protection, etc.). This pack explicitly does not scan live GitHub settings. |
| Allstar | GitHub App enforcing org policy | skip — out of model | A running GitHub App / org-policy enforcer, not a scanner. Needs a live org. |
| Legitify | GitHub/GitLab org + repo misconfig via API | skip — not offline | Needs an SCM API token for live settings enumeration — the same remote class Gato-X already represents read-only. |
| chain-bench | CIS supply-chain benchmark against an SCM | skip — not offline | Needs SCM API access to live settings; outside the pinned-snapshot model. |
| cosign (Sigstore) | Artifact / attestation signing and verification | skip; defer for provenance | A signing/verification tool, not a scanner; verification needs a live transparency log or registry. Wire only if artifact-provenance verification becomes a goal. |
| octoscan | Static GitHub Actions scanner | skip — overlap | Overlaps the wrapped zizmor + poutine workflow engines; no distinct detection shown to justify a third. |
| raven | CI/CD pipeline graph scanner | skip — not offline + overlap | Ingests workflows from the GitHub API into a graph DB; its strength is cross-repo scale, like Gato-X, outside the single-snapshot model. |
| actionlint | GitHub Actions workflow linter | skip — out of model | A correctness/style linter, not a security scanner; the security-relevant workflow checks are carried by zizmor + poutine, and a lint warning is not harm. |

## Comparison observed

Run `node spike/packs/supply-chain/compare.mjs` to repeat the comparison.
It prints only rule IDs and source locations. It never prints raw scanner output.
Each run uses newly generated throwaway wallet material.

- zizmor: seven results. Five concern security. Two are style or concurrency advice and do not enter the lead board.
- poutine: two results. One identifies PR-head checkout followed by execution. One warns about a third-party action creator.
- Gitleaks: one generic key result in `wallet.env`.
- TruffleHog: one Alchemy credential in source. A raw filesystem scan also finds its compressed Git object. The production wrapper scans only materialized pinned source, so that duplicate cannot enter the lead board.
- Kingfisher: zero findings. Its summary says validation is skipped and update checks are disabled.
- OSV: one advisory, `GHSA-35jh-r3h4-6jhm` / `CVE-2021-23337`, for Lodash 4.17.20. The cached npm database contains only this record. It is a lab slice, not a complete vulnerability database.

The crypto checks find both private keys, the mnemonic, the encrypted keystore, the RPC provider key, and two package-name lookalikes.
The private key and mnemonic derive the same wallet address and share one root cause.
The default mnemonic path is `m/44'/60'/0'/0/0`, with an empty passphrase.
The keystore address is declared metadata. We do not decrypt it or prove control of that address.

## Upstream checks

Licenses were checked through each repository's GitHub metadata and README.
Selected image tags were pulled and inspected. Their exact manifest digests are in `scanners.mjs`.
The unselected GuardDog, Syft and Grype tags were checked with `docker manifest inspect --verbose`.
Gato-X's README documents a Python package and GitHub API modes, not an offline container scan.

Offline support: [zizmor CLI](https://docs.zizmor.sh/usage/), [poutine README](https://github.com/boostsecurityio/poutine), [OSV offline mode](https://google.github.io/osv-scanner/usage/offline-mode/), [GuardDog README](https://github.com/DataDog/guarddog), [Syft README](https://github.com/anchore/syft), [Grype configuration](https://oss.anchore.com/docs/reference/grype/configuration/), [TruffleHog README](https://github.com/trufflesecurity/trufflehog), [Gitleaks CLI](https://github.com/gitleaks/gitleaks), [Kingfisher usage](https://github.com/mongodb/kingfisher/blob/v2.18.1/docs/USAGE.md).

## Limits

This pack audits a pinned snapshot: the Git HEAD tree (committed files only; untracked and ignored files are counted, and `--worktree` reads them), or a plain folder. Binary, oversized and over-budget files (8 MiB total) are skipped. The record keeps counts per reason and folder, and the full list is written to a file. A skipped file in `node_modules/<package>` is a coverage gap. Dependency heuristics have known evasions: see SKILL.md Limits. It does not scan deleted history, live GitHub settings, package registries, installed dependency payloads, or container image layers.
Tools run offline and read a pinned snapshot. `scan.mjs <folder>` runs them on a real repo or folder. There is no credential verification, chain query, transaction, exploit workflow, or network fallback.
A tool error remains an explicit coverage error. A missing advisory database is not a clean result.
The bundled advisory record is narrow by design. Other dependencies need a separately supplied and pinned database.

## Added in Wave 2

- **Grype and Syft** are wrapped. Syft makes the SBOM. Grype reads it against its own database. They agree with OSV on the lab.
- **Semgrep** is wrapped with three original rules.
- **Crypto checks** in `crypto.mjs`: `dependency-reaches-signer` (a suspect package imported by a file that handles signer material), `dependency-exfil-code` (vendored code that reads secrets and calls the network), and `dependency-not-in-lockfile`. A lookalike, a signer reach, an exfil match and a semgrep hit on one package are one root cause: `malicious-dependency:<package>`.
- **Lab plant**: `node_modules/ethres` is vendored into the lab workspace. It is inert and looks like `ethers`. The lockfile does not list it. OSV and Grype find nothing on it. Our checks and Semgrep do.
- **Real input**: `node packs/supply-chain/scan.mjs <folder>`. It reads a Git root or a plain folder and prints redacted leads with a replay result.
- **Rule lifts**: none new. See Semgrep above. The earlier Gitleaks lift stays in `THIRD_PARTY.md`.
- **Viewer note**: the evidence `where` uses the key `fingerprint`, not `secretHash`. The viewer redacts any key whose name looks secret, and it would show the hash of the hash.
