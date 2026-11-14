# What a run may reach

Status: decided 2026-11-14 by the owner. This page is the authority. Where an older
page, comment or prompt says something narrower, that older text is wrong.

## The rule

**A run may use the network.** Nothing in the product depends on being offline.
Some checks read files and need no network; some already reach the internet; a
replay may read a real chain. Which of those happens is a property of the module
and the scope, not a promise the product makes about itself.

## What each surface actually does

| Surface | Reaches the network? | Detail |
|---|---|---|
| Contracts, a lab | No | A lab is a local Foundry project. Its analysis tools run in Docker with `--network none`, and the proof deploys the code in a local EVM. |
| Contracts, a scope with GitHub links | Yes, on the host | `fetch_source` clones the scope's links on the host, and the host warms the `solc` versions those files pin. The sandbox itself stays offline for that step. |
| Contracts, a **forked** scope | **Yes, the chain** | The replay forks a real chain at a pinned block and reads it through an RPC. The container joins the network for that read. Requires an RPC in Settings and a block pin; see below. |
| Contracts, a target with a shipped `*.runtime.hex` | No | The bytecode tools (Mythril, Heimdall) run offline, and Heimdall skips online signature lookup. |
| Keys and signing | No | Anvil runs inside our sandbox. `offline: true` on the pack. |
| Chain watch | No | Same: a local Anvil world. |
| Web and sign-in, AI and MCP, Infra and cloud | No, against their own labs | The labs are Docker services on a private network with no route out. |
| Web, AI and MCP, Domains, Surface, Supply chain, Phishing, **live** scopes | **Yes** | A live scope is a real host the operator holds a grant for. Traffic goes through the scope proxy, which enforces the grant. |
| Domains, Surface, Phishing captures | **Yes** | Their capture tools use the open bridge network, confined by the scope proxy. |
| Supply chain, a GitHub repo or org | **Yes** | Read through the read-only GitHub API with the operator's token. |
| The agent itself | **Yes** | Model calls go to the provider's API. A free-roam child has an open network on its own machine. |

## The one thing a run still never does

**No transaction on a live chain.** A fork is read-only: `eth_call`, storage
reads, logs. Nothing signs, nothing broadcasts, nothing spends. The proof's EVM is
a copy of a past block in the sandbox; it is not the chain. That boundary is about
**funds**, not about being offline, and it does not move.

## A forked replay, exactly

1. The scope carries `fork: { chain, block }`. The block is **required**: a pin
   that can move is not a proof.
2. Settings holds one RPC per chain, beside the provider keys
   (`spike/data/providers.json`, mode 0600, gitignored). The URL never enters the
   workspace, a run record, a finding or a replay bundle: it reaches the replay as
   an environment variable.
3. The module's needs (`spike/lib/module-needs.mjs`) decide whether the module can
   run. No RPC for that chain, or no block, and the module is greyed out in the
   console and refused at run start, from the same table.
4. The proof is judged by an oracle that names what it measured. The offline
   channels look for harm to a contract the test deployed from source. The
   **deployed** oracle (`spike/lib/oracle-deployed.mjs`) looks for harm to a real
   address instead, from the fork's own trace. A cheatcode that fakes a target's
   state disqualifies it in either case.
5. A pinned address is a victim only when the test did not create code there. A
   fork's addresses exist before the test runs, so a `CREATE` at a pinned address
   means the test put its own contract at a victim's address, and the proof fails.
6. A `Transfer` log counts here, and not offline, for one reason: on a fork the
   token at an address is the chain's real token, so nobody in the test chooses what
   it emits. Offline the gate still requires the emitter to be a scope contract with
   a balance slot that really moved.
7. A fork may be created once in `setUp`. Rolling, re-selecting or replaying a
   transaction inside the test body is refused: that is how a test rewinds time to
   make a loss look bigger.

Verified against a real incident: **Euler, 2023-03, $197M**. The corpus PoC drains
real DAI from a real address at block 16817995, and the deployed oracle credits it
(`test/oracle-deployed.test.mjs`, opt-in, needs an RPC and the corpus).

The deployed oracle **cannot** prove: a lock or an insolvency with no transfer (that
needs a separate channel, not built); a loss where the pinned contract is not the
payer; or a loss that depends on state before the operator's pin.

## Why this is safe

- The sandbox is a throwaway container, mounted only the run workspace and the
  solc cache. It has no credentials except the one RPC it was given.
- The RPC is the only credential a fork sees, and it can read a chain, not write
  to one.
- A live scope already required a grant before this change; a fork requires an RPC
  configured by the operator. Neither widens what a run *does*, only the one place
  it may read.

## The oracle that judges a forked proof

Two oracles decide what harm means, and a finding records which one judged it.

| Oracle | Victim | Used when | What it can prove |
|---|---|---|---|
| **Scope code** (the offline channels) | a contract the replay CREATEd from source in `src/` or `vendor/` | every run without a pin | ETH or an in-scope ERC-20 left it, or an owner/admin/implementation slot was repointed |
| **Deployed** (`spike/lib/oracle-deployed.mjs`) | an address the operator pinned | a run with a fork pin | the pinned address lost native ETH or an ERC-20 and another address gained it |
| **Locked** (`spike/lib/oracle-locked.mjs`) | a holder the replay acted for | any run, tried when the transfer channels find nothing | a withdrawal the holder was entitled to reverted while they still held a claim, read from the target's own storage |

The **locked** oracle is what sees the harm class with no transfer in it: the holder
keeps their receipt and cannot turn it into assets. It needs three things and refuses
without all of them: the call was made by a non-test party, it reverted, and the
holder still has a claim afterwards (a share or deposit slot from the compiled layout).
A guard working correctly is a revert with no claim left, and is not harm.
Until it existed, `lab/vault-shares`' own reference exploit proved a lock with
`vm.expectRevert()` and the gate scored it as "no harm".

The deployed oracle closes four forgeries the offline gate never had to face, and
one that only a fork creates:

- `vm.etch` at a pinned address — it is no longer the deployed contract;
- `vm.prank` as a pinned address — the test cannot be its own victim;
- `vm.store` / `mockCall` on a pinned address — the loss may be what it granted;
- a wildcard tamper — disqualifies every pinned address;
- **code the test CREATEd at a pinned address** — a fork's addresses already
  exist, so that contract is the test's, not the chain's.

Known limits, stated rather than discovered later: a lock or insolvency with no
transfer; a loss where the pinned contract is not the payer; a loss that depends on
state before the pin.
