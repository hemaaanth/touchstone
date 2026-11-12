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

Build the live-cloud lab image. It carries a private moto service with IAM
enforced, plus the node runtime the request-script harness needs:

```sh
docker build -t touchstone/infra-cloud-cloud-lab:wave2 spike/packs/infra-cloud/lab/cloud
```

The comparison also uses Checkov and Kubescape:

```sh
docker build -f spike/packs/infra-cloud/Dockerfile.checkov \
  -t touchstone/checkov-cli:3.4.3 spike/packs/infra-cloud
docker build -f spike/packs/infra-cloud/Dockerfile.kubescape \
  -t touchstone/kubescape-cli:4.0.20 spike/packs/infra-cloud
```

Tool provisioning may fetch public images, a CLI binary, policy assets and npm
or pip packages. The actual IaC scans, evidence replays and cloud replays have no
internet. The moto posture run and the live-cloud replay each use their own
internal Docker network with no host port. See `TOOLS.md` for licenses,
checksums, sizes and the comparison.

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
It also runs the live-cloud replay for the role lead, checks that a narrowed grant and a narrowed trust both fail with a 403, and checks that no credential value survives in the rendered proof.
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
It exits non-zero when any submitted finding did not pass its replay.
`node spike/packs/infra-cloud/live.mjs summarize <record.json>` rebuilds
`validation/live.json` and `validation/live-record.json` from an existing record
with no spend, and re-applies the proof redaction.
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

## Real folders

The pack reads any folder, not only its lab:

```sh
node spike/packs/infra-cloud/real-input.mjs /path/to/infra
```

It captures the folder, runs the same prepass, replays three leads (`REPLAYS`
sets the count) and saves `validation/real-input.json` with the command line.
Binary, oversized and symlinked files are listed as skipped instead of stopping
the audit.
It pins the folder in place (`snapshot.json` and `.touchstone.json`), so point it
at a copy when the folder must stay untouched.
The app's scope target path currently allows only the Contracts and Review packs,
so a scope run cannot select this pack yet. The folder runner is the supported
path today.

Real input is evidence-only for the crypto checks, and the live-cloud path is
lab-only. That is a real limit, not a claim of coverage: on real Terraform the
trust document usually sits behind `jsonencode(...)` or
`data.aws_iam_policy_document`, which the structural parser does not interpret.
So a real folder produces scanner leads, not crypto leads, and no moto replay.
Four public repos were audited that way (72, 1009, 18 and 6 scanner leads); each
replayed two leads green, and none produced a crypto lead.

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

The broad role read is the one lead with a live replay.
`live-cloud.mjs` seeds a private moto cloud from the same pinned policy.
A separate attacker key assumes the role, proves the assumed identity, then reads a
bucket that is not the workload's own.
The shared `lib/proof-http.mjs` records the traffic out of band and its oracle
decides the verdict. The finding then carries an `http` proof, not an `evidence`
proof, and the app renders its request log.
The same policy narrowed to the workload's own bucket fails the replay with a
403, and so does a trust narrowed away from the caller.
Every call crosses the recording proxy on the private network. No host port and
no raw socket from this process are used.
Moto enforces the trust principal and the identity policy. It does not evaluate
the rest of a trust document, such as conditions.
The oracle binds the object read to the session AssumeRole returned: the read
must carry that exact session token.
After the oracle reads the raw transcript, the proof log is scrubbed of the
secret key, the session token and the lab seed secret, so the rendered proof
carries no credential value.

## What a finding means

A passing proof confirms configuration in the pinned files.
It does not prove a live deployment, actual internet routing, stolen credentials, key use or fund loss.
For the role read, the live replay shows the declared grant really executes
against a running S3-compatible service. It is not a real AWS account.
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
The selected ensemble and crypto checks plus the new role policy produced 188
leads in the no-spend smoke.
All 188 replayed, and the live-cloud replay passed for the role lead while a
narrowed grant and a narrowed trust each failed it with a 403.
The rendered proof was checked for surviving credential values.
The smoke rejected unchecked submissions and duplicate submissions.
All 12 planted crypto cases were present.

The live `near/qwen-abl` run finished with 26 findings: 25 passing evidence
proofs and one passing `http` proof for the role lead.
It covered all 12 planted crypto cases.
The http finding carries its 4 recorded requests, and the app renders the oracle
result and the request log beside it.
Its recorded cost was $0.12676524 under the $1 run budget.
A baseline run before the live proof was added cost $0.11297417.
`validation/live-record.json` keeps the safe result.
`validation/live.json` keeps its summary and archive reference.
The raw test key was checked absent from that saved result.
The full spike suite passed all 235 tests on this branch.
App target discovery found `infra-cloud/lab`, kept its pack config and selected the evidence proof kind.
Four real checkouts were audited with `real-input.mjs`: the public
terraform-aws-vpc module, the microservices-demo shop, and two public IAM-role
modules. Two leads replayed green in each, and all four produced zero crypto
leads, for the HCL reason above. The results are in `validation/real-input.json`.
The saved `validation/live.json` still names the pre-repair oracle
`assumed-role-reads-foreign-bucket`, because the paid run predates the
token-bound oracle. A new paid run would refresh it; none was run for the repair.
