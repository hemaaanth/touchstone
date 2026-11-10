# Chain watch (M9): OSS survey

## Scope today

Read from [`spike/packs/chain-watch/pack.mjs`](../../spike/packs/chain-watch/pack.mjs),
`SKILL.md` and `TOOLS.md`.

- Tier P. Proof kind `forge`. Anvil runs a lab chain offline.
- The pack reads a block range. It watches the EIP-1967 implementation and admin
  slots, the owner, role members, a canary wallet and EIP-7702 delegation.
- Two engines give leads: our per-block slot diff, and the Forta SDK's log filter.
- Forge proves harm as `funds` (ETH leaves) or `control` (the implementation,
  admin or owner changes).
- Known gaps in `TOOLS.md`: there is no live block watcher, only one role system
  is read, there is no alert delivery, and only three control fields are read.

## Leading OSS tools

Licenses were read from each repository's LICENSE file on 2026-11-10. See the
[method](README.md#method).

| Tool | What it does | License | Use mode | Coverage | Crypto gap |
|---|---|---|---|---|---|
| [OpenZeppelin Monitor](https://github.com/OpenZeppelin/openzeppelin-monitor) | Rust service. It matches blocks, transactions, events and function calls against JSON monitor configs. It sends matches to triggers (Slack, webhook, script). | [AGPL-3.0](https://github.com/OpenZeppelin/openzeppelin-monitor/blob/HEAD/LICENSE) | shell out | EVM and Stellar networks. Event, function and transaction filters. Alert delivery. OpenZeppelin [is phasing out Defender](https://blog.openzeppelin.com/doubling-down-on-open-source-and-phasing-out-defender) in favor of these open tools. | It only matches what the config names. A slot write with no event is invisible. It has no harm oracle and no replay. |
| [Forta bot SDK](https://github.com/forta-network/forta-bot-sdk) | SDK to write detection bots over blocks, transactions and logs. Pack uses it today. | [MIT](https://github.com/forta-network/forta-bot-sdk/blob/HEAD/LICENSE) | lift | Log and trace filters, decoded events. | Last push was 2024-01-24. Treat it as low maintenance. Event-only, like OZ Monitor. |
| [Forta starter kits](https://github.com/forta-network/starter-kits) | Library of example and production bots. | [MIT](https://github.com/forta-network/starter-kits/blob/HEAD/LICENSE) | lift | Detection ideas: admin events, large transfers, and more. Their detection logic can be copied. | The bots are heuristics. None replays a change to show harm. |
| [cryo](https://github.com/paradigmxyz/cryo) | Extracts chain data over a block range into Parquet, CSV or JSON. Datasets include blocks, transactions, logs, traces and state diffs. | [MIT](https://github.com/paradigmxyz/cryo/blob/HEAD/LICENSE-MIT) or [Apache-2.0](https://github.com/paradigmxyz/cryo/blob/HEAD/LICENSE-APACHE) | lift | Every storage write in a range, not only the three slots we read today. Works against any RPC, including Anvil. | Raw data only. It does not know which slot is admin, owner or a role. |
| [WhatsABI](https://github.com/shazow/whatsabi) | Guesses an ABI from bytecode and resolves proxies. | [MIT](https://github.com/shazow/whatsabi/blob/HEAD/LICENSE) | lift | Many proxy patterns (EIP-1967, Diamond, Safe and others). | No change watching. It answers "what is this contract now", not "what changed". |
| [EVMole](https://github.com/cdump/evmole) | Extracts function selectors, arguments, state mutability and storage layout from bytecode. | [MIT](https://github.com/cdump/evmole/blob/HEAD/LICENSE) | lift | Unverified contracts. | No diff between the old and the new implementation. |
| [heimdall-rs](https://github.com/Jon-Becker/heimdall-rs) | EVM decompiler and calldata decoder. | [MIT](https://github.com/Jon-Becker/heimdall-rs/blob/HEAD/LICENSE) | lift | Turns an unverified new implementation into readable code for the agent. | No risk signal. A human or agent must read the output. |
| [OpenZeppelin Upgrades](https://github.com/OpenZeppelin/openzeppelin-upgrades) | Plugins and `upgrades-core` that check storage-layout compatibility between implementations. | [MIT](https://github.com/OpenZeppelin/openzeppelin-upgrades/blob/HEAD/LICENSE) | lift | Storage collisions and unsafe patterns before an upgrade. Needs build info. | It checks layout, not intent. A malicious but layout-safe upgrade passes. |
| [Slither](https://github.com/crytic/slither) (`slither-check-upgradeability`) | Static analyzer. The upgradeability checker compares proxy and implementation. | [AGPL-3.0](https://github.com/crytic/slither/blob/HEAD/LICENSE) | shell out | Storage collisions, missing initializers, function ID clashes. Needs source. | Source-only. It cannot judge a live upgrade to unverified bytecode. |
| [Sourcify](https://github.com/argotorg/sourcify) | Verifies contract source against deployed bytecode. Public API. | [MIT](https://github.com/argotorg/sourcify/blob/HEAD/LICENSE) | lift | "Is the new implementation verified, and by which source?" | It does not rate the risk of an unverified upgrade. |
| [safe-tx-hashes-util](https://github.com/pcaversaccio/safe-tx-hashes-util) | Bash script. It computes the Safe domain, message and transaction hashes that a signer's wallet should show. | [AGPL-3.0](https://github.com/pcaversaccio/safe-tx-hashes-util/blob/HEAD/LICENSE) | shell out | Lets each signer check the hash they sign against the queued transaction. | Manual, per transaction. No watch over the queue. No risk rating for `delegatecall`, owner or module changes. |
| [safe-hash-rs](https://github.com/Cyfrin/safe-hash-rs) | Rust tool for the same Safe hash check. | No LICENSE file found | read only | Same as above. | Same as above. |
| [Safe Transaction Service](https://github.com/safe-global/safe-transaction-service) | Indexes Safe multisigs and their queued transactions. [API docs](https://docs.safe.global/core-api/transaction-service-overview). | [MIT up to 2026-02-16, then FSL-1.1-MIT](https://github.com/safe-global/safe-transaction-service/blob/HEAD/LICENSE) | read only (use the public API as a feed) | Pending and executed multisig transactions, confirmations, owners. | A data source, not a detector. |
| [Ponder](https://github.com/ponder-sh/ponder) | TypeScript indexer framework. | [MIT](https://github.com/ponder-sh/ponder/blob/HEAD/LICENSE) | lift | Live block follow with reorg handling. Useful at I tier. | Framework only. No detectors. |
| [rindexer](https://github.com/joshstevens19/rindexer) | Rust indexer configured by YAML. | [MIT](https://github.com/joshstevens19/rindexer/blob/HEAD/LICENSE) | lift | Event indexing with no code. | Event-only. |
| [Silverback](https://github.com/ApeWorX/silverback) | Python framework for event-driven bots over blocks and events. | [Apache-2.0](https://github.com/ApeWorX/silverback/blob/HEAD/LICENSE) | lift | Live bot runtime. | Framework only. No detectors. |
| [DeFiHackLabs](https://github.com/SunWeb3Sec/DeFiHackLabs) | Foundry reproductions of real DeFi incidents. | [Apache-2.0](https://github.com/SunWeb3Sec/DeFiHackLabs/blob/HEAD/LICENSE) | lift | A large source of real attack transactions to seed labs and test the `forge` oracle. | Exploits, not monitors. |
| [Foundry](https://github.com/foundry-rs/foundry) (forge, anvil, cast) | Test runner, local chain and RPC client. Wrapped today. | [MIT](https://github.com/foundry-rs/foundry/blob/HEAD/LICENSE-MIT) or [Apache-2.0](https://github.com/foundry-rs/foundry/blob/HEAD/LICENSE-APACHE) | lift | The proof engine. | Not a monitor. |
| [mev-inspect-py](https://github.com/flashbots/mev-inspect-py) | MEV classifier over traces. | [MIT](https://github.com/flashbots/mev-inspect-py/blob/HEAD/LICENSE) | skip | Archived on GitHub. | Not maintained. |
| [Tenderly CLI](https://github.com/Tenderly/tenderly-cli) | CLI for the hosted Tenderly platform. | [GPL-3.0](https://github.com/Tenderly/tenderly-cli/blob/HEAD/LICENSE) | skip | Alerts and simulation live in the hosted service. | No offline mode. |

Hosted monitors (Hypernative, Hexagate, Cyvers, Tenderly Alerts) have no OSS
license. `TOOLS.md` already marks them `skip`.

## Recommendation

1. **Wrap cryo** for the state-diff dataset. It replaces our three-field slot
   diff with every storage write in the range. Our own code then labels the
   slots (EIP-1967, owner, roles, Safe owners and threshold, modules, guards).
   This closes the "one role system" and "three control fields" gaps in
   `TOOLS.md` without building an extractor.
2. **Shell out to OpenZeppelin Monitor** when the I tier adds a live RPC. Use its
   config format and triggers for alert delivery. Keep our slot diff as the
   second engine, because a silent upgrade has no event.
3. Cheap lifts: WhatsABI and EVMole for proxy resolution and selector diffs, and
   Sourcify to flag an upgrade to unverified code. Use DeFiHackLabs to seed labs.

## Biggest crypto gap

**Pending multisig transactions are not checked before the signers sign.**
Every tool above reacts after a transaction executes, or checks a hash only
when a person runs it by hand. None watches a Safe's queue and rates each
queued transaction before the threshold is reached. A queued transaction is
risky when it uses `delegatecall` to an unknown target, or changes owners, the
threshold, modules, guards, the fallback handler or the master copy. The
Bybit theft used a signed Safe transaction that changed the wallet's logic
([FBI IC3 PSA, 2025-02-26](https://www.ic3.gov/PSA/2025/PSA250226)). Touchstone
can read the queue from the Safe Transaction Service API. It can replay each
queued transaction on an Anvil fork and use the existing `control` oracle to
show the harm before anyone signs.

## Feeds

| Feed | What it gives | URL | Terms or note |
|---|---|---|---|
| Safe Transaction Service API | Queued and executed Safe transactions | <https://docs.safe.global/core-api/transaction-service-overview> | Public API. Code is MIT plus FSL-1.1-MIT. |
| Forta alerts API | Alerts from the Forta network bots | <https://docs.forta.network/en/latest/api/> | Needs an API key. The GraphQL endpoint returned 401 without one. |
| Sourcify API | Verified source by address | <https://docs.sourcify.dev/docs/api/> | Public. Code [MIT](https://github.com/argotorg/sourcify/blob/HEAD/LICENSE). |
| Function signature DB | Decode selectors in queued calldata | <https://4byte.sourcify.dev/> (openchain.xyz now redirects here), <https://www.4byte.directory/>, [ethereum-lists/4bytes](https://github.com/ethereum-lists/4bytes) | 4bytes repo is [MIT](https://github.com/ethereum-lists/4bytes/blob/HEAD/LICENSE). |
| OFAC sanctioned addresses | Sanctioned actors touching the protocol | [0xB10C ETH list](https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt) | [MIT](https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses/blob/HEAD/LICENSE) tool over US government data. |
| ScamSniffer scam addresses | Drainer and scam addresses | [address.json](https://github.com/scamsniffer/scam-database/tree/main/blacklist) | [GPL-3.0](https://github.com/scamsniffer/scam-database/blob/HEAD/LICENSE). Fetch and pin. Do not commit. The public list has a 7-day delay. |
| Polkadot scam addresses | Scam addresses by site | <https://polkadot.js.org/phishing/address.json> | [Apache-2.0](https://github.com/polkadot-js/phishing/blob/HEAD/LICENSE) |
| DeFiLlama hacks | Incident list with amounts and techniques | <https://api.llama.fi/hacks>, <https://defillama.com/hacks> | Public API. |
| rekt.news | Incident write-ups | <https://rekt.news/> | Editorial. Read only. |
| SEAL 911 | Emergency contact for active incidents | <https://github.com/security-alliance/seal-911> | Escalation path, not data. |
| Client advisories | Bugs in the node that serves our reads | [go-ethereum advisories](https://github.com/ethereum/go-ethereum/security/advisories) | GitHub advisories (CC-BY-4.0 in the global DB). |
