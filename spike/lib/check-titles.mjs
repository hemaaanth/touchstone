// One readable title per check kind. A finding or a candidate never shows a
// raw check id (`tls-cipherlist_3des_idea`) as its title; the id stays in the
// record and in the detail, as a machine value.
//
// TLS ids come from testssl.sh and are open-ended, so a tls-* id gets an exact
// title when it is known, then a family title by its prefix, then one generic
// title. Every other id gets its own line here (a test fails until it does).

export const CHECK_TITLES = {
  // domains: front end, DNS, mail, registry
  "dangling-cname": "A DNS name points at a service that no longer answers for it",
  "subdomain-takeover-fingerprint": "A subdomain shows a known takeover fingerprint",
  "wallet-drainer-behavior": "The front end contains code shaped like a wallet drainer",
  "missing-frame-protection": "The site can be framed by other sites (no frame protection)",
  "weak-csp": "The Content-Security-Policy allows unsafe sources",
  "wallet-cdn-without-sri": "A wallet script loads from a CDN with no integrity hash",
  "third-party-script-without-sri": "A third-party script loads with no integrity hash",
  "known-vulnerable-js": "The front end ships a JavaScript library with known vulnerabilities",
  "email-auth-evidence-missing": "Mail authentication could not be checked",
  "email-dmarc-missing": "No DMARC record for the domain",
  "email-dmarc-policy-none": "DMARC is set to monitor only (policy none)",
  "email-dmarc-no-reporting": "DMARC sends no failure reports",
  "email-dmarc-invalid": "The DMARC record is not valid",
  "email-spf-invalid": "The SPF record is not valid",
  "email-spf-missing": "No SPF record for the domain",
  "email-spf-allows-all": "SPF lets any server send mail for the domain",
  "tls-evidence-missing": "TLS could not be checked",
  "dnssec-evidence-missing": "DNSSEC could not be checked",
  "dnssec-unsigned": "The DNS zone is not signed (no DNSSEC)",
  "dnssec-broken-chain": "The DNSSEC chain of trust is broken",
  "dnssec-warning": "DNSSEC shows a warning",
  "dnssec-no-ds": "DNSSEC: no DS record at the parent zone",
  "registry-lock-evidence-missing": "The registry lock could not be checked",
  "frontend-content-pin-missing": "The front end has no content pin (IPFS or hash)",
  // surface (leads only; never a finding today)
  "discovered-host": "A host found by discovery",
  "discovered-service": "A service found by discovery",
  "discovered-endpoint": "An endpoint found by discovery",
  "discovered-secret": "A secret-shaped value found by discovery",
  // supply-chain
  "evm-private-key": "An EVM private key is committed in the repository",
  "bip39-mnemonic": "A wallet seed phrase is committed in the repository",
  "rpc-provider-key": "An RPC provider key is committed in the repository",
  "evm-keystore": "An encrypted wallet keystore is committed in the repository",
  "crypto-package-lookalike": "A dependency name looks like a known crypto package",
  "dependency-reaches-signer": "A dependency's code reaches a signing function",
  "dependency-exfil-code": "A dependency contains code that sends data out",
  "dependency-not-in-lockfile": "A dependency is not pinned in the lockfile",
  "artifact-signature-missing": "A release artifact has no signature",
  "tool:cosign": "A release artifact's signature does not verify",
  "tool:zizmor": "A CI workflow weakness (zizmor)",
  "tool:poutine": "A CI pipeline weakness (poutine)",
  "tool:gitleaks": "A secret-shaped value in the repository (gitleaks)",
  "tool:trufflehog": "A secret-shaped value in the repository (TruffleHog)",
  "tool:semgrep": "A code pattern that moves secrets or signer data (Semgrep)",
  "tool:grype": "A dependency with a known vulnerability (Grype)",
  "tool:osv": "A dependency with a known vulnerability (OSV)",
  "tool:scorecard": "A low OpenSSF Scorecard result",
  "tool:chain-bench": "A CIS software supply chain check fails (chain-bench)",
  // infra-cloud
  "broad-kms-sign": "A role may sign with the KMS key more broadly than needed",
  "internet-signer-security-group": "A signer's security group is open to the internet",
  "public-signer-load-balancer": "A signer sits behind a public load balancer",
  "exposed-signer-service": "A signer service is exposed outside the cluster",
  "internet-rpc-admin-namespaces": "RPC admin methods are reachable from the internet",
  "hot-wallet-key-in-config": "A hot-wallet key is in a config file",
  "hot-wallet-key-in-env": "A hot-wallet key is in an environment variable",
  "ci-can-exec-signers": "CI can run commands on the signers",
  "iam-role-broad-object-read": "A role can read storage buckets it does not own",
  "frontend-versioning-disabled": "The front-end bucket keeps no old versions",
  "frontend-object-lock-missing": "The front-end bucket has no object lock",
  "frontend-public-write": "Anyone can write to the front-end bucket",
  "ci-can-write-frontend": "CI can overwrite the published front end",
  "tool:trivy": "An infrastructure misconfiguration (Trivy)",
  "tool:kics": "An infrastructure misconfiguration (KICS)",
  // http oracles (web, ai-mcp, infra-cloud live)
  "siwe-nonce-replay": "A signed sign-in message can be replayed for a new session",
  "bola-wallet-idor": "A user can read another user's account data",
  "debug-route-signer-key-leak": "A debug route returns the signer's private key",
  "reflected-xss": "A page reflects input as executable markup (reflected XSS)",
  "prompt-injection-forbidden-tool": "Injected text makes the assistant run a tool nobody asked for",
  "prompt-injection-data-exfil": "Injected text makes the assistant send a secret to an outside host",
  "fetch-url-scope-escape": "The fetch tool reads outside its allowed scope",
  "mcp-tool-scope-bypass": "An MCP token runs a tool it has no scope for",
  "tool-description-poisoning": "A tool description makes the assistant run another tool",
  "mcp-tool-definition-rug-pull": "An approved MCP tool changes after approval",
  "assumed-role-reads-other-bucket": "A role reads a bucket it does not own",
};

