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
export const ATTRIBUTES: ReadonlySet<string> = new Set([
  "aria-describedby", "aria-labelledby", "aria-roledescription", "class", "cx", "cy", "d", "data-icon",
  "data-id", "fill", "fill-opacity", "font-family", "font-size", "font-style", "font-weight", "height",
  "id", "opacity", "points", "r", "role", "rx", "ry", "stroke", "stroke-dasharray", "stroke-linecap",
  "stroke-linejoin", "stroke-width", "style", "text-anchor", "transform", "viewBox", "width", "x", "y",
  // Sankey's link gradients only.
  "gradientUnits", "offset", "stop-color", "x1", "x2",
])

// Inline style properties kept. Custom properties are kept only as Pele's own
// plumbing: a `--_x` name whose value is `var(--pele-…)`. So a source's
// `themeVariables` (written as `--pele-series-1:#ff0000`) is dropped.
export const STYLE_PROPS: ReadonlySet<string> = new Set([
  "color", "direction", "fill", "font", "font-family", "font-style", "font-weight", "height",
  "letter-spacing", "max-width", "rx", "stroke", "stroke-dasharray", "stroke-dashoffset",
  "stroke-width", "text-transform", "word-spacing",
])

// Colour attributes and properties keep only a token. A fixed colour attribute
// (an arrowhead coloured by `linkStyle`) becomes the line token; a fixed colour
// declaration is dropped, so the element falls back to its token attribute.
const COLOURS = new Set(["fill", "stroke", "color", "stop-color"])
// Only Pele's own variables: a source must not reach an app token such as
// `--destructive`. The frame maps every `--pele-*` to a neutral token.
const TOKEN = /^\s*(var\(--(_[a-z]+|pele-[a-z0-9-]+)(,[^;()]*)?\)|none|transparent|currentcolor|inherit)\s*$/i
const PELE_VAR = /^var\(--pele-[a-z0-9-]+(,[^;()]*)?\)$/
// A value may hold only these characters. No `\`, `;`, `<`, `>`, `&`, `@`,
// `{`, `}`, `/`, `*` (no comment), `:` (no scheme).
const PLAIN_VALUE = /^[\w\s#.,%()'"+-]*$/
const LOCAL_URL = /^url\(#[\w-]+\)$/
// A paint that points at a gradient in the same SVG, with a token fallback
// (Sankey: `url(#m1-g0) var(--pele-series-1,#4c78a8)`).
const LOCAL_PAINT = /^url\(#[\w-]+\)\s+(.+)$/

function cleanValue(name: string, value: string): string | null {
  const v = value.trim()
  if (COLOURS.has(name)) {
    const paint = LOCAL_PAINT.exec(v)
    if (paint) return TOKEN.test(paint[1]) ? v : "var(--_l)"
    return TOKEN.test(v) ? v : "var(--_l)"
  }
  if (/url\(/i.test(v) && !LOCAL_URL.test(v)) return null
  if (name === "class") {
    // Only Pele's own class names. A source's `classDef` names (or a Tailwind
    // utility such as `fixed`) would be styled by the app's CSS.
    const kept = v.split(/\s+/).filter((c) => /^pele[\w-]*$/.test(c))
    return kept.length ? kept.join(" ") : null
  }
  if (name === "font-family") return TOKEN.test(v) ? v : null
  if (name === "style") return cleanStyle(v)
  if (name === "d" || name === "points" || name === "transform" || name === "viewBox") {
    return /^[\w\s.,()+-]*$/.test(v) ? v : null
  }
  return PLAIN_VALUE.test(v) ? v : null
}

function cleanStyle(style: string): string | null {
  const kept: string[] = []
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":")
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const value = decl.slice(i + 1).trim()
    if (prop.startsWith("--")) {
      if (/^--_[a-z]+$/.test(prop) && PELE_VAR.test(value)) kept.push(`${prop}:${value}`)
      continue
    }
    if (!STYLE_PROPS.has(prop) || !PLAIN_VALUE.test(value) || /url\(/i.test(value)) continue
    if ((COLOURS.has(prop) || prop === "font-family") && !TOKEN.test(value)) continue
    kept.push(`${prop}:${value}`)
  }
  return kept.length ? kept.join(";") : null
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const SHAPES = new Set(["path", "rect", "circle", "ellipse", "polygon", "text"])

// Writes the allowed part of a parsed SVG. Null when the root is not an SVG
// `<svg>` or nothing drawable is left.
export function writeAllowedSvg(root: SvgNode | null): string | null {
  if (!root || root.kind !== "el" || root.ns !== SVG_NS || root.name !== "svg") return null
  let shapes = 0
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
      const value = name === "xml:space" ? (a.value === "preserve" ? a.value : null) : cleanValue(a.name, a.value)
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
