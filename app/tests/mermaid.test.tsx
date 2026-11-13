import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { renderAsync } from "pele/lazy"
import { drawMermaid, fenceClosed, peleOptions, type DrawOptions } from "@/lib/mermaid"
import { Markdown, MAX_DIAGRAMS } from "@/components/markdown"
import { miniXml } from "./helpers/mini-xml"
import { fixedColours, namesOffList } from "./helpers/svg-check"
import examples from "./fixtures/pele-examples.json"

// Bun has no DOMParser: the pass reads the tree from the test reader.
const T: DrawOptions = { parse: miniXml, maxWidth: 700, fontFamily: "sans-serif" }
const draw = (source: string, opts: DrawOptions = {}) => drawMermaid(source, { ...T, ...opts })
const RAW = { links: false, images: false, responsive: true, fontSize: 14, maxWidth: 700, fontFamily: "sans-serif" }
// Pele alone, with exactly the options the app gives it.
const rawOf = (source: string) => renderAsync(source, peleOptions(source, T))
const tags = (svg: string) => svg.match(/<[^>]*>/g) ?? []
const samples = Object.entries(examples as Record<string, string[] | string>).filter(
  (e): e is [string, string[]] => Array.isArray(e[1]),
)

describe("drawMermaid: a hostile source", () => {
  const hostile: Record<string, string> = {
    "a script tag and an img onerror in labels":
      'flowchart LR\n  A["<script>alert(1)</script>"] --> B["x<img src=x onerror=alert(1)>"]\n  B --> C["<svg onload=alert(1)>"]',
    "click callbacks and links":
      'flowchart LR\n  A --> B\n  click A call alert(1)\n  click B "javascript:alert(1)"\n  click A href "https://evil.example/x" _blank\n  click B callback "tip"',
    "an external image": 'flowchart LR\n  A@{ img: "https://evil.example/a.png", label: "x", pos: "t" } --> B',
    "a sequence diagram with links":
      'sequenceDiagram\n  participant A as <script>x</script>\n  link A: Dashboard @ https://evil.example/d\n  links A: {"Repo": "javascript:alert(1)"}\n  A->>B: <img src=https://evil.example/p.png>',
    "a config that asks for html labels, links and images":
      '%%{init: {"links": true, "images": true, "securityLevel": "loose", "htmlLabels": true}}%%\nflowchart LR\n  A["<a href=javascript:alert(1)>x</a>"] --> B\n  click B href "https://evil.example/d"',
    "a math label": 'flowchart LR\n  A["$$\\frac{1}{2}$$"] --> B',
    "an icon label": "flowchart LR\n  A[fa:fa-car Car] --> B",
    "class names that are app utilities": "flowchart LR\n  A:::fixed --> B\n  classDef fixed fill:#f00\n  class B inset-0,z-50",
  }
  for (const [name, source] of Object.entries(hostile)) {
    test(name, async () => {
      const r = await draw(source)
      if (!r.ok) {
        expect(r.error.length).toBeGreaterThan(0)
        return
      }
      expect(namesOffList(r.svg)).toEqual([])
      for (const t of tags(r.svg)) {
        expect(t).not.toMatch(/\son[a-z]+\s*=|href|<(script|style|a|image|use|foreignObject)\b|url\(/i)
        expect(t).not.toMatch(/\b(fixed|inset-0|z-50)\b/)
      }
      expect(r.svg).not.toContain("javascript:")
      expect(r.svg).not.toContain("evil.example")
    })
  }

  test("label markup is dropped or shown as escaped text", async () => {
    const r = await draw('flowchart LR\n  A["<script>alert(1)</script>"] --> B["<svg onload=alert(1)>"]')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.svg).toContain(">alert(1)</text>")
    expect(r.svg).toContain("&lt;svg onload=alert(1)&gt;")
    expect(tags(r.svg).filter((t) => /onload/i.test(t))).toEqual([])
  })

  test("a huge source is refused by Pele's default limit", async () => {
    const huge = "flowchart LR\n" + Array.from({ length: 9000 }, (_, i) => `  n${i} --> n${i + 1}`).join("\n")
    const r = await draw(huge)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("limit")
  })

  test("a broken source gives a one-line reason, not a diagram", async () => {
    const r = await draw("flowchart LR\n  A --> \n  ((( -->")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).not.toContain("\n")
      expect(r.error.length).toBeLessThanOrEqual(200)
    }
  })
})

