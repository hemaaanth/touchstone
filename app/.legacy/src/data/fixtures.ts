/*
 * Mock data for the chat-first mockups. Every screen reads from here.
 * Nothing calls a backend. The story is one Sunday morning, Nov 8, 09:31.
 *
 * Story:
 * - Run #129 (Morning check, 06:00) is done. It found F-0039 and F-0051.
 * - Run #131 (Vault review) is live in Run mode Prove. It waits at step 5
 *   of 8: a fork-only exploit test. That is the one waiting approval.
 * - F-0042 is Likely. It can show "Proven (machine)" only after the fork
 *   test passes. AFTER_APPROVE holds that later state. The mock plays it
 *   only when you click Approve.
 *
 * Rules kept in this data (decisions, Nov 8):
 * - One user. No roles. No person's name on runs, approvals or alerts.
 * - Every run happens in a sandbox. Agents think on the host.
 * - No wallet and no signing. The grant is confirmed by typing the
 *   project name.
 * - Access is per asset: Source or Public, with the link method.
 */

/* ---------- Words used everywhere ---------- */

export type Severity = "Critical" | "High" | "Medium" | "Low"

/** Proven needs a passing proof test. "Not exploitable" and "Fixed" are closed. */
export type Verdict = "Proven" | "Likely" | "Unproven" | "Not exploitable" | "Fixed"

/** The input axis, per asset. Source is a superset of Public. */
export type Access = "Source" | "Public"

/** Set per run. The project has a ceiling, never a single mode. */
export type RunMode = "Observe" | "Safe" | "Prove" | "Lab"

/** Step tier. P look only, S safe test, I intrusive test, F fork-only test. */
export type Tier = "P" | "S" | "I" | "F"

/** What the grant allows on one asset. */
export type AssetTier = "Test" | "Look only" | "Logged-in only" | "Ask first" | "Never touch"

/** Result markers: + New, ! Reopened, - Fixed, = Open, ~ Changed, ? Not run. */
export type DiffMark = "New" | "Reopened" | "Fixed" | "Open" | "Changed" | "Not run"

export const DIFF_SIGN: Record<DiffMark, string> = {
  New: "+",
  Reopened: "!",
  Fixed: "-",
  Open: "=",
  Changed: "~",
  "Not run": "?",
}

/** Sandbox profiles from the sandbox design. */
export type SandboxProfile = "code" | "net" | "PoC" | "lab"

/* ---------- The user, the instance, the project ---------- */

/** The instance. One user, no organization. Spend is for all projects together. */
export const ORG = {
  spendToday: "$3.20",
  spendCap: "$10.00",
  spendMonth: "$41.70",
  spendMonthCap: "$150.00",
}

/** The active permission. Static facts, never shown as chips. */
export const GRANT = {
  version: "v3",
  confirmed: "Oct 30",
  confirmedHow: "You typed the project name",
  /** sha256 of the confirmed scope. Technical view and exports only. */
  scopeHash: "sha256:4be1…77a0",
  ceiling: "Prove" as RunMode,
  window: "Every day, 01:00 to 22:00 UTC",
  expires: "in 20 days",
  ends: "Nov 28",
}

export type NeverTouch = { item: string; why: string }
export type OutsideScope = { item: string; label: string; how: string; when: string; state: string }
export type ScopeChange = { mark: "+" | "-" | "~"; item: string; detail: string }
export type ScopeVersion = {
  version: string
  confirmed: string
  scopeHash: string
  /** Assets the harness may test. */
  inScope: number
  /** Assets listed so the harness never touches them. */
  neverTouch: number
  current: boolean
}

export const PROJECT = {
  name: "Acme Protocol",
  /** The highest run mode the grant allows. The top bar shows "Ceiling: Prove". */
  ceiling: "Prove" as RunMode,
  spendToday: ORG.spendToday,
  spendCap: ORG.spendCap,
  grantVersion: GRANT.version,
  scopeHash: GRANT.scopeHash,
  neverTouch: [
    { item: "Security Safe (0x9c0d…41b7)", why: "Production signer." },
    { item: "staging.acme.xyz", why: "Shared with a vendor." },
    { item: "Mainnet sends", why: "The harness never signs or sends a transaction." },
    { item: "Uniswap V3 pools", why: "Third-party contracts." },
  ] satisfies NeverTouch[],
  /** Third-party things seen while tracing. Not tested. Add one through a scope change. */
  foundOutsideScope: [
    {
      item: "0x5f4e…8419",
      label: "Chainlink ETH/USD feed",
      how: "Traced from PriceOracle in run #131",
      when: "Nov 8, 09:21",
      state: "Not tested",
    },
    {
      item: "cdn.jsdelivr.net",
      label: "Script host used by docs.acme.xyz",
      how: "Seen by the Morning check, run #129",
      when: "Nov 8, 06:05",
      state: "Not tested",
    },
  ] satisfies OutsideScope[],
  versions: [
    // v2 to v3: 2 added, staging moved to Never touch. 15 + 2 - 1 = 16 in scope.
    { version: "v3", confirmed: "Oct 30", scopeHash: "sha256:4be1…77a0", inScope: 16, neverTouch: 2, current: true },
    { version: "v2", confirmed: "Oct 9", scopeHash: "sha256:3f9a…07c2", inScope: 15, neverTouch: 1, current: false },
    { version: "v1", confirmed: "Sep 28", scopeHash: "sha256:0c7d…a12e", inScope: 3, neverTouch: 1, current: false },
  ] satisfies ScopeVersion[],
  /** v3 compared with v2. The Scope screen shows this diff. */
  diff: [
    { mark: "+", item: "OldPool (0x7d2a…19c4)", detail: "Added. Public access, look only." },
    { mark: "+", item: "support-bot (MCP)", detail: "Added. Source access, from acme/app/mcp.json." },
    { mark: "~", item: "Router", detail: "Source → Public. The deploy manifest no longer lists it." },
    { mark: "~", item: "app.acme.xyz", detail: "Test → Logged-in only." },
    { mark: "-", item: "staging.acme.xyz", detail: "Moved to Never touch." },
    { mark: "~", item: "Ceiling", detail: "Safe → Prove." },
  ] satisfies ScopeChange[],
}

export const PROJECTS = [
  { name: "Acme Protocol", access: "Source + Public", current: true, limited: false },
  { name: "near-pay", access: "Source", current: false, limited: true },
  { name: "Practice lab", access: "Source + Public", current: false, limited: false },
]

/* ---------- Assets ---------- */

export type AssetKind =
  | "Contract"
  | "Safe"
  | "Wallet"
  | "Domain"
  | "Web app"
  | "API"
  | "Package"
  | "Repo"
  | "Cloud"
  | "AI agent"

export type Asset = {
  id: string
  name: string
  kind: AssetKind
  /** CAIP-2 chain id for chain assets. */
  chain?: string
  address?: string
  access: Access
  /** The link method that set the access, in plain words. */
  accessBecause: string
  /** Set when the access changed since the last scope version. */
  drift?: string
  tier: AssetTier
  /** Ownership proof. P and fork tests may run before proof. S and I may not. */
  proof: { kind: string; ok: boolean }
  /** NEAR contracts and Chain Signatures: checks are limited. */
  limited?: boolean
  /** Safes only. */
  threshold?: string
}

/** Shown when an asset has no ownership proof yet. */
export const BEFORE_PROOF = "Look-only and fork tests can run. Active tests wait for proof."

/** Shown on every NEAR asset, finding and module row. */
export const NEAR_LIMITED = "NEAR checks are limited. Findings stay Unproven until a near-sandbox test runs."

