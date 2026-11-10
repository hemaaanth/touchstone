# Infra and cloud

The `infra-cloud` pack audits a small IaC snapshot.
It covers paths to signer keys, RPC admin methods and front-end publishing.
It does not deploy the target or use a real cloud account.

## Install

```sh
(cd spike && bun install)
(cd spike/packs/infra-cloud && bun install)
```

The pack adds YAML 2.8.1 as an isolated parser dependency.
It uses the existing ethers dependency for offline EVM address derivation.
Do not install anything from the target lab.

Pull the pinned Trivy, KICS, moto and Prowler images listed in `scanners.mjs`, `cloud.mjs` and `Dockerfile.prowler-python`.
Build the small entrypoint adapter:

```sh
docker build -f spike/packs/infra-cloud/Dockerfile.prowler-python \
  -t touchstone/prowler-python:5.48.0 spike/packs/infra-cloud
```

The comparison also uses Checkov and Kubescape:

```sh
docker build -f spike/packs/infra-cloud/Dockerfile.checkov \
  -t touchstone/checkov-cli:3.4.3 spike/packs/infra-cloud
docker build -f spike/packs/infra-cloud/Dockerfile.kubescape \
  -t touchstone/kubescape-cli:4.0.20 spike/packs/infra-cloud
```

Tool provisioning may fetch public images, a CLI binary and policy assets.
The actual IaC scans and evidence replays have no network.
Prowler and moto share an internal Docker network with no host port.
See `TOOLS.md` for licenses, checksums, sizes and the comparison.

## Lab

The app discovers `infra-cloud/lab` from `lab/.touchstone.json`.
The config contains the pack ID, title and blurb.
The static lab contains Terraform HCL and JSON, Kubernetes YAML, a Helm chart, a Dockerfile and CloudFormation JSON.
It includes one generated throwaway EVM key in a ConfigMap.
Never fund that address. Never deploy or build the target.
The URLs, instance IDs and bucket names are lab data.

`makeLabWorkspace()` copies the lab into a fresh temporary directory.
The prepass captures the source bytes and makes a deterministic private Git snapshot commit.
That commit cites the captured files. It is not an upstream repository revision or a deployed cloud release.
The shared `pinSnapshot()` writes the raw source snapshot with mode 0600 and pins its SHA-256 in `.touchstone.json`.
Never publish `snapshot.json`. It contains the test private key.

## No-spend proof

```sh
node --test spike/test/infra-cloud.test.mjs
node spike/packs/infra-cloud/compare.mjs
node spike/packs/infra-cloud/cloud-smoke.mjs
node spike/packs/infra-cloud/smoke.mjs
```

The comparison calls all four real IaC tools through `runTool()`.
The selected prepass uses Trivy and KICS.
The cloud smoke seeds risky and repaired moto buckets, then runs Prowler.
It checks versioning and Object Lock FAIL-to-PASS transitions.
It does not claim cloud verification of the public-write ACL case.

The pack smoke checks every retained lead's replay, the submit gate, duplicate rejection and secret-value exclusion.
This mechanically exercises the proof path. It does not claim that every scanner lead is a distinct vulnerability.
Saved safe results live under `validation/`.

## Live run

Source the main checkout's env file as WAVE1.md says. Never read or print it.
Then run:

```sh
export SPEND_LEDGER=/home/hemanth/Projects/near/redteam-harness/spike/spend.json
export SPEND_CAP_USD=50.85 RUN_BUDGET_USD=1
node spike/packs/infra-cloud/live.mjs
```

The runner invokes the existing `spike/agent-run.mjs` with `near/qwen-abl` and a fresh lab workspace.
It checks the ledger, cap and $1 budget before starting.
The engine uses fixed `qwen-abl` record names.
The runner preserves old records, archives the new run under a unique name and restores the old fixed-name files.
It does not push or publish anything.

## Agent workflow

1. Call `infrastructure_leads` to read the complete redacted board and coverage.
2. Rank distinct root causes. Prioritize signing, RPC administration and front-end integrity.
3. Call `check_evidence` for one lead ID.
4. Call `submit_finding` only after that lead passes.
5. Continue with the remaining crypto and upstream leads. Reject duplicate causes and explain untried coverage.

The model cannot read raw source, run a shell, change IaC or submit arbitrary proof code through this pack.
Finding text and severity come from the deterministic lead.
A literal wallet key is represented by its derived address, `[REDACTED]` and a hash.
No scanner source snippet, raw stdout, raw stderr or detector exception enters the run record.
The shared evidence helper also suppresses detector prose.

## Proof contract

The pack uses `lib/proof-evidence.mjs` without changes.
A finding carries `evidence: { check, where, snapshotHash }`.
The location includes the exact file, line and rule or crypto resource.
Each finding also cites the private snapshot commit.

Crypto detectors reparse the pinned IaC and confirm the exact requested fact.
Upstream detectors run the selected pinned tool again on materialized snapshot files.
Within one model session, identical pinned bytes share a tool execution.
The final `prove()` call has a fresh detector map and reruns each used engine.
Changed snapshot bytes, unsupported checks and forged locations fail closed.
Only passing findings survive the final replay.

Prowler is synthetic corroboration for source-level bucket recovery checks.
It does not replace the finding's IaC detector.
No HTTP proof or second HTTP runner is implemented here.

## What a finding means

A passing proof confirms configuration in the pinned files.
It does not prove a live deployment, actual internet routing, stolen credentials, key use or fund loss.
NodePort alone is not internet reachability.
A CI publishing grant is a trust-boundary warning, not evidence that CI was compromised.
A missing recovery control is not evidence that an overwrite already happened.

The crypto checks support literal Terraform JSON, CloudFormation JSON/YAML and Kubernetes YAML.
Upstream tools handle HCL, Dockerfiles and Helm rendering.
Unknown bucket expressions and parse errors stay visible as coverage gaps.
The moto seed accepts only supported literal settings and a throwaway `touchstone-lab-*` bucket.
No real AWS credential, cluster credential, signer endpoint or RPC URL is accepted by the tool set.

The public-address EC2 check is IPv4-only.
RBAC grants restricted by `resourceNames` are not promoted.

## Recorded validation

The four-tool comparison retained 85 Trivy leads, 54 Checkov leads, 88 KICS leads and 18 Kubescape leads.
These are located rule hits, not counts of distinct vulnerabilities.
The selected ensemble and crypto checks produced 183 leads in the no-spend smoke.
All 183 replayed. The smoke rejected unchecked submissions and duplicate submissions.
All 11 planted crypto cases were present.

The live `near/qwen-abl` run finished with 20 findings and 20 passing evidence proofs.
It covered all 11 planted crypto cases.
Its recorded cost was $0.02941203 under the $1 run budget.
`validation/live-record.json` keeps the safe result.
`validation/live.json` keeps its summary and archive reference.
The raw test key was checked absent from that saved result.