describe("only theme tokens: a source's own colours are dropped", () => {
  const coloured = {
    "flowchart style, classDef and linkStyle":
      "flowchart LR\n  A --> B\n  style A fill:#ff0000,stroke:#00ff00,color:#f00\n  classDef r fill:red,stroke:green\n  class B r\n  linkStyle 0 stroke:red",
    "sequence box and rect": "sequenceDiagram\n  box rgb(0,128,0) Team\n  participant A\n  end\n  rect rgb(255,0,0)\n  A->>B: hi\n  end",
  }
  // The four types that take a palette from themeVariables, each through a
  // directive and through front matter.
  const palettes: Record<string, [string, string]> = {
    pie: ['{"pie1": "#ff0000", "pie2": "#00ff00"}', 'pie title Share\n  "a": 1\n  "b": 2'],
    xychart: ['{"xyChart": {"plotColorPalette": "#ff0000, #00ff00"}}', "xychart\n  x-axis [jan, feb, mar]\n  bar [3, 5, 2]\n  line [2, 4, 3]"],
    radar: ['{"cScale0": "#ff0000", "cScale1": "#00ff00"}', "radar-beta\n  axis a, b, c\n  curve x{1, 2, 3}\n  curve y{3, 2, 1}"],
    timeline: ['{"cScale0": "#ff0000", "cScale1": "#00ff00"}', "timeline\n  title T\n  2020 : a\n  2021 : b"],
  }
  const yaml = (json: string) => {
    const vars = JSON.parse(json) as Record<string, unknown>
    const lines = Object.entries(vars).map(([k, v]) =>
      typeof v === "string" ? `    ${k}: "${v}"` : `    ${k}:\n${Object.entries(v as Record<string, string>).map(([k2, v2]) => `      ${k2}: "${v2}"`).join("\n")}`,
    )
    return `---\nconfig:\n  themeVariables:\n${lines.join("\n")}\n---\n`
  }
  for (const [type, [vars, body]] of Object.entries(palettes)) {
    coloured[`${type} palette by a directive` as keyof typeof coloured] = `%%{init: {"themeVariables": ${vars}}}%%\n${body}`
    coloured[`${type} palette by front matter` as keyof typeof coloured] = `${yaml(vars)}${body}`
  }
  for (const [name, source] of Object.entries(coloured)) {
    test(name, async () => {
      // The attack is real: Pele alone puts a fixed colour in the SVG.
      const raw = await rawOf(source)
      expect(fixedColours(raw.svg).length).toBeGreaterThan(0)
      const r = await draw(source)
      expect(r.ok).toBe(true)
      if (r.ok) expect(fixedColours(r.svg)).toEqual([])
    })
  }
})

describe("every diagram type Pele registers", () => {
  test("the examples cover all 33 types", async () => {
    const types = new Set<string>()
    for (const [, list] of samples) for (const s of list) types.add((await renderAsync(s, RAW)).type)
    expect(types.size).toBe(33)
  })

  // One sample of each type: it still draws, with the same shapes, the same
  // geometry and the same text as Pele's own output.
  const GEOMETRY = ["d", "x", "y", "width", "height", "points", "cx", "cy", "r", "rx", "ry", "transform", "viewBox"]
  for (const [page, list] of samples) {
    test(`${page}: draws and loses nothing it needs`, async () => {
      const raw = miniXml((await rawOf(list[0])).svg)
      const r = await draw(list[0])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const kept = miniXml(r.svg)
      const flat = (n: ReturnType<typeof miniXml>, out: string[] = []): string[] => {
        if (n.kind === "text") out.push(`#${n.value}`)
        else {
          const g = n.attrs.filter((a) => GEOMETRY.includes(a.name)).map((a) => `${a.name}=${a.value}`).sort()
          out.push(`<${n.name} ${g.join(" ")}>`)
          n.children.forEach((c) => flat(c, out))
        }
        return out
      }
      expect(flat(kept)).toEqual(flat(raw))
    })
  }

  test("every example: only names on the lists, and no fixed colour", async () => {
    let n = 0
    for (const [, list] of samples) {
      for (const s of list) {
        const r = await draw(s)
        expect(r.ok).toBe(true)
        if (!r.ok) continue
        expect(namesOffList(r.svg)).toEqual([])
        expect(fixedColours(r.svg)).toEqual([])
        n++
      }
    }
    expect(n).toBeGreaterThan(150)
  }, 30000)
})

