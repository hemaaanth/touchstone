# PR #9 — review blockers

The PR remains open and unmerged. Neither main nor the owner release includes
these changes. Reconciled local candidate: `2ed40ee5d2d33791e29ab1dd1a6c66a5b2562547`
on `takeover/pr9`. Original head: `77386e0e8c1775f960d544279d0618d0f135645d`.

The parent also reproduced a false positive through real offline Foundry:
a holder deposited 1 ETH; a safe vault correctly rejected withdrawing 2 ETH;
the new locked oracle returned proven harm. No external target or real RPC was used.

Disposition: do not land either new oracle as a proven-finding path. A sound
repair needs entitlement evidence, common tamper/backstop enforcement, authentic
asset and final-state accounting, operator-pin binding, and an isolated RPC
transport that never hands credentials or host networking to submitted code.
Keep useful source work preserved; continue independent delivery slices.

## Independent proof/RPC review

Not ready to merge. The new oracles weaken the proven-finding boundary.

Reviewed head `77386e0e8c1775f960d544279d0618d0f135645d`. Actual merge base: `c858f83faeac1016056ad1a8e8eb1957f4cb19f7`. Compared the scoped files with assembled candidate `2ed40ee5d2d33791e29ab1dd1a6c66a5b2562547`. The relevant oracle and proof code is unchanged. The sandbox difference is main’s cleanup change.

## Findings

1. **P1 — A correct withdrawal refusal becomes proven locked harm.**  
   `spike/lib/oracle-locked.mjs:175-196`

   The oracle checks a reverted withdrawal and a positive claim. It never checks entitlement to the requested withdrawal.

   Independent synthetic `proofDelta` reproduction: holder owns 10 shares and requests 11. Result: `pass:true`, `harm.ok:true`, `kind:"locked"`, `stillOwed:"10"`.

   I also read the parent’s owned `/tmp/pr9-locked-negative.log`. It records the same failure through actual Foundry: deposit 1 ETH, correctly reject withdrawal of 2 ETH, report proven locked harm. That runtime execution was the parent’s, not mine.

2. **P1 — Fallback oracles bypass existing tamper and backstop refusals.**  
   `spike/lib/proof.mjs:167-175`

   `judgeHarm` removes unusable targets. The locked fallback receives a fresh, unfiltered `scanTargets(...).targets` instead. It does not receive `controlTrace`. The deployed oracle receives that trace but does not enforce its global backstop.

   Synthetic `proofDelta` reproductions returned `harm.ok:true` after:
   - `vm.store` on the locked target;
   - `vm.etch` on the locked target;
   - `vm.revertToState` in the body, through either fallback.

   The extracted control trace contained the rollback backstop. The fallback still promoted the replay.

3. **P1 — Arbitrary Transfer logs prove deployed token theft.**  
   `spike/lib/oracle-deployed.mjs:137-160,174-180,208-211`

   Emitter authentication checks only the pinned victim. It does not reject a test-created token, an etched token, or the test contract itself.

   All three synthetic `proofDelta` cases returned `asset:"token"`, `lostUnits:"1000"`, `onChain:true` without a real token balance change.

   Existing `oracle-tokens.test.mjs` explicitly expects an etched emitter to remain accepted. Its passing result therefore preserves this defect.

   The channel also ignores setup deposits. A setup deposit followed by the same depositor’s body refund was credited as theft.

4. **P1 — Historical and rolled-back claims count as remaining claims.**  
   `spike/lib/oracle-locked.mjs:109-131`

   `claimOf` takes the largest observed old or new value. It neither reconstructs final storage nor checks ancestor success.

   Two focused reproductions returned `stillOwed:"10"`:
   - the only positive claim was written under a reverted parent;
   - a successful redemption reduced the claim from 10 to zero before a later rejected withdrawal.

5. **P1 — Fork execution exposes the RPC credential and unrestricted host reach to submitted Solidity.**  
   `spike/lib/fork.mjs:91-99`; `spike/lib/proof.mjs:187`

   Docker receives both `--network host` and the credential-bearing environment variable. Submitted Solidity can call `vm.envString`. Vendored `Vm.sol:609-612` also exposes arbitrary-endpoint `vm.rpc`.

   A later harm refusal cannot undo a network request. This does not enforce the documented read-only RPC boundary or prevent calls to host-local services.

   Synthetic checks confirmed:
   - the credential enters the container environment;
   - `envString` produces no backstop;
   - a dummy custom-endpoint credential URL survives `redactSecrets` unchanged.

   **Limit:** no EVM credential extraction, socket connection, RPC request, or real credential was used.

6. **P1 — The operator’s fork pin is not enforced after launch.**  
   `spike/lib/proof.mjs:909`

   Every setup cheatcode classified as `fork` is exempted. This includes `rollFork`, `selectFork`, transaction-based forks and `rpc`, not only one matching `createSelectFork`.

   There is no comparison with the operator’s chain/block. The exception also applies without a configured fork. A synthetic offline drain remained accepted with setup `rollFork`.

   Separately, `proofDelta` credited `onChain:true` with `forkTargets` present but no `fork` configuration. This demonstrates missing binding, not an externally demonstrated config-write exploit.