export const ASSETS: Asset[] = [
  {
    id: "vault",
    name: "Vault",
    kind: "Contract",
    chain: "eip155:1",
    address: "0x5c1e…a94f",
    access: "Source",
    accessBecause: "Address found in repo at contracts/Vault.sol",
    tier: "Test",
    proof: { kind: "Deploy manifest in the connected repo", ok: true },
  },
  {
    id: "oracle",
    name: "PriceOracle",
    kind: "Contract",
    chain: "eip155:1",
    address: "0x91d0…07b2",
    access: "Source",
    accessBecause: "Address found in repo at deployments/mainnet.json",
    tier: "Test",
    proof: { kind: "Deploy manifest in the connected repo", ok: true },
  },
  {
    id: "router",
    name: "Router",
    kind: "Contract",
    chain: "eip155:1",
    address: "0x6a3f…e21c",
    access: "Public",
    accessBecause: "Verified on Sourcify (full match). Repo connected, no link found.",
    drift: "Was Source in v2. The deploy manifest no longer lists it.",
    tier: "Look only",
    proof: { kind: "None. Public access cannot prove ownership.", ok: false },
  },
  {
    id: "oldpool",
    name: "OldPool",
    kind: "Contract",
    chain: "eip155:1",
    address: "0x7d2a…19c4",
    access: "Public",
    accessBecause: "Bytecode only, behind an EIP-1967 proxy. Repo connected, no link found.",
    tier: "Look only",
    proof: { kind: "None. Public access cannot prove ownership.", ok: false },
  },
  {
    id: "bridge-near",
    name: "bridge.acme.near",
    kind: "Contract",
    chain: "near:mainnet",
    address: "bridge.acme.near",
    access: "Source",
    accessBecause: "Account ID found in repo at near/deploy.json",
    tier: "Test",
    proof: { kind: "Deploy manifest in the connected repo", ok: true },
    limited: true,
  },
  {
    id: "treasury",
    name: "Treasury Safe",
    kind: "Safe",
    chain: "eip155:1",
    address: "0x2b7e…d013",
    access: "Public",
    accessBecause: "Safe read on chain. Repo connected, no link found.",
    tier: "Look only",
    proof: { kind: "Listed in /.well-known/security-assets.json on acme.xyz", ok: true },
    threshold: "2 of 5",
  },
  {
    id: "security-safe",
    name: "Security Safe",
    kind: "Safe",
    chain: "eip155:1",
    address: "0x9c0d…41b7",
    access: "Public",
    accessBecause: "Safe read on chain. Repo connected, no link found.",
    tier: "Never touch",
    proof: { kind: "Listed in /.well-known/security-assets.json on acme.xyz", ok: true },
    threshold: "2 of 3",
  },
  {
    id: "deployer",
    name: "Deployer key",
    kind: "Wallet",
    chain: "eip155:1",
    address: "0x3fa1…c2d9",
    access: "Public",
    accessBecause: "Address read on chain. No key material is ever used.",
    tier: "Look only",
    proof: { kind: "Listed in /.well-known/security-assets.json on acme.xyz", ok: true },
  },
  {
    id: "acme-xyz",
    name: "acme.xyz",
    kind: "Domain",
    access: "Public",
    accessBecause: "Repo connected, no hosting link found.",
    tier: "Look only",
    proof: { kind: "DNS TXT record", ok: true },
  },
  {
    id: "app",
    name: "app.acme.xyz",
    kind: "Web app",
    access: "Source",
    accessBecause: "Vercel project acme/app serves this domain",
    tier: "Logged-in only",
    proof: { kind: "DNS TXT record on acme.xyz", ok: true },
  },
  {
    id: "docs",
    name: "docs.acme.xyz",
    kind: "Web app",
    access: "Public",
    accessBecause: "Repo connected, no link found.",
    tier: "Look only",
    proof: { kind: "DNS TXT record on acme.xyz", ok: true },
  },
  {
    id: "api",
    name: "api.acme.xyz",
    kind: "API",
    access: "Source",
    accessBecause: "Schema found in repo at acme/app/api/openapi.yaml",
    tier: "Test",
    proof: { kind: "DNS TXT record on acme.xyz", ok: true },
  },
  {
    id: "sdk",
    name: "@acme/sdk",
    kind: "Package",
    access: "Source",
    accessBecause: "Repository field and npm provenance point to acme/sdk",
    tier: "Test",
    proof: { kind: "npm provenance", ok: true },
  },
  {
    id: "repo-contracts",
    name: "acme/contracts",
    kind: "Repo",
    access: "Source",
    accessBecause: "GitHub App installed on the repo",
    tier: "Test",
    proof: { kind: "GitHub App install", ok: true },
  },
  {
    id: "repo-app",
    name: "acme/app",
    kind: "Repo",
    access: "Source",
    accessBecause: "GitHub App installed on the repo",
    tier: "Test",
    proof: { kind: "GitHub App install", ok: true },
  },
  {
    id: "aws",
    name: "AWS account 1234…5678",
    kind: "Cloud",
    access: "Public",
    accessBecause: "Account ID found in IaC. No read-only role.",
    tier: "Look only",
    proof: { kind: "Read-only cloud role", ok: false },
  },
  {
    id: "support-bot",
    name: "support-bot (MCP)",
    kind: "AI agent",
    access: "Source",
    accessBecause: "MCP config found in repo at acme/app/mcp.json",
    tier: "Test",
    proof: { kind: "Config in the connected repo", ok: true },
  },
  {
    id: "staging",
    name: "staging.acme.xyz",
    kind: "Web app",
    access: "Public",
    accessBecause: "Repo connected, no link found.",
    tier: "Never touch",
    proof: { kind: "DNS TXT record on acme.xyz", ok: true },
  },
]

export const ASSET_NAMES = ASSETS.map((asset) => asset.name)

/** In scope means any tier except Never touch. */
export const IN_SCOPE = ASSETS.filter((asset) => asset.tier !== "Never touch")

export function assetById(id: string): Asset | undefined {
  return ASSETS.find((asset) => asset.id === id)
}

/* ---------- Modules: a catalog, not pages ---------- */

export type ModuleKey =
  | "surface"
  | "keys"
  | "contracts"
  | "nodes"
  | "chain-watch"
  | "web"
  | "apis"
  | "domains"
  | "infra"
  | "supply"
  | "people"
  | "ai"
  | "readiness"

/** What ran on one asset. "found" is not stored: code sets it from open findings. */
export type AssetRun = "ok" | "partial" | "not run" | "needs source"

export type Module = {
  key: ModuleKey
  n: number
  name: string
  group: "Top" | "Chain" | "Apps" | "Infra" | "People and AI" | "Readiness"
  /** The access the module needs for its full checks. */
  needs: Access
  /** How much it can check with Public access only. */
  publicCoverage: "High" | "Medium" | "Medium/Low" | "Low"
  /** NEAR checks are limited for this module. */
  nearLimited: boolean
  /** The agent turned it on for this project. */
  on: boolean
  /** Why it is on or off, in plain words. The agent says this in the chat. */
  why: string
  lastRun: string
  /** Every in-scope asset this module fits, and what ran on it. */
  assets: { asset: string; run: AssetRun; note?: string }[]
}

export const MODULES: Module[] = [
  {
    key: "surface",
    n: 1,
    name: "Surface",
    group: "Top",
    needs: "Public",
    publicCoverage: "Medium",
    nearLimited: true,
    on: true,
    why: "On for every project. It lists what can be reached from outside.",
    lastRun: "Run #129, today 06:00",
    assets: [
      { asset: "acme-xyz", run: "ok" },
      { asset: "app", run: "ok" },
      { asset: "docs", run: "ok" },
      { asset: "api", run: "ok" },
    ],
  },
  {
    key: "keys",
    n: 2,
    name: "Keys and signing",
    group: "Chain",
    needs: "Public",
    publicCoverage: "High",
    nearLimited: true,
    on: true,
    why: "On because the scope has a Safe and a deployer key.",
    lastRun: "Run #126, Nov 5",
    assets: [
      { asset: "treasury", run: "ok" },
      { asset: "deployer", run: "ok" },
      { asset: "oracle", run: "ok" },
    ],
  },
  {
    key: "contracts",
    n: 3,
    name: "Contracts",
    group: "Chain",
    needs: "Source",
    publicCoverage: "Medium/Low",
    nearLimited: true,
    on: true,
    why: "On because acme/contracts links to Vault and PriceOracle.",
    lastRun: "Run #131, running now",
    assets: [
      { asset: "vault", run: "ok" },
      { asset: "oracle", run: "ok" },
      { asset: "router", run: "partial", note: "Router: verified source, no repo link. Source checks skipped." },
      { asset: "oldpool", run: "partial", note: "OldPool: bytecode only. 6 Source checks skipped." },
      { asset: "bridge-near", run: "partial", note: "bridge.acme.near: NEAR checks are limited." },
    ],
  },
  {
    key: "nodes",
    n: 4,
    name: "Nodes and RPC",
    group: "Chain",
    needs: "Public",
    publicCoverage: "Low",
    nearLimited: true,
    on: false,
    why: "The scope has no nodes or RPC endpoints.",
    lastRun: "Never",
    assets: [],
  },
  {
    key: "chain-watch",
    n: 5,
    name: "Chain watch",
    group: "Chain",
    needs: "Public",
    publicCoverage: "High",
    nearLimited: true,
    on: true,
    why: "On because the scope has contracts and a Safe on Ethereum.",
    lastRun: "Every block. Last change at block 23,456,802",
    assets: [
      { asset: "vault", run: "ok" },
      { asset: "oracle", run: "ok" },
      { asset: "treasury", run: "ok" },
      { asset: "deployer", run: "ok" },
    ],
  },
  {
    key: "web",
    n: 6,
    name: "Web and sign-in",
    group: "Apps",
    needs: "Public",
    publicCoverage: "Medium",
    nearLimited: false,
    on: true,
    why: "On because app.acme.xyz has a sign-in and a test account.",
    lastRun: "Run #129, today 06:00",
    assets: [
      { asset: "app", run: "ok" },
      { asset: "docs", run: "partial", note: "docs.acme.xyz: Public only. No repo link." },
    ],
  },
  {
    key: "apis",
    n: 7,
    name: "APIs",
    group: "Apps",
    needs: "Public",
    publicCoverage: "Low",
    nearLimited: false,
    on: true,
    why: "On because acme/app has an OpenAPI schema for api.acme.xyz.",
    lastRun: "Run #129, today 06:00",
    assets: [{ asset: "api", run: "ok" }],
  },
  {
    key: "domains",
    n: 8,
    name: "Domains and front end",
    group: "Apps",
    needs: "Public",
    publicCoverage: "High",
    nearLimited: false,
    on: true,
    why: "On because the scope has three domains.",
    lastRun: "Run #129, today 06:00",
    assets: [
      { asset: "acme-xyz", run: "ok" },
      { asset: "app", run: "ok" },
      { asset: "docs", run: "ok" },
    ],
  },
  {
    key: "infra",
    n: 9,
    name: "Infra and cloud",
    group: "Infra",
    needs: "Source",
    publicCoverage: "Low",
    nearLimited: false,
    on: true,
    why: "On because the IaC in acme/app names an in-scope AWS account.",
    lastRun: "Never",
    assets: [
      { asset: "aws", run: "needs source", note: "AWS 1234…5678: no read-only role. Infra checks need one." },
    ],
  },
  {
    key: "supply",
    n: 10,
    name: "Supply chain and secrets",
    group: "Infra",
    needs: "Source",
    publicCoverage: "Medium/Low",
    nearLimited: false,
    on: true,
    why: "On because two repos and a package are in scope.",
    lastRun: "Run #126, Nov 5",
    assets: [
      { asset: "sdk", run: "ok" },
      { asset: "repo-contracts", run: "ok" },
      { asset: "repo-app", run: "not run", note: "acme/app: not scanned yet. Weekly deep missed 2 runs." },
    ],
  },
  {
    key: "people",
    n: 11,
    name: "People and brand",
    group: "People and AI",
    needs: "Public",
    publicCoverage: "Medium",
    nearLimited: false,
    on: true,
    why: "On because acme.xyz is a brand that can be copied.",
    lastRun: "Run #129, today 06:00",
    assets: [{ asset: "acme-xyz", run: "ok" }],
  },
  {
    key: "ai",
    n: 12,
    name: "AI agents and MCP",
    group: "People and AI",
    needs: "Source",
    publicCoverage: "Low",
    nearLimited: false,
    on: true,
    why: "On because acme/app/mcp.json lists the support bot.",
    lastRun: "Never",
    assets: [
      { asset: "support-bot", run: "not run", note: "support-bot: not checked yet. It is in the next Weekly deep." },
    ],
  },
  {
    key: "readiness",
    n: 13,
    name: "Drills and response",
    group: "Readiness",
    needs: "Public",
    publicCoverage: "Low",
    nearLimited: true,
    on: false,
    why: "You turned off the Monthly drill.",
    lastRun: "Sep 30",
    assets: [],
  },
]

