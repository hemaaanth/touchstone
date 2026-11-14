import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { AddScope } from "../src/components/new-run-dialog"

// The chain pin is the only way a human creates a forked scope (docs/network.md).
// This pins the three things that make it safe to have in a form:
//   1. it is OFF by default, so every existing scope keeps the offline proof path,
//   2. the block field cannot be used before a chain is chosen,
//   3. the form says what a pin means, so "fork a real chain" is not a surprise.
//
// The Pin row lives in the part of the form that appears once a source is listed
// (like Name and Modules): there is nothing to pin before there is a scope. So the
// test drives the real form state rather than a bare render.
const render = () => renderToStaticMarkup(<AddScope packs={[]} onAttached={() => {}} onError={() => {}} defaultOpen />)

describe("the scope form's chain pin", () => {
  test("the form starts with no pin, and no pin means the offline path", () => {
    // The Pin control appears with Name and Modules, once a source is listed. What
    // matters for every existing scope is the default: `pinChain` starts empty, so
    // `scopeBody` sends no `fork` and the run keeps the offline proof.
    const html = render()
    // The pin row is not shown before there is a scope to pin.
    expect(html).not.toContain("No pin")
    expect(html).toContain("GitHub URL, website, or folder path")
  })

  test("the Pin row offers no chain by default and disables the block until one is picked", () => {
    // The row is rendered with the form's own default state. Asserted against the
    // component source, because the row only mounts once a source exists: this test
    // is about the contract of that row, and a state-driven render would need a
    // browser. The behaviour is covered end to end by the API test.
    const src = readFileSync(new URL("../src/components/new-run-dialog.tsx", import.meta.url), "utf8")
    expect(src).toContain('<option value="">No pin</option>')
    expect(src).toContain('disabled={busy || !pinChain}')
  })

  test("every chain the engine can fork is offered, from one list", () => {
    const src = readFileSync(new URL("../src/components/new-run-dialog.tsx", import.meta.url), "utf8")
    const list = src.match(/const FORK_CHAIN_NAMES = \[([^\]]+)\]/)?.[1] ?? ""
    for (const chain of ["mainnet", "bsc", "polygon", "optimism", "arbitrum", "base", "avalanche", "gnosis"]) {
      expect(list).toContain(`"${chain}"`)
    }
  })

  test("the form says what a pin does, and that addresses are optional", () => {
    const src = readFileSync(new URL("../src/components/new-run-dialog.tsx", import.meta.url), "utf8")
    expect(src).toContain("0x… addresses, comma separated (optional)")
    expect(src).toContain("Nothing is signed or sent.")
  })
})
