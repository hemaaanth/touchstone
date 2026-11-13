// A small, strict XML reader for tests only. Bun has no DOMParser, so the
// allow-list pass (src/lib/svg-allow.ts) is fed this tree in unit tests. The
// browser uses the real DOMParser; the same hand-made inputs ran there too
// (wave/n5-report.md). It throws on anything it does not know (a DOCTYPE, an
// unknown entity, a bad tag), and the pass treats a throw as "show the code".
import type { SvgNode } from "@/lib/svg-allow"

const XMLNS = "http://www.w3.org/2000/xmlns/"
const XML = "http://www.w3.org/XML/1998/namespace"
const NAME = /^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?/

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);|&/g, (m, e: string | undefined) => {
    if (!e) throw new Error("bare &")
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }
    if (!(e in named)) throw new Error(`unknown entity ${m}`)
    return named[e]
  })
}

export function miniXml(src: string): SvgNode {
  let i = 0
  const scopes: Record<string, string>[] = [{ xml: XML }]
  const lookup = (prefix: string) => {
    for (let k = scopes.length - 1; k >= 0; k--) if (prefix in scopes[k]) return scopes[k][prefix]
    throw new Error(`unbound prefix ${prefix}`)
  }
  const skipMisc = () => {
    for (;;) {
      const ws = /^\s*/.exec(src.slice(i))![0]
      i += ws.length
      if (src.startsWith("<?", i)) i = src.indexOf("?>", i) + 2
      else if (src.startsWith("<!--", i)) i = src.indexOf("-->", i) + 3
      else if (src.startsWith("<!", i)) throw new Error("DOCTYPE not supported")
      else return
      if (i < 2) throw new Error("unclosed")
    }
  }
  const element = (): SvgNode => {
    if (src[i] !== "<") throw new Error(`expected < at ${i}`)
    i++
    const qn = NAME.exec(src.slice(i))?.[0]
    if (!qn) throw new Error("bad tag name")
    i += qn.length
    const raw: [string, string][] = []
    for (;;) {
      const ws = /^\s*/.exec(src.slice(i))![0]
      i += ws.length
      if (src.startsWith("/>", i) || src[i] === ">") break
      if (!ws) throw new Error("expected space")
      const an = NAME.exec(src.slice(i))?.[0]
      if (!an) throw new Error("bad attribute name")
      i += an.length
      const m = /^\s*=\s*(["'])/.exec(src.slice(i))
      if (!m) throw new Error("attribute without a quoted value")
      i += m[0].length
      const end = src.indexOf(m[1], i)
      if (end < 0) throw new Error("unclosed attribute")
      const v = src.slice(i, end)
      if (v.includes("<")) throw new Error("< in attribute")
      raw.push([an, decode(v)])
      i = end + 1
    }
    const scope: Record<string, string> = {}
    for (const [n, v] of raw) {
      if (n === "xmlns") scope[""] = v
      else if (n.startsWith("xmlns:")) scope[n.slice(6)] = v
    }
    scopes.push(scope)
    const split = (q: string) => (q.includes(":") ? q.split(":") : ["", q])
    const [p, local] = split(qn)
    const ns = p ? lookup(p) : (() => { try { return lookup("") } catch { return null } })()
    const attrs = raw.map(([n, v]) => {
      if (n === "xmlns" || n.startsWith("xmlns:")) return { ns: XMLNS, name: n === "xmlns" ? "xmlns" : n.slice(6), value: v }
      const [ap, al] = split(n)
      return { ns: ap ? lookup(ap) : null, name: al, value: v }
    })
    const children: SvgNode[] = []
    if (src.startsWith("/>", i)) {
      i += 2
    } else {
      i++
      for (;;) {
        if (src.startsWith("</", i)) {
          const close = new RegExp(`^</${qn.replace(/[.]/g, "\\.")}\\s*>`).exec(src.slice(i))
          if (!close) throw new Error(`mismatched close for ${qn}`)
          i += close[0].length
          break
        }
        if (src.startsWith("<!--", i)) { i = src.indexOf("-->", i) + 3; if (i < 3) throw new Error("unclosed comment"); continue }
        if (src.startsWith("<![CDATA[", i)) {
          const end = src.indexOf("]]>", i)
          if (end < 0) throw new Error("unclosed CDATA")
          children.push({ kind: "text", value: src.slice(i + 9, end) })
          i = end + 3
          continue
        }
        if (src.startsWith("<?", i)) { i = src.indexOf("?>", i) + 2; continue }
        if (src[i] === "<") { children.push(element()); continue }
        if (i >= src.length) throw new Error(`unclosed ${qn}`)
        const next = src.indexOf("<", i)
        const end = next < 0 ? src.length : next
        children.push({ kind: "text", value: decode(src.slice(i, end)) })
        i = end
      }
    }
    scopes.pop()
    return { kind: "el", ns, name: local, attrs, children }
  }
  skipMisc()
  const root = element()
  skipMisc()
  if (i < src.length) throw new Error("content after the root")
  return root
}
