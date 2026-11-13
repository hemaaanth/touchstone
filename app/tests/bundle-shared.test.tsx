import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ExportReport } from "../src/components/proof-parts"
import { hasBundle } from "../src/lib/findings-view"

// The replay bundle lives in the shared proof view: the run drawer and the
// Findings sheet both render ExportReport, so both get it, once.
describe("the replay bundle in the shared proof view", () => {
  test("ExportReport offers the bundle when asked, under the shareable report", () => {
    const html = renderToStaticMarkup(<ExportReport findingId="run-1.1" bundle={{ start: false }} />)
    expect(html).toContain("Shareable report")
    expect(html).toContain("Download replay bundle")
    expect(html.indexOf("Shareable report")).toBeLessThan(html.indexOf("Download replay bundle"))
    expect(renderToStaticMarkup(<ExportReport findingId="run-1.1" />)).not.toContain("Download replay bundle")
  })

  test("only a proven finding that is not an evidence finding has a bundle", () => {
    expect(hasBundle({ stages: { proven: true }, proofKind: "forge" })).toBe(true)
    expect(hasBundle({ stages: { proven: true }, proofKind: "http" })).toBe(true)
    expect(hasBundle({ stages: { proven: true } })).toBe(true)
    // The server ends an evidence bundle in its refusal sentence: no control.
    expect(hasBundle({ stages: { proven: true }, proofKind: "evidence" })).toBe(false)
    expect(hasBundle({ stages: { proven: false }, proofKind: "forge" })).toBe(false)
  })
})
