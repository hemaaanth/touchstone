# Infra and cloud: tool choices

Checked upstream licenses, release tags, images and offline behavior on 2026-11-10.
Research starts at M10 in `03-capabilities.md`, cloud and key-risk rows in `04-crypto-coverage.md`, and the infrastructure labs in `07-gap-6.md`.
The research files live in the main checkout. They are not tracked in this worktree.

## Verdicts

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [Trivy](https://github.com/aquasecurity/trivy) | Apache-2.0 | `aquasec/trivy:0.76.2`, digest in scanners.mjs; 265.5 MB | Yes: `config --skip-check-update`; embedded checks; Docker network none | Terraform HCL/JSON, Kubernetes, Helm, CloudFormation, Dockerfile | `--format sarif` | Rule ID, static title, severity, exact file and line | evidence: rerun the same rule at the same location | Broadest format coverage here; 85 located results on all six source files | Rule IDs, titles and shared severity classifications in rule-catalog.json | Does not connect public services, CI access and signer roles into the crypto-specific paths | **ensemble** with KICS; covers Terraform JSON that KICS missed in this lab |
| [Checkov](https://github.com/bridgecrewio/checkov) | Apache-2.0 | `bridgecrew/checkov:3.4.3`, pinned base, direct CLI adapter `touchstone/checkov-cli:3.4.3`; 808.8 MB | Yes: `--skip-download --download-external-modules false`; no API key; network none | Same IaC lab | `-o sarif` writes `results.sarif`. Stdout remains a human report | 54 source-located results; synthetic rendered Helm paths are not treated as exact source citations | Comparison adapter can rerun exact located results; not in the selected proof allowlist | Fewer located results and source formats than Trivy/KICS on this lab | Rule IDs, titles and severity classifications retained; no detector source copied | No signer-role, RPC namespace or CI-to-signer relationship checks added by this adapter | **skip** in prepass; retain the working comparison adapter |
| [KICS](https://github.com/Checkmarx/kics) | Apache-2.0 | `checkmarx/kics:v2.2.1`, digest in scanners.mjs; 293.4 MB | Yes: bundled queries and libraries at explicit absolute paths; network none; secret scanning disabled here | Terraform HCL, Kubernetes, Helm templates, Dockerfile, CloudFormation | SARIF file via `--report-formats sarif` | Rule ID, static title, severity and exact source location | evidence: rerun the same rule and line | 88 located results. Adds a separate rule engine. No main.tf.json results in this lab | Rule IDs, titles and shared severity classifications in rule-catalog.json | Does not derive the hot-wallet address or connect crypto roles across these resources | **ensemble** with Trivy; independent configuration rules and exact citations |
| [Kubescape](https://github.com/kubescape/kubescape) | Apache-2.0 | CLI 4.0.20 in `touchstone/kubescape-cli:4.0.20`; 952.8 MB. Binary and offline policy assets have explicit SHA-256 checksums | Yes after policy provisioning. Local WorkloadScan, controls and exceptions; `--keep-local`; network none | Kubernetes manifest file | `--format sarif --output ...` | 18 located results with control IDs | Comparison only; selected proof allowlist does not include it | Narrower file scope; default workload risks overlap this lab's other scanners | Rule IDs/severity metadata; unmodified regolibrary WorkloadScan assets fetched into the image | No AWS KMS, bucket or CI-cloud relationships | **skip** in prepass; retain the offline comparison image and adapter |
| [Prowler](https://github.com/prowler-cloud/prowler) | Apache-2.0 | `toniblyx/prowler:5.48.0`, pinned base; Python entrypoint adapter `touchstone/prowler-python:5.48.0`; 4384.0 MB | Yes for this bounded moto subset, on a Docker internal network with no published ports | One synthetic S3 account seeded from the pinned lab IaC | JSON OCSF; only rule IDs and PASS/FAIL leave the container | Synthetic corroboration for bucket versioning and Object Lock | The finding still replays its IaC detector. Prowler output alone cannot pass the finding gate | Confirms two source-level recovery-control risks against a live local service | No Prowler source copied. Check IDs remain upstream | Does not prove real-cloud exposure; the public-write ACL case was not reproduced by the moto observation | **wrap** for the private lab subset; never a real account scan |
| [moto](https://github.com/getmoto/moto) | Apache-2.0 | `motoserver/moto:5.2.5`, pinned digest; 548.4 MB; plus the pack's `lab/cloud` image (node for the request-script harness, IAM enforcement on) | Yes. The posture run and the live replay each use their own internal Docker network with no host port and no internet | Supported literal front-end bucket settings, and one role policy plus trust taken from the pinned main.tf.json | AWS-compatible local API; no target code executed | Two jobs: posture corroboration, and the `http` proof service | `http`: a separate attacker key assumes the seeded role and reads an unrelated bucket through the recording proxy | The bucket posture run corroborates source recovery controls. The replay proves the declared role grant executes | Chosen instead of LocalStack to avoid a cloud account or hobby-plan sign-in | No server source copied | Simulated AWS behavior is not a deployment or internet reachability proof. Moto checks the identity policy but not the trust policy | **wrap** as the private cloud lab service and the `http` proof |
| [ScoutSuite](https://github.com/nccgroup/ScoutSuite) | GPL-2.0; separate program only | No image selected or pulled; size not measured | Not exercised; no real cloud account allowed | Cloud account APIs | JSON/HTML reports | No adapter | None | Alternative to Prowler; Prowler works for the required local subset | Read only; no GPL source copied | No offline crypto-specific adapter built | **skip**; Prowler satisfies the offline posture experiment |

Sizes are Docker's installed sizes, in decimal MB. They are not compressed download sizes.
The two selected scanners run only through `runTool()` with `--network none`.
The cloud service and Prowler also run through `runTool()`, but use a named Docker network created with `--internal`.
No host port, cloud key, kubeconfig, Docker socket or host home is mounted into those containers.

## Comparison

Run `node spike/packs/infra-cloud/compare.mjs`.
The saved result is `validation/tool-comparison.json`.
`rule-catalog.json` stores the extracted rule IDs, static titles, image references and severity classifications.
The catalog is used for lead titles. Actual proof still reruns the upstream detector.
The existing `sarifLeads()` helper supplies severity handling. This pack has no second SARIF parser.

| Engine | Located results | Source files with results | Decision |
|---|---:|---|---|
| Trivy | 85 | HCL, Terraform JSON, Kubernetes, Helm, CloudFormation, Dockerfile | Keep for broad coverage |
| Checkov | 54 | HCL, Kubernetes, CloudFormation, Dockerfile | Comparison only |
| KICS | 88 | HCL, Kubernetes, Helm, CloudFormation, Dockerfile | Keep as the second engine |
| Kubescape | 18 | Kubernetes | Comparison only |

Counts are leads, not distinct root causes or proven exploits.
They are not a quality score or a general benchmark.
The prepass keeps the selected engines' located results and the crypto checks.
It merges some known rule families within the same resource.
The agent must still reject duplicate root causes and separate security risks from advice.

## Integration issues resolved

- Trivy `config` does not accept `--offline-scan` in this version. `--skip-check-update` and network none select the embedded checks.
- Checkov prints its human report to stdout even when asked for SARIF. Read `results.sarif`, never scrape the console report.
- The standard Kubescape image starts `ksserver`. It needs in-cluster credentials. This comparison uses the pinned CLI binary instead.
- Kubescape's automatic artifact download failed after the GitHub API returned 403. The image fetches known release assets by URL and SHA-256 instead.
- Docker remote ADD files defaulted to root-only read permission. The offline policy files must be readable by `runTool()`'s non-root user.
- Kubescape policy evaluation uses the local WorkloadScan framework and does not submit results to a backend.

## Cloud posture result

Run `node spike/packs/infra-cloud/cloud-smoke.mjs`.
The evidence is `validation/cloud-posture.json`.

The runner seeds a fresh moto service from the pinned front-end bucket definition.
It tests a risky configuration and then a repaired one on separate internal networks.
Prowler's versioning and Object Lock checks change from FAIL to PASS.
Direct SDK reads confirm Suspended/no lock before repair and Enabled/lock after repair.

The requested `public-read-write` ACL did not appear as public WRITE in the recorded moto observation.
Prowler reported PASS for that check.
Do not count this case as cloud corroboration of public-write access.
The source-level `frontend-public-write` detector still checks the declared ACL and public-access block settings.
The local service does not establish real AWS behavior for this ACL case.

Only this S3 subset is seeded. This is not a whole-account AWS audit.
KMS, security groups, load balancers, RBAC and RPC checks use pinned source evidence.
No cloud-posture finding can skip the evidence gate.

## Live cloud replay

One lead, `iam-role-broad-object-read`, gets a live replay of its own.
The lab image `lab/cloud` runs moto with `INITIAL_NO_AUTH_ACTION_COUNT=0`, so moto
evaluates IAM identity policies instead of accepting everything.
The seed is taken from the same pinned policy the finding cites.
A separate attacker key assumes the role. The assumed credential then reads
`touchstone-lab-treasury/wallets.json`, a bucket outside the workload.
`lib/proof-http.mjs` starts the service on a private internal network and records
every call at a proxy the script cannot write to.
The finding's proof becomes `http` with the recorded exchanges.
The same policy narrowed to the workload's own bucket fails the replay, so the
replay is a real differential and not a tautology.

The proof script signs its own SigV4 requests. The shared AWS SDK could not be
used: the recording proxy rewrites the Host header, and the SDK always signs the
URL host, so every signature would break at that boundary.
The lab gate passes the Host header through and the script signs the origin host.

Moto checks both the trust principal and the identity policy, so a narrowed
trust fails at AssumeRole with a 403. A wildcard trust is still required for the
lead, because a specific principal would not match the attacker.
The proof log is scrubbed of the seed secret and of the session credential after
the oracle has read the raw transcript.
The gate process is part of the lab image. It serves `/healthz` and the lab seed
so a readiness probe only passes once the seed is complete.

## Crypto additions

- An unconditional KMS key-policy Allow for a wildcard principal and `kms:Sign` or a matching action wildcard.
- A signer instance with a public-address setting and a referenced world-ingress security group.
- A tagged signer/validator public load balancer with a listener.
- A NodePort or external LoadBalancer selecting a signer workload. NodePort alone is not called internet-reachable.
- An external LoadBalancer selecting an RPC workload, with a matching port, a listener on all interfaces and admin/debug/personal HTTP namespaces.
- A literal EVM key in a ConfigMap, Kubernetes environment or ECS task environment. The public lead contains only an address, `[REDACTED]` and a hash.
- A CI service account bound to pods/exec access in a namespace containing a signer.
- Front-end bucket public-write ACLs, CI PutObject grants, disabled versioning and missing Object Lock.

## Limits

Crypto checks parse Terraform JSON, CloudFormation JSON/YAML and Kubernetes YAML structurally.
They do not implement an HCL interpreter or a Helm renderer. HCL, Dockerfiles and rendered Helm checks stay with upstream tools.
Unresolved bucket expressions are coverage gaps, not proof that controls are disabled.
IAM handling is conservative. Conditional or denied grants are not promoted as broad access.
All findings describe requested configuration in the captured files, not actual deployment, token theft, signing, RPC responses or loss of funds.

The live replay reads a synthetic bucket in moto, not a real AWS account.
It needs Docker at prove time and the built lab image. Without either, the live
leading finding fails instead of silently falling back.
The lab seeds one role, one treasury bucket and one policy. It does not model
bucket policies, resource policies, trust conditions, permission boundaries or
SCPs.
The S3-compatible emulation is enough for an object read. It is not AWS fidelity
for every IAM feature.

Upstream references: [Trivy config scanning](https://trivy.dev/latest/docs/scanner/misconfiguration/), [Checkov](https://github.com/bridgecrewio/checkov), [KICS](https://docs.kics.io/), [Kubescape offline use](https://github.com/kubescape/kubescape#offline-support), [Prowler](https://github.com/prowler-cloud/prowler), [moto server mode](https://docs.getmoto.org/en/latest/docs/server_mode.html).
