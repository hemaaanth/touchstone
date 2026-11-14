import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RpcSection } from "../src/components/settings-page"
import type { SettingsState } from "../src/lib/types"

// A forked replay reads one real chain, so the operator needs somewhere to say
// which chain and with which RPC. This pins the three facts that make the row
// usable and safe:
//   1. a chain with no RPC says a fork on it cannot run (not an empty row),
//   2. a chain with one shows where it came from and the last 4 characters only,
//   3. the URL itself is never in the markup.
const settings = (rpc: SettingsState["rpc"]): SettingsState => ({
  providers: [],
  default: { provider: "near", model: null },
  envOverride: null,
  spend: { usd: 0, budgetUsd: 5, capUsd: null, ledgerError: null },
  fallbackPrice: { input: 1, output: 5 },
  rpc,
})

const row = (over: Partial<SettingsState["rpc"][number]>) => ({
  chain: "mainnet",
  chainId: 1,
  envName: "TOUCHSTONE_FORK_RPC_1",
  set: false,
  source: null,
  last4: null,
  saved: false,
  ...over,
})

describe("Chain RPCs settings section", () => {
  test("a chain with no RPC says a fork on it cannot run", () => {
    const html = renderToStaticMarkup(<RpcSection settings={settings([row({})])} onSaved={() => {}} />)
    expect(html).toContain("Chain RPCs")
    expect(html).toContain("Not set — a fork on this chain cannot run")
    expect(html).toContain("Add")
  })

  test("a set RPC shows its source and last 4 characters, and never the URL", () => {
    const html = renderToStaticMarkup(
      <RpcSection settings={settings([row({ set: true, source: "settings", last4: "9f2a", saved: true })])} onSaved={() => {}} />,
    )
    expect(html).toContain("Saved · ends 9f2a")
    expect(html).toContain("Replace")
    expect(html).not.toContain("https://")
  })

  test("an env-provided RPC names the variable, so the operator knows where to change it", () => {
    const html = renderToStaticMarkup(
      <RpcSection settings={settings([row({ set: true, source: "env", last4: "abcd" })])} onSaved={() => {}} />,
    )
    expect(html).toContain("From TOUCHSTONE_FORK_RPC_1")
  })

  test("every chain the server offers gets a row", () => {
    const chains = ["mainnet", "bsc", "polygon", "optimism", "arbitrum", "base", "avalanche", "gnosis"]
    const html = renderToStaticMarkup(
      <RpcSection settings={settings(chains.map((chain) => row({ chain, chainId: 1, envName: `TOUCHSTONE_FORK_RPC_${chain}` })))} onSaved={() => {}} />,
    )
    for (const c of chains) expect(html).toContain(`>${c}<`)
  })
})
