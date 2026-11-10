import { useState, type ReactNode } from "react"
import { Collapsible, Switch, ThemedIcon, Toast } from "@graphical"
import { cn } from "cn"
import { Dot, KeyValues, Muted, Section, Tag } from "@/components/app/blocks"
import { PanelLink } from "@/components/app/cards/frame"
import {
  FINDINGS,
  IN_SCOPE,
  MODULES,
  NEAR_LIMITED,
  assetById,
  moduleByKey,
  type Access,
  type Asset,
  type Module,
  type ModuleKey,
} from "@/data/fixtures"
import { answer, cellState, isOpen, ranOn, type CellState } from "@/lib/answer"
import { panelHref } from "@/lib/route"

/*
 * The Coverage panel, with Module detail (MVP panel view 3).
 *   coverage          13 modules by asset, a state per cell, access per asset,
 *                     and why each module is on or off
 *   coverage/<key>    one module: what it checks under Source and Public access,
 *                     the state per asset, the last run, and the on/off control
 * Counts come from lib/answer.ts, so this view and the Answer card agree.
 */

export function CoveragePanel({ id }: { id: string | null }) {
  if (!id) return <CoverageGrid />
  const module = moduleByKey(id)
  if (!module) return <Muted>No module with the key {id}.</Muted>
  return <ModuleDetail key={module.key} module={module} />
}

/* ---------- Cell states ---------- */

/* The data font has no "◐", so Partial is a half-filled dot in the text colour. */
const HALF_DOT = (
  <span className="inline-block size-[0.6em] rounded-(--radius-full) bg-[linear-gradient(90deg,currentColor_50%,color-mix(in_oklab,currentColor_30%,transparent)_50%)] align-middle" />
)

/* Tones match the coverage strip on the Answer card (cards/core.tsx). */
const CELL: Record<CellState, { glyph: ReactNode; tone: string; word: string }> = {
  ok: { glyph: "✓", tone: "text-(--success)", word: "Ran, nothing found" },
  found: { glyph: "!", tone: "text-(--error) weight-heavy", word: "Found something" },
  partial: { glyph: HALF_DOT, tone: "text-(--color-2)", word: "Partial" },
  "not run": { glyph: "?", tone: "text-(--cte-text-muted)", word: "Not run yet" },
  "needs source": { glyph: "S", tone: "text-(--warning) weight-medium", word: "Needs Source access" },
  off: { glyph: "–", tone: "text-(--neutral-6)", word: "Module off" },
  "not relevant": { glyph: "·", tone: "text-(--neutral-6)", word: "Not relevant" },
}

const CELL_ORDER: CellState[] = ["ok", "found", "partial", "not run", "needs source", "off", "not relevant"]

function CellMark({ state, className }: { state: CellState; className?: string }) {
  const cell = CELL[state]
  return (
    <span aria-hidden="true" className={cn("inline-block w-[1.5ch] text-center font-data", cell.tone, className)}>
      {cell.glyph}
    </span>
  )
}

const ACCESS_ORDER: Access[] = ["Source", "Public"]

/* ---------- The grid ---------- */

