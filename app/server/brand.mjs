// The Touchstone brand, for pages the server writes (the shareable report).
//
// WHY THIS EXISTS. The report is one self-contained HTML file, so it cannot
// link the app's stylesheet. It must still look like the app. So we do not copy
// colour values here. We read the app's own files as text, once, and inline
// them:
//   - src/tokens.css  the colour tokens (:root and .dark). index.css imports
//                     the same file, so the app and the report cannot drift.
//   - src/fonts.css   the font face. Its URL is root-relative. When the app
//                     serves the report, the font loads from the app. A saved
//                     copy opened offline falls back to the system sans.
//   - src/assets/touchstone-mark.svg  the logo mark.
// The report has no script to set a .dark class, so the .dark block becomes a
// prefers-color-scheme media query. The app follows the system setting too.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => readFileSync(path.join(APP, rel), "utf8")

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "")

// The tokens as CSS for a page with no .dark class.
function tokensCss() {
  const css = stripComments(read("src/tokens.css"))
  const dark = /\.dark\s*\{([\s\S]*?)\}/.exec(css)
  if (!dark) throw new Error("src/tokens.css has no .dark block.")
  const light = css.slice(0, dark.index).trim()
  return `${light}\n@media (prefers-color-scheme: dark) {\n  :root {${dark[1]}}\n}`
}

let cache = null
function load() {
  if (cache) return cache
  const mark = read("src/assets/touchstone-mark.svg").replace(/<!--[\s\S]*?-->/g, "").replace(/\n\s*/g, " ").trim()
  cache = { css: `${stripComments(read("src/fonts.css")).trim()}\n${tokensCss()}`, mark }
  return cache
}

// The font stacks. Same values as the @theme block in src/index.css.
export const FONT_SANS = `"Timeless Grotesk", ui-sans-serif, system-ui, sans-serif`
export const FONT_MONO = `ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", monospace`

// The font face and colour tokens, ready for a <style> block.
export function brandCss() {
  return load().css
}

// The logo mark as inline SVG. It fills with currentColor.
export function markSvg(size = 20) {
  return load().mark.replace("<svg ", `<svg width="${size}" height="${size}" aria-hidden="true" `).replace(/ role="img" aria-label="Touchstone"/, "")
}
