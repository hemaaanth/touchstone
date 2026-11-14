// The manifest of every Docker image the packs need: one data-only module, so
// the engine (lib/daytona.mjs: which images a Daytona machine may pull) and the
// setup CLI (scripts/setup.mjs) read the same list without the engine loading the
// CLI. No side effects: importing it only defines MANIFEST.

// ---------------------------------------------------------------- the manifest
//
// kind "pull": `ref` is the exact image reference the pack code uses (pinned by
//   digest where the code pins it). We pull that ref; `tag` is what we inspect.
// kind "build": `file` (optional -f Dockerfile) and `context` (build context,
//   relative to repo root). `base` (optional) is a public image pulled first for
//   a build that uses --pull=false.
//
// group = the pack the image belongs to. optional = heavy / rarely needed.
// daytona = true for the images that reach a Daytona sandbox on main today.

const STRIX_SANDBOX_TAG = "ghcr.io/usestrix/strix-sandbox:1.3.0";
export const STRIX_SANDBOX_IMAGE = `${STRIX_SANDBOX_TAG}@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331`;

export const MANIFEST = [
  // ---- base (plain images the code and tests run directly) ----
  { tag: "node:20-slim", group: "base", kind: "pull",
    ref: "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0",
    note: "Web lab recording proxy, reach-confine proxy, jwt token capture." },
  { tag: "alpine:3.20", group: "base", kind: "pull", optional: true,
    ref: "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
    note: "Only the capture-mode tests run it (they skip without it); the scorecard and legitify builds pull it as their base. Optional, so a default setup pulls nothing new." },

  // ---- contracts (EVM static/dynamic analysis + proof replay) ----
  { tag: "ghcr.io/foundry-rs/foundry:latest", group: "contracts", kind: "pull",
    ref: "ghcr.io/foundry-rs/foundry:latest@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39", daytona: true,
    note: "forge, anvil, solc install, proof replay. A moving tag upstream: pinned here to the digest on the host." },
  { tag: "ghcr.io/trailofbits/eth-security-toolbox:nightly", group: "contracts", kind: "pull",
    ref: "ghcr.io/trailofbits/eth-security-toolbox:nightly@sha256:205f5d7c5f41c8ef4ead6ef5c95fddf0cb69352a547a8b47c3e172e5d01ac35c", daytona: true,
    note: "Slither, Echidna, Medusa. A moving tag upstream: pinned here to the digest on the host." },
  { tag: "touchstone/mythril:0.24.8", group: "contracts", kind: "build",
    file: "spike/packs/contracts/Dockerfile.mythril", context: "spike/packs/contracts", daytona: true },
  { tag: "touchstone/heimdall:0.9.3", group: "contracts", kind: "build",
    file: "spike/packs/contracts/Dockerfile.heimdall", context: "spike/packs/contracts", daytona: true },
  { tag: "touchstone/aderyn:0.6.8", group: "contracts", kind: "build",
    context: "tools/aderyn", daytona: true },
  { tag: "touchstone/halmos:0.3.3", group: "contracts", kind: "build",
    file: "spike/packs/contracts/images/Dockerfile.halmos", context: "spike/packs/contracts/images",
    note: "Halmos pre-pass; same build as images/build.sh halmos." },
  { tag: "touchstone/chimera:e2.3.3-m1.5.1", group: "contracts", kind: "build",
    file: "spike/packs/contracts/images/Dockerfile.chimera", context: "spike/packs/contracts/images",
    note: "Chimera pre-pass (Echidna + Medusa); same build as images/build.sh chimera." },

  // ---- keys (Safe / signing) ----
  { tag: "touchstone-chain-tools:wave1", group: "keys", kind: "build",
    file: "spike/packs/keys/runtime/Dockerfile", context: ".", daytona: true,
    note: "Shared lab world for keys and chain-watch. Context is the repo root." },
  { tag: "touchstone/safe-hash:0.0.19", group: "keys", kind: "build",
    file: "spike/packs/keys/safe-hash/Dockerfile", context: "spike/packs/keys/safe-hash" },
  { tag: "touchstone/safe-tx-hashes:e295975", group: "keys", kind: "build",
    file: "spike/packs/keys/safe-tx-hashes/Dockerfile", context: "spike/packs/keys/safe-tx-hashes" },

  // ---- chain-watch ----
  { tag: "touchstone/slither:0.11.6", group: "chain-watch", kind: "build",
    context: "spike/packs/chain-watch/slither", daytona: true },
  { tag: "touchstone/oz-monitor:1.7.0", group: "chain-watch", kind: "build",
    context: "spike/packs/chain-watch/oz-monitor", pullFalse: true,
    base: "openzeppelin/openzeppelin-monitor:v1.7.0@sha256:0d5ac20151328d691cfcb90eeec77d9ce4d9f2f962ddbbb90988c8e0e7c2d616",
    note: "Base pulled by digest first, then built with --pull=false." },

  // ---- web ----
  { tag: "touchstone/web-lab:dev", group: "web", kind: "build",
    context: "spike/packs/web/lab/dapp/oracle" },
  { tag: "touchstone/web-ffuf:2.3.0", group: "web", kind: "build",
    file: "spike/packs/web/Dockerfile.ffuf", context: "spike/packs/web" },
  { tag: "touchstone/web-arjun:2.2.7", group: "web", kind: "build",
    file: "spike/packs/web/Dockerfile.arjun", context: "spike/packs/web" },
  { tag: "touchstone/web-schemathesis:4.33.4", group: "web", kind: "build",
    file: "spike/packs/web/Dockerfile.schemathesis", context: "spike/packs/web" },
  { tag: "touchstone/web-jwt-tool:2.3.0", group: "web", kind: "build",
    file: "spike/packs/web/Dockerfile.jwt_tool", context: "spike/packs/web" },
  { tag: "ghcr.io/zaproxy/zaproxy:2.16.1", group: "web", kind: "pull",
    ref: "ghcr.io/zaproxy/zaproxy:2.16.1@sha256:7840969c7c9fead565bf9734b12f49f6886db90b1d35b1f74d79710bbd081dab" },
  { tag: "projectdiscovery/nuclei:v3.4.2", group: "web", kind: "pull",
    ref: "projectdiscovery/nuclei:v3.4.2@sha256:d0e34e04a7180c6b944550b81fe50719f57383affcb18ae7a42c0045643d54af" },
  { tag: "projectdiscovery/nuclei:v3.4.10", group: "web", kind: "pull",
    ref: "projectdiscovery/nuclei:v3.4.10@sha256:aeb5ea2db32a252b8135707d2ad0e89b90e19a18ea7816d38759bc51efb46b97" },
  { tag: "hahwul/dalfox:v2.12.0", group: "web", kind: "pull",
    ref: "hahwul/dalfox:v2.12.0@sha256:11c1249ef35f8eb3482d180e247304b351b37da2929eecd518dd8057d2687dc7" },

  // ---- ai-mcp ----
  { tag: "touchstone/ai-mcp-lab:dev", group: "ai-mcp", kind: "build",
    context: "spike/packs/ai-mcp/lab/mcp/oracle" },
  { tag: "touchstone/mcp-inspector:0.17.2", group: "ai-mcp", kind: "build",
    file: "spike/packs/ai-mcp/Dockerfile.inspector", context: "spike/packs/ai-mcp" },
  { tag: "touchstone/mcp-shield:1.0.4", group: "ai-mcp", kind: "build",
    file: "spike/packs/ai-mcp/Dockerfile.shield", context: "spike/packs/ai-mcp" },
  { tag: "touchstone/garak:0.17.1", group: "ai-mcp", kind: "build", optional: true,
    file: "spike/packs/ai-mcp/Dockerfile.garak", context: "spike/packs/ai-mcp",
    note: "~3 GB, CPU torch. Only for live AI/MCP runs with an assistant budget." },

  // ---- surface ----
  { tag: "touchstone-jsluice:0ddfab1", group: "surface", kind: "build",
    context: "spike/packs/surface/jsluice" },

  // ---- domains + phishing ----
  { tag: "touchstone-domains-tools:wave2", group: "domains", kind: "build",
    context: "spike/packs/domains" },
  { tag: "projectdiscovery/dnsx:v1.2.2", group: "domains", kind: "pull",
    ref: "projectdiscovery/dnsx:v1.2.2@sha256:8fced0bedf3655e06c9f1805f6277d60d4988a4b13209e24b3d7cde7baa656ec" },
  { tag: "projectdiscovery/httpx:v1.7.1", group: "domains", kind: "pull",
    ref: "projectdiscovery/httpx:v1.7.1@sha256:4458ef60897c6abd1d93f7efa82c10c23b783d8ec974e2abd17e4711ff52cb41" },
  { tag: "projectdiscovery/katana:v1.2.2", group: "domains", kind: "pull",
    ref: "projectdiscovery/katana:v1.2.2@sha256:5dc4db5bea876732f2e393a460c2145de1e7385c1884b5d9129beb34acd4e45b" },
  { tag: "projectdiscovery/subfinder:v2.6.8", group: "domains", kind: "pull",
    ref: "projectdiscovery/subfinder:v2.6.8@sha256:bf8f25e6dfb8806afa917ff1d4741fabe9296152ef150a4a539115bb6a77e682" },
  { tag: "punksecurity/dnsreaper", group: "domains", kind: "pull",
    ref: "punksecurity/dnsreaper@sha256:6bd99203cf59f7137418f676d1dbf69cdc3193a808b2d91b420f5f9f33255649" },
  { tag: "letiemble/checkdmarc:6.0.3", group: "domains", kind: "pull",
    ref: "letiemble/checkdmarc:6.0.3@sha256:be9d7e828fe80ace6140fdc0f4b499c10fffb2001be5f346718c3ec6dd6c90cd" },
  { tag: "drwetter/testssl.sh:3.2", group: "domains", kind: "pull",
    ref: "drwetter/testssl.sh:3.2@sha256:64bab3c1fd8eee440f68d5e020dd633c1f2d375fe0ae593bdfec2725110a7e29" },
  { tag: "dnsviz/dnsviz", group: "domains", kind: "pull",
    ref: "dnsviz/dnsviz@sha256:5a4c5e8293d591010bd57fb2e79a803865607d72457e74335229130f69265932" },
  { tag: "coredns/coredns:1.12.0", group: "domains", kind: "pull",
    ref: "coredns/coredns:1.12.0@sha256:40384aa1f5ea6bfdc77997d243aec73da05f27aed0c5e9d65bfa98933c519d97",
    note: "The Domains and Phishing labs' DNS server." },
  { tag: "node:22-alpine", group: "domains", kind: "pull",
    ref: "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
    note: "The Domains lab's web server." },
  { tag: "touchstone-observatory:1.7.2", group: "domains", kind: "build", optional: true,
    file: "spike/packs/domains/Dockerfile.observatory", context: "spike/packs/domains",
    note: "Used by the domains smoke test only." },
  { tag: "touchstone-phishing-dnstwist:20250130", group: "phishing", kind: "build",
    context: "spike/packs/phishing" },

  // ---- supply-chain scanners (offline at run time) ----
  { tag: "ghcr.io/zizmorcore/zizmor:1.32.0", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d" },
  { tag: "ghcr.io/boostsecurityio/poutine:1.1.6", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/boostsecurityio/poutine:1.1.6@sha256:722a8e0999b583c1540fe2974e691032b2d9d21b9256a17965132b6bfd0081b0" },
  { tag: "ghcr.io/gitleaks/gitleaks:v8.30.1", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f" },
  { tag: "ghcr.io/google/osv-scanner:v2.7.1", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/google/osv-scanner:v2.7.1@sha256:a70ffffc2bfd33482953e5d6b64c6fcdb30239717a07b0f0d3ab2859ce3e4cde" },
  { tag: "trufflesecurity/trufflehog:3.99.8", group: "supply-chain", kind: "pull",
    ref: "trufflesecurity/trufflehog:3.99.8@sha256:674b2f187620a19df77f44cf9a7d77efcc581a5662accef2f2739cbb46ba4a3a" },
  { tag: "ghcr.io/mongodb/kingfisher:2.18.1", group: "supply-chain", kind: "pull",
    ref: "ghcr.io/mongodb/kingfisher:2.18.1@sha256:e5cb2daee5521ad68f15f695c510fa87c1eefaa87103f13137cfb8420067700b" },
  { tag: "touchstone-cosign:v3.1.4", group: "supply-chain", kind: "build",
    context: "spike/packs/supply-chain/cosign" },
  // Opt-in networked tools (networked.mjs). Each runs only in capture mode.
  { tag: "touchstone/scorecard:5.6.0", group: "supply-chain", kind: "build", optional: true,
    context: "spike/packs/supply-chain/images/scorecard",
    note: "OSSF Scorecard. Opt-in: --network-tools scorecard." },
  { tag: "touchstone/legitify:1.0.11", group: "supply-chain", kind: "build", optional: true,
    context: "spike/packs/supply-chain/images/legitify",
    note: "Legitify. Opt-in; always fails closed (no lead parser)." },
  { tag: "touchstone/chain-bench:0.1.10-env", group: "supply-chain", kind: "build", optional: true,
    context: "spike/packs/supply-chain/images/chain-bench",
    note: "chain-bench v0.1.10 built from source with a main that reads SCM_TOKEN (never argv). Opt-in." },

  // ---- infra-cloud ----
  { tag: "touchstone/checkov-cli:3.4.3", group: "infra-cloud", kind: "build",
    file: "spike/packs/infra-cloud/Dockerfile.checkov", context: "spike/packs/infra-cloud" },
  { tag: "touchstone/kubescape-cli:4.0.20", group: "infra-cloud", kind: "build",
    file: "spike/packs/infra-cloud/Dockerfile.kubescape", context: "spike/packs/infra-cloud" },
  { tag: "touchstone/prowler-python:5.48.0", group: "infra-cloud", kind: "build",
    file: "spike/packs/infra-cloud/Dockerfile.prowler-python", context: "spike/packs/infra-cloud" },
  { tag: "touchstone/infra-cloud-cloud-lab:wave2", group: "infra-cloud", kind: "build",
    context: "spike/packs/infra-cloud/lab/cloud",
    note: "Live-cloud lab: private moto with IAM + node runtime for the http proof." },
  { tag: "motoserver/moto:5.2.5", group: "infra-cloud", kind: "pull",
    ref: "motoserver/moto:5.2.5@sha256:59a1965d845249b04def37a0e2565f9cc6c44543cb89b68e90f28f344b3b0d1a" },
  { tag: "aquasec/trivy:0.76.2", group: "infra-cloud", kind: "pull",
    ref: "aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb" },
  { tag: "checkmarx/kics:v2.2.1", group: "infra-cloud", kind: "pull",
    ref: "checkmarx/kics:v2.2.1@sha256:49ccc54b6ae7f5d5fc95e96f8f95c18c57f3bba047ab611a03d80792bdff6757" },
  { tag: "anchore/grype", group: "infra-cloud", kind: "pull",
    ref: "anchore/grype@sha256:13113eeceab017260370cf540e1d25442c59665fd07d1b09b66d63bb0c282887" },
  { tag: "anchore/syft", group: "infra-cloud", kind: "pull",
    ref: "anchore/syft@sha256:03215d0e98b661d0ecbc8575dbc14d65be1743b5de5df6410aecb7e80f95b060" },
  { tag: "semgrep/semgrep", group: "infra-cloud", kind: "pull",
    ref: "semgrep/semgrep@sha256:cc1b68266f267878b39739373ea9985b9a78e5d64497dd875c8de100b22695ed" },

  // ---- strix (its own sandbox; carries a docker client) ----
  { tag: STRIX_SANDBOX_TAG, group: "strix", kind: "pull", optional: true,
    ref: STRIX_SANDBOX_IMAGE,
    note: "Runtime sandbox required by the pinned Strix 1.7.0 CLI." },
  { tag: "touchstone/strix:1.7.0", group: "strix", kind: "build",
    file: "spike/tools/strix/Dockerfile", context: "spike", optional: true,
    note: "Carries the Strix CLI + a docker client + the loopback model shim." },
];