export function moduleByKey(key: string): Module | undefined {
  return MODULES.find((module) => module.key === key)
}

/* ---------- Findings ---------- */

export type ProofTest = {
  kind: "fork test" | "replay test" | "near-sandbox test"
  state: "passed" | "failed" | "waiting" | "not run"
  run?: number
  step?: number
}

export type Finding = {
  id: string
  title: string
  severity: Severity
  module: ModuleKey
  /** Asset id. */
  asset: string
  access: Access
  /** What the verdict rests on, for example "repo:acme/contracts@9e1c" or "bytecode". */
  inputs: string[]
  /** Where the problem is. lib/finding-text.ts writes it as one line. */
  location: FindingLocation
  /** Dedup key. Technical view only. */
  fingerprint: string
  /** What the code computed from the evidence. */
  machineVerdict: Verdict
  /** What you accepted. Null until you accept. */
  accepted: Verdict | null
  /** The highest verdict the inputs allow. */
  cap: Verdict
  capReason: string
  /** Proven needs this test to pass. Null when no test applies. */
  proofTest: ProofTest | null
  /** One line in plain words. */
  why: string
  fix: string
  diff: DiffMark
  run: number
  found: string
  history: { when: string; text: string }[]
  evidence: { plain: string; technical: string }[]
  /** The evidence bundle. A hash is null until the run seals the bundle. */
  files: EvidenceFile[]
  /** The hash of the sealed bundle. Null while the run is still going. */
  evidenceHash: string | null
  /** The day the evidence is deleted, RETENTION.days after it was found. */
  deletes: string
  refuter: string | null
}

/**
 * chain is a CAIP-2 id, or null for web assets. selector is the 4-byte
 * selector or the NEAR method. label is the function name or a short note.
 * The label is never part of the dedup key (C2).
 */
export type FindingLocation = {
  chain: string | null
  address: string
  selector: string | null
  label: string | null
}

/** One file in an evidence bundle. Plain words say what it is. The hash shows in Technical words. */
export type EvidenceFile = { name: string; plain: string; hash: string | null }

/** The four files every bundle has. hashes is null while the run is still going. */
function bundle(version: string, hashes: [finding: string, authorization: string, models: string] | null): EvidenceFile[] {
  const scope = PROJECT.versions.find((row) => row.version === version)
  return [
    { name: "finding.json", plain: "The finding", hash: hashes?.[0] ?? null },
    { name: "authorization.json", plain: `Your scope ${version}`, hash: hashes?.[1] ?? null },
    { name: "scope.sha256", plain: "Scope proof file", hash: scope?.scopeHash ?? null },
    { name: "models.json", plain: "Models used", hash: hashes?.[2] ?? null },
  ]
}

export const FINDINGS: Finding[] = [
  {
    id: "F-0042",
    title: "Vault.withdraw reentrancy",
    severity: "High",
    module: "contracts",
    asset: "vault",
    access: "Source",
    inputs: ["repo:acme/contracts@9e1c", "verified:sourcify-full", "fuzz:echidna"],
    location: { chain: "eip155:1", address: "0x5c1e…a94f", selector: "0x2e1a7d4d", label: "withdraw" },
    fingerprint: "contracts|eip155:1:0x5c1e…a94f|0x2e1a7d4d|reentrancy",
    machineVerdict: "Likely",
    accepted: null,
    cap: "Proven",
    capReason: "Source at a linked commit. A passing fork test can reach Proven.",
    proofTest: { kind: "fork test", state: "waiting", run: 131, step: 5 },
    why: "withdraw sends ETH before it lowers the balance. A contract can call it again and take more.",
    fix: "Lower the balance before the transfer, or add a reentrancy guard to withdraw.",
    diff: "New",
    run: 131,
    found: "Nov 8, 09:24",
    files: bundle("v3", null),
    evidenceHash: null,
    deletes: "Feb 6",
    history: [
      { when: "Nov 8, 09:24", text: "Found by run #131 (fuzz). Seen in Source access, acme/contracts@9e1c." },
      { when: "Nov 1", text: "Not seen in run #118. The code at acme/contracts@71aa had a guard." },
    ],
    evidence: [
      {
        plain: "Fuzzing broke the balance rule on the third call.",
        technical: "echidna 50,000 runs; withdraw_balance_invariant failed at call 3",
      },
      {
        plain: "Exploit test written. It has not run yet.",
        technical: "test/exploit/VaultReentrancy.t.sol (not run)",
      },
    ],
    refuter: null,
  },
  {
    id: "F-0039",
    title: "Session cookie has no SameSite flag",
    severity: "Medium",
    module: "web",
    asset: "app",
    access: "Source",
    inputs: ["repo:acme/app@4b7e", "test-account"],
    location: { chain: null, address: "https://app.acme.xyz", selector: null, label: "Set-Cookie: session" },
    fingerprint: "web|app.acme.xyz|cookie:session|samesite",
    machineVerdict: "Likely",
    accepted: null,
    cap: "Proven",
    capReason: "Source at a linked commit. A replay test with the test account can reach Proven.",
    proofTest: { kind: "replay test", state: "not run" },
    why: "The sign-in cookie goes out on requests from other sites. That allows forged requests.",
    fix: "Set SameSite=Lax on the session cookie in acme/app/src/auth/session.ts.",
    diff: "New",
    run: 129,
    found: "Nov 8, 06:07",
    files: bundle("v3", ["3c81…5e", "7a02…d9", "e40b…16"]),
    evidenceHash: "sha256:5a3e…c108",
    deletes: "Feb 6",
    history: [
      { when: "Nov 8, 06:07", text: "Found by run #129 (Morning check). Seen in Source access, acme/app@4b7e." },
    ],
    evidence: [
      {
        plain: "The sign-in reply sets the cookie without SameSite.",
        technical: "Set-Cookie: session=…; Path=/; HttpOnly; Secure",
      },
      {
        plain: "The code that sets it.",
        technical: "acme/app@4b7e src/auth/session.ts:41",
      },
    ],
    refuter: "Checked for a CSRF token on state changes. Two forms have none.",
  },
  {
    id: "F-0038",
    title: "PriceOracle admin is one key",
    severity: "Medium",
    module: "keys",
    asset: "oracle",
    access: "Source",
    inputs: ["repo:acme/contracts@9e1c", "chain-read"],
    location: { chain: "eip155:1", address: "0x91d0…07b2", selector: "0x8da5cb5b", label: "owner" },
    fingerprint: "keys|eip155:1:0x91d0…07b2|0x8da5cb5b|single-key-admin",
    machineVerdict: "Likely",
    accepted: "Likely",
    cap: "Likely",
    capReason: "A chain read shows the owner. No test can prove misuse of a key.",
    proofTest: null,
    why: "One key can change the price source. If that key leaks, prices can be faked.",
    fix: "Move the owner role to the Treasury Safe or a timelock.",
    diff: "Open",
    run: 126,
    found: "Nov 5, 02:14",
    files: bundle("v3", ["b07f…2a", "1d9c…e3", "6f54…b0"]),
    evidenceHash: "sha256:c41d…9e27",
    deletes: "Feb 3",
    history: [
      { when: "Nov 5, 02:14", text: "Found by run #126 (Weekly deep)." },
      { when: "Nov 8, 09:18", text: "Still open in run #131." },
    ],
    evidence: [
      {
        plain: "The owner is the deployer key, not a Safe.",
        technical: "owner() = 0x3fa1…c2d9 at block 23,456,802",
      },
    ],
    refuter: "The owner can call setFeed. No timelock sits in front of it.",
  },
  {
    id: "F-0055",
    title: "OldPool implementation can be initialized by anyone",
    severity: "Medium",
    module: "contracts",
    asset: "oldpool",
    access: "Public",
    inputs: ["bytecode", "decompiled:heimdall", "symbolic:hevm"],
    location: { chain: "eip155:1", address: "0x7d2a…19c4", selector: "0x8129fc1c", label: "initialize" },
    fingerprint: "contracts|eip155:1:0x7d2a…19c4|0x8129fc1c|unprotected-init",
    machineVerdict: "Likely",
    accepted: null,
    cap: "Likely",
    capReason: "Likely (decompiled bytecode; needs a fork test)",
    proofTest: { kind: "fork test", state: "not run" },
    why: "The code behind the OldPool proxy was never set up. Anyone can set it up and own it.",
    fix: "Call initialize on the implementation from your admin, or deploy one that blocks it.",
    diff: "Open",
    run: 126,
    found: "Nov 5, 02:31",
    files: bundle("v3", ["8e26…4c", "f1a7…09", "2b3d…7e"]),
    evidenceHash: "sha256:07b9…3fd1",
    deletes: "Feb 3",
    history: [
      { when: "Nov 5, 02:31", text: "Found by run #126 (Weekly deep). Seen in Public access, bytecode only." },
    ],
    evidence: [
      {
        plain: "The decompiled code has no owner check on initialize.",
        technical: "heimdall decompile 0x7d2a…19c4 impl; selector 0x8129fc1c",
      },
      {
        plain: "A second check agrees.",
        technical: "hevm symbolic: initialize() reachable from any caller",
      },
    ],
    refuter: "Initialized slot is 0 at block 23,456,802. The path is open.",
  },
  {
    id: "F-0053",
    title: "Bridge accepts a Chain Signatures reply without a request check",
    severity: "Medium",
    module: "contracts",
    asset: "bridge-near",
    access: "Source",
    inputs: ["repo:acme/contracts@9e1c"],
    location: { chain: "near:mainnet", address: "bridge.acme.near", selector: "sign_callback", label: null },
    fingerprint: "contracts|near:mainnet:bridge.acme.near|sign_callback|unchecked-callback",
    machineVerdict: "Likely",
    accepted: null,
    cap: "Unproven",
    capReason: "NEAR is Limited. Stays Unproven until a near-sandbox test runs.",
    proofTest: { kind: "near-sandbox test", state: "not run" },
    why: "The callback does not check that the reply matches a request it made.",
    fix: "Store a request ID before the sign call and check it in sign_callback.",
    diff: "Open",
    run: 126,
    found: "Nov 5, 02:40",
    files: bundle("v3", ["5c90…b1", "a3e4…62", "d81f…3c"]),
    evidenceHash: "sha256:e6a0…52bb",
    deletes: "Feb 3",
    history: [
      { when: "Nov 5, 02:40", text: "Found by run #126 (Weekly deep). Seen in Source access. NEAR is Limited." },
    ],
    evidence: [
      {
        plain: "sign_callback reads the reply but no request ID.",
        technical: "acme/contracts@9e1c near/bridge/src/lib.rs:212",
      },
    ],
    refuter: null,
  },
  {
    id: "F-0051",
    title: "Lookalike domain acme-xyz.co",
    severity: "Low",
    module: "people",
    asset: "acme-xyz",
    access: "Public",
    inputs: ["public-web", "ct-log"],
    location: { chain: null, address: "acme.xyz", selector: null, label: "lookalike acme-xyz.co" },
    fingerprint: "people|acme.xyz|lookalike|acme-xyz.co",
    machineVerdict: "Unproven",
    accepted: null,
    cap: "Unproven",
    capReason: "Pattern match only (name and certificate). Stays Unproven.",
    proofTest: null,
    why: "A new certificate names acme-xyz.co. It looks like acme.xyz and could host a fake sign-in.",
    fix: "Watch the domain. If it copies the app, ask the registrar to take it down.",
    diff: "New",
    run: 129,
    found: "Nov 8, 06:04",
    files: bundle("v3", ["47d2…f8", "0e6b…a5", "93c1…2d"]),
    evidenceHash: "sha256:1f8c…a6e4",
    deletes: "Feb 6",
    history: [{ when: "Nov 8, 06:04", text: "Found by run #129 (Morning check) in the certificate log." }],
    evidence: [
      {
        plain: "A certificate for the lookalike name.",
        technical: "crt.sh id 14822019; CN=acme-xyz.co; issued Nov 7",
      },
    ],
    refuter: null,
  },
  {
    id: "F-0047",
    title: "Vault share price can be inflated by the first deposit",
    severity: "Medium",
    module: "contracts",
    asset: "vault",
    access: "Source",
    inputs: ["repo:acme/contracts@9e1c", "fork-test"],
    location: { chain: "eip155:1", address: "0x5c1e…a94f", selector: "0xb6b55f25", label: "deposit" },
    fingerprint: "contracts|eip155:1:0x5c1e…a94f|0xb6b55f25|share-inflation",
    machineVerdict: "Not exploitable",
    accepted: "Not exploitable",
    cap: "Proven",
    capReason: "Source at a linked commit. A fork test ran.",
    proofTest: { kind: "fork test", state: "failed", run: 126 },
    why: "The Vault mints dead shares on deploy, so the attack does not pay.",
    fix: "None needed.",
    diff: "Changed",
    run: 126,
    found: "Nov 5, 02:20",
    files: bundle("v3", ["e9b5…70", "62f0…1b", "c3a8…d4"]),
    evidenceHash: "sha256:b2e7…0c95",
    deletes: "Feb 3",
    history: [
      { when: "Nov 5, 02:20", text: "Found by run #126 as Likely." },
      { when: "Nov 5, 02:52", text: "Fork test failed to inflate the price. You accepted Not exploitable." },
    ],
    evidence: [
      {
        plain: "The fork test could not move the share price.",
        technical: "forge test --match-test testInflation: price delta 0",
      },
    ],
    refuter: "Dead shares at deploy block the first-deposit attack.",
  },
  {
    id: "F-0031",
    title: "api.acme.xyz allows any origin",
    severity: "Medium",
    module: "apis",
    asset: "api",
    access: "Source",
    inputs: ["repo:acme/app@4b7e", "public-web"],
    location: { chain: null, address: "https://api.acme.xyz", selector: null, label: "Access-Control-Allow-Origin" },
    fingerprint: "apis|api.acme.xyz|cors|wildcard",
    machineVerdict: "Fixed",
    accepted: "Fixed",
    cap: "Proven",
    capReason: "A replay test ran.",
    proofTest: { kind: "replay test", state: "passed", run: 129 },
    why: "The API answered any site. It now answers only app.acme.xyz.",
    fix: "Done in acme/app@4b7e.",
    diff: "Fixed",
    run: 129,
    found: "Oct 21, 06:03",
    files: bundle("v2", ["71ac…3e", "d4f9…80", "18e2…b7"]),
    evidenceHash: "sha256:9d04…e71a",
    deletes: "Jan 19",
    history: [
      { when: "Oct 21, 06:03", text: "Found by run #104." },
      { when: "Nov 8, 06:09", text: "Retest in run #129 passed. Fixed." },
    ],
    evidence: [
      {
        plain: "The API now names one origin.",
        technical: "Access-Control-Allow-Origin: https://app.acme.xyz",
      },
    ],
    refuter: null,
  },
]

