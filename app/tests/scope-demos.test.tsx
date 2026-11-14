import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ScopesPage } from "../src/components/scopes-page"
import { SidebarProvider } from "../src/components/ui/sidebar"
import type { TargetChoice } from "../src/lib/types"

const owner: TargetChoice = {
  id: "scope-owner", title: "Acme · staging", kind: "scope", pack: "contracts",
  blurb: "", entry: "", signal: "", proofSurface: { kind: "none", note: "" }, runnable: true,
}

test("the scope list marks demos without relabelling saved projects or live scopes", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <ScopesPage catalog="ready" packs={[]} targets={[
        owner,
        { ...owner, id: "website-owner", kind: "live", title: "Owner website" },
        { ...owner, id: "vault-multi", kind: "lab", title: "FeeVault" },
      ]} runs={[]} briefs={{}} onOpenRun={() => {}} onChanged={() => {}} />
    </SidebarProvider>,
  )
  const rows = html.split('<li data-slot="list-row"').slice(1)
  expect(rows[0]).toContain("Acme · staging")
  expect(rows[1]).toContain("Owner website")
  expect(rows[0]).not.toMatch(/>Demo</)
  expect(rows[1]).not.toMatch(/>Demo</)
  expect(rows[2]).toContain("FeeVault")
  expect(rows[2]).toMatch(/>Demo</)
})
