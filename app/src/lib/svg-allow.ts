// The one pass between Pele's SVG and the page (components/mermaid-block.tsx).
//
// Pele escapes text and filters links, but the page does not rely on that. The
// SVG string is parsed (the browser's DOMParser, as `image/svg+xml`), walked,
// and written out again by this file. Only the names in the lists below are
// written; every value is escaped here. Anything else is left out:
// `foreignObject`, `a`, `image`, `use`, `script`, `style`, `animate`, `set`,
// any `on…` attribute, `href`, `xlink:href`, any element outside the SVG
// namespace, any attribute in another namespace (except `xml:space`), any
// `url(…)` that is not a same-document `#id` reference.
//
// The lists come from Pele 1.13.0's real output: every example on pele.run for
// all 32 diagram types, rendered with the app's options (tests/fixtures).
// A parse error, a root that is not `<svg>`, or nothing left to draw gives
// null: the caller then shows the source as code (fail closed).

export type SvgNode =
  | { kind: "el"; ns: string | null; name: string; attrs: SvgAttr[]; children: SvgNode[] }
  | { kind: "text"; value: string }
export type SvgAttr = { ns: string | null; name: string; value: string }

export const SVG_NS = "http://www.w3.org/2000/svg"
export const XML_NS = "http://www.w3.org/XML/1998/namespace"

// Elements Pele emits. A disallowed element is dropped with all it holds.
export const ELEMENTS: ReadonlySet<string> = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "polygon", "text", "tspan", "title", "desc",
  // Sankey's link gradients only.
  "defs", "linearGradient", "stop",
])

// Attributes Pele emits, without a namespace. `xml:space` is the one
// namespaced attribute kept (it only says how to treat white space).
// No `class`: Pele draws with inline styles only, and no app CSS reads a Pele
// class (it emits 267 over the fixture), so none is written. A source's
// `classDef` names, or a Tailwind utility such as `fixed`, never reach the page,
// and a newer Pele cannot add one either.
export const ATTRIBUTES: ReadonlySet<string> = new Set([
  "aria-describedby", "aria-labelledby", "aria-roledescription", "cx", "cy", "d", "data-icon",
  "data-id", "fill", "fill-opacity", "font-family", "font-size", "font-style", "font-weight", "height",
  "id", "opacity", "points", "r", "role", "rx", "ry", "stroke", "stroke-dasharray", "stroke-linecap",
  "stroke-linejoin", "stroke-width", "style", "text-anchor", "transform", "viewBox", "width", "x", "y",
  // Sankey's link gradients only.
  "gradientUnits", "offset", "stop-color", "x1", "x2",
])

// Inline style properties kept. No custom property is written, and no `font`
// shorthand (it can name a font): Pele's `font:14px sans-serif` becomes
// `font-size:14px`.
export const STYLE_PROPS: ReadonlySet<string> = new Set([
  "color", "direction", "fill", "font-family", "font-size", "font-style", "font-weight", "height",
  "letter-spacing", "max-width", "rx", "stroke", "stroke-dasharray", "stroke-dashoffset",
  "stroke-width", "text-transform", "word-spacing",
])

// The Pele variables `.mermaid-frame` maps to app tokens (src/index.css). This
// list is the one source of truth: a test fails when the CSS and this list
// differ. A `var(...)` is written only with one of these names, and never with
// its fallback, so an unmapped name cannot fall back to a fixed colour.
export const FRAME_VARS: ReadonlySet<string> = new Set(
  [
    "bg", "fg", "fg-on-light", "fg-on-dark", "muted", "line", "surface", "surface-alt", "border",
    "accent", "critical", "error", "font", "font-mono", "radius", "title-weight", "heading-weight",
    "bold-weight", "series-1", "series-2", "series-3", "series-4", "series-5", "series-6", "series-7",
    "series-8",
  ].map((n) => `--pele-${n}`),
)

