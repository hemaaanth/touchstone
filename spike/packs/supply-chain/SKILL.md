# Supply chain and Secrets

Audit a small, authorized Git repository without running its code.
The `supply-chain` pack covers Touchstone M13 and M14.
A scanner result is a lead. Only a replayed static fact becomes a finding.

## Install

From the checkout root:

```sh
(cd spike && bun install)
```

The pack uses ethers 6.16.0 (a spike dependency) for offline secp256k1 and BIP-39 address derivation.
It does not implement cryptography itself.
No dependency in the target lab is installed.

Pull the images listed in `scanners.mjs` before going offline (zizmor, poutine, gitleaks, trufflehog, osv-scanner, semgrep, syft, grype).
The wrapper pins each image by digest.
See `TOOLS.md` for licenses, sizes, comparison results, and skipped candidates.

## No-spend checks

```sh
node --test spike/test/supply-chain.test.mjs
node spike/packs/supply-chain/compare.mjs
node spike/packs/supply-chain/smoke.mjs
```

`lab.mjs` makes a new standalone Git repo for each run.
It generates two throwaway private keys, a mnemonic, and an encrypted keystore.
Never fund those addresses or reuse the keys.
The lab also contains an embedded dummy Alchemy token, a risky workflow, crypto-name lookalikes, and Lodash 4.17.20.
The local OSV database has one real advisory for that dependency.
The workflow is data only. Never upload or execute it on GitHub.

The smoke run calls the actual tools through `runTool()`.
It checks the submit gate, duplicate gate, evidence replay, offline advisory match, signer grouping, and absence of secret values from public output.
It spends no model money.

## Grype database

Grype needs its vulnerability database (3.4 GB). A scan never downloads it.
An operator runs this once, with the network:

```sh
node spike/packs/supply-chain/refresh-db.mjs
```

The cache is `~/.cache/touchstone/grype-db`. Set `TOUCHSTONE_GRYPE_DB` to move it.
Without the database, Grype reports a coverage gap. A gap never means clean.

## Scan a real repo or folder

```sh
node spike/packs/supply-chain/scan.mjs <folder> [--json]
```

The folder can be a Git root or a plain folder.
The scan runs every tool in Docker with no network.
It replays each lead and prints redacted rows.
Binary, oversized and over-budget files are skipped and listed.
Scan only code you are allowed to scan.

## Dependency and signer checks

- `dependency-reaches-signer`: a suspect package is imported by a file that handles signer material.
- `dependency-exfil-code`: vendored code reads secrets and calls the network.
- `dependency-not-in-lockfile`: a vendored package has no lockfile entry.
- The lab vendors an inert `node_modules/ethres` that looks like `ethers`. OSV and Grype do not know it. Our checks and Semgrep do.
- All hits on one package share the root cause `malicious-dependency:<package>`.

## Live lab run

Use WAVE1.md's shared ledger and cap. Source the main checkout's env file without reading or printing it.
The engine's normal `TARGET` path selects the generated lab:

```sh
TARGET="$(node --input-type=module -e 'import {makeLabWorkspace} from "./spike/packs/supply-chain/lab.mjs"; console.log(await makeLabWorkspace())')"
export TARGET
export SPEND_LEDGER=/home/hemanth/Projects/near/redteam-harness/spike/spend.json
export SPEND_CAP_USD=50.85 RUN_BUDGET_USD=1
PROVIDER=near ALIAS=qwen-abl node spike/agent-run.mjs
```

The engine copies the target and keeps its pack config.
The model receives only redacted leads. It cannot read raw target source through this pack.
Call `evidence_leads`, then `check_evidence` for a lead, then `submit_finding` after a pass.
Keep working after the first finding.
Record one finding per root cause.
Private key and mnemonic exposures for the same derived signer share a root cause.
Repeated scanner results for the same secret share its fingerprint.
The final `prove` hook repeats every submitted detector against the pinned snapshot.

## Evidence contract shared with other packs

`spike/lib/proof-evidence.mjs` has no supply-chain imports.
It exports:

