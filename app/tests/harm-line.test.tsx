import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { HarmLine } from "../src/components/replay-proof"

// The shared proof view (run drawer and Findings sheet) says what was lost.
describe("What was lost", () => {
  test("an ETH drain shows the amount with the exact wei on hover", () => {
    const html = renderToStaticMarkup(
      <HarmLine harm={{ ok: true, kind: "funds", victim: "0xabc0000000000000000000000000000000000def", lostWei: "9945000000000000000", targets: [{ address: "0xabc0000000000000000000000000000000000def", name: "FeeVault" }] }} />,
    )
    expect(html).toContain("What was lost")
    expect(html).toContain("FeeVault lost 9.945 ETH.")
    expect(html).toContain('title="9945000000000000000 wei"')
  })
  test("no harm in the record: nothing", () => {
    expect(renderToStaticMarkup(<HarmLine harm={undefined} />)).toBe("")
  })
})
