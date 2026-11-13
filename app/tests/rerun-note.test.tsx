import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RerunNote } from "../src/components/proof-parts"

// Point 5: the proof view shows "re-run checked" only when the check passed,
// and it is neutral — never green (green is reserved for the proven verdict).
describe("the re-run note on a Foundry proof", () => {
  test("a passing verdict reads 're-run checked', with no success/green tone", () => {
    const html = renderToStaticMarkup(<RerunNote rerun={{ checked: true, pass: true }} />)
    expect(html).toContain("Re-run checked")
    expect(html).toContain("the proof test passed")
    // No green / success tone: those tokens are reserved for the proven verdict.
    expect(html).not.toContain("text-ok")
    expect(html).not.toContain("text-success")
    expect(html).not.toContain("text-green")
  })

  test("a failed verdict never claims a re-run and shows the reason", () => {
    const html = renderToStaticMarkup(<RerunNote rerun={{ checked: true, pass: false, reason: "the proof forked a chain, which the offline re-run cannot" }} />)
    expect(html).not.toContain("Re-run checked")
    expect(html).toContain("Not re-run-checked")
    expect(html).toContain("the proof forked a chain")
  })

  test("no verdict renders nothing", () => {
    expect(renderToStaticMarkup(<RerunNote rerun={null} />)).toBe("")
    expect(renderToStaticMarkup(<RerunNote />)).toBe("")
  })
})
