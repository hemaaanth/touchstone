// Checks on the allow-list pass's output, for tests.
import { ATTRIBUTES, ELEMENTS, STYLE_PROPS, SVG_NS, XML_NS, type SvgNode } from "@/lib/svg-allow"
import { miniXml } from "./mini-xml"

const XMLNS = "http://www.w3.org/2000/xmlns/"

function* walk(n: SvgNode): Generator<Extract<SvgNode, { kind: "el" }>> {
  if (n.kind !== "el") return
  yield n
  for (const c of n.children) yield* walk(c)
}

const decls = (style: string) =>
  style
    .split(";")
    .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()] as const)
    .filter(([p]) => p)

// Every name in the output that is not on the lists. Empty means all is well.
export function namesOffList(svg: string): string[] {
  const root = miniXml(svg)
  const out: string[] = []
  for (const el of walk(root)) {
    if (el.ns !== SVG_NS || !ELEMENTS.has(el.name)) out.push(`element ${el.ns}:${el.name}`)
    for (const a of el.attrs) {
      if (a.ns === XMLNS && a.name === "xmlns" && el === root && a.value === SVG_NS) continue
      if (a.ns === XML_NS && a.name === "space") continue
      if (a.ns !== null || !ATTRIBUTES.has(a.name)) out.push(`attribute ${a.ns ?? ""}:${a.name} on ${el.name}`)
      if (a.name === "style") {
        for (const [p, v] of decls(a.value)) {
          if (p.startsWith("--") ? !(/^--_[a-z]+$/.test(p) && /^var\(--pele-/.test(v)) : !STYLE_PROPS.has(p)) out.push(`style ${p} on ${el.name}`)
        }
      }
    }
  }
  return out
}

// CSS named colours (CSS Color 4), for the colour check.
const NAMED =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
const NAMED_RE = new RegExp(`\\b(${NAMED.split(" ").join("|")})\\b`, "i")
const LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
// A Pele variable with its fallback is a token: the frame sets every one.
const PELE_VAR = /var\(--(?:_[a-z]+|pele-[a-z0-9-]+)(?:,[^;()]*)?\)/gi

// Every fixed colour in the output: in any attribute value or any style
// declaration (custom properties included), outside a Pele variable.
export function fixedColours(svg: string): string[] {
  const out: string[] = []
  for (const el of walk(miniXml(svg))) {
    for (const a of el.attrs) {
      if (["class", "id", "data-id", "role", "aria-roledescription", "aria-labelledby", "aria-describedby"].includes(a.name)) continue
      const values = a.name === "style" ? decls(a.value).map(([p, v]) => `${p}:${v}`) : [`${a.name}=${a.value}`]
      for (const v of values) {
        const bare = v.replace(PELE_VAR, "")
        if (LITERAL.test(bare) || NAMED_RE.test(bare.replace(/^[\w-]+[:=]/, ""))) out.push(`${el.name} ${v}`)
      }
    }
  }
  return out
}