describe("the cache", () => {
  test("the same source at the same width is drawn once", () => {
    const src = "flowchart LR\n  Cache1 --> Cache2"
    expect(draw(src)).toBe(draw(src))
    expect(draw(src, { maxWidth: 300 })).not.toBe(draw(src))
  })

  test("a failed chunk load is not kept; a source error is", async () => {
    const { PeleError } = await import("pele/lazy")
    let calls = 0
    const flaky: DrawOptions["load"] = async () => ({
      PeleError,
      renderAsync: async () => {
        calls++
        if (calls === 1) throw new TypeError("Failed to fetch dynamically imported module")
        return { svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', width: 1, height: 1, links: [], type: "flowchart", mermaidType: "flowchart-v2" } as never
      },
    })
    const src = "flowchart LR\n  Flaky --> Load"
    const first = await draw(src, { load: flaky })
    expect(first.ok).toBe(false)
    const second = await draw(src, { load: flaky })
    expect(second.ok).toBe(true)
    expect(calls).toBe(2)

    const broken = "flowchart LR\n  A --> ((("
    const a = draw(broken)
    await a
    expect(draw(broken)).toBe(a)
  })
})

describe("fenceClosed", () => {
  test("open while streaming, closed once the fence arrives", () => {
    expect(fenceClosed("```mermaid\nflowchart LR\n  A --> B")).toBe(false)
    expect(fenceClosed("```mermaid\nflowchart LR\n  A --> B\n``")).toBe(false)
    expect(fenceClosed("```mermaid")).toBe(false)
    expect(fenceClosed("```mermaid\nflowchart LR\n  A --> B\n```")).toBe(true)
    expect(fenceClosed("```mermaid\nflowchart LR\n```\n")).toBe(true)
    expect(fenceClosed("~~~mermaid\nflowchart LR\n~~~")).toBe(true)
    expect(fenceClosed("````mermaid\nflowchart LR\n```")).toBe(false)
    expect(fenceClosed("```mermaid\nflowchart LR\n~~~")).toBe(false)
    expect(fenceClosed("> ```mermaid\n> flowchart LR\n> ```")).toBe(true)
  })
})

describe("Markdown with a mermaid fence", () => {
  const fence = (i: number) => `\`\`\`mermaid\nflowchart LR\n  A${i} --> B${i}\n\`\`\``

  test("first paint is the normal code block with the source as text", () => {
    const html = renderToStaticMarkup(
      <Markdown text={'Before.\n\n```mermaid\nflowchart LR\n  A["<b>x</b>"] --> B\n```\n\nAfter.'} />,
    )
    expect(html).toContain("data-mermaid")
    expect(html).toContain("<pre")
    expect(html).toContain("flowchart LR")
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;")
    expect(html).not.toContain("<svg")
    expect(html).toContain("After.")
  })

  test("only a mermaid fence goes to the diagram block", () => {
    for (const lang of ["js", "python", "json", "Mermaid", ""]) {
      const html = renderToStaticMarkup(<Markdown text={`\`\`\`${lang}\nflowchart LR\n  A --> B\n\`\`\``} />)
      expect(html).not.toContain("data-mermaid")
      expect(html).toContain('<pre class="my-2')
    }
  })

  test(`at most ${MAX_DIAGRAMS} fences draw by themselves; the rest wait for "Draw diagram"`, () => {
    const at = (n: number) => renderToStaticMarkup(<Markdown text={Array.from({ length: n }, (_, i) => fence(i)).join("\n\n")} />)
    expect(at(MAX_DIAGRAMS)).not.toContain("Draw diagram")
    expect(at(MAX_DIAGRAMS + 2).match(/Draw diagram/g)?.length).toBe(2)
  })
})
