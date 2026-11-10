# Keys and signing: integration research

Module M12. Same table as `packs/README.md`. Licenses marked "check" must be
confirmed against the upstream repo before a release. All wrapped tools run in the
image `touchstone-chain-tools:wave1` (built from `runtime/Dockerfile`), with
`--network none`, through `lib/wrap.mjs` `runTool()`.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| Foundry (forge) | MIT or Apache-2.0 | `ghcr.io/foundry-rs/foundry:latest` through `forgeTest` | Yes | Workspace with `test/` | `forge test --json -vvvv` | The proof itself | `forge`: the test replays green and a Safe loses ETH to another address | None | Cheatcodes (`vm.sign`, `vm.getCode`, `vm.prank`) | We add the harm oracle: the Safe must lose ETH and another address must gain it | wrap |
| Anvil | MIT or Apache-2.0 | Binary in the tools image, started by `observe.mjs` | Yes | None, a fresh local chain | JSON-RPC on `127.0.0.1` inside the container | Chain state of the deployed Safes | None | None | None | None | wrap |
| Safe contracts 1.4.1 (`@safe-global/safe-contracts`) | LGPL-3.0 | Build artifacts only (`Safe.json`, `SafeProxy.json`, support contracts). The pre-pass writes them into the workspace from the npm package. They are loaded with `vm.getCode`. Nothing from Safe is stored in our repo | Yes | Constructor args | Deployed Safe | The target itself | The lab target | None | Artifacts used as bytes, not as source | We pick weak setups on purpose | wrap (artifacts, separate bytecode) |
| Safe protocol-kit (`@safe-global/protocol-kit`) | MIT | `observe.mjs` in the tools image, `Safe.init` on the local RPC | Yes, with contract addresses passed in `contractNetworks` | Safe address and RPC | owners, threshold, modules, nonce, version | Second reader. A fact both readers return makes the lead `corroborated` | `forge` | Touchstone ethers reader | The SDK is called, not copied | We run our checks over what the SDK reads | ensemble |
| ethers v6 | MIT | Same container | Yes | Safe address | Raw storage and `eth_getCode` reads | Owners, threshold, modules, guard, fallback handler, code at each owner | `forge` | Safe protocol-kit | None | Reads the guard and fallback slots and 7702 delegation. The SDK does not | wrap |
| Touchstone Safe checks (ours) | Ours | `common.mjs` `keysLeads`, pure functions | Yes | The observation file | Ranked leads | `threshold-one`, `threshold-below-majority`, `owner-known-key`, `owner-7702-delegated`, `owner-is-contract`, `module-enabled`, `no-guard`, `fallback-handler-set`, `old-safe-version`, `signer-reuse` | `forge` | None | None | This is the crypto gap: no open-source tool does these checks on a lab chain | own |
| safe-tx-hashes-util (`pcaversaccio`) | AGPL-3.0 | Not wired | Needs the Safe Transaction Service (network) | Safe tx or message hash | Verified hash, decoded call | Would flag a signed hash that does not match the call shown to signers | `evidence` (later) | None | None | Blind-signing check. Needs a real Safe tx history | read-only (separate program, never pasted) |
| safe-cli (`safe-global/safe-cli`) | MIT | Not wired | Needs an RPC. Could point at Anvil | Safe address | Prints owners, threshold, modules | None beyond protocol-kit | None | Safe protocol-kit | None | None | skip (protocol-kit already covers it) |
| safe-hash-rs (`Frontier159/safe-hash-rs`) | License not confirmed | Not wired | Hash computation is offline | Tx fields | Safe tx hash | Hash mismatch | None | safe-tx-hashes-util | None | Same as safe-tx-hashes-util | read-only until the license is checked |

## Gaps in our wrapping

- The lab has two Safes with fixed weak setups. The agent reads them and proves
  harm. It does not scan a Safe by address on a live chain. That needs the scope
  proxy and the grant (I tier).
- Only Safe 1.4.1 is deployed. The `old-safe-version` check fires on the version
  string. The lab has no old singleton to exploit.
- The blind-signing check (hash shown to signers against the call executed) needs
  the Safe Transaction Service. No tool in this pack can run it offline yet.

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