const LINE = "var(--pele-line)"
const PAINTS = new Set(["fill", "stroke", "color", "stop-color"])
const KEYWORD = /^(none|transparent|currentcolor|inherit)$/i
// One `var(--name)` or `var(--name, fallback)` and nothing else. The fallback
// is read only to be dropped.
const ONE_VAR = /^var\((--[\w-]+)\s*(?:,[^()]*)?\)$/
// A value may hold only these characters. No `\`, `;`, `<`, `>`, `&`, `@`,
// `{`, `}`, `/`, `*` (no comment), `:` (no scheme).
const PLAIN_VALUE = /^[\w\s#.,%()'"+-]*$/
const LOCAL_URL = /^url\(#[\w-]+\)$/
// A paint that points at a gradient in the same SVG, with a fallback
// (Sankey: `url(#m1-g0) var(--pele-series-1,#4c78a8)`).
const LOCAL_PAINT = /^(url\(#[\w-]+\))\s+(.+)$/

// Pele's root sets aliases such as `--_s:var(--pele-surface,#f3f3f3)` and the
// shapes use `var(--_s)`. The aliases are read from the root and each use is
// written as the frame name itself (`var(--pele-surface)`); the alias
// declarations are not written. An alias to an unmapped name is unknown.
type Aliases = ReadonlyMap<string, string>

export function readAliases(rootStyle: string | undefined): Aliases {
  const out = new Map<string, string>()
  for (const decl of (rootStyle ?? "").split(";")) {
    const i = decl.indexOf(":")
    const prop = decl.slice(0, i).trim()
    const m = ONE_VAR.exec(decl.slice(i + 1).trim())
    if (/^--_[a-z]+$/.test(prop) && m && FRAME_VARS.has(m[1])) out.set(prop, m[1])
  }
  return out
}

// `var(--x[, fallback])` as `var(--pele-y)`, or null.
function frameVar(v: string, aliases: Aliases): string | null {
  const m = ONE_VAR.exec(v)
  if (!m) return null
  const name = FRAME_VARS.has(m[1]) ? m[1] : aliases.get(m[1])
  return name ? `var(${name})` : null
}

// A paint: a keyword, a frame variable, or a same-document gradient with one of
// those after it. Null for anything else.
function paint(v: string, aliases: Aliases): string | null {
  if (KEYWORD.test(v)) return v
  if (LOCAL_URL.test(v)) return v
  const g = LOCAL_PAINT.exec(v)
  if (g) {
    const after = KEYWORD.test(g[2]) ? g[2] : frameVar(g[2], aliases)
    return after ? `${g[1]} ${after}` : null
  }
  return frameVar(v, aliases)
}

// Any other value. A value with `var(` must be exactly one frame variable.
function plain(name: string, v: string, aliases: Aliases): string | null {
  if (/var\(/i.test(v)) return frameVar(v, aliases)
  if (name === "font-family") return null
  if (/url\(/i.test(v) && !LOCAL_URL.test(v)) return null
  if (name === "d" || name === "points" || name === "transform" || name === "viewBox") {
    return /^[\w\s.,()+-]*$/.test(v) ? v : null
  }
  return PLAIN_VALUE.test(v) ? v : null
}

function cleanValue(name: string, value: string, aliases: Aliases): string | null {
  const v = value.trim()
  // A fixed colour attribute (an arrowhead coloured by `linkStyle`) becomes
  // the line colour.
  if (PAINTS.has(name)) return paint(v, aliases) ?? LINE
  // A style with a foreign url() is dropped whole.
  if (name === "style") return /url\((?!#)/i.test(v) ? null : cleanStyle(v, aliases)
  return plain(name, v, aliases)
}

function cleanStyle(style: string, aliases: Aliases): string | null {
  const kept: string[] = []
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":")
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const value = decl.slice(i + 1).trim()
    if (prop === "font") {
      const size = /(?:^|\s)(\d+(?:\.\d+)?px)(?:\s|$)/.exec(value)
      if (size) kept.push(`font-size:${size[1]}`)
      continue
    }
    if (!STYLE_PROPS.has(prop)) continue
    // A fixed colour declaration is dropped, so the element keeps its token
    // attribute.
    const v = PAINTS.has(prop) ? paint(value, aliases) : plain(prop, value, aliases)
    if (v !== null && !/url\(/i.test(v)) kept.push(`${prop}:${v}`)
  }
  return kept.length ? kept.join(";") : null
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

const SHAPES = new Set(["path", "rect", "circle", "ellipse", "polygon", "text"])

// Writes the allowed part of a parsed SVG. Null when the root is not an SVG
// `<svg>` or nothing drawable is left.
export function writeAllowedSvg(root: SvgNode | null): string | null {
  if (!root || root.kind !== "el" || root.ns !== SVG_NS || root.name !== "svg") return null
  let shapes = 0
  const aliases = readAliases(root.attrs.find((a) => a.ns === null && a.name === "style")?.value)
  const walk = (n: SvgNode): string => {
    if (n.kind === "text") return esc(n.value)
    if (n.ns !== SVG_NS || !ELEMENTS.has(n.name)) return ""
    if (SHAPES.has(n.name)) shapes++
    let out = `<${n.name}`
    if (n === root) out += ` xmlns="${SVG_NS}"`
    for (const a of n.attrs) {
      let name: string
      if (a.ns === XML_NS && a.name === "space") name = "xml:space"
      else if (a.ns === null && ATTRIBUTES.has(a.name)) name = a.name
      else continue
      const value = name === "xml:space" ? (a.value === "preserve" ? a.value : null) : cleanValue(a.name, a.value, aliases)
      if (value !== null) out += ` ${name}="${esc(value)}"`
    }
    return `${out}>${n.children.map(walk).join("")}</${n.name}>`
  }
  const svg = walk(root)
  return shapes > 0 ? svg : null
}

// The browser parser. Text and CDATA become text; comments and processing
// instructions are dropped. A parse error gives null.
export function parseSvg(svg: string): SvgNode | null {
  if (typeof DOMParser === "undefined") return null
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
  if (doc.getElementsByTagNameNS("*", "parsererror").length) return null
  const toNode = (n: Node): SvgNode | null => {
    if (n.nodeType === 3 || n.nodeType === 4) return { kind: "text", value: n.nodeValue ?? "" }
    if (n.nodeType !== 1) return null
    const el = n as Element
    return {
      kind: "el",
      ns: el.namespaceURI,
      name: el.localName,
      attrs: [...el.attributes].map((a) => ({ ns: a.namespaceURI, name: a.localName, value: a.value })),
      children: [...el.childNodes].map(toNode).filter((c): c is SvgNode => c !== null),
    }
  }
  return toNode(doc.documentElement)
}

export function allowSvg(svg: string, parse: (svg: string) => SvgNode | null = parseSvg): string | null {
  try {
    return writeAllowedSvg(parse(svg))
  } catch {
    return null
  }
}
