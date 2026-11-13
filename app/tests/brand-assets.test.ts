import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { markSvg } from "../server/brand.mjs"

const SRC = path.join(import.meta.dir, "..", "src")
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(tsx?|css)$/.test(e.name) ? [path.join(dir, e.name)] : []))

describe("brand: the mark is a source asset (final review Minor 1)", () => {
  test("no source file imports from public/", () => {
    // Vite warns at every start when JavaScript imports a file in public/.
    const bad = files(SRC).filter((f) => /from\s+["'][^"']*\bpublic\//.test(readFileSync(f, "utf8")))
    expect(bad).toEqual([])
  })
  test("the report still inlines the same mark", () => {
    const mark = readFileSync(path.join(SRC, "assets", "touchstone-mark.svg"), "utf8")
    const d = /\sd="([^"]+)"/.exec(mark)?.[1]
    expect(d).toBeTruthy()
    expect(markSvg(20)).toContain(d!)
  })
})
