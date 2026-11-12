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
node spike/packs/supply-chain/scan.mjs <folder> [--json] [--worktree] [--skipped-out <file>]
```

The folder can be a Git root or a plain folder.
The scan runs every tool in Docker with no network.
It replays each lead and prints redacted rows.
Scan only code you are allowed to scan.

**Scope.** A Git root is scanned as *committed files only*. The output says so.
Untracked files (such as `.env`) and ignored files (such as `node_modules/`) are not read.
The scan counts them and prints the counts, with a per-folder summary, as a coverage gap.
A file deleted in the working tree is still read from its commit.
Add `--worktree` to read untracked and ignored files too. That mode has no commit pin.
A plain folder is read as it is.

**Skipped files.** Binary, oversized and over-budget files are skipped.
The output prints counts per reason and per top-level folder.
The full list is written to a file (`--skipped-out`, default under `~/.cache/touchstone/scans/`).
A skipped code file inside `node_modules/<package>` raises a coverage gap. That package was not fully checked.
An empty folder prints a clear message and exits 1.

## Dependency and signer checks

- `dependency-reaches-signer`: a suspect package is imported by a file that handles signer material.
- `dependency-exfil-code`: vendored code reads a secret and calls the network within 8 lines, after comments are removed. Type files (`.d.ts`) and minified bundles are skipped.
- `dependency-not-in-lockfile`: a package is declared in `package.json` but the lockfile next to it has no entry. A lockfile scan never sees it. Low impact. It is a suspect only when its name also looks like a known crypto package.
- Trust rule: a package that is locked under its own name with an integrity hash and a registry source is trusted. Its code hits are Medium, not High. The canonical packages (`ethers`, `viem`, `web3` and so on) are skipped.
- A lookalike name is never trusted, even when locked. A typosquat from the registry has a real integrity hash. So a vendored lookalike with exfil code is High, and a vendored or declared lookalike that is used as a signer is a suspect (Medium without code evidence).
- A lookalike name alone (such as `view` or `web`) is a Low lead. It becomes a Medium suspect only when a file uses it as a signer.
- Lookalike names include edit-distance-1 typos, swapped letters, and affix squats: a known name plus `js`, `sdk`, `lib`, `node` or `client` (`ethers-js`, `web3.js`, `viem-sdk`, `@solana/web3.js-sdk`). Real names and real families (`web3-utils`, `@ethersproject/*`) are not flagged.
- Network sinks for exfil: `fetch`, `http(s).request/get`, `axios`, `got`, `ky`, `needle`, `superagent`, `undici`, `navigator.sendBeacon`, `net`/`tls` connect, DNS, `WebSocket`, `XMLHttpRequest`. The Semgrep rules cover the same clients.
- `evm-private-key` needs the 64-hex value assigned or listed after a key word (`KEY=0x..`, `"privateKey": "0x.."`, `accounts: ["0x.."]`). Lines with `bytes32`, `_ROLE` or `keccak256` are role or hash constants and are skipped.
- `dependency-reaches-signer` needs the imported binding to be used as a signer, such as `new Wallet(process.env.DEPLOYER_KEY)`, `new ethers.Wallet(pk)`, `Wallet.fromPhrase(words)`, or `new ethers.Contract(addr, abi, wallet)`. The word `Wallet` in a comment does not count. A lookalike that is not locked is capped at Medium.
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
A Git scan reads committed files only. Untracked and ignored files are counted, not read. Use `--worktree` to read them.
Only regular text files are read. A source file is at most 512 KiB. Source text totals at most 8 MiB.
Other files are skipped. The record keeps counts per reason and per folder, and the full list goes to a file next to the run. It never lives only in memory.
This pack audits the pinned HEAD tree, not deleted Git history.

Known evasions. The dependency checks are static and heuristic. They miss:

- an exfil that splits the secret read and the network call across two files, or more than 8 lines apart;
- a secret read through destructuring, such as `const { PRIVATE_KEY } = process.env`, before the sink;
- minified or bundled code, and `.d.ts` files (skipped on purpose, because they caused false positives);
- module names built at run time, and native or binary add-ons;
- a hijacked canonical package that is locked with a valid integrity hash.

A clean result is never proof of a clean dependency tree. OSV and Grype cover known advisories. Semgrep covers our own rules.

Network and host exceptions. Every scanner runs in Docker with `--network none` and no host execution.
Two steps are different. `refresh-db.mjs` uses the network, and an operator runs it. `snapshot.mjs` runs host `git` to read the repository (`ls-files`, `cat-file`). It never runs target code.
It has no source-fetching tool, package install tool, credential verification, chain access, or GitHub API mode.
EVM scalar checks require key/account context. Mnemonics are single-line English phrases. Encrypted keystores must use the V3 AES-128-CTR shape.
The OSV npm slice contains only the lab's Lodash advisory. Do not treat it as a full registry scan.
Scanner failures are reported as coverage gaps. They never mean the repository is safe.

## Verification recorded

- The focused supply-chain tests pass: 33 tests (14 first delivery, 10 repair 1, 2 repair 2, 7 deep review).
- The full `bun run test` in `spike/` passes (count in the repair report).
- The no-spend smoke runs all seven tools through `runTool()` and replays 12 root causes. It checks that source secrets are absent from public output. Spend: $0.
- One live lab run used NEAR `qwen-abl` with `RUN_BUDGET_USD=1`. It submitted 11 findings. All passed final evidence replay. Finding 1 is `malicious-dependency:ethres`, the planted package that OSV and Grype do not know. Spend: $0.032.
- The live record has no raw secret. Secrets show as `[REDACTED]` with a SHA-256.
- The live engine's top-level `pocProved` flag remains Forge-specific. Platform owns that record-field fix.
- The server's `proofView()` turns each finding into the card that `EvidenceProofCard` draws. A browser check of the app is not done.
