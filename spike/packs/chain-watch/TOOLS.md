# Chain watch: integration research

Module M9. Same table as `packs/README.md`. Licenses marked "check" must be
confirmed against the upstream repo before a release. All wrapped tools run in the
image `touchstone-chain-tools:wave1` (built from `../keys/runtime/Dockerfile`),
with `--network none`, through `lib/wrap.mjs` `runTool()`.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| Foundry (forge) | MIT or Apache-2.0 | `ghcr.io/foundry-rs/foundry:latest` through `forgeTest` | Yes | Workspace with `test/` | `forge test --json -vvvv` | The proof itself | `forge`: the test replays green, shows the admin change, and the proxy loses ETH to another address | None | Cheatcodes (`vm.load`, `vm.prank`, `vm.getRecordedLogs`) | We add the harm oracle | wrap |
| Anvil | MIT or Apache-2.0 | Binary in the tools image, started by `observe.mjs` | Yes | None, a fresh local chain | JSON-RPC on `127.0.0.1` inside the container | Blocks, logs and storage slots of the lab proxy | None | None | None | None | wrap |
| Forta (`forta-agent` 0.1.48) | MIT | `runtime/monitor.mjs` in the tools image. `TransactionEvent.filterLog` decodes the logs | Yes. It does not call the Forta network | Raw logs from `eth_getLogs`, grouped per transaction | Decoded admin events: `Upgraded`, `AdminChanged`, `RoleGranted`, `RoleRevoked`, `OwnershipTransferred` | Event name, address, block, transaction hash | `forge` | Touchstone slot diff | The SDK is called. No bot code is copied | Reads logs only. It is blind to a change with no event | ensemble |
| Touchstone slot diff (ours) | Ours | `observe.mjs` `chainWatch()` takes a snapshot per block. `common.mjs` `watchLeads` compares them | Yes | EIP-1967 implementation and admin slots, owner, role members, per block | Slot changes by block | `implementation-changed`, `admin-changed`, `owner-changed`, `role-granted`, `role-revoked`, and a note when the matching event is missing | `forge` | Forta | None | A silent upgrade (no `Upgraded` event) shows only here | own |
| Touchstone canary and actor checks (ours) | Ours | Same container | Yes | Canary wallet balances and code, transactions per sender | Canary moves, delegation, actor groups | `canary-wallet-moved`, `actor-correlation` | `forge` | None | None | No open-source monitor does gap-5 canary wallets or 7702 delegation checks | own |
| OpenZeppelin Monitor | AGPL-3.0 | Not wired. A Rust service with a config of networks, monitors and triggers | Needs an RPC and a block range. Could point at Anvil | Monitor JSON plus RPC | Matches, sent to triggers (Slack, webhook) | Same events as Forta | None | Forta | None | None | evaluated, not wired. Runs as a separate program only. Its value is alert delivery, which this lab has no use for |
| Forta bots (network, `forta-network`) | Per bot. Mostly MIT | Not wired | No. The Forta network is a live service | Live blocks | Alerts | Many | None | Forta SDK | Detection ideas only | Not offline | read-only |
| Tenderly Alerts | Hosted, proprietary | Not wired | No | Live chain | Alerts | Many | None | Forta | None | None | skip (hosted, no offline mode) |
| Hypernative, Cyvers | Hosted, proprietary | Not wired | No | Live chain | Alerts | Many | None | Forta | None | None | skip (hosted) |
| cast (Foundry) | MIT or Apache-2.0 | Binary in the tools image | Yes | Local RPC | `cast storage`, `cast logs` | Slot values and logs | None | The slot diff reads the same data | None | None | wrap (manual cross-check only) |

## Gaps in our wrapping

- The lab replays a fixed list of transactions. The agent reads a range. It does
  not watch blocks as they arrive. A live watcher needs the scope proxy, the
  grant and an RPC (I tier).
- Role reads use one role mapping (`hasRole[role][account]`). Other role systems
  (OpenZeppelin `AccessControl` enumerable roles, Zodiac Roles, custom ACL) are not read.
- No alert delivery. The leads go to the agent and the run record.

## Candidates from the research (03-capabilities.md M9, 04-crypto-coverage.md, 07-gap-5)

| Tool | Why | Open questions |
|------|-----|----------------|
| OpenZeppelin Monitor | Open-source monitor with config and triggers. It would give alert delivery | AGPL. Run as a separate program. Is the config format stable? |
| Forta bot library | Many detection bots: upgrades, ownership, oracle, large transfers | Which bots are MIT and self-contained? |
| Ethereum Execution Specs and `eth_getProof` | Verify a storage slot with a proof instead of trusting an RPC | Needs a light client in the image. |
| Proxy-upgrade diff tools (OpenZeppelin Upgrades, `slither-check-upgradeability`) | Check that a new implementation keeps the storage layout | Slither is AGPL. Run as a separate program. Chain it from this pack to Contracts. |
| Dune and Etherscan label datasets | Know the actor behind an address | Network. Licenses differ. |
| 7702 delegation trackers | Watch for wallets that delegate code | No open-source tracker found. The canary check covers this in the lab. |
