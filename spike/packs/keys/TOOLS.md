# Keys and signing: integration research

Module M12. Same table as `packs/README.md`. Licenses marked "check" must be
confirmed against the upstream repo before a release. All wrapped tools run in the
image `touchstone-chain-tools:wave1` (built from `runtime/Dockerfile`), with
`--network none`, through `lib/wrap.mjs` `runTool()`.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| Foundry (forge) | MIT or Apache-2.0 | `ghcr.io/foundry-rs/foundry:latest` through `forgeTest` | Yes | Workspace with `test/` | `forge test --json -vvvv`, and `-vvvvv` for the proof replay (storage writes) | The proof itself | `forge`: the test replays green, and either a Safe loses ETH to another address (`funds`) or the replay changes a lab owner, threshold, module, guard, fallback handler or EIP-7702 delegation (`control`) | None | Cheatcodes (`vm.sign`, `vm.getCode`, `vm.prank`) | We add the harm oracle: funds harm or control harm, read from the replay state diff. A proxy owner or admin change is harm only when its caller did not already hold that role: the owner handing over control is legitimate (`lib/control-trace.mjs` records each write's caller and prior owner or admin as `writeMeta`, `control.mjs`) | wrap |
| Anvil | MIT or Apache-2.0 | Binary in the tools image, started by `observe.mjs` | Yes | None, a fresh local chain | JSON-RPC on `127.0.0.1` inside the container | Chain state of the deployed Safes | None | None | None | None | wrap |
| Safe contracts 1.4.1 (`@safe-global/safe-contracts`) | LGPL-3.0 | Build artifacts only (`Safe.json`, `SafeProxy.json`, support contracts). The pre-pass writes them into the workspace from the npm package. They are loaded with `vm.getCode`. Nothing from Safe is stored in our repo | Yes | Constructor args | Deployed Safe | The target itself | The lab target | None | Artifacts used as bytes, not as source | We pick weak setups on purpose | wrap (artifacts, separate bytecode) |
| Safe protocol-kit (`@safe-global/protocol-kit`) | MIT | `observe.mjs` in the tools image, `Safe.init` on the local RPC | Yes, with contract addresses passed in `contractNetworks` | Safe address and RPC | owners, threshold, modules, nonce, version | Second reader. A fact both readers return makes the lead `corroborated` | `forge` | Touchstone ethers reader | The SDK is called, not copied | We run our checks over what the SDK reads | ensemble |
| ethers v6 | MIT | Same container | Yes | Safe address | Raw storage and `eth_getCode` reads | Owners, threshold, modules, guard, fallback handler, code at each owner | `forge` | Safe protocol-kit | None | Reads the guard and fallback slots and 7702 delegation. The SDK does not | wrap |
| Touchstone Safe checks (ours) | Ours | `common.mjs` `keysLeads`, pure functions | Yes | The observation file | Ranked leads | `threshold-one`, `threshold-below-majority`, `owner-known-key`, `owner-7702-delegated`, `owner-is-contract`, `module-enabled`, `no-guard`, `fallback-handler-set`, `old-safe-version`, `signer-reuse` | `forge` | None | None | This is the crypto gap: no open-source tool does these checks on a lab chain | own |
| Aderyn 0.6.8 (`Cyfrin/aderyn`) | MIT | `lib/aderyn.mjs` `aderynScan`, through `runTool()`, image `touchstone/aderyn:0.6.8`, `--network none` | Yes | The workspace `src/` and `foundry.toml` | JSON report of High and Medium issues | Up to 10 leads, merged into the source leads. A lead both Aderyn and our checks return is `corroborated` | `forge` | Our source checks | None. The binary is run, not copied | On the chain-watch lab source it did **not** flag the planted open `upgradeTo`. Our source check does | ensemble |
| Slither (`crytic/slither`) | AGPL-3.0 | **Not wrapped in this pack.** `lib/static.mjs` runs it with a direct `docker` `execFile`, not `runTool()`. That file is a seam file, so this thread did not change it | Yes (Docker, no network) | A Foundry project | Detector findings | Would add a second static engine beside Aderyn | `forge` | Aderyn | None | None | skip here, until `static.mjs` moves to `runTool()`. Run as a separate program only |
| Touchstone source checks (ours) | Ours | `source-checks.mjs`, pure text checks, called by `common.mjs` `sourceLeads`. It runs on any Foundry folder, with or without the lab world | Yes | `src/**/*.sol`. Comments are stripped first. Vendored folders are skipped: `lib` at the repo root, and `node_modules` or `vendor` anywhere. A first-party `src/lib/` is scanned. A function with an unknown modifier or helper (`onlyGov`, `_checkGov()`) is Medium, not High, because a gate may exist. A gate is a `require`, `assert` or `if` that COMPARES `msg.sender` inside its own condition (`==`, `!=`, `admins[msg.sender]`, `hasRole(..., msg.sender)`), in the function or in a file-local modifier. Logging, storing or passing `msg.sender` is not a gate. Neither is comparing it to `address(0)` or `tx.origin`, a lookup like `lastm[msg.sender] > 0`, or an `if` whose branch does not revert. `tx.origin` is never a gate | Ranked leads with file and line | `ecrecover-zero-address`, `signature-malleability`, `signature-replay-no-nonce`, `signature-no-domain`, `tx-origin-auth`, `unprotected-control-function`, `unprotected-implementation-write`, `module-no-access-control`, `silent-upgrade-path`, `uups-authorize-empty`, `initializer-unprotected`, `implementation-initializable`, `delegatecall-user-target`, `unprotected-selfdestruct`, `hardcoded-private-key` | `forge` | Aderyn (partial) | None | This is the crypto gap: signature checks (zero address, malleability, replay, domain), tx.origin auth, and open owner, module or upgrade functions. The wrapped tools miss these | own |
| cast (Foundry) | MIT or Apache-2.0 | Binary is in the tools image. Nothing in this pack calls it | Yes | Local RPC | `cast storage`, `cast logs` | Slot values and logs | None | `observe.mjs` ethers reads and the forge cheatcodes read the same data | None | None | skip (in the image, not called, no gain over what we read) |
| safe-tx-hashes-util (`pcaversaccio`) | AGPL-3.0 | Not wired | Needs the Safe Transaction Service (network) | Safe tx or message hash | Verified hash, decoded call | Would flag a signed hash that does not match the call shown to signers | `evidence` (later) | None | None | Blind-signing check. Needs a real Safe tx history | read-only (separate program, never pasted) |
| safe-cli (`safe-global/safe-cli`) | MIT | Not wired | Needs an RPC. Could point at Anvil | Safe address | Prints owners, threshold, modules | None beyond protocol-kit | None | Safe protocol-kit | None | None | skip (protocol-kit already covers it) |
| safe-hash-rs (`Frontier159/safe-hash-rs`) | License not confirmed | Not wired | Hash computation is offline | Tx fields | Safe tx hash | Hash mismatch | None | safe-tx-hashes-util | None | Same as safe-tx-hashes-util | read-only until the license is checked |

## Source mode (a real folder)

Run `TARGET=<dir> node agent-run.mjs`. The folder needs `.touchstone.json` with
`{"pack":"keys"}`, `foundry.toml`, `src/`, `test/` and `lib/forge-std`. There is no lab
world, so no Anvil reads. The pre-pass runs the source checks and Aderyn. The agent
writes a Foundry test. The same `forge` oracle proves funds or control harm.
`test/keys-source.test.mjs` runs this path with no model spend.

Scopes in the app can only run the `contracts` and `review` packs. A real folder reaches
this pack through the CLI only. That is a platform gap, not a pack gap.

## Gaps in our wrapping

- Slither and cast are not wrapped here. See their rows above.

- The lab has two Safes with fixed weak setups. The agent reads them and proves
  harm. It does not scan a Safe by address on a live chain. That needs the scope
  proxy and the grant (I tier).
- Only Safe 1.4.1 is deployed. The `old-safe-version` check fires on the version
  string. The lab has no old singleton to exploit.
- The blind-signing check (hash shown to signers against the call executed) needs
  the Safe Transaction Service. No tool in this pack can run it offline yet.

- Control harm reads Safe 1.4.1 slots only: singleton, owner count, threshold, guard,
  fallback handler, and the owner and module list entries. Other slots are not control.
- EIP-7702 is proven by `vm.etch` of an `ef0100` designator on a lab account, then a call
  to it. The vendored forge-std has no `signAndAttachDelegation`. The lab accounts are
  owners with a public key, and owners that already have delegation code.
- `vm.store` writes are not counted. Writes in a constructor, in a reverted call, or in
  Safe `setup` on a Safe the test made or a lab Safe it rebuilt are not counted. Safe
  `setup` on a lab account (an owner with a public key or delegation code) is counted: it
  is the takeover of an uninitialised 7702 account. The live run found this path.

## Candidates from the research (03-capabilities.md M12, 04-crypto-coverage.md, 07-gap-5)

| Tool | Why | Open questions |
|------|-----|----------------|
| Wallet Guard and Blockaid transaction simulation | Shows what a signed transaction does before signing | Both are hosted services. No offline mode. |
| Fireblocks and Cobo MPC audit tools | MPC signer setups | Closed. Not self-hostable. |
| Hardware wallet firmware verifiers (Ledger, Trezor) | Device integrity | Needs a device. Not a lab check. |
| Safe `SafeGuard` and module allowlists from OpenZeppelin Defender | Policy for modules and guards | Defender is hosted and being retired. Read the docs for check ideas only. |
| Slither and Aderyn on custom modules | Find bugs in a module the Safe enables | Overlaps the Contracts pack. Chain a module scan from this pack to Contracts. |
| Echidna on Safe modules | Fuzz a module's access to `execTransactionFromModule` | Needs a harness per module. |
| Key-ceremony and Shamir share checkers | MPC and key-ceremony gaps (07-gap-5) | No offline open-source checker found. |
