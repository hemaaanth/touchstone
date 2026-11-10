# Infra and cloud (M10): OSS survey

## Scope today

Read from [`spike/packs/infra-cloud/pack.mjs`](../../spike/packs/infra-cloud/pack.mjs),
`SKILL.md` and `TOOLS.md`.

- Tier P. Proof kind `evidence`. A private moto service adds a cloud posture
  check: Prowler runs against moto and flips from FAIL to PASS after the
  repair. It never scans a real account.
- Wrapped today: Trivy plus KICS (IaC ensemble), and Prowler plus moto (private
  cloud lab). Checkov and Kubescape are kept as comparison adapters. ScoutSuite
  is skipped.
- Our own crypto checks already parse Terraform JSON, CloudFormation and
  Kubernetes YAML. They flag a wildcard `kms:Sign` grant, public signer
  instances and load balancers, signer NodePorts, public RPCs with
  `admin`/`debug`/`personal` namespaces, literal EVM keys, CI `pods/exec` near a
  signer, and weak front-end buckets.
- Stated limit: no HCL interpreter and no Helm renderer.

## Leading OSS tools

Licenses were read from each repository's LICENSE file on 2026-11-10. See the
[method](README.md#method).

| Tool | What it does | License | Use mode | Coverage | Crypto gap |
|---|---|---|---|---|---|
| [Trivy](https://github.com/aquasecurity/trivy) | IaC, image, filesystem and Kubernetes scanner. Wrapped today. | [Apache-2.0](https://github.com/aquasecurity/trivy/blob/HEAD/LICENSE) | lift | Terraform, CloudFormation, Kubernetes, Helm, Dockerfile. Renders HCL and Helm. | No rule knows which key or workload signs. |
| [KICS](https://github.com/Checkmarx/kics) | IaC scanner with Rego queries. Wrapped today. | [Apache-2.0](https://github.com/Checkmarx/kics/blob/HEAD/LICENSE) | lift | 2,000+ queries across many IaC formats. | Same as Trivy. |
| [Checkov](https://github.com/bridgecrewio/checkov) | IaC scanner with graph checks. Comparison only today. | [Apache-2.0](https://github.com/bridgecrewio/checkov/blob/HEAD/LICENSE) | lift | Graph checks link resources, for example an instance to its security group. | Its graph stops at one template. No signer concept. |
| [Kubescape](https://github.com/kubescape/kubescape) | Kubernetes posture and manifest scanner. Comparison only today. | [Apache-2.0](https://github.com/kubescape/kubescape/blob/HEAD/LICENSE) | lift | NSA and MITRE frameworks, RBAC, network policy. | Does not know a validator pod from a web pod. |
| [Prowler](https://github.com/prowler-cloud/prowler) | Cloud posture scanner. Wrapped today against moto. | [Apache-2.0](https://github.com/prowler-cloud/prowler/blob/HEAD/LICENSE) | lift | AWS, Azure, GCP and Kubernetes. Hundreds of checks and compliance maps. | Its KMS checks cover rotation and public policies, not who may call `kms:Sign` on a signing key. |
| [moto](https://github.com/getmoto/moto) | Mock AWS services. Wrapped today as the lab cloud. | [Apache-2.0](https://github.com/getmoto/moto/blob/HEAD/LICENSE) | lift | Most AWS APIs, including KMS `Sign` with ECC keys. | Some behavior differs from AWS. `TOOLS.md` notes a public-write ACL that moto did not show. |
| [Cartography](https://github.com/cartography-cncf/cartography) | Loads cloud, Kubernetes, GitHub and identity assets into a Neo4j graph. [Docs](https://cartography-cncf.github.io/cartography/). | [Apache-2.0](https://github.com/cartography-cncf/cartography/blob/HEAD/LICENSE) | lift | Cross-account and cross-service relations. Paths from a GitHub repo to an AWS role to a resource. | No signer node type. We would add one: a KMS key or pod that signs, linked to its on-chain address. |
| [Cloud Custodian](https://github.com/cloud-custodian/cloud-custodian) | YAML policy engine for cloud resources. [Docs](https://cloudcustodian.io/docs/). | [Apache-2.0](https://github.com/cloud-custodian/cloud-custodian/blob/HEAD/LICENSE) | lift | Filters on KMS key policies, IAM, security groups and tags. It can run read-only. | No crypto policies ship with it. We would write `kms:Sign` and signer-tag policies. |
| [PMapper](https://github.com/nccgroup/PMapper) | Builds an IAM graph and answers "who can do X". | [AGPL-3.0](https://github.com/nccgroup/PMapper/blob/HEAD/LICENSE) | shell out | Privilege escalation paths in AWS IAM. | Does not rank `kms:Sign` above other actions. Low recent activity. |
| [CloudFox](https://github.com/BishopFox/cloudfox) | Finds exploitable paths in cloud accounts. | [MIT](https://github.com/BishopFox/cloudfox/blob/HEAD/LICENSE) | lift | Role trusts, secrets, endpoints, permission maps. Needs live credentials. | Same as PMapper. |
| [Steampipe](https://github.com/turbot/steampipe) and [Powerpipe](https://github.com/turbot/powerpipe) | SQL over cloud APIs, plus benchmark dashboards. | AGPL-3.0 ([Steampipe](https://github.com/turbot/steampipe/blob/HEAD/LICENSE), [Powerpipe](https://github.com/turbot/powerpipe/blob/HEAD/LICENSE)) | shell out | Live queries across many clouds. | The engine is AGPL. The query packs are separate (next row). |
| [steampipe-mod-aws-compliance](https://github.com/turbot/steampipe-mod-aws-compliance) | CIS, NIST and other benchmark queries. [Mods hub](https://hub.steampipe.io/mods). | [Apache-2.0](https://github.com/turbot/steampipe-mod-aws-compliance/blob/HEAD/LICENSE) | lift | Query logic we can read and port. | Generic benchmarks. |
| [kube-bench](https://github.com/aquasecurity/kube-bench) | CIS Kubernetes benchmark checks. | [Apache-2.0](https://github.com/aquasecurity/kube-bench/blob/HEAD/LICENSE) | lift | Node and control-plane config. Needs a live cluster. | Generic. |
| [Falco](https://github.com/falcosecurity/falco) | Runtime threat detection for containers. | [Apache-2.0](https://github.com/falcosecurity/falco/blob/HEAD/LICENSE) | lift | Syscall rules. A runtime guard, not an audit. | No rule for reads of keystore or slashing-protection files. Rules can be added. |
| [ScoutSuite](https://github.com/nccgroup/ScoutSuite) | Multi-cloud posture audit. | [GPL-2.0](https://github.com/nccgroup/ScoutSuite/blob/HEAD/LICENSE) | skip | Prowler covers it. | Same as Prowler. |
| [CloudSploit](https://github.com/aquasecurity/cloudsploit) | Cloud posture scanner. | [GPL-3.0](https://github.com/aquasecurity/cloudsploit/blob/HEAD/LICENSE) | skip | Prowler covers it. | Same as Prowler. |
| [Web3Signer](https://github.com/Consensys/web3signer) | Remote signer for validators and EVM accounts. A target, not a scanner. | [Apache-2.0](https://github.com/Consensys/web3signer/blob/HEAD/LICENSE) | lift (lab target) | Supports AWS KMS, Vault and HSM backends and a slashing-protection DB. [Docs](https://docs.web3signer.consensys.io/). | Gives a real target for lab checks: open HTTP port, missing TLS, missing allowlist. |
| [Dirk](https://github.com/attestantio/dirk) | Distributed remote signer for Ethereum validators. A target, not a scanner. | [Apache-2.0](https://github.com/attestantio/dirk/blob/HEAD/LICENSE) | lift (lab target) | Threshold signing with mTLS between peers. | Same as Web3Signer. |
| [aws-kms-ethereum-accounts](https://github.com/aws-samples/aws-kms-ethereum-accounts) | AWS sample for Ethereum signing with KMS keys. | [MIT-0](https://github.com/aws-samples/aws-kms-ethereum-accounts/blob/HEAD/LICENSE) | lift | A reference KMS signer setup to build lab IaC from. | A sample, not a scanner. |
| [open-cvdb](https://github.com/wiz-sec/open-cvdb) | Open database of cloud provider vulnerabilities. Site: [cloudvulndb.org](https://www.cloudvulndb.org/). | [CC-BY-4.0](https://github.com/wiz-sec/open-cvdb/blob/HEAD/LICENSE.md) | lift (data, attribution) | Provider-side issues that no CVE covers. | Not crypto-specific. |
| [HashiCorp Vault](https://github.com/hashicorp/vault) | Secrets manager. | [BUSL-1.1](https://github.com/hashicorp/vault/blob/HEAD/LICENSE) | skip | Source-available, not OSS. | A common signer backend, so it stays a lab target name only. |

## Recommendation

1. **Wrap Cartography.** It is the permissive way to answer path questions
   across services. Load the moto lab and the Kubernetes manifests, add a
   `Signer` node for each KMS signing key and signer pod, and query "which
   principals and which networks reach a Signer". Each path becomes a lead
   with exact resource IDs as evidence.
2. **Wrap Cloud Custodian** with our own read-only crypto policies. Examples:
   `kms:Sign` allowed outside an approved principal list, signing keys without
   deletion protection, and signer-tagged instances in public subnets. It runs
   against moto, so it fits the existing moto posture check.
3. Next: port Steampipe compliance queries (Apache-2.0) where Prowler lacks a
   check. Add Web3Signer and Dirk as lab targets so the keymanager and signer
   checks in [surface.md](surface.md) have something real to find.

## Biggest crypto gap

**No scanner shows which principal or network path can make the signer
sign.** Every scanner above checks one resource at a time. Our own checks
already catch the single-resource cases, such as a wildcard `kms:Sign` grant or
a public signer pod. The harder cases are chains. A CI role assumes a deploy
role, which may call `kms:Sign`. A debug pod in the same namespace reaches the
web3signer port. A public RPC load balancer shares a security group with the
signer. Those paths are how one cloud foothold becomes a signed transaction.
PMapper and CloudFox find IAM paths, but they do not know which key moves
funds. Slashing-protection setup (Web3Signer's database, Dirk's peer set) is
not checked by any scanner either.

## Feeds

| Feed | What it gives | URL | Terms or note |
|---|---|---|---|
| Kubernetes official CVE feed | Kubernetes CVEs as JSON | <https://kubernetes.io/docs/reference/issues-security/official-cve-feed/index.json> | Public. [sig-security](https://github.com/kubernetes/sig-security) is [Apache-2.0](https://github.com/kubernetes/sig-security/blob/HEAD/LICENSE). |
| AWS security bulletins | AWS-side issues and patches | <https://aws.amazon.com/security/security-bulletins/rss/feed/> | Public RSS. |
| Cloud vulnerability DB | Provider issues with no CVE | <https://www.cloudvulndb.org/> | [CC-BY-4.0](https://github.com/wiz-sec/open-cvdb/blob/HEAD/LICENSE.md) |
| Signer and client advisories | Bugs in remote signers and consensus clients | [Web3Signer](https://github.com/Consensys/web3signer/security/advisories), [Prysm](https://github.com/OffchainLabs/prysm/security/advisories), [Lighthouse](https://github.com/sigp/lighthouse/security/advisories) | GitHub advisories. |
| Keymanager API spec | The endpoints an exposed signer offers | <https://ethereum.github.io/keymanager-APIs/> | Public spec. |
| NVD and CISA KEV | CVEs for images and cloud software | See the [shared feeds](README.md#feeds-shared-by-several-packs). | KEV has no chain or signer entries. |
