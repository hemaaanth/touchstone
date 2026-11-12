# Chain watch: integration research

Module M9. Same table as `packs/README.md`. Licenses marked "check" must be
confirmed against the upstream repo before a release. All wrapped tools run in the
image `touchstone-chain-tools:wave1` (built from `../keys/runtime/Dockerfile`),
with `--network none`, through `lib/wrap.mjs` `runTool()`.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| Foundry (forge) | MIT or Apache-2.0 | `ghcr.io/foundry-rs/foundry:latest` through `forgeTest` | Yes | Workspace with `test/` | `forge test --json -vvvv`, and `-vvvvv` for the proof replay (storage writes) | The proof itself | `forge`: the test replays green, and either the proxy loses ETH to another address (`funds`) or the replay changes the EIP-1967 implementation or admin slot or the owner (`control`) | None | Cheatcodes (`vm.load`, `vm.prank`, `vm.getRecordedLogs`) | We add the harm oracle: funds harm or control harm, read from the replay state diff (`lib/control-trace.mjs`, `packs/keys/control.mjs`) | wrap |
| Anvil | MIT or Apache-2.0 | Binary in the tools image, started by `observe.mjs` | Yes | None, a fresh local chain | JSON-RPC on `127.0.0.1` inside the container | Blocks, logs and storage slots of the lab proxy | None | None | None | None | wrap |
| Forta (`forta-agent` 0.1.48) | MIT | `runtime/monitor.mjs` in the tools image. `TransactionEvent.filterLog` decodes the logs | Yes. It does not call the Forta network | Raw logs from `eth_getLogs`, grouped per transaction | Decoded admin events: `Upgraded`, `AdminChanged`, `RoleGranted`, `RoleRevoked`, `OwnershipTransferred` | Event name, address, block, transaction hash | `forge` | Touchstone slot diff | The SDK is called. No bot code is copied | Reads logs only. It is blind to a change with no event | ensemble |
| Touchstone slot diff (ours) | Ours | `observe.mjs` `chainWatch()` takes a snapshot per block. `common.mjs` `watchLeads` compares them | Yes | EIP-1967 implementation and admin slots, owner, role members, per block | Slot changes by block | `implementation-changed`, `admin-changed`, `owner-changed`, `role-granted`, `role-revoked`, and a note when the matching event is missing | `forge` | Forta | None | A silent upgrade (no `Upgraded` event) shows only here | own |
| Touchstone canary and actor checks (ours) | Ours | Same container | Yes | Canary wallet balances and code, transactions per sender | Canary moves, delegation, actor groups | `canary-wallet-moved`, `actor-correlation` | `forge` | None | None | No open-source monitor does gap-5 canary wallets or 7702 delegation checks | own |
| Aderyn 0.6.8 (`Cyfrin/aderyn`) | MIT | `lib/aderyn.mjs` `aderynScan`, through `runTool()`, image `touchstone/aderyn:0.6.8`, `--network none` | Yes | The workspace `src/` and `foundry.toml` | JSON report of High and Medium issues | Up to 10 leads, merged into the source leads. A lead both Aderyn and our checks return is `corroborated` | `forge` | Our source checks | None. The binary is run, not copied | On the chain-watch lab source it did **not** flag the planted open `upgradeTo`. Our source check does | ensemble |
| Slither (`crytic/slither`) | AGPL-3.0 | **Not wrapped in this pack.** `lib/static.mjs` runs it with a direct `docker` `execFile`, not `runTool()`. That file is a seam file, so this thread did not change it | Yes (Docker, no network) | A Foundry project | Detector findings | Would add a second static engine beside Aderyn | `forge` | Aderyn | None | None | skip here, until `static.mjs` moves to `runTool()`. Run as a separate program only |
| Touchstone source checks (ours) | Ours | `source-checks.mjs`, pure text checks, called by `common.mjs` `sourceLeads`. It runs on any Foundry folder, with or without the lab world | Yes | `src/**/*.sol`. Comments are stripped first. Vendored folders (`lib`, `node_modules`, `vendor`) are skipped | Ranked leads with file and line | `unprotected-control-function`, `unprotected-implementation-write`, `silent-upgrade-path`, `uups-authorize-empty`, `initializer-unprotected`, `implementation-initializable`, `delegatecall-user-target`, `unprotected-selfdestruct`, `tx-origin-auth`, `module-no-access-control`, plus the signature checks | `forge` | Aderyn (partial) | None | A proxy function that changes the implementation with no caller check, and that emits no event, is found here. An event monitor cannot see it. Aderyn does not rank it | own |
| OpenZeppelin Monitor | AGPL-3.0 | Not wired. A Rust service with a config of networks, monitors and triggers | Needs an RPC and a block range. Could point at Anvil | Monitor JSON plus RPC | Matches, sent to triggers (Slack, webhook) | Same events as Forta | None | Forta | None | None | evaluated, not wired. Runs as a separate program only. Its value is alert delivery, which this lab has no use for |
| Forta bots (network, `forta-network`) | Per bot. Mostly MIT | Not wired | No. The Forta network is a live service | Live blocks | Alerts | Many | None | Forta SDK | Detection ideas only | Not offline | read-only |
| Tenderly Alerts | Hosted, proprietary | Not wired | No | Live chain | Alerts | Many | None | Forta | None | None | skip (hosted, no offline mode) |
| Hypernative, Cyvers | Hosted, proprietary | Not wired | No | Live chain | Alerts | Many | None | Forta | None | None | skip (hosted) |
| cast (Foundry) | MIT or Apache-2.0 | Binary is in the tools image. Nothing in this pack calls it | Yes | Local RPC | `cast storage`, `cast logs` | Slot values and logs | None | `observe.mjs` ethers reads and the forge cheatcodes read the same data | None | None | skip (in the image, not called, no gain over what we read) |

