// Mermaid diagrams in agent text, drawn by Pele (https://pele.run, MIT).
//
// Agent text can carry text from a hostile target, so the diagram source is
// untrusted. The rules here follow Pele's security page:
// - The options are fixed in this file. The diagram source never sets them.
// - No links and no images (an image makes a network request when shown).
// - Pele's default size limits stay (50,000 characters of source, 4,000,000
//   of SVG, 5,000 edges).
// - The SVG that goes into the page is only Pele's output, after
//   `quietColors`. An error is shown as React text, never as HTML.
//
// Pele loads lazily (`pele/lazy`, by a dynamic import), so the first page load
// does not grow. Each diagram type loads on first use.

export type Drawn = { ok: true; svg: string; width: number; height: number } | { ok: false; error: string }

// The fixed render options. Only the app sets fontFamily, maxWidth and idPrefix.
const FIXED = { links: false, images: false, responsive: true, fontSize: 14 } as const

const CACHE_MAX = 64
const cache = new Map<string, Promise<Drawn>>()

// Draws one source at one width. The result is cached, so a streamed snapshot
// that re-renders the same closed block draws it once.
export function drawMermaid(source: string, opts: { maxWidth?: number; fontFamily?: string; fontFamilyMono?: string } = {}): Promise<Drawn> {
  const key = `${opts.maxWidth ?? 0}\n${opts.fontFamily ?? ""}\n${opts.fontFamilyMono ?? ""}\n${source}`
  const hit = cache.get(key)
  if (hit) return hit
  const run = (async (): Promise<Drawn> => {
    try {
      const { renderAsync } = await import("pele/lazy")
      const r = await renderAsync(source, {
        ...FIXED,
        maxWidth: opts.maxWidth && opts.maxWidth > 0 ? opts.maxWidth : undefined,
        fontFamily: opts.fontFamily || undefined,
        fontFamilyMono: opts.fontFamilyMono || undefined,
        // One prefix per source: two different diagrams on a page never share
        // a marker id, and the same diagram twice has the same defs.
        idPrefix: `m${hash(key)}`,
      })
      return { ok: true, svg: quietColors(r.svg), width: r.width, height: r.height }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  })()
  cache.set(key, run)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  return run
}

// One short line for the operator. Pele's message can quote the source; it is
// shown as React text, so that is safe. A parse error has the place on its
// first line and the reason on its last ("Expecting ..."); keep those two.
function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean)
  const first = lines[0] ?? "The diagram could not be drawn."
  const last = lines.length > 1 ? lines[lines.length - 1] : ""
  return (last && !last.startsWith("-") ? `${first} ${last}` : first).slice(0, 200)
}

const COLOR_PROPS = new Set(["fill", "stroke", "color", "stop-color", "flood-color", "lighting-color", "background", "background-color"])
const TOKEN_VALUE = /^\s*(var\(|none\b|transparent\b|currentcolor\b|inherit\b)/i

// A diagram's own `style`, `classDef`, `linkStyle`, `rect <colour>` and
// `box <colour>` set fixed colours. The app shows only its theme tokens (no red,
// no green: app/docs/restraint.md), so those colours are dropped:
// - In a `style` attribute, a colour declaration that is not a `var(...)` goes.
//   Pele keeps its token colour on the element's own attribute
//   (`fill="var(--_s)"`), so the element falls back to it.
// - A colour attribute with a fixed value (an arrowhead coloured by
//   `linkStyle`) becomes the line token.
export function quietColors(svg: string): string {
  return svg
    .replace(/\sstyle="([^"]*)"/g, (_m, body: string) => {
      const kept = body
        .split(";")
        .filter((decl) => {
          const i = decl.indexOf(":")
          if (i < 0) return decl.trim() !== ""
          const prop = decl.slice(0, i).trim().toLowerCase()
          return !COLOR_PROPS.has(prop) || TOKEN_VALUE.test(decl.slice(i + 1))
        })
        .join(";")
      return kept.trim() ? ` style="${kept}"` : ""
    })
    .replace(/\s(fill|stroke|color|stop-color)="([^"]*)"/g, (m, prop: string, value: string) =>
      TOKEN_VALUE.test(value) ? m : ` ${prop}="var(--_l)"`,
    )
}

// True when a fenced block in Markdown has its closing fence. `raw` is the
// block's own text in the source, from the opening fence to the end of the
// block. While the agent streams, an open fence runs to the end of the text.
export function fenceClosed(raw: string): boolean {
  const lines = raw.replace(/\s+$/, "").split("\n")
  if (lines.length < 2) return false
  const open = /^[\s>]*(`{3,}|~{3,})/.exec(lines[0])
  const close = /^[\s>]*(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1])
  return !!open && !!close && close[1][0] === open[1][0] && close[1].length >= open[1].length
}

function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}
