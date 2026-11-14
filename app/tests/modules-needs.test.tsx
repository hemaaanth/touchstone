import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ModulesPage } from "../src/components/modules-page"
import { SidebarProvider } from "../src/components/ui/sidebar"
import type { PackChoice, TargetChoice } from "../src/lib/types"

// A module that needs an input must say so on its row and in its sheet, and must
// be visibly not-ready. This is the operator-facing half of
// spike/lib/module-needs.mjs: the server greys nothing, it only reports needs.
const contracts: PackChoice = {
  id: "contracts",
  title: "Contracts",
  description: "Solidity contracts you own.",
  proof: "forge",
}
const review: PackChoice = { id: "review", title: "Code review", description: "Read and report leads.", proof: "none" }

const forked = (over: Partial<TargetChoice> = {}): TargetChoice => ({
  id: "scope-forked",
  title: "Forked target",
  kind: "scope",
  pack: "contracts",
  packs: ["contracts"],
  runnable: false,
  needs: [
    { id: "fork-rpc", label: "An RPC for mainnet", kind: "settings", met: false, detail: "Add an RPC for mainnet in Settings, or set TOUCHSTONE_FORK_RPC_1." },
  ],
  needsByPack: { contracts: [
    { id: "fork-rpc", label: "An RPC for mainnet", kind: "settings", met: false, detail: "Add an RPC for mainnet in Settings, or set TOUCHSTONE_FORK_RPC_1." },
  ], review: [] },
  ...over,
} as TargetChoice)

const ready: TargetChoice = { id: "lab", title: "Vault · reentrancy", kind: "lab", pack: "contracts", packs: ["contracts"], runnable: true } as TargetChoice

const render = (targets: TargetChoice[]) =>
  renderToStaticMarkup(
    <SidebarProvider>
      <ModulesPage
        catalog="ready"
        packs={[contracts, review]}
        targets={targets}
        runs={[]}
        briefs={{}}
        onOpenRun={() => {}}
      />
    </SidebarProvider>,
  )

describe("a module with an unmet need", () => {
  test("is greyed and names the missing input on its row", () => {
    const html = render([forked()])
    expect(html).toContain("Cannot run now")
    expect(html).toContain("Needs An RPC for mainnet")
    // The dimming is what makes it read as unavailable, not just a badge.
    expect(html).toContain("cursor-not-allowed")
  })

  test("is still greyed when OTHER scopes of the same module are fine", () => {
    // This is the real shape: the app always lists the shipped labs, which are
    // Contracts scopes with no needs. The first version asked "is EVERY scope
    // blocked" and so never reported a single blocked scope. Opening the page in a
    // browser is what found it.
    const html = render([forked(), ready])
    expect(html).toContain("Cannot run now")
    expect(html).toContain("Needs An RPC for mainnet")
  })

  test("a module with no needs is untouched", () => {
    const html = render([ready])
    expect(html).not.toContain("Cannot run now")
  })

  test("the same need on two scopes is one line, not two", () => {
    const html = render([forked(), forked({ id: "scope-forked-2" })])
    expect(html.match(/An RPC for mainnet/g)?.length ?? 0).toBeGreaterThan(0)
  })
})

test("a forked scope that allows Review blocks Contracts, and only Contracts", () => {
  // The real shape: a scope pins a chain and allows both modules. Review never reads
  // a chain, so it runs; Contracts cannot. The Modules page must grey Contracts and
  // name the reason, and leave Review untouched.
  const mixed = forked({ runnable: true })
  const html = render([mixed])
  // Contracts is blocked with its reason...
  expect(html).toContain("Cannot run now")
  expect(html).toContain("Needs An RPC for mainnet")
  // ...and the target itself is runnable overall, which the data already says.
  expect(mixed.runnable).toBe(true)
})
