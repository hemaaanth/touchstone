// N6 part 1: the page declares the one colour scheme it really uses. A browser's
// forced dark mode (Chrome's auto dark, Samsung Internet's "prefer media query"
// setting) leaves a page alone that says it is already dark; a page that only
// says "light dark" leaves the browser to guess.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
// @ts-expect-error — plain .mjs module, no types
import { brandCss } from "../server/brand.mjs"

const APP = path.join(import.meta.dir, "..")
const read = (rel: string) => readFileSync(path.join(APP, rel), "utf8")
const block = (css: string, selector: string) => {
  const m = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([\\s\\S]*?)\\}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ""))
  return m?.[1] ?? ""
}

// Run index.html's theme script against a stub window: the system setting, the
// root class list, the meta tag, and the change listener.
function runThemeScript(prefersDark: boolean) {
  const html = read("index.html")
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (!script) throw new Error("index.html has no inline theme script")
  const classes = new Set<string>()
  const meta = { content: /<meta name="color-scheme" content="([^"]*)"/.exec(html)?.[1] ?? "" }
  const query = { matches: prefersDark, listener: null as null | (() => void), addEventListener: (_: string, fn: () => void) => { query.listener = fn } }
  const window = { matchMedia: () => query }
  const document = {
    documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } },
    querySelector: (sel: string) => (sel === 'meta[name="color-scheme"]' ? meta : null),
  }
  new Function("window", "document", script)(window, document)
  return { classes, meta, query }
}

describe("the page names the colour scheme it uses (N6 part 1)", () => {
  test("tokens.css declares color-scheme on the root for each theme", () => {
    const css = read("src/tokens.css")
    expect(block(css, ":root")).toMatch(/color-scheme:\s*light;/)
    expect(block(css, ".dark")).toMatch(/color-scheme:\s*dark;/)
  })

  test("the theme script sets the dark class and the meta tag to the same scheme, and follows a live change", () => {
    const dark = runThemeScript(true)
    expect(dark.classes.has("dark")).toBe(true)
    expect(dark.meta.content).toBe("dark")
    const light = runThemeScript(false)
    expect(light.classes.has("dark")).toBe(false)
    expect(light.meta.content).toBe("light")
    // The system setting changes while the page is open: both follow.
    light.query.matches = true
    light.query.listener?.()
    expect(light.classes.has("dark")).toBe(true)
    expect(light.meta.content).toBe("dark")
  })

  test("before the script runs, the meta tag still says the page supports both", () => {
    expect(read("index.html")).toMatch(/<meta name="color-scheme" content="light dark" \/>/)
  })

  test("the shareable report gets the same declaration through the shared tokens", () => {
    const css = brandCss()
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light;/)
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^}]*color-scheme:\s*dark;/)
  })
})
