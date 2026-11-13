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
    expect(html).toMatch(/FeeVault lost <span[^>]*data-slot="exact-amount"[^>]*>9\.945 ETH<\/span>\./)
    // The amount is a Tab stop, so a keyboard reaches its exact value.
    expect(html).toMatch(/<span tabindex="0"[^>]*data-slot="exact-amount"|<span[^>]*data-slot="exact-amount"[^>]*tabindex="0"/)
  })
  test("a rounded amount is marked and its name says the exact value", () => {
    const html = renderToStaticMarkup(<HarmLine harm={{ ok: true, kind: "funds", victim: "0xabc", lostWei: "1999999999999" }} />)
    expect(html).toContain("≈0.000002 ETH")
    expect(html).toContain('aria-label="≈0.000002 ETH, exactly 1,999,999,999,999 wei"')
  })

  test("no harm in the record: nothing", () => {
    expect(renderToStaticMarkup(<HarmLine harm={undefined} />)).toBe("")
  })
})