## Source mode (a real folder)

Run `TARGET=<dir> node agent-run.mjs` on a folder with `{"pack":"chain-watch"}` in
`.touchstone.json`. With no lab proxy there is no chain observation. The pre-pass runs
the source checks and Aderyn. The agent reads the leads, writes a Foundry test, and the
`forge` oracle proves funds or control harm. See `../keys/TOOLS.md` for the folder layout
and the scope limit.

## Gaps in our wrapping

- Slither is not wrapped here. See its row above.

- The lab replays a fixed list of transactions. The agent reads a range. It does
  not watch blocks as they arrive. A live watcher needs the scope proxy, the
  grant and an RPC (I tier).
- Role reads use one role mapping (`hasRole[role][account]`). Other role systems
  (OpenZeppelin `AccessControl` enumerable roles, Zodiac Roles, custom ACL) are not read.
- No alert delivery. The leads go to the agent and the run record.
- Control harm reads three fields of the lab proxy: the EIP-1967 implementation slot, the
  EIP-1967 admin slot, and the owner at slot 0. Roles are not read as control.
- `vm.store` writes, constructor writes and writes in reverted calls are not counted.

## Candidates from the research (03-capabilities.md M9, 04-crypto-coverage.md, 07-gap-5)

| Tool | Why | Open questions |
|------|-----|----------------|
| OpenZeppelin Monitor | Open-source monitor with config and triggers. It would give alert delivery | AGPL. Run as a separate program. Is the config format stable? |
| Forta bot library | Many detection bots: upgrades, ownership, oracle, large transfers | Which bots are MIT and self-contained? |
| Ethereum Execution Specs and `eth_getProof` | Verify a storage slot with a proof instead of trusting an RPC | Needs a light client in the image. |
| Proxy-upgrade diff tools (OpenZeppelin Upgrades, `slither-check-upgradeability`) | Check that a new implementation keeps the storage layout | Slither is AGPL. Run as a separate program. Chain it from this pack to Contracts. |
| Dune and Etherscan label datasets | Know the actor behind an address | Network. Licenses differ. |
| 7702 delegation trackers | Watch for wallets that delegate code | No open-source tracker found. The canary check covers this in the lab. |