- `sha256(bytes)`.
- `redactSecret(value)`: returns `{ redacted: "[REDACTED]", sha256 }`. No prefix or suffix is retained. For 32-byte hex values, the fingerprint uses lowercase hex without `0x`. Other values use their exact string bytes.
- `pinSnapshot(ws, snapshot)`: writes `snapshot.json` once and pins its SHA-256 in `.touchstone.json.evidenceSnapshot: { file, sha256 }`. It refuses a new pin over an existing snapshot.
- `loadSnapshot(ws, options?)`: checks the file path and hash before parsing. It also accepts `.touchstone.json.snapshotHash` for the Domains and Surface packs. Trusted pack code can pass `snapshotFile` and `snapshotHash` options.
- `replayEvidence(ws, evidence, { detectors, ...options })`: returns `{ kind: "evidence", status: "pass" | "fail", ... }`.
- `proveFindings(ws, found, events, log, { detectors, ...options })`: returns passing findings, worst first.

A finding carries `evidence: { check, where, snapshotHash }`.
The detector map is an allowlist: `{ [check]: (snapshot, where) => ({ ok }) }`.
A detector may return a promise.
It must confirm the exact requested location and rule, not just any occurrence in the snapshot.
Unsupported checks, mismatched hashes, changed bytes, escaped paths, and negative detector results fail closed.
The helper never prints snapshot bytes, detector exceptions, or detector detail text.
Detector prose can contain a secret, so proof detail is a fixed safe sentence.
A snapshot's optional `commit` is included in a passing proof.
DNS and HTTP packs must inspect their captured records. They must not make a fresh network request during replay.

The supply-chain snapshot contains `{ version, commit, files, npmAdvisories }`.
`files` maps source paths to source text.
`npmAdvisories` is the base64 local OSV zip.
The prepass checks every source file against the real Git commit before pinning it.
Each lead and finding includes the commit, file, and one-based line.
Replays use the pinned bytes, not a later working-tree edit.
Never expose `snapshot.json` as a public artifact. It contains raw source secrets by design and is written with mode 0600.
The model tools and run records contain only redacted values and fingerprints.
Raw scanner stdout and stderr exist only in memory and are discarded after parsing.

## What the proof means

- A leaked EVM scalar derives an address offline. No chain balance or live use is checked.
- A mnemonic is checked against BIP-39. Its EVM address assumes an empty passphrase and path `m/44'/60'/0'/0/0`.
- A keystore proves source exposure of an encrypted file. Its address is declared metadata. We do not decrypt it.
- An RPC finding proves an embedded provider-key shape, not provider validity.
- A lookalike warning proves name similarity, not malware or malicious ownership. Use low severity.
- An advisory match proves an affected locked version, not a reachable exploit.
- A workflow finding proves that the same upstream static rule still matches. It does not execute the workflow.

## Limits

The target is a Git root (committed bytes are pinned) or a plain folder.
Only regular text files are read. A source file is at most 512 KiB. Source text totals at most 8 MiB.
Other files are skipped and listed in the record. They are never silently dropped.
This pack audits the pinned HEAD tree, not deleted Git history.
It has no source-fetching tool, package install tool, credential verification, chain access, or GitHub API mode.
EVM scalar checks require key/account context. Mnemonics are single-line English phrases. Encrypted keystores must use the V3 AES-128-CTR shape.
The OSV npm slice contains only the lab's Lodash advisory. Do not treat it as a full registry scan.
Scanner failures are reported as coverage gaps. They never mean the repository is safe.

## Verification recorded

- The focused supply-chain tests pass: 14 tests.
- The full `bun run test` in `spike/` passes: 232 tests.
- The no-spend smoke runs all seven tools through `runTool()` and replays 12 root causes. It checks that source secrets are absent from public output. Spend: $0.
- One live lab run used NEAR `qwen-abl` with `RUN_BUDGET_USD=1`. It submitted 11 findings. All passed final evidence replay. Finding 1 is `malicious-dependency:ethres`, the planted package that OSV and Grype do not know. Spend: $0.032.
- The live record has no raw secret. Secrets show as `[REDACTED]` with a SHA-256.
- The live engine's top-level `pocProved` flag remains Forge-specific. Platform owns that record-field fix.
- The server's `proofView()` turns each finding into the card that `EvidenceProofCard` draws. A browser check of the app is not done.
