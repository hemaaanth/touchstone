# Chain watch: integration research

Module M9. Same table as `packs/README.md`. Licenses marked "check" must be
confirmed against the upstream repo before a release. The chain tools run in the
image `touchstone-chain-tools:wave1` (built from `../keys/runtime/Dockerfile`),
with `--network none`, through `lib/wrap.mjs` `runTool()`. Slither and Aderyn have
their own images, also `--network none`. OpenZeppelin Monitor is the one exception: it
needs a chain to read, so it runs on an owned `--internal` Docker network (no route out)
whose only other member is a lab Anvil.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| Foundry (forge) | MIT or Apache-2.0 | `ghcr.io/foundry-rs/foundry:latest` through `forgeTest` | Yes | Workspace with `test/` | `forge test --json -vvvv`, and `-vvvvv` for the proof replay (storage writes) | The proof itself | `forge`: the test replays green, and either the proxy loses ETH to another address (`funds`) or the replay changes the EIP-1967 implementation or admin slot or the owner (`control`) | None | Cheatcodes (`vm.load`, `vm.prank`, `vm.getRecordedLogs`) | We add the harm oracle: funds harm or control harm, read from the replay state diff. A proxy owner or admin change is harm only when its caller did not already hold that role: the owner handing over control is legitimate (`lib/control-trace.mjs` records each write's caller and prior owner or admin as `writeMeta`, `packs/keys/control.mjs`) | wrap |
| Anvil | MIT or Apache-2.0 | Binary in the tools image, started by `observe.mjs` | Yes | None, a fresh local chain | JSON-RPC on `127.0.0.1` inside the container | Blocks, logs and storage slots of the lab proxy | None | None | None | None | wrap |
| Forta (`forta-agent` 0.1.48) | MIT | `runtime/monitor.mjs` in the tools image. `TransactionEvent.filterLog` decodes the logs | Yes. It does not call the Forta network | Raw logs from `eth_getLogs`, grouped per transaction | Decoded admin events: `Upgraded`, `AdminChanged`, `RoleGranted`, `RoleRevoked`, `OwnershipTransferred` | Event name, address, block, transaction hash | `forge` | Touchstone slot diff | The SDK is called. No bot code is copied | Reads logs only. It is blind to a change with no event | ensemble |
| Touchstone slot diff (ours) | Ours | `observe.mjs` `chainWatch()` takes a snapshot per block. `common.mjs` `watchLeads` compares them | Yes | EIP-1967 implementation and admin slots, owner, role members, per block | Slot changes by block | `implementation-changed`, `admin-changed`, `owner-changed`, `role-granted`, `role-revoked`, and a note when the matching event is missing | `forge` | Forta | None | A silent upgrade (no `Upgraded` event) shows only here | own |
| Touchstone canary and actor checks (ours) | Ours | Same container | Yes | Canary wallet balances and code, transactions per sender | Canary moves, delegation, actor groups | `canary-wallet-moved`, `actor-correlation` | `forge` | None | None | No open-source monitor does gap-5 canary wallets or 7702 delegation checks | own |
| Aderyn 0.6.8 (`Cyfrin/aderyn`) | MIT | `lib/aderyn.mjs` `aderynScan`, through `runTool()`, image `touchstone/aderyn:0.6.8`, `--network none` | Yes | The workspace `src/` and `foundry.toml` | JSON report of High and Medium issues | Up to 10 leads, merged into the source leads. A lead both Aderyn and our checks return is `corroborated` | `forge` | Our source checks | None. The binary is run, not copied | On the chain-watch lab source it did **not** flag the planted open `upgradeTo`. Our source check does | ensemble |
| Slither 0.11.6 (`crytic/slither`) | AGPL-3.0 (crytic-compile 0.4.2 and solc-select 1.2.0 are AGPL-3.0 too; solc is GPL-3.0) | `lib/slither.mjs` `slitherLeads`, through `runTool()` (`--network none`, `--pull=never`), image `touchstone/slither:0.11.6` built from `slither/Dockerfile` by `tools/build-slither-image.sh`. The Dockerfile pins the base images by digest, every Python package by exact version (`slither/requirements.txt`), forge 1.9.0, and solc 0.8.38 by SHA-256. The scan copies `/work` to `/tmp` in the container first, because crytic-compile runs `forge clean` and `forge build`. The workspace is not written | Yes. solc is inside the image (`FOUNDRY_SOLC`, `FOUNDRY_OFFLINE`). A run never downloads a compiler | The workspace as a Foundry project. `lib/`, `test/`, `script/`, `node_modules` and `vendor` are filtered out | JSON detector report. Informational and Optimization are dropped | Up to 10 High and Medium leads, named `Contract.member (file:line)`, merged into the chain leads before Aderyn in each impact class. They reach the agent in the brief, not in `watch_leads`. Fail closed: a missing image, a timeout (the container is removed), a non-zero exit, a compile error (also a pragma that excludes 0.8.38), an unreadable report, or a report with no `results` object gives `slither: false` in the record and a NOTE in the brief that says the code is not clean. A result for a file that is not in the workspace (absolute, `../`, or missing) is dropped | `forge`. A Slither lead is never a finding | Aderyn, our source checks | None. The binary is run as a separate program. No Slither code is copied or imported | On the chain-watch lab it flags `uninitialized-state` (High, High confidence) on `VaultImplementationV2.initialized`: the flag is read and never set, so anyone can re-initialize and drain. Our source checks and Aderyn raise nothing on that file. `oracle/ReinitVaultTest.t.sol` proves it with funds harm. `test/slither.test.mjs` | wrap |
| Touchstone source checks (ours) | Ours | `source-checks.mjs`, pure text checks, called by `common.mjs` `sourceLeads`. It runs on any Foundry folder, with or without the lab world | Yes | `src/**/*.sol`. Strings and comments are blanked first, in one pass. Vendored folders are skipped: `lib` at the repo root, and `node_modules` or `vendor` anywhere. A first-party `src/lib/` is scanned. A function with an unknown modifier or helper (`onlyGov`, `_checkGov()`) is Medium, not High, because a gate may exist. A gate is a `require`, `assert` or `if` that COMPARES `msg.sender` inside its own condition (`==`, `!=`, `admins[msg.sender]`, `hasRole(..., msg.sender)`), in the function or in a file-local modifier. Logging, storing or passing `msg.sender` is not a gate. Neither is comparing it to `address(0)` or `tx.origin`, a lookup like `lastm[msg.sender] > 0`, or an `if` whose branch does not revert. The gate must dominate the state write: a write before a non-reverting `if`, or outside a positive `if` block, is not gated. `tx.origin` is never a gate | Ranked leads with file and line | `unprotected-control-function`, `unprotected-implementation-write`, `silent-upgrade-path`, `uups-authorize-empty`, `initializer-unprotected`, `implementation-initializable`, `delegatecall-user-target`, `unprotected-selfdestruct`, `tx-origin-auth`, `module-no-access-control`, plus the signature checks | `forge` | Aderyn (partial) | None | A proxy function that changes the implementation with no caller check, and that emits no event, is found here. An event monitor cannot see it. Aderyn does not rank it | own |
| OpenZeppelin Monitor 1.7.0 (`OpenZeppelin/openzeppelin-monitor`) | AGPL-3.0 (image label `org.opencontainers.image.licenses`; upstream revision `4565bb18`) | `lib/oz-monitor.mjs` `ozMonitorLeads`, through `runTool()` (`--pull=never`, no capabilities), image `touchstone/oz-monitor:1.7.0` built from `oz-monitor/Dockerfile` by `tools/build-oz-monitor-image.sh`. The Dockerfile pins the upstream image by digest (`sha256:0d5ac201…`, linux/amd64) and adds two shell scripts: `run.sh` runs the real binary once per monitor and block (`--monitor-path … --network lab --block N`), and `record.sh` is the script trigger that keeps each match | No public network. It runs on a fresh `docker network create --internal` network. The code checks that Docker reports `Internal: true` before it starts anything. The only other member is our own lab Anvil (`observe.mjs chain-watch --serve`, alias `labchain`). `test/oz-monitor.test.mjs` shows a container on that network reaches the lab and cannot open a TCP connection to `1.1.1.1:443`. So it is not `--network none`, as the owner allowed for this row | A second, deterministic run of the chain-watch lab world, started by the adapter. It is not the chain the pre-pass observed (that container is gone by then). Same addresses and blocks. The monitor config is built from this run's own observation | Matches as JSON on the trigger's stdin: the monitor name, the transaction, the matched functions and events, and their decoded arguments | Three monitors over the lab range (blocks 5 to 11). `admin`: the five admin functions and five admin events of the proxy. It reads calls, so it sees the silent upgrade at block 5 too. Those leads use the slot diff's check names and merge with it. `non_owner`: the same functions, only for a successful call whose sender is not the owner the lab read at the baseline block. One `admin-call-by-non-owner` lead (High) per sender, with each call, its arguments and its block. `canary`: any successful transaction from the canary wallet, merged with our canary lead. The leads reach the agent in the brief, not in `watch_leads`. Fail closed: a missing image, a lab that does not start or stops, a network that is not internal, a timeout, a run that exits non-zero (an unreachable RPC exits 1), a run with no match count, a trigger that kept fewer matches than the monitor reported (the monitor exits 0 even when its trigger fails), or a match we cannot read gives `ozMonitor: false` in the record and a NOTE in the brief that says the chain is not clean. Lab mode only: source mode has no chain, so it does not run | `forge`. A Monitor lead is never a finding | Forta, the slot diff, our canary check | None. The binary is run as a separate program. No Monitor code is copied or imported | On the chain-watch lab it reports that `0x7099…79c8` called `upgradeTo` on the proxy and succeeded at blocks 5 (`announce=false`, to the drain implementation) and 6, and that this sender is not the owner `0xf39f…2266`. No other pack engine raised a lead that says a non-owner called an admin function on chain. Our source check already flags `ChainWatchLab.upgradeTo` as `unprotected-control-function` from the code text; the Monitor adds the on-chain evidence: who called it, with what, at which block. It also gives the silent upgrade at block 5 its second engine (before, only the slot diff saw it) and corroborates the canary move at block 11. `test/oz-monitor.test.mjs` | wrap |
| Forta bots (network, `forta-network`) | Per bot. Mostly MIT | Not wired | No. The Forta network is a live service | Live blocks | Alerts | Many | None | Forta SDK | Detection ideas only | Not offline | read-only |
| Tenderly Alerts | Hosted, proprietary | Not wired | No | Live chain | Alerts | Many | None | Forta | None | None | skip (hosted, no offline mode) |
| Hypernative, Cyvers | Hosted, proprietary | Not wired | No | Live chain | Alerts | Many | None | Forta | None | None | skip (hosted) |
| cast (Foundry) | MIT or Apache-2.0 | Binary is in the tools image. Nothing in this pack calls it | Yes | Local RPC | `cast storage`, `cast logs` | Slot values and logs | None | `observe.mjs` ethers reads and the forge cheatcodes read the same data | None | None | skip (in the image, not called, no gain over what we read) |

## Source mode (a real folder)

Run `TARGET=<dir> node agent-run.mjs` on a folder with `{"pack":"chain-watch"}` in
`.touchstone.json`. With no lab proxy there is no chain observation. The pre-pass runs
the source checks, Slither and Aderyn. The agent reads the leads, writes a Foundry test, and the
`forge` oracle proves funds or control harm. See `../keys/TOOLS.md` for the folder layout
and the scope limit.

## Gaps in our wrapping

- Slither compiles with one solc, 0.8.38, inside the image. A project whose pragma excludes
  0.8.38 gets no Slither leads. The brief then says Slither did not run. It is not read as clean.
- Slither runs on the source only. It does not read the lab chain state.
- The Slither image is amd64 only: the Dockerfile adds the `linux-amd64` solc. Python
  packages are pinned by exact version, not by hash. An arm64 host has no Slither leads,
  and the brief says so.
- `lib/static.mjs` (the contracts pack) still runs its own Slither from the
  `eth-security-toolbox` image without `runTool()`. That seam file is unchanged.
- OpenZeppelin Monitor watches its own second run of the lab world, not the run the
  pre-pass observed. The lab is deterministic, so the blocks match. A lab that is not
  deterministic would need the monitor to read the observed chain itself.
- OpenZeppelin Monitor runs on an `--internal` network, not `--network none`. The owner
  allowlist for `non_owner` is the owner the lab read at the baseline block. An owner that
  changes inside the range is not followed. Only one proxy and one canary are watched.
- OpenZeppelin Monitor leads are in the brief and the record only. `watch_leads` does not
  return them. Its alerting (Slack, webhook, email) is not used.
- OpenZeppelin Monitor adds about 15 seconds to a lab pre-pass (one lab start, 21 one-shot runs).

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
| Forta bot library | Many detection bots: upgrades, ownership, oracle, large transfers | Which bots are MIT and self-contained? |
| Ethereum Execution Specs and `eth_getProof` | Verify a storage slot with a proof instead of trusting an RPC | Needs a light client in the image. |
| Proxy-upgrade diff tools (OpenZeppelin Upgrades, `slither-check-upgradeability`) | Check that a new implementation keeps the storage layout | Slither is AGPL. Run as a separate program. Chain it from this pack to Contracts. |
| Dune and Etherscan label datasets | Know the actor behind an address | Network. Licenses differ. |
| 7702 delegation trackers | Watch for wallets that delegate code | No open-source tracker found. The canary check covers this in the lab. |
