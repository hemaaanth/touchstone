import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { drawMermaid, fenceClosed, quietColors } from "@/lib/mermaid"
import { Markdown } from "@/components/markdown"

// The tags of an SVG, without their text. A label's text may say "onload=" as
// escaped text; only an attribute inside a tag can run.
const tags = (svg: string) => svg.match(/<[^>]*>/g) ?? []

// Every fill / stroke / colour in a drawn diagram is a token (var(...)) or none.
function fixedColors(svg: string): string[] {
  const attrs = [...svg.matchAll(/\s(?:fill|stroke|color|stop-color)="([^"]*)"/g)].map((m) => m[1])
  const decls = [...svg.matchAll(/\sstyle="([^"]*)"/g)].flatMap((m) =>
    m[1]
      .split(";")
      .filter((d) => /^\s*(fill|stroke|color|stop-color|background(-color)?)\s*:/i.test(d))
      .map((d) => d.slice(d.indexOf(":") + 1)),
  )
  return [...attrs, ...decls].filter((v) => !/^\s*(var\(|none\b|transparent\b|currentcolor\b)/i.test(v))
}

describe("drawMermaid: a hostile source", () => {
  const hostile: Record<string, string> = {
    "a script tag and an img onerror in labels":
      'flowchart LR\n  A["<script>alert(1)</script>"] --> B["x<img src=x onerror=alert(1)>"]\n  B --> C["<svg onload=alert(1)>"]',
    "click callbacks and links":
      'flowchart LR\n  A --> B\n  click A call alert(1)\n  click B "javascript:alert(1)"\n  click A href "https://evil.example/x" _blank\n  click B callback "tip"',
    "an external image": 'flowchart LR\n  A@{ img: "https://evil.example/a.png", label: "x", pos: "t" } --> B',
    "a sequence diagram with links":
      'sequenceDiagram\n  participant A as <script>x</script>\n  link A: Dashboard @ https://evil.example/d\n  links A: {"Repo": "javascript:alert(1)"}\n  A->>B: <img src=https://evil.example/p.png>',
    "a config that asks for html labels":
      '---\nconfig:\n  securityLevel: loose\n  htmlLabels: true\n  flowchart:\n    htmlLabels: true\n---\nflowchart LR\n  A["<a href=javascript:alert(1)>x</a>"] --> B',
  }
  for (const [name, source] of Object.entries(hostile)) {
    test(name, async () => {
      const r = await drawMermaid(source)
      // Each one either draws, with nothing live in it, or is refused.
      if (!r.ok) {
        expect(r.error.length).toBeGreaterThan(0)
        return
      }
      expect(r.svg.startsWith("<svg")).toBe(true)
      expect(r.svg).not.toMatch(/<script/i)
      expect(tags(r.svg).filter((t) => /\son[a-z]+\s*=/i.test(t))).toEqual([])
      expect(r.svg).not.toMatch(/href/i)
      expect(r.svg).not.toMatch(/<image/i)
      expect(r.svg).not.toMatch(/<foreignObject/i)
      expect(r.svg).not.toMatch(/<a[\s>]/i)
      expect(r.svg).not.toContain("javascript:")
      expect(r.svg).not.toContain("evil.example/a.png")
      expect(r.svg).not.toContain("evil.example/p.png\"")
    })
  }

  test("label markup is dropped or shown as escaped text", async () => {
    const r = await drawMermaid('flowchart LR\n  A["<script>alert(1)</script>"] --> B["<svg onload=alert(1)>"]')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.svg).toContain(">alert(1)</text>")
    expect(r.svg).toContain("&lt;svg onload=alert(1)&gt;")
    expect(tags(r.svg).filter((t) => /onload/i.test(t))).toEqual([])
  })

  test("a huge source is refused by Pele's default limit", async () => {
    const huge = "flowchart LR\n" + Array.from({ length: 9000 }, (_, i) => `  n${i} --> n${i + 1}`).join("\n")
    const r = await drawMermaid(huge)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("limit")
  })

  test("a broken source gives a one-line reason, not a diagram", async () => {
    const r = await drawMermaid("flowchart LR\n  A --> \n  ((( -->")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).not.toContain("\n")
      expect(r.error.length).toBeLessThanOrEqual(200)
    }
  })
})

describe("quietColors: only theme tokens", () => {
  const coloured = {
    flowchart:
      "flowchart LR\n  A --> B\n  style A fill:#ff0000,stroke:#00ff00,color:#f00\n  classDef r fill:red,stroke:green\n  class B r\n  linkStyle 0 stroke:red",
    sequence: "sequenceDiagram\n  box rgb(0,128,0) Team\n  participant A\n  end\n  rect rgb(255,0,0)\n  A->>B: hi\n  end",
    pie: '---\nconfig:\n  themeVariables:\n    pie1: "#ff0000"\n---\npie\n  "a": 3\n  "b": 5',
  }
  for (const [name, source] of Object.entries(coloured)) {
    test(`${name}: a colour the source sets is dropped`, async () => {
      const r = await drawMermaid(source)
      expect(r.ok).toBe(true)
      if (r.ok) expect(fixedColors(r.svg)).toEqual([])
    })
  }

  test("a token colour and other styles stay", () => {
    const out = quietColors('<rect fill="var(--_s)" style="rx:var(--_r);fill:#ff0000;stroke-dasharray:4 4"/><path fill="red"/>')
    expect(out).toBe('<rect fill="var(--_s)" style="rx:var(--_r);stroke-dasharray:4 4"/><path fill="var(--_l)"/>')
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
  test("first paint is the normal code block with the source as text", () => {
    const html = renderToStaticMarkup(
      <Markdown text={'Before.\n\n```mermaid\nflowchart LR\n  A["<b>x</b>"] --> B\n```\n\nAfter.'} />,
    )
    expect(html).toContain("<pre")
    expect(html).toContain("flowchart LR")
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;")
    expect(html).not.toContain("<svg")
    expect(html).toContain("After.")
  })

  test("another language stays a plain code block", () => {
    const html = renderToStaticMarkup(<Markdown text={"```js\nlet a = 1\n```"} />)
    expect(html).toContain('<pre class="my-2')
    expect(html).toContain("let a = 1")
  })
})