function CoverageGrid() {
  const result = answer()
  const limited = IN_SCOPE.filter((asset) => asset.limited)
  return (
    <div className="flex flex-col gap-(--space-xl)">
      <div className="flex flex-col gap-(--space-xs)">
        <KeyValues
          rows={[
            ["Checked", <span key="checked" className="font-data">{result.checked} of {result.of}</span>],
            ["On", <span key="on" className="font-data">{result.on} of {result.of}</span>],
            [
              "Access",
              <span key="access">
                {result.accessMix}. <span className="font-data">{result.byAccess.Source}</span> assets with Source,{" "}
                <span className="font-data">{result.byAccess.Public}</span> with Public.
              </span>,
            ],
          ]}
        />
        <Muted className="type-xs">Checked means the module is on and ran on every asset it fits.</Muted>
      </div>

      <Section title="Modules by asset">
        <Grid />
        <Legend />
        {limited.length > 0 ? (
          <p className="flex items-start gap-(--space-s) type-xs">
            <Tag>Limited</Tag>
            <span>
              {limited.map((asset) => asset.name).join(", ")}. {NEAR_LIMITED}
            </span>
          </p>
        ) : null}
      </Section>

      <ModuleList />

      {result.couldNotSee.length > 0 ? (
        <Section title="What we could not see" count={result.couldNotSee.length}>
          <ul className="flex list-disc flex-col gap-(--space-xxs) pl-(--space-l) type-s">
            {result.couldNotSee.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <AccessPerAsset />
    </div>
  )
}

/** 13 module columns by in-scope asset rows, grouped by access. */
function Grid() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[22rem] table-fixed type-xs">
        <caption className="sr-only">Coverage: 13 modules by asset. Each cell shows what ran.</caption>
        <colgroup>
          <col />
          {MODULES.map((module) => (
            <col key={module.key} className="w-[1.25rem]" />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="pb-(--space-xs) text-left weight-regular text-(--cte-text-muted)">
              Asset
            </th>
            {MODULES.map((module) => (
              <th key={module.key} scope="col" className="pb-(--space-xs) text-center weight-regular">
                <a
                  href={panelHref(`coverage/${module.key}`)}
                  title={`${module.n}. ${module.name}${module.on ? "" : " (off)"}`}
                  aria-label={`${module.n}. ${module.name}${module.on ? "" : ", off"}`}
                  className={cn(
                    "inline-block w-full rounded-(--radius-xs) font-data hover:bg-(--cte-surface-muted) focus-ring",
                    !module.on && "text-(--cte-text-muted)",
                  )}
                >
                  {module.n}
                </a>
              </th>
            ))}
          </tr>
        </thead>
        {ACCESS_ORDER.map((access) => {
          const assets = IN_SCOPE.filter((asset) => asset.access === access)
          if (assets.length === 0) return null
          return (
            <tbody key={access}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={MODULES.length + 1}
                  className="pt-(--space-s) pb-(--space-xxs) text-left weight-medium divide-bottom"
                >
                  {access} access <Muted className="font-data weight-regular">{assets.length}</Muted>
                </th>
              </tr>
              {assets.map((asset) => (
                <tr key={asset.id} className="hover:bg-(--cte-surface-muted)">
                  <th scope="row" title={asset.name} className="truncate py-(--space-xxs) pr-(--space-xs) text-left weight-regular">
                    {asset.name}
                  </th>
                  {MODULES.map((module) => {
                    const state = cellState(module, asset.id)
                    const label = `${module.name} on ${asset.name}: ${CELL[state].word}`
                    return (
                      <td key={module.key} title={label} className="py-(--space-xxs) text-center">
                        <CellMark state={state} />
                        <span className="sr-only">{label}</span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          )
        })}
      </table>
    </div>
  )
}

function Legend() {
  return (
    <ul aria-label="Cell states" className="flex flex-wrap gap-x-(--space-m) gap-y-(--space-xxs) type-xs text-(--cte-text-muted)">
      {CELL_ORDER.map((state) => (
        <li key={state} className="inline-flex items-center gap-(--space-xxs)">
          <CellMark state={state} />
          {CELL[state].word}
        </li>
      ))}
    </ul>
  )
}

/** Each module, on or off, where it ran, and the agent's reason. */
function ModuleList() {
  return (
    <Section title="Modules" count={MODULES.length}>
      <ul className="flex flex-col">
        {MODULES.map((module) => {
          const { ran, of } = ranOn(module)
          return (
            <li key={module.key} className="flex flex-col gap-(--space-xxs) py-(--space-xs) divide-bottom">
              <div className="flex items-baseline gap-(--space-s) type-s">
                <span className="w-[2ch] shrink-0 font-data tabular-nums text-(--cte-text-muted)">{module.n}</span>
                <PanelLink view={`coverage/${module.key}`} className="min-w-0">
                  {module.name}
                </PanelLink>
                {module.nearLimited ? <Tag className="self-center">NEAR Limited</Tag> : null}
                <span className="ml-auto inline-flex shrink-0 items-center gap-(--space-xxs) type-xs">
                  <Dot tone={module.on ? "success" : "muted"} />
                  {module.on ? "On" : "Off"}
                </span>
              </div>
              <div className="flex flex-col pl-[calc(2ch+var(--space-s))] type-xs text-(--cte-text-muted)">
                <span>{module.why}</span>
                {of > 0 ? (
                  <span>
                    Ran on <span className="font-data">{ran}</span> of <span className="font-data">{of}</span>{" "}
                    {of === 1 ? "asset" : "assets"}
                  </span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/** The access per asset and the link method that set it. */
function AccessPerAsset() {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger>
        Why each asset has its access
        <Collapsible.Indicator>
          <ThemedIcon name="chevronRight" />
        </Collapsible.Indicator>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <Collapsible.Content>
          <ul className="flex flex-col">
            {IN_SCOPE.map((asset) => (
              <li key={asset.id} className="flex flex-col gap-(--space-xxs) py-(--space-xs) type-s divide-bottom">
                <span className="flex items-center gap-(--space-s)">
                  <span className="min-w-0 truncate">{asset.name}</span>
                  <Muted className="type-xs">{asset.kind}</Muted>
                  {asset.limited ? <Tag>Limited</Tag> : null}
                  <Tag className="ml-auto">{asset.access}</Tag>
                </span>
                <Muted className="type-xs">{asset.accessBecause}</Muted>
                {asset.drift ? <span className="type-xs">{asset.drift}</span> : null}
              </li>
            ))}
          </ul>
        </Collapsible.Content>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/* ---------- Module detail ---------- */

function ModuleDetail({ module }: { module: Module }) {
  const toasts = Toast.useToastManager()
  const [on, setOn] = useState(module.on)
  const { ran, of } = ranOn(module)
  const checks = CHECKS[module.key]

  function toggle(next: boolean) {
    setOn(next)
    toasts.add({
      title: `${module.name} turned ${next ? "on" : "off"}`,
      description: "Logged as an override. It never raises a tier.",
    })
  }

  return (
    <div className="flex flex-col gap-(--space-xl)">
      <div className="flex flex-col gap-(--space-m)">
        <KeyValues
          rows={[
            [
              "State",
              <span key="state" className="inline-flex items-center gap-(--space-xs)">
                <Dot tone={on ? "success" : "muted"} />
                {on ? "On" : "Off"}
                {on === module.on ? null : <Muted className="type-xs">(your override)</Muted>}
              </span>,
            ],
            ["Why", module.why],
            [
              "Ran on",
              of > 0 ? (
                <span key="ran">
                  <span className="font-data">{ran}</span> of <span className="font-data">{of}</span>{" "}
                  {of === 1 ? "asset" : "assets"}
                </span>
              ) : (
                "Fits no asset in scope"
              ),
            ],
            ["Last run", module.lastRun],
            ["Group", module.group],
            [
              "Full checks need",
              module.needs === "Source" ? "Source access" : "Public access is enough",
            ],
            ["With Public only", `${module.publicCoverage} coverage`],
            [
              "NEAR",
              module.nearLimited ? (
                <span key="near" className="flex flex-col items-start gap-(--space-xxs)">
                  <Tag>Limited</Tag>
                  <Muted className="type-xs">{NEAR_LIMITED}</Muted>
                </span>
              ) : (
                checks.near
              ),
            ],
          ]}
        />
        <div className="flex flex-col gap-(--space-xxs)">
          <Switch.Row>
            <Switch.Root checked={on} onCheckedChange={toggle}>
              <Switch.Thumb />
            </Switch.Root>
            <Switch.Label>Module on</Switch.Label>
          </Switch.Row>
          <Muted className="type-xs">Overrides are logged. They never raise a tier.</Muted>
        </div>
      </div>

      <AssetStates module={module} />

      <Section title="What it checks">
        <CheckList title="With Source access" checks={checks.source} />
        <CheckList title="With Public access" checks={checks.public} />
        {module.nearLimited ? (
          <div className="flex flex-col gap-(--space-xxs)">
            <h3 className="flex items-center gap-(--space-s) type-xs text-(--cte-text-muted)">
              On NEAR <Tag>Limited</Tag>
            </h3>
            <p className="type-s">{checks.near}</p>
          </div>
        ) : null}
        <Muted className="type-xs">Tier P look only. S safe test. I intrusive test. F fork only.</Muted>
      </Section>
    </div>
  )
}

/** Drops a leading "<asset>: " from a note, since the row already names the asset. */
function withoutName(note: string, name: string) {
  const prefix = `${name}: `
  if (!note.startsWith(prefix)) return note
  const rest = note.slice(prefix.length)
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

/** Each asset the module fits: its access, the cell state, and why. */
function AssetStates({ module }: { module: Module }) {
  const rows = module.assets
    .map((row) => ({ row, asset: assetById(row.asset) }))
    .filter((item): item is { row: Module["assets"][number]; asset: Asset } => item.asset !== undefined)
  return (
    <Section title="State per asset" count={rows.length || undefined}>
      {rows.length === 0 ? (
        <Muted className="type-s">This module fits no asset in scope.</Muted>
      ) : (
        <ul className="flex flex-col">
          {rows.map(({ row, asset }) => {
            const state = cellState(module, asset.id)
            const finding = FINDINGS.find((f) => f.module === module.key && f.asset === asset.id && isOpen(f))
            return (
              <li key={asset.id} className="flex flex-col gap-(--space-xxs) py-(--space-xs) type-s divide-bottom">
                <span className="flex items-center gap-(--space-s)">
                  <span className="min-w-0 truncate">{asset.name}</span>
                  <Tag>{asset.access}</Tag>
                  <span className="ml-auto inline-flex shrink-0 items-center gap-(--space-xxs) type-xs">
                    <CellMark state={state} />
                    {CELL[state].word}
                  </span>
                </span>
                {row.note ? (
                  <Muted className="type-xs">{withoutName(row.note, asset.name)}</Muted>
                ) : null}
                {finding ? (
                  <span className="type-xs">
                    <PanelLink view={`finding/${finding.id}`} className="font-data">
                      {finding.id}
                    </PanelLink>{" "}
                    {finding.title}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

function CheckList({ title, checks }: { title: string; checks: Check[] }) {
  return (
    <div className="flex flex-col gap-(--space-xxs)">
      <h3 className="type-xs text-(--cte-text-muted)">{title}</h3>
      <ul className="flex flex-col gap-(--space-xxs) type-s">
        {checks.map(([tier, text]) => (
          <li key={text} className="flex items-baseline gap-(--space-s)">
            <span className="w-[3ch] shrink-0 font-data type-xs text-(--cte-text-muted)">{tier}</span>
            <span className="min-w-0">{text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------- What each module checks (from modes.md §5) ---------- */

/** [tier, check]. The tier is the highest a check needs. */
type Check = [string, string]

const CHECKS: Record<ModuleKey, { source: Check[]; public: Check[]; near: string }> = {
  surface: {
    source: [
      ["P", "List contracts per chain from deploy manifests"],
      ["P", "Pull hosts, buckets, API and RPC URLs from IaC and config"],
      ["P", "List published packages"],
      ["P", "Map deployed bytecode to the audited commit"],
      ["P", "Send a new asset in code to the scope inbox"],
    ],
    public: [
      ["P", "Subdomains from certificate logs"],
      ["S", "Resolve and probe hosts"],
      ["S", "Open ports on owned hosts"],
      ["P", "Contracts from deployer addresses"],
      ["P", "Follow proxies to implementations"],
      ["P", "Addresses listed in the docs"],
      ["P", "Bounty scope against what is deployed"],
      ["S", "security.txt"],
    ],
    near: "Sub-accounts by RPC. Code hash per account.",
  },
  keys: {
    source: [
      ["P", "Where keys are loaded in code"],
      ["P", "Keys in the repo and its history"],
      ["P", "--private-key in scripts and CI"],
      ["P", "Signing service allowlist"],
      ["P", "KMS policy in IaC"],
      ["P", "Address book against on-chain owners"],
      ["P", "MPC and TSS versions against advisories"],
    ],
    public: [
      ["P", "Safe owners, threshold, modules and guards"],
      ["P", "Decode pending Safe transactions and recompute the SafeTxHash"],
      ["F", "Simulate pending transactions on a fork"],
      ["P", "EIP-7702 delegation, every block"],
      ["P", "Unlimited approvals from the treasury"],
      ["P", "Hot wallet outflows"],
      ["P", "Signer addresses with DeFi activity"],
    ],
    near: "Full-access keys per account. Chain Signatures signer set and threshold.",
  },
  contracts: {
    source: [
      ["P", "Slither, Aderyn and Semgrep on each commit"],
      ["P", "Agent review of each pull request diff"],
      ["F", "Invariant fuzzing"],
      ["F", "Symbolic checks"],
      ["P", "Mutation testing"],
      ["P", "Storage layout diff"],
      ["P", "Compile the repo at the commit and match the bytecode"],
      ["F", "Exploit test on a fork"],
    ],
    public: [
      ["P", "Resolve proxies"],
      ["P", "Owners, roles, admin and implementation"],
      ["P", "Map what each admin can do"],
      ["P", "Static tools on verified source"],
      ["P, F", "Decompile unverified bytecode. These findings stop at Likely."],
      ["P", "Symbolic checks on bytecode"],
      ["F", "Selector sweep on a fork"],
      ["F", "Exploit test with raw calldata"],
      ["P", "Check a queued upgrade"],
    ],
    near: "Source runs cargo-audit, clippy and near-workspaces. Public sees Wasm only. Findings stay Unproven without a sandbox test.",
  },
  nodes: {
    source: [
      ["P", "Admin and debug APIs on a public listener"],
      ["P", "CORS and vhosts"],
      ["P", "JWT secret"],
      ["P", "Slashing protection"],
      ["P", "Client versions against CVEs"],
      ["P", "IaC scan"],
      ["P", "DVN config against the chain"],
    ],
    public: [
      ["S", "Which RPC methods answer"],
      ["P", "Chain ID"],
      ["P", "Answers match across providers"],
      ["S", "Client version against CVEs"],
      ["S", "Ports and TLS"],
      ["P", "DVN per route. A 1-of-1 is flagged."],
      ["P", "Validator performance"],
    ],
    near: "RPC status and network_info exposure. Validator stake.",
  },
  "chain-watch": {
    source: [
      ["P", "Alert when state leaves the value in the repo"],
      ["P", "Map each alert to a function"],
      ["P", "Every contract has a monitor"],
    ],
    public: [
      ["P", "Admin, proxy and timelock changes"],
      ["P", "Outflows"],
      ["P", "Supply against backing"],
      ["P", "Oracle changes"],
      ["P", "Governance and the timelock queue"],
      ["F", "Simulate queued proposals on a fork"],
      ["P", "Decode calls"],
    ],
    near: "Watches by RPC and near-lake.",
  },
  web: {
    source: [
      ["P", "Static analysis of the app code"],
      ["P", "Sign-in with Ethereum checks in code"],
      ["P", "Cookies and sessions in code"],
      ["P", "CSP and SRI config"],
      ["P", "Spender and target addresses against the contract list"],
      ["P", "Hidden routes feed the dynamic scan"],
      ["I", "Logged-in tests with test accounts"],
      ["P", "Scan of CI builds"],
    ],
    public: [
      ["S", "TLS and security headers"],
      ["S", "CSP and SRI as served"],
      ["S", "Crawl"],
      ["S", "Template scans"],
      ["S", "Passive dynamic scan"],
      ["S", "Exposed source maps"],
      ["P", "Addresses in the served bundles"],
      ["S", "Sign-in with Ethereum fields, with a throwaway sandbox key"],
      ["P", "App store builds"],
    ],
    near: "Not chain-specific.",
  },
  apis: {
    source: [
      ["S", "Routes in code against routes deployed"],
      ["P", "Access rules per route"],
      ["S, I", "Object and function access with two test accounts. I on production."],
      ["P", "Rate limit config"],
      ["P", "Relayer that signs any calldata"],
    ],
    public: [
      ["S", "Access without a login"],
      ["S", "GraphQL introspection"],
      ["S", "Parameter discovery"],
      ["S", "CORS"],
      ["S", "Anonymous tokens"],
    ],
    near: "Not chain-specific.",
  },
  domains: {
    source: [
      ["P", "Live records against IaC"],
      ["S", "Served JavaScript hash against the CI build"],
      ["S", "Script origins against the code"],
      ["P", "SRI for third-party scripts"],
    ],
    public: [
      ["S", "NS and record changes every 15 to 60 minutes"],
      ["P", "Registrar locks and Registry Lock"],
      ["P", "New certificates"],
      ["P", "Lookalike domains, daily"],
      ["P", "Dangling CNAMEs"],
      ["P", "SPF, DKIM, DMARC, CAA and DNSSEC"],
      ["S", "Script hash changes"],
    ],
    near: "Not chain-specific.",
  },
  infra: {
    source: [
      ["P", "IaC scan"],
      ["P", "Image scan"],
      ["P", "Kubernetes manifests"],
      ["P", "Cloud posture with a read-only role"],
      ["P", "IAM paths"],
      ["P", "KMS policies"],
      ["P", "New principals and keys"],
      ["P", "Drift between IaC and live"],
    ],
    public: [
      ["S", "Exposed ports"],
      ["S", "Bucket listing"],
      ["S", "Exposed Kubernetes API"],
      ["P", "Origin IP leaks"],
      ["P", "Public images"],
    ],
    near: "Not chain-specific.",
  },
  supply: {
    source: [
      ["S", "Full-history secret scan. Live key checks need your OK."],
      ["P", "CI audit"],
      ["P", "Actions pinned to a SHA"],
      ["P", "Lockfile registry allowlist"],
      ["P", "Known CVEs in the SBOM"],
      ["P", "Malicious package signs"],
      ["P", "Autorun files"],
      ["P", "Dormant tokens"],
      ["P", "Release signatures and provenance"],
      ["P", "Scorecard"],
    ],
    public: [
      ["P", "The same scanners on public repos"],
      ["P", "Secrets in public CI logs"],
      ["P", "Package tarball against the tag"],
      ["P", "Provenance"],
      ["P", "Package name squats"],
      ["P", "Expired maintainer domains"],
      ["P", "Scorecard"],
    ],
    near: "Rust crates are fully covered. Not Limited.",
  },
  people: {
    source: [
      ["P", "Write access against current staff"],
      ["P", "Commit signing"],
      ["F", "Scan repos sent by candidates, in a sandbox"],
    ],
    public: [
      ["P", "Lookalike domains"],
      ["P", "Fake apps"],
      ["P", "Fake tokens"],
      ["P", "Impersonation accounts"],
      ["P", "Admin 2FA, from evidence you upload"],
    ],
    near: "Not chain-specific.",
  },
  ai: {
    source: [
      ["P", "MCP config scan"],
      ["P", "Tool description drift"],
      ["P", "Wallet tool limits"],
      ["P", "Static analysis of the MCP server"],
      ["S, I", "Prompt injection on staging"],
    ],
    public: [
      ["P", "Agent wallet limits on chain"],
      ["P", "Public MCP drift"],
      ["I", "Prompt injection on a public bot, with your OK"],
    ],
    near: "Not chain-specific.",
  },
  readiness: {
    source: [
      ["P", "Every contract, wallet and domain has a monitor and an alert route"],
      ["F", "Pause drill with the team's script on a fork"],
      ["P", "Runbook addresses match the chain"],
      ["F", "Synthetic alerts on a fork"],
    ],
    public: [
      ["F", "The guardian can call pause. Tested on a fork."],
      ["P", "Guardian Safe threshold"],
      ["S", "security.txt and SEAL 911"],
    ],
    near: "A near-sandbox drill comes later.",
  },
}