7. **P2 — The deployed native-ETH channel receives the wrong flow map.**  
   `spike/lib/proof.mjs:170`

   `scanTargets(...).net` contains only contracts created from scope code. A genuine pre-existing pinned victim is absent. Creating it instead causes `createdByTest` to reject it.

   Synthetic replay: `netFlows` measured victim `-1000`, attacker `+1000`; `proofDelta` reported no harm.

## Harness coverage gap

`spike/lib/harness.mjs:146-164` generates `try stranger.<function>()`, but `stranger` is an `address`, not a contract instance. It also drops function arguments. The new template coverage test checks detection only, not generated-project compilation. I did not run a Solidity compiler.

## Checks and disposition

Ran, with an empty inherited environment, private HOME/TMPDIR, and isolated-env loaded first:

```text
node --import ./spike/test/helpers/isolated-env.mjs \
  --experimental-test-module-mocks --test \
  spike/test/oracle-tokens.test.mjs \
  spike/test/oracle-locked.test.mjs \
  spike/test/fork.test.mjs \
  spike/test/module-needs.test.mjs
```

Result: **36 passed, zero failed**. Additional inline Node checks exercised real oracle/parser code with mocked forge JSON and private synthetic artifacts.

Smallest sound disposition: do not promote either new oracle’s evidence into proven findings yet. Keep it as candidate evidence. Preserve existing global refusals before any oracle runs. Fork execution additionally needs enforced RPC egress and credential isolation.

No product source changed. Only the permitted dependency symlinks were added. No full suite, Docker/provider/model/RPC/browser calls, real stores, or credential environments were accessed.

## Independent app integration review

Not ready. Four confirmed integration defects.

Candidate: `2ed40ee5d2d33791e29ab1dd1a6c66a5b2562547`
Base: `8ccb6b2427a7e4cdbdbf5bd2b1845f7a5e596229`

1. P1 — Settings-only RPC never reaches final publication replay.
   - Locations: `app/server/runs.mjs:1098–1099`, `:1188`, `:1947`, `:2095`.
   - Input: save mainnet RPC through Settings; leave `TOUCHSTONE_FORK_RPC_1` unset in the server environment.
   - Admission reports ready. Workers receive `forkEnv()`. But `recordRun` and `recordMore` replay inside the server, without those variables.
   - Focused check: actual `proveFindings` returned `forgePassed: true`, `pocProved: false`, `proof: null`. Diagnostic: `TOUCHSTONE_FORK_RPC_1 is not set`. Refusal occurred before Docker.
   - This also affects recovery into the proof phase.
   - Fix direction: supply the RPC consistently at the replay boundary. Do not mutate process-wide environment around concurrent runs.

2. P1 — Replay publication loses the engine-selected fork.
   - Locations: new workspace application at `spike/lib/targets.mjs:648`; unmatched reader at `spike/lib/replay-bundle.mjs:412–427`, `:575`.
   - Input: scope pinned to mainnet block `19000001`; Solidity test does not call `createFork`, because the engine supplies the fork flags.
   - The block lives in `.touchstone.json`. Snapshot detection reads only TOML and Solidity. Its TOML endpoint contains a variable reference, not the HTTPS literal detection expects.
   - Focused check: snapshot returned `{rpc:"${RPC_URL}", block:null, forked:false}`. The bundle omitted the block and offered `--network none`.
   - Consequence: published replay instructions describe a different execution environment.
   - Fix direction: read the workspace’s authoritative fork pin when creating replay metadata.

3. P2 — Fork configuration never reaches the agent’s instructions.
   - Locations: `spike/lib/targets.mjs:403–438`; `spike/packs/contracts/pack.mjs:156`, `:175`, `:471`.
   - Input: pinned GitHub scope with victim addresses.
   - Actual system instructions say “There is no chain fork”. Kickoff says “no forking, no live chain”. Neither those strings nor `scopeEnv` contain the selected block or victim addresses.
   - Focused check confirmed those outputs. The tool list exposes no fork/config reader.
   - Consequence: an instruction-following agent builds local deployments rather than targeting the operator’s deployed victims.
   - Fix direction: provide fork-aware instructions and the non-secret pin/address fields.

4. P2 — Empty `pack` bypasses direct admission checks.
   - Locations: `app/server/runs.mjs:579`, `:596`, `:608`; HTTP forwards it unchanged.
   - Input: `{targetId: forkedScope, pack:"", mode:"solo", freeRoam:false}` with no RPC.
   - Target selection resolves Contracts using `one || undefined`. Needs checking uses `one ?? target.pack`, preserving `""`; `targetNeeds` treats that as non-Contracts.
   - Focused actual `acceptRun` check reached the grant gate with `target.pack === "contracts"`. Normal omitted/explicit Contracts and joined Contracts/Review requests correctly refused.
   - Fix direction: check the resolved module identity.

Verification: 10 focused cases exercised successfully. Also checked masked settings preservation, pin storage, single/joined workspaces, historical unpinned scopes, Review admission, Daytona routing, and release source filtering.

Limits: recovery/follow-up traced in source, not launched. No live services, Docker, providers, browser, private-state reads, source edits, commits, or publication. No oracle audit.