// Scanner rules named in plain words. A rule not listed takes its tool's
// title (CHECK_TITLES "tool:…"); its id stays in the evidence, never the title.
export const RULE_TITLES = {
  // zizmor (GitHub Actions)
  "zizmor/excessive-permissions": "A CI workflow has more permissions than it needs (zizmor)",
  "zizmor/unpinned-uses": "A CI workflow uses an action that is not pinned to a commit (zizmor)",
  "zizmor/artipacked": "A CI workflow can leak its token in an uploaded artifact (zizmor)",
  "zizmor/template-injection": "A CI workflow puts untrusted input into a script (zizmor)",
  "zizmor/dangerous-triggers": "A CI workflow runs on a trigger that gives forks its secrets (zizmor)",
  "zizmor/cache-poisoning": "A CI workflow can be fed a poisoned cache (zizmor)",
  "zizmor/github-env": "A CI workflow writes untrusted input to GITHUB_ENV (zizmor)",
  "zizmor/unpinned-images": "A CI workflow uses a container image that is not pinned (zizmor)",
  "zizmor/secrets-inherit": "A CI workflow passes every secret to a called workflow (zizmor)",
  // poutine (CI pipelines)
  "untrusted_checkout_exec": "A CI job runs code from an untrusted checkout (poutine)",
  "github_action_from_unverified_creator_used": "A CI workflow uses an action from an unverified creator (poutine)",
  "injection": "A CI pipeline puts untrusted input into a command (poutine)",
  "job_all_secrets": "A CI job can read every secret (poutine)",
  "default_permissions_on_risky_events": "A CI workflow keeps default permissions on a risky trigger (poutine)",
  "pr_runs_on_self_hosted": "Pull requests run on a self-hosted CI runner (poutine)",
  "unpinnable_action": "A CI workflow uses an action that cannot be pinned (poutine)",
  "known_vulnerability_in_build_component": "A CI build component has a known vulnerability (poutine)",
};

// testssl.sh ids seen in our runs, then families by prefix.
const TLS_TITLES = {
  "tls-cipherlist_3des_idea": "TLS offers weak 3DES or IDEA ciphers",
  "tls-breach": "HTTP compression over TLS (BREACH)",
  "tls-dns_caarecord": "No CAA record limits who may issue certificates",
  "tls-cert_chain_of_trust": "The TLS certificate chain is not trusted",
};
const TLS_FAMILIES = [
  [/^tls-cipherlist_/i, "TLS offers a weak cipher group"],
  [/^tls-cipher/i, "TLS offers a weak cipher"],
  [/^tls-cert/i, "A TLS certificate problem"],
  [/^tls-(?:SSLv2|SSLv3|TLS1|TLS1_1)$/i, "An old TLS protocol version is offered"],
  [/^tls-(?:HSTS|HPKP)/i, "A TLS-related HTTP header is missing or weak"],
];
export const TLS_FALLBACK = "A TLS setting the scanner flags";

const isTls = (check) => typeof check === "string" && check.startsWith("tls-");

// The title for a check id. Null for an id that is not a check kind we know
// (the caller keeps its own title then).
export function checkTitle(check) {
  const id = String(check ?? "");
  if (Object.hasOwn(CHECK_TITLES, id)) return CHECK_TITLES[id];
  if (!isTls(id)) return null;
  if (Object.hasOwn(TLS_TITLES, id)) return TLS_TITLES[id];
  for (const [re, title] of TLS_FAMILIES) if (re.test(id)) return title;
  return TLS_FALLBACK;
}

// The title to show for a finding or candidate of this check. A title that is
// only an id (no spaces: a check id, a scanner rule such as
// zizmor/unpinned-uses, an advisory id) becomes the readable one, and so does
// every scanner (tool:*) title, whose rule stays in the evidence. A real
// sentence is kept. An unknown check keeps its title.
const ID_LIKE = /^[^\s]+$/;
export function readableTitle(title, check, rule = "") {
  const t = String(title ?? "").trim();
  const ruleTitle = Object.hasOwn(RULE_TITLES, String(rule)) ? RULE_TITLES[rule] : null;
  const readable = ruleTitle ?? checkTitle(check) ?? checkTitle(t);
  if (!readable) return t;
  if (!t || ID_LIKE.test(t) || String(check ?? "").startsWith("tool:")) return readable;
  return t;
}