export function findingById(id: string): Finding | undefined {
  return FINDINGS.find((finding) => finding.id === id)
}

/* ---------- Models ---------- */

/**
 * Every role runs on an abliterated NEAR AI model. The judge is abliterated
 * too, so every guardrail holds in code. Kit.tsx reads MODELS[2].model.
 */
export const MODELS = [
  { role: "Planner", model: "Qwen/Qwen3.8-27B-abliterated", structured: true },
  { role: "Executor", model: "Qwen/Qwen3.8-27B-abliterated", structured: true },
  { role: "Refuter", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated", structured: false },
  { role: "Judge", model: "Qwen/Qwen3.8-27B-abliterated", structured: true },
]

/** Short names for tight places. */
export const MODEL_SHORT: Record<string, string> = {
  "Qwen/Qwen3.8-27B-abliterated": "Qwen3.8-abl",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated": "DeepSeek-V4.1-abl",
}

/** Embeddings are off by default. Search uses keywords. */
export const SEARCH = { mode: "Keyword search", embeddings: "Off" }

/* ---------- Sandbox, slots, health, retention ---------- */

export const SANDBOX = {
  provider: "Local Docker + gVisor",
  driver: "local-gvisor",
  isolation: "gVisor",
  isolationLabel: "Isolation: gVisor",
  services: ["app", "broker", "scope-proxy", "rpc-proxy"],
  selfTest: {
    result: "passed" as "passed" | "failed",
    at: "06:00",
    checks: ["no route to the host", "no cloud metadata IP", "egress only through the proxies"],
  },
  proxies: { scope: "on", rpc: "on", rule: "Default deny" },
  inUse: 1,
  capacity: 2,
  inUseLabel: "1 of 2",
  /** The local provider has no fixed egress IP. Show hosts contacted instead. */
  egressIp: null as string | null,
  egressNote: "Local provider. No fixed egress IP.",
  trafficHeader: "X-Acme-Redteam: rt-7f2",
  hostNote: "Agents think on the host and act in sandboxes. The NEAR AI key stays on the host.",
  downRule: "If the provider is down, no run starts. The harness never falls back to the host.",
  drivers: [
    { key: "e2b-embed", label: "E2B (embedded)", isolation: "microVM", current: false, note: "" },
    { key: "local-gvisor", label: "Local Docker + gVisor", isolation: "gVisor", current: true, note: "" },
    {
      key: "local-runc",
      label: "Local Docker (runc)",
      isolation: "container (shared kernel)",
      current: false,
      note: "Mac fallback. I-tier and PoC runs are off.",
    },
    { key: "daytona", label: "Daytona", isolation: "VM", current: false, note: "Optional. Not the default." },
  ],
}

/** 64 model requests at once. 8 stay for the chat. 56 split evenly between running jobs. */
export const SLOTS = {
  total: 64,
  chat: 8,
  shared: 56,
  jobs: [{ run: 131, label: "Vault review", share: 56 }],
  note: "A lone run can use all 56.",
  waitingModel: "Waiting for a model slot",
  waitingSandbox: "Waiting for a sandbox (2 of 2 in use)",
}

/** Shown on a Plan card when a plan is large. */
export const LARGE_RUN = {
  text: "This plan sends about 1,200 RPC reads. The RPC provider may limit it.",
  next: "Split it into two runs, or add a second RPC provider in Settings.",
}

export type HealthRow = { label: string; value: string; tone: "ok" | "warn" | "fail" }

export const HEALTH: HealthRow[] = [
  { label: "NEAR AI models answer", value: "ok, 2 models", tone: "ok" },
  { label: "Run sandbox", value: "ok, self-test 06:00", tone: "ok" },
  { label: "Isolation", value: "gVisor", tone: "ok" },
  { label: "Sandbox egress proxy", value: "ok, default deny", tone: "ok" },
  { label: "RPC proxy", value: "ok, blocks sign and send", tone: "ok" },
  { label: "PII filter", value: "ok", tone: "ok" },
  { label: "Audit log", value: "ok, entry 48,211", tone: "ok" },
  { label: "Kill switch test", value: "passed 08:00", tone: "ok" },
  { label: "Retention", value: "90 days, last cleanup 03:00", tone: "ok" },
  { label: "Backup", value: "ok, 03:00", tone: "ok" },
]

export const RETENTION = {
  days: 90,
  lastCleanup: "Nov 8, 03:00",
  lastDeleted: "Trace and evidence of run #88 (Aug 9)",
  auditLifetime: "The audit log is kept as long as this instance.",
}

export type AuditEntry = {
  n: number
  at: string
  /** You, Harness or an automation name. Never a person's name. */
  by: string
  text: string
  deletion?: boolean
}

/** Newest first. */
export const AUDIT: AuditEntry[] = [
  { n: 48211, at: "Nov 8, 09:30", by: "Harness", text: "Step 5 of run #131 waits for approval. Auto-deny at 09:41." },
  { n: 48209, at: "Nov 8, 09:21", by: "Harness", text: "Scope proxy blocked a call to 0x5f4e…8419 (rule-2)." },
  { n: 48203, at: "Nov 8, 09:12", by: "You", text: "Started run #131. Grant v3, Run mode Prove." },
  { n: 48190, at: "Nov 8, 06:11", by: "Morning check", text: "Run #129 done. 2 new findings, 1 fixed." },
  { n: 48184, at: "Nov 8, 06:05", by: "You", text: "Approved step 4 of run #129." },
  { n: 48171, at: "Nov 8, 03:00", by: "Harness", text: "Deleted the trace of run #88. Older than 90 days.", deletion: true },
  {
    n: 48170,
    at: "Nov 8, 03:00",
    by: "Harness",
    text: "Deleted evidence sha256:1d0c…be41 of run #88. Older than 90 days.",
    deletion: true,
  },
  { n: 48102, at: "Oct 30, 14:05", by: "You", text: "Confirmed grant v3 by typing the project name." },
]

/** The 13 ready checks. Every run passes all 13 in its sandbox before it starts. */
export const READY_CHECKS = [
  { n: 1, label: "Grant active", ok: true },
  { n: 2, label: "Scope hash matches", ok: true },
  { n: 3, label: "Ownership proofs valid", ok: true },
  { n: 4, label: "Inside the window", ok: true },
  { n: 5, label: "Run mode within ceiling", ok: true },
  { n: 6, label: "Notification route works", ok: true },
  { n: 7, label: "Budget left", ok: true },
  { n: 8, label: "NEAR AI models answer", ok: true },
  { n: 9, label: "Target health normal", ok: true },
  { n: 10, label: "Change gate passed", ok: true },
  { n: 11, label: "Secrets present", ok: true },
  { n: 12, label: "Network rules hold", ok: true },
  { n: 13, label: "Sandbox self-test passed", ok: true },
]

/* ---------- Runs ---------- */

export type PlanStep = {
  n: number
  plain: string
  technical: string
  tier: Tier
  module: ModuleKey
  profile: SandboxProfile
  /**
   * True while the step still waits for your OK. S, I and F steps get their
   * own Approval card when the run reaches them.
   */
  needsApproval: boolean
  /** When you approved the step. Set once you approve it. */
  approvedAt?: string
  state: "done" | "running" | "waiting" | "next" | "skipped"
}

export type RunAgent = { name: string; role: string; model: string; state: string; spend: string }

export type Approval = {
  id: string
  run: number
  step: number
  /** "step" is a run step. The other two are the special variants. */
  variant: "step" | "live key check" | "PoC warm pass"
  plain: string
  /** The exact command or request. One click away, always. */
  raw: string
  target: string
  tier: Tier
  runMode: RunMode
  ruleId: string
  rule: string
  judge: string
  impact: string
  rollback: string
  fingerprint: string
  autoDeny: string
}

export type ResultRow = { mark: DiffMark; finding?: string; text: string }

export type RunResult = {
  summary: string
  rows: ResultRow[]
  checksPassed: number
}

export type Run = {
  id: number
  title: string
  /** "Thread" when you started it in the chat, or the automation name. */
  trigger: string
  runMode: RunMode
  status: "running" | "waiting for you" | "done" | "stopped"
  /** Plain status line. For example "Waiting for a sandbox (2 of 2 in use)". */
  waiting: string | null
  started: string
  finished: string | null
  duration: string
  step: number
  steps: PlanStep[]
  /** Module on or off for this run, with the agent's reason. */
  modules: { key: ModuleKey; on: boolean; why: string }[]
  /** Opt-in. Needs a deeper clone. Default off. */
  historyScan: boolean
  grantVersion: string
  scopeHash: string
  fork: { chain: string; block: string; banner: string } | null
  agents: RunAgent[]
  /** From models.json for this run. */
  modelsUsed: { role: string; model: string }[]
  selfTest: { result: "passed" | "failed"; passed: number; of: number; at: string }
  isolation: string
  setupWindow: "open" | "closed"
  outsideHosts: { host: string; via: string; header: boolean }[]
  trafficHeader: string
  slot: { share: number } | null
  spend: { spent: string; quote: string }
  cleanup: { text: string; who: "you" | "harness"; done: boolean }[]
  trace: { at: string; plain: string; technical: string }[]
  approval: Approval | null
  result: RunResult | null
}

const MODELS_USED = [
  { role: "Planner", model: "Qwen/Qwen3.8-27B-abliterated" },
  { role: "Executor", model: "Qwen/Qwen3.8-27B-abliterated" },
  { role: "Refuter", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated" },
  { role: "Judge", model: "Qwen/Qwen3.8-27B-abliterated" },
]

export const RUN_131: Run = {
  id: 131,
  title: "Vault review",
  trigger: "Thread",
  runMode: "Prove",
  status: "waiting for you",
  waiting: "Waiting for you",
  started: "09:12",
  finished: null,
  duration: "19m",
  step: 5,
  steps: [
    {
      n: 1,
      plain: "Copy acme/contracts into the code sandbox, read-only",
      technical: "git clone --depth 1 acme/contracts@9e1c (read-only mount)",
      tier: "P",
      module: "contracts",
      profile: "code",
      needsApproval: false,
      state: "done",
    },
    {
      n: 2,
      plain: "Read the contracts and list risky paths",
      technical: "slither . --json; static read by static-1",
      tier: "P",
      module: "contracts",
      profile: "code",
      needsApproval: false,
      state: "done",
    },
    {
      n: 3,
      plain: "Fuzz Vault.withdraw",
      technical: "echidna --test-limit 50000 VaultInvariants",
      tier: "P",
      module: "contracts",
      profile: "code",
      needsApproval: false,
      state: "done",
    },
    {
      n: 4,
      plain: "Write an exploit test and a copy with a guard",
      technical: "write test/exploit/VaultReentrancy.t.sol (2 tests)",
      tier: "P",
      module: "contracts",
      profile: "code",
      needsApproval: false,
      state: "done",
    },
    {
      n: 5,
      plain: "Run both tests on a copy of mainnet",
      technical: "forge test --fork-block-number 23456802 --match-contract VaultReentrancy",
      tier: "F",
      module: "contracts",
      profile: "PoC",
      needsApproval: true,
      state: "waiting",
    },
    {
      n: 6,
      plain: "Read who controls PriceOracle",
      technical: "eth_call owner() via RPC proxy, block 23,456,802",
      tier: "P",
      module: "keys",
      profile: "net",
      needsApproval: false,
      state: "next",
    },
    {
      n: 7,
      plain: "Ask a second model to refute the results",
      technical: "refute-1 reads trace + tests",
      tier: "P",
      module: "contracts",
      profile: "code",
      needsApproval: false,
      state: "next",
    },
    {
      n: 8,
      plain: "Write the result",
      technical: "result.json + report draft",
      tier: "P",
      module: "contracts",
      profile: "code",
      needsApproval: false,
      state: "next",
    },
  ],
  modules: [
    { key: "contracts", on: true, why: "acme/contracts links to Vault and PriceOracle." },
    { key: "keys", on: true, why: "PriceOracle has an admin key." },
    { key: "supply", on: false, why: "Not in this run. Weekly deep covers it." },
    { key: "web", on: false, why: "Not relevant to the Vault." },
  ],
  historyScan: false,
  grantVersion: GRANT.version,
  scopeHash: GRANT.scopeHash,
  fork: {
    chain: "Ethereum mainnet",
    block: "23,456,802",
    banner: "FORK mainnet @ 23,456,802 in the run sandbox. Nothing leaves this fork.",
  },
  agents: [
    { name: "planner", role: "Planner", model: "Qwen/Qwen3.8-27B-abliterated", state: "Done", spend: "$0.06" },
    { name: "static-1", role: "Executor", model: "Qwen/Qwen3.8-27B-abliterated", state: "Done, 14 notes", spend: "$0.21" },
    { name: "fuzz-1", role: "Executor", model: "Qwen/Qwen3.8-27B-abliterated", state: "Done, 1 rule broken", spend: "$0.48" },
    { name: "prove-1", role: "Executor", model: "Qwen/Qwen3.8-27B-abliterated", state: "Waiting for you", spend: "$0.31" },
    {
      name: "refute-1",
      role: "Refuter",
      model: "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated",
      state: "Waiting",
      spend: "$0.00",
    },
    { name: "judge", role: "Judge", model: "Qwen/Qwen3.8-27B-abliterated", state: "Allowed step 5", spend: "$0.02" },
  ],
  modelsUsed: MODELS_USED,
  selfTest: { result: "passed", passed: 13, of: 13, at: "09:12" },
  isolation: "gVisor",
  setupWindow: "closed",
  outsideHosts: [{ host: "Mainnet RPC provider", via: "RPC proxy, reads only", header: false }],
  trafficHeader: SANDBOX.trafficHeader,
  slot: { share: 56 },
  spend: { spent: "$1.08", quote: "$5.00" },
  cleanup: [{ text: "Discard the fork when the run ends", who: "harness", done: false }],
  trace: [
    { at: "09:12", plain: "Self-test passed, 13 of 13.", technical: "selftest 13/13 ok (runsc)" },
    {
      at: "09:13",
      plain: "Copied acme/contracts into the code sandbox, read-only.",
      technical: "git clone --depth 1 acme/contracts@9e1c -> /src (ro)",
    },
    {
      at: "09:14",
      plain: "Setup window closed. No more package downloads.",
      technical: "egress allowlist: -github.com -registry.npmjs.org",
    },
    { at: "09:18", plain: "Read the contracts. 14 notes.", technical: "slither . --json (14 results)" },
    {
      at: "09:21",
      plain: "Blocked a call to a price feed that is not in scope.",
      technical: "scope-proxy deny eth_call 0x5f4e…8419 (rule-2)",
    },
    {
      at: "09:24",
      plain: "Fuzzing broke the balance rule. New finding F-0042.",
      technical: "echidna: withdraw_balance_invariant FAILED (call 3)",
    },
    {
      at: "09:27",
      plain: "Wrote an exploit test and a copy with a guard.",
      technical: "write test/exploit/VaultReentrancy.t.sol",
    },
    { at: "09:29", plain: "Built the tests.", technical: "forge build (ok)" },
    {
      at: "09:30",
      plain: "Waiting for you: run the tests on the fork.",
      technical: "step 5 tier F: approval requested (auto-deny 09:41)",
    },
  ],
  approval: {
    id: "131-5",
    run: 131,
    step: 5,
    variant: "step",
    plain:
      "Run the exploit test on a copy of mainnet in the run sandbox. A second copy runs with a guard on. Nothing is sent to mainnet.",
    raw: "forge test --fork-url http://127.0.0.1:8545 --fork-block-number 23456802 --match-contract VaultReentrancy",
    target: "Vault (0x5c1e…a94f) on the fork",
    tier: "F",
    runMode: "Prove",
    ruleId: "rule-4",
    rule: "Withdraw calls run on a fork only",
    judge: "Allow. Same target, same fork block. In scope.",
    impact: "Fork only. No mainnet effect.",
    rollback: "Discard the fork.",
    fingerprint: "a91c…3e07",
    autoDeny: "09:41",
  },
  result: null,
}

export const RUN_129: Run = {
  id: 129,
  title: "Morning check",
  trigger: "Morning check",
  runMode: "Safe",
  status: "done",
  waiting: null,
  started: "06:00",
  finished: "06:11",
  duration: "11m",
  step: 6,
  steps: [
    {
      n: 1,
      plain: "List what is reachable from outside",
      technical: "subfinder + httpx on acme.xyz",
      tier: "P",
      module: "surface",
      profile: "net",
      needsApproval: false,
      state: "done",
    },
    {
      n: 2,
      plain: "Read the certificate log for lookalike names",
      technical: "crt.sh query %acme%",
      tier: "P",
      module: "people",
      profile: "net",
      needsApproval: false,
      state: "done",
    },
    {
      n: 3,
      plain: "Check the domains and their scripts",
      technical: "dns + sri checks on 3 hosts",
      tier: "P",
      module: "domains",
      profile: "net",
      needsApproval: false,
      state: "done",
    },
    {
      n: 4,
      plain: "Sign in with the test account and check the cookie",
      technical: "playwright login rt-test-1; inspect Set-Cookie",
      tier: "S",
      module: "web",
      profile: "net",
      needsApproval: false,
      approvedAt: "06:05",
      state: "done",
    },
    {
      n: 5,
      plain: "Send one request to retest F-0031 on api.acme.xyz",
      technical: "OPTIONS https://api.acme.xyz/v1/me Origin: https://evil.example",
      tier: "P",
      module: "apis",
      profile: "net",
      needsApproval: false,
      state: "done",
    },
    {
      n: 6,
      plain: "Write the result",
      technical: "result.json",
      tier: "P",
      module: "surface",
      profile: "code",
      needsApproval: false,
      state: "done",
    },
  ],
  modules: [
    { key: "surface", on: true, why: "Daily." },
    { key: "people", on: true, why: "Daily certificate log check." },
    { key: "domains", on: true, why: "Daily." },
    { key: "web", on: true, why: "app.acme.xyz changed yesterday." },
    { key: "apis", on: true, why: "Retest of F-0031." },
  ],
  historyScan: false,
  grantVersion: GRANT.version,
  scopeHash: GRANT.scopeHash,
  fork: null,
  agents: [
    { name: "planner", role: "Planner", model: "Qwen/Qwen3.8-27B-abliterated", state: "Done", spend: "$0.05" },
    { name: "web-1", role: "Executor", model: "Qwen/Qwen3.8-27B-abliterated", state: "Done", spend: "$0.52" },
    {
      name: "refute-1",
      role: "Refuter",
      model: "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated",
      state: "Done",
      spend: "$0.22",
    },
    { name: "judge", role: "Judge", model: "Qwen/Qwen3.8-27B-abliterated", state: "Done", spend: "$0.05" },
  ],
  modelsUsed: MODELS_USED,
  selfTest: { result: "passed", passed: 13, of: 13, at: "06:00" },
  isolation: "gVisor",
  setupWindow: "closed",
  outsideHosts: [
    { host: "app.acme.xyz", via: "Scope proxy", header: true },
    { host: "api.acme.xyz", via: "Scope proxy", header: true },
    { host: "acme.xyz", via: "Scope proxy", header: true },
    { host: "docs.acme.xyz", via: "Scope proxy", header: true },
    { host: "crt.sh", via: "Scope proxy, TLS pass-through", header: false },
  ],
  trafficHeader: SANDBOX.trafficHeader,
  slot: null,
  spend: { spent: "$0.84", quote: "$2.00" },
  cleanup: [
    { text: "Sign out the test session on app.acme.xyz", who: "harness", done: true },
    { text: "Rotate the password of test account rt-test-1", who: "you", done: false },
  ],
  trace: [
    { at: "06:00", plain: "Self-test passed, 13 of 13.", technical: "selftest 13/13 ok (runsc)" },
    { at: "06:04", plain: "New lookalike name in the certificate log.", technical: "crt.sh: acme-xyz.co (Nov 7)" },
    { at: "06:05", plain: "You approved step 4.", technical: "approval 129-4 granted (tier S)" },
    {
      at: "06:07",
      plain: "The session cookie has no SameSite flag.",
      technical: "Set-Cookie: session=…; HttpOnly; Secure",
    },
    { at: "06:09", plain: "F-0031 retest passed.", technical: "ACAO: https://app.acme.xyz" },
    { at: "06:11", plain: "Done.", technical: "result.json written" },
  ],
  approval: null,
  result: {
    summary: "2 new findings. 1 fix held. The Treasury Safe threshold changed.",
    checksPassed: 3,
    rows: [
      { mark: "New", finding: "F-0039", text: "Session cookie has no SameSite flag" },
      { mark: "New", finding: "F-0051", text: "Lookalike domain acme-xyz.co" },
      { mark: "Fixed", finding: "F-0031", text: "api.acme.xyz allows any origin" },
      { mark: "Changed", text: "Treasury Safe threshold 3 of 5 → 2 of 5 at block 23,456,802" },
      { mark: "Not run", text: "AI agents and MCP. Not in the Morning check." },
    ],
  },
}

export const RUNS: Record<string, Run> = { "131": RUN_131, "129": RUN_129 }

/** Runs in a sandbox now. The Automations screen reads id and label. */
export const LIVE_RUNS = [
  { id: 131, label: "Vault review", project: "Acme Protocol", state: "Waiting for you", step: "5 of 8" },
]

/** One approval per active step. This is the only one waiting. */
export const APPROVALS: Record<string, Approval> = { "131-5": RUN_131.approval as Approval }

/** The other variants of the Approval card. None is waiting. */
export const APPROVAL_VARIANTS: Approval[] = [
  {
    id: "example-live-key",
    run: 126,
    step: 3,
    variant: "live key check",
    plain: "Live key check: sends this key to Alchemy.",
    raw: "trufflehog verify --only-verified --detector alchemy (1 key)",
    target: "Alchemy API key in acme/app@71aa .env.example",
    tier: "S",
    runMode: "Safe",
    ruleId: "rule-9",
    rule: "Live key checks need approval",
    judge: "Allow. The key is in an in-scope repo.",
    impact: "The provider sees one request with this key.",
    rollback: "Rotate the key.",
    fingerprint: "c03e…9b1d",
    autoDeny: "02:25",
  },
  {
    id: "example-warm-pass",
    run: 126,
    step: 7,
    variant: "PoC warm pass",
    plain: "PoC warm pass: the PoC sandbox may reach the RPC proxy for one pass.",
    raw: "poc-sandbox egress += rpc-proxy:8545 (one pass, reads only)",
    target: "RPC proxy",
    tier: "F",
    runMode: "Prove",
    ruleId: "rule-11",
    rule: "PoC sandboxes have no egress by default",
    judge: "Allow. Reads only, one pass.",
    impact: "Fork state reads through the RPC proxy.",
    rollback: "The pass closes by itself.",
    fingerprint: "7e21…04aa",
    autoDeny: "02:48",
  },
]

/* ---------- Other cards: blocked, stop, setup, scope proposal ---------- */

export type Blocked = {
  id: string
  title: string
  what: string
  ruleId: string
  rule: string
  run: number | null
  next: string
}

export const BLOCKED: Record<string, Blocked> = {
  "outside-scope": {
    id: "outside-scope",
    title: "Blocked: not in scope",
    what: "A call to 0x5f4e…8419 (Chainlink ETH/USD feed) while tracing PriceOracle.",
    ruleId: "rule-2",
    rule: "Only in-scope targets",
    run: 131,
    next: "Added to Found outside scope. Not tested. Add it with a scope change if it is yours.",
  },
  "sandbox-down": {
    id: "sandbox-down",
    title: "Sandbox not available",
    what: "Docker did not answer. No run can start.",
    ruleId: "sandbox-1",
    rule: "No run starts without a sandbox. Never on the host.",
    run: null,
    next: "Start Docker, then run the self-test again.",
  },
  "target-429": {
    id: "target-429",
    title: "Paused: target answered 429",
    what: "api.acme.xyz asked us to slow down.",
    ruleId: "rate-1",
    rule: "Pause a module when the target answers 429 or 503",
    run: 129,
    next: "Resumes in 10 minutes at half speed.",
  },
  "rpc-limit": {
    id: "rpc-limit",
    title: "Stopped: RPC provider limit",
    what: "The RPC provider answered 429. Fork reads stopped.",
    ruleId: "rpc-2",
    rule: "Stop fork reads when the RPC provider limits us",
    run: 131,
    next: "Try again after 10:00, or add a second RPC provider in Settings.",
  },
  "pii-filter": {
    id: "pii-filter",
    title: "Model calls stopped: PII filter failed",
    what: "The PII filter did not answer. No prompt went to NEAR AI.",
    ruleId: "pii-1",
    rule: "Strip personal data before any model call",
    run: null,
    next: "Harness health shows the filter. Calls resume when it answers.",
  },
  "never-touch": {
    id: "never-touch",
    title: "Blocked: Never touch",
    what: "A request to staging.acme.xyz while mapping app.acme.xyz.",
    ruleId: "never-1",
    rule: "Never touch items are blocked in code",
    run: 129,
    next: "Nothing reached staging.acme.xyz. To test it, take it off Never touch with a scope change.",
  },
  "missing-setup": {
    id: "missing-setup",
    title: "Blocked: setup needed",
    what: "A logged-in test of app.acme.xyz. No test account is set.",
    ruleId: "setup-1",
    rule: "Logged-in tests need a test account you added",
    run: 129,
    next: "Add a test account in Settings. The other steps go on.",
  },
}

export type StopInfo = {
  id: string
  by: "You" | "Provider"
  at: string
  runs: number[]
  /** The module that was running when the run stopped (D8). Null when no single module stopped. */
  module: ModuleKey | null
  /** The step of runs[0] that stopped. Null when no single step stopped. */
  stepNumber: number | null
  /** In order. The scope proxy is always first. */
  cut: string[]
  evidenceKept: string
  notRun: string[]
  cleanup: { text: string; who: "you" | "harness"; done: boolean }[]
}

export const STOPS: Record<string, StopInfo> = {
  "stop-all": {
    id: "stop-all",
    by: "You",
    at: "09:32",
    runs: [131],
    module: null,
    stepNumber: null,
    cut: ["Scope proxy (first, under 2 seconds)", "RPC proxy", "Run sandbox of #131", "Run tokens"],
    evidenceKept: "Trace and tests up to step 4",
    notRun: ["Step 5: run both tests on a copy of mainnet", "Steps 6 to 8"],
    cleanup: [
      { text: "Discard the fork", who: "harness", done: true },
      { text: "Check the Vault for unexpected calls since 09:12", who: "you", done: false },
    ],
  },
  "provider-131": {
    id: "provider-131",
    by: "Provider",
    at: "09:36",
    runs: [131],
    module: "contracts",
    stepNumber: 5,
    cut: ["Scope proxy", "Run sandbox of #131"],
    evidenceKept: "Trace and tests up to step 5",
    notRun: ["Steps 6 to 8"],
    cleanup: [{ text: "Run the self-test again before the next run", who: "you", done: false }],
  },
}

/** Stop all asks first. It names what it cuts, in order. */
export const STOP_ALL = {
  title: "Stop all runs?",
  body: "This cuts the scope proxy first, so nothing more reaches a target. Then it stops every sandbox and revokes run tokens.",
  cuts: STOPS["stop-all"].cut,
}

export type SetupRow = {
  label: string
  state: "ok" | "running" | "missing"
  detail: string
  /** How to add it, or what happens next. Shown when the row is not ok. The card never sends anything. */
  how: string
}

export const SETUP_NEEDED: Record<string, { id: string; rows: SetupRow[]; note: string }> = {
  "first-run": {
    id: "first-run",
    note: "Nothing is sent anywhere until these pass.",
    rows: [
      {
        label: "NEAR AI connected",
        state: "ok",
        detail: "Models answer: Qwen3.8-abl, DeepSeek-V4.1-abl",
        how: "Add a NEAR AI key in Settings. The models must answer.",
      },
      {
        label: "PII filter",
        state: "ok",
        detail: "Strips emails, names, keys, tokens and IPs before any model call",
        how: "Settings shows the filter under Harness health. Model calls wait until it answers.",
      },
      {
        label: "Sandbox provider",
        state: "ok",
        detail: "Local Docker + gVisor",
        how: "Start Docker with gVisor, or pick a provider in Settings.",
      },
      {
        label: "Sandbox self-test",
        state: "running",
        detail: "Running…",
        how: "It runs by itself in about a minute. No run starts until it passes.",
      },
      { label: "Scope", state: "missing", detail: "No assets yet", how: "Add one repo or one domain in the chat below." },
    ],
  },
}

/** The proof each asset kind needs (C7). Tests beyond look-only wait for it. */
export const PROOF_BY_KIND: Record<AssetKind, string> = {
  Contract: "Deploy manifest or address in a connected repo",
  Safe: "Listed in /.well-known/security-assets.json",
  Wallet: "Listed in /.well-known/security-assets.json",
  Domain: "DNS TXT record or a /.well-known file",
  "Web app": "DNS TXT record on its domain",
  API: "DNS TXT record on its domain",
  Package: "npm provenance",
  Repo: "GitHub App install or a fine-grained token",
  Cloud: "Read-only cloud role",
  "AI agent": "Config in a connected repo",
}

export type ProposedAsset = {
  name: string
  kind: AssetKind
  access: Access
  accessBecause: string
  tier: AssetTier
  proof: string
  proofOk: boolean
}

export type ScopeProposal = {
  id: string
  version: string
  /** Preview only. The hash is fixed when you confirm. */
  scopeHash: string
  assets: ProposedAsset[]
  neverTouch: NeverTouch[]
  diff: ScopeChange[] | null
  /** You type this to confirm. */
  confirmWord: string
}

export const SCOPE_PROPOSALS: Record<string, ScopeProposal> = {
  "first-run": {
    id: "first-run",
    version: "v1",
    scopeHash: "sha256:0c7d…a12e",
    assets: [
      {
        name: "acme.xyz",
        kind: "Domain",
        access: "Public",
        accessBecause: "Repo connected, no hosting link found.",
        tier: "Look only",
        proof: "DNS TXT record (pending)",
        proofOk: false,
      },
      {
        name: "acme/contracts",
        kind: "Repo",
        access: "Source",
        accessBecause: "GitHub App installed on the repo",
        tier: "Test",
        proof: "GitHub App install",
        proofOk: true,
      },
      {
        name: "Vault (0x5c1e…a94f)",
        kind: "Contract",
        access: "Source",
        accessBecause: "Address found in repo at contracts/Vault.sol",
        tier: "Test",
        proof: "Deploy manifest in the connected repo",
        proofOk: true,
      },
    ],
    neverTouch: [
      { item: "Security Safe (0x9c0d…41b7)", why: "Production signer." },
      { item: "Mainnet sends", why: "The harness never signs or sends a transaction." },
    ],
    diff: null,
    confirmWord: "Acme Protocol",
  },
}

/* ---------- Automations, notifications, needs you ---------- */

export type Automation = {
  name: string
  state: "healthy" | "running" | "failed" | "off"
  when: string
  trigger: string
  /** "Quiet", "Found N", "Paused: needs you", "Missed" or "Turned off". */
  lastResult: string
  runMode: RunMode
}

/** Scheduled runs never auto-approve. A step that needs you pauses the run. */
export const AUTOMATIONS: Automation[] = [
  { name: "Morning check", state: "healthy", when: "Daily 06:00", trigger: "Schedule", lastResult: "Found 2", runMode: "Safe" },
  { name: "Deploy check", state: "healthy", when: "On deploy", trigger: "GitHub deploy", lastResult: "Quiet", runMode: "Safe" },
  { name: "Weekly deep", state: "failed", when: "Sat 02:00", trigger: "Schedule", lastResult: "Missed", runMode: "Prove" },
  { name: "Chain watch", state: "healthy", when: "Every block", trigger: "New block", lastResult: "Found 1", runMode: "Observe" },
  { name: "Monthly drill", state: "off", when: "1st of month", trigger: "Schedule", lastResult: "Turned off", runMode: "Safe" },
]

export const NOTIFY = [
  { route: "Telegram", on: true, what: "Critical problems and missed runs" },
  { route: "Browser", on: true, what: "Approvals waiting" },
  { route: "Slack", on: false, what: "Not set up" },
]

/** The top bar "Needs you" count reads this. */
export const NEEDS_YOU = [{ id: "131-5", text: "Approve step 5 of run #131", autoDeny: "09:41", panel: "run/131" }]

/** Q14 is not decided. This is the proposed order. */
export const PRACTICE_LAB = {
  decided: false,
  fixtures: [
    "A vulnerable vault on Anvil",
    "A repo with a leaked test key and a risky CI workflow",
    "A Safe with a weak signer setup",
    "A site with a dangling CNAME and an unpinned script",
    "Public: an unverified-bytecode contract with one finding capped at Likely",
  ],
}

/* ---------- Chat ---------- */

export type CardKind =
  | "answer"
  | "scope-proposal"
  | "plan"
  | "approval"
  | "run-progress"
  | "result"
  | "finding"
  | "blocked"
  | "stop"
  | "setup-needed"

/**
 * One chat turn. card.id keys:
 * answer "acme"; scope-proposal SCOPE_PROPOSALS; plan, run-progress and
 * result RUNS ("131", "129"); approval APPROVALS ("131-5"); finding
 * FINDINGS ("F-0042"); blocked BLOCKED; stop STOPS; setup-needed SETUP_NEEDED.
 * panel is a panel view the turn opens, for example "finding/F-0042".
 */
export type ChatMessage = {
  role: "agent" | "you"
  time: string
  text: string
  card?: { kind: CardKind; id: string }
  panel?: string
}

/** Home, Nov 8 morning. W-2 and W-3 merged, fixed per the critic notes. */
export const HOME_CHAT: ChatMessage[] = [
  {
    role: "agent",
    time: "06:11",
    text: "Morning check done. Two new findings. The F-0031 fix held.",
    card: { kind: "result", id: "129" },
  },
  {
    role: "you",
    time: "09:11",
    text: "Look at the Vault. The withdraw code changed last week.",
  },
  {
    role: "agent",
    time: "09:12",
    text: "Here is the plan for run #131. It runs in Prove. Step 5 is a fork-only test, so it asks you first.",
    card: { kind: "plan", id: "131" },
  },
  {
    role: "agent",
    time: "09:21",
    text: "I traced PriceOracle to a price feed that is not in scope. I did not test it.",
    card: { kind: "blocked", id: "outside-scope" },
  },
  {
    role: "agent",
    time: "09:30",
    text: "Fuzzing found a reentrancy path in Vault.withdraw. One step is waiting for you.",
    card: { kind: "approval", id: "131-5" },
  },
  {
    role: "you",
    time: "09:31",
    text: "Is the Vault really broken?",
  },
  {
    role: "agent",
    time: "09:31",
    text: "Not proven yet. F-0042 is Likely: fuzzing and the code read agree. The fork test in step 5 can prove it.",
    card: { kind: "finding", id: "F-0042" },
  },
]

/** The fork test result. It exists only after you approve step 5. */
export const PROOF = {
  before: "10,421.0 ETH",
  after: "10,008.3 ETH",
  moved: "412.7 ETH",
  guardedMoved: "0 ETH",
  test: "test/exploit/VaultReentrancy.t.sol",
  command: "forge test --fork-url http://127.0.0.1:8545 --fork-block-number 23456802 --match-contract VaultReentrancy",
  traceHash: "0x7c1e…a94f",
  evidenceHash: "sha256:9f2b…41ce",
  kept: "Kept 90 days, until Feb 6",
}

/**
 * What changes after you approve step 5 of run #131. The mock plays this
 * when you click Approve. Nothing here shows before that.
 */
export const AFTER_APPROVE = {
  /** The approval this plays. APPROVALS key. */
  approval: "131-5",
  spendToday: "$3.60",
  proof: PROOF,
  /** Run #131 after step 5. Steps 6 to 8 are quick, so the run is done at 09:34.
   *  The $0.40 it spends is the same $0.40 that spendToday adds. */
  run: {
    status: "done",
    waiting: null,
    finished: "09:34",
    duration: "22m",
    step: 8,
    spend: { spent: "$1.48", quote: "$5.00" },
  } satisfies Partial<Run>,
  finding: {
    id: "F-0042",
    machineVerdict: "Proven" as Verdict,
    accepted: null as Verdict | null,
    proofTest: { kind: "fork test", state: "passed", run: 131, step: 5 } satisfies ProofTest,
    refuter: "Re-ran with the guard on. The drain stopped.",
    /** The exploit test has run now, so its line changes. */
    evidence: [
      {
        plain: "Fuzzing broke the balance rule on the third call.",
        technical: "echidna 50,000 runs; withdraw_balance_invariant failed at call 3",
      },
      {
        plain: `Exploit test passed on the fork. It moved ${PROOF.moved}. With the guard on: ${PROOF.guardedMoved}.`,
        technical: `${PROOF.test} (passed, run #131 step 5)`,
      },
    ],
    /** The sealed bundle. The fork proof adds its files. */
    files: [
      { name: "finding.json", plain: "The finding", hash: "9b1e…07" },
      { name: PROOF.test.replace("test/exploit/", "reproduce/"), plain: "The fork-only test", hash: "41ac…d2" },
      { name: "foundry.toml", plain: "Test settings", hash: "5d0e…3a" },
      { name: "chain/trace.json", plain: "What the fork did", hash: PROOF.traceHash },
      { name: "chain/balance-diff.json", plain: "Balances before and after", hash: "b812…6f" },
      { name: "validator.json", plain: "The refuter check", hash: "e2f8…1b" },
      { name: "authorization.json", plain: `Your scope ${GRANT.version}`, hash: "0d5b…a4" },
      { name: "scope.sha256", plain: "Scope proof file", hash: GRANT.scopeHash },
      { name: "models.json", plain: "Models used", hash: "a611…58" },
      { name: "audit.jsonl", plain: "Audit log, 412 lines", hash: "c7d2…90" },
      { name: "footprints.json", plain: "What the run touched", hash: "18fa…c4" },
    ] satisfies EvidenceFile[],
    evidenceHash: PROOF.evidenceHash as string | null,
  },
  result: {
    summary: "The fork test passed. F-0042 is Proven (machine). Accept it to mark it Proven.",
    checksPassed: 2,
    rows: [
      { mark: "New", finding: "F-0042", text: "Vault.withdraw reentrancy" },
      { mark: "Open", finding: "F-0038", text: "PriceOracle admin is one key" },
    ],
  } satisfies RunResult,
  chat: [
    {
      role: "agent",
      time: "09:34",
      text: "The fork test passed. It moved 412.7 ETH on the fork. The copy with the guard moved nothing. F-0042 is Proven (machine) until you accept it.",
      card: { kind: "result", id: "131" },
    },
    { role: "you", time: "09:35", text: "Show me the proof." },
    {
      role: "agent",
      time: "09:35",
      text: "Here it is. Nothing left the fork.",
      panel: "finding/F-0042",
    },
  ] satisfies ChatMessage[],
}

/** After you deny step 5 of run #131. The run goes on without it. */
export const AFTER_DENY = {
  run: { status: "running", waiting: null, step: 6 } satisfies Partial<Run>,
}

/** The clock times the mock writes when you act. Nothing reads the real clock. */
export const ACTION_TIMES = {
  confirmScope: "10:06",
  decide: "09:32",
  accept: "09:36",
}

/** The Home chat turn after you stop run #131, from Stop all or Stop run. */
export const HOME_STOP_TURN: ChatMessage = {
  role: "agent",
  time: STOPS["stop-all"].at,
  text: "You stopped run #131. The scope proxy was cut first, so nothing more reaches a target. Step 5 did not run.",
  card: { kind: "stop", id: "stop-all" },
}

/** First run. W-1, fixed per the critic notes. Run mode stays Observe until you confirm. */
export const FIRST_RUN_CHAT: ChatMessage[] = [
  {
    role: "agent",
    time: "10:02",
    text: "Welcome. A few checks must pass before I can look at anything.",
    card: { kind: "setup-needed", id: "first-run" },
  },
  {
    role: "agent",
    time: "10:02",
    text: "Add one asset to start. A repo gives Source access. A domain alone gives Public access.",
  },
  { role: "you", time: "10:04", text: "acme.xyz and github.com/acme/contracts" },
  {
    role: "agent",
    time: "10:04",
    text: "Here is the scope I propose. acme/contracts has Source access: the GitHub App is installed, and I found the Vault address in it. acme.xyz has Public access: no hosting link found. Nothing is tested until you confirm.",
    card: { kind: "scope-proposal", id: "first-run" },
  },
]

/** One step of Plan 1. module is null for steps the harness does itself, like writing the result. */
export type FirstRunStep = {
  n: number
  plain: string
  technical: string
  tier: Tier
  module: ModuleKey | null
  profile: SandboxProfile
}

/** Plan 1, after you confirm scope v1. Every step is look only (P), so Observe allows all of it. */
export const FIRST_RUN_PLAN: FirstRunStep[] = [
  {
    n: 1,
    plain: "Copy acme/contracts into a sandbox, read-only",
    technical: "Clone acme/contracts read-only into the code sandbox (no egress)",
    tier: "P",
    module: "contracts",
    profile: "code",
  },
  {
    n: 2,
    plain: "Read the contracts and list the risky paths",
    technical: "Static analysis of contracts/*.sol, rank external calls and auth checks",
    tier: "P",
    module: "contracts",
    profile: "code",
  },
  {
    n: 3,
    plain: "Look for leaked keys and risky packages in the repo",
    technical: "Secret scan of the git history and a dependency audit of package.json and foundry.toml",
    tier: "P",
    module: "supply",
    profile: "code",
  },
  {
    n: 4,
    plain: "Look at acme.xyz from outside: DNS, TLS and headers",
    technical: "Passive DNS, TLS and HTTP header read of acme.xyz from the net sandbox",
    tier: "P",
    module: "domains",
    profile: "net",
  },
  {
    n: 5,
    plain: "Write the result",
    technical: "Write the result and the coverage map",
    tier: "P",
    module: null,
    profile: "code",
  },
]

/** The First run chat after you confirm scope v1. */
export const FIRST_RUN_AFTER_CONFIRM: ChatMessage[] = [
  { role: "you", time: ACTION_TIMES.confirmScope, text: "Confirmed scope v1." },
  {
    role: "agent",
    time: ACTION_TIMES.confirmScope,
    text: "Scope v1 is saved. Here is Plan 1. Run mode stays Observe, so every step only looks. No step needs your approval.",
  },
]

/** The top bar on the First run screen. No grant yet. */
export const FIRST_RUN_BAR = {
  project: "Acme Protocol",
  runMode: "Observe" as RunMode,
  needsYou: 1,
  spendToday: "$0.00",
}

/* ---------- Drafts. The harness drafts. A human sends. ---------- */

export const REPORT_DRAFT = {
  title: "Acme Protocol, security check, Nov 8",
  note: "Draft. Exports carry plain words and technical terms.",
  sections: ["Answer", "Things to fix", "What we checked", "What we could not see", "Models used"],
}

export const DISCLOSURE_DRAFT = {
  finding: "F-0042",
  to: "The security contact in acme/contracts SECURITY.md",
  subject: "Vault.withdraw reentrancy (F-0042)",
  note: "The harness never sends a disclosure. Copy it and send it yourself.",
}
