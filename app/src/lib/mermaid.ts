// Mermaid diagrams in agent text, drawn by Pele (https://pele.run, MIT).
//
// Agent text can carry text from a hostile target, so the diagram source is
// untrusted. The rules here follow Pele's security page, and one more:
// - The options are fixed in this file. The diagram source never sets them.
// - No links and no images (an image makes a network request when shown).
//   No math and no icons (no resolver is given).
// - Pele's default size limits stay (50,000 characters of source, 4,000,000
//   of SVG, 5,000 edges).
// - Pele's SVG goes through one allow-list pass (lib/svg-allow.ts) before the
//   page sees it. Only that pass's output reaches `dangerouslySetInnerHTML`.
//   When the pass leaves nothing, the source shows as code.
// - An error is shown as React text, never as HTML.
//
// Pele loads lazily (`pele/lazy`, by a dynamic import), so the first page load
// does not grow. Each diagram type loads on first use.
import { allowSvg, type SvgNode } from "@/lib/svg-allow"

export type Drawn =
  | { ok: true; svg: string; width: number; height: number; type: string }
  | { ok: false; error: string }

export type DrawOptions = {
  maxWidth?: number
  fontFamily?: string
  fontFamilyMono?: string
  // Tests only: bun has no DOMParser, and a failed chunk load is faked. The
  // page always uses the browser's DOMParser and the real lazy import.
  parse?: (svg: string) => SvgNode | null
  load?: () => Promise<RenderAsync>
}

type RenderAsync = (typeof import("pele/lazy"))["renderAsync"]

// The direct `const { renderAsync } = await import(…)` form lets the bundler
// keep only what is used in Pele's lazy chunk (36.8 kB, not 50 kB).
async function loadPele(): Promise<RenderAsync> {
  const { renderAsync } = await import("pele/lazy")
  return renderAsync
}

// The fixed render options. Only the app sets fontFamily, maxWidth and idPrefix.
const FIXED = { links: false, images: false, responsive: true, fontSize: 14 } as const

// The exact options Pele gets for one source. Exported for the tests, which
// compare the pass's output with Pele's own.
export function peleOptions(source: string, opts: DrawOptions = {}) {
  return {
    ...FIXED,
    maxWidth: opts.maxWidth && opts.maxWidth > 0 ? opts.maxWidth : undefined,
    fontFamily: opts.fontFamily || undefined,
    fontFamilyMono: opts.fontFamilyMono || undefined,
    // One prefix per source: two different diagrams on a page never share an
    // id, and the same diagram twice has the same ids.
    idPrefix: `m${hash(cacheKey(source, opts))}`,
  }
}

const cacheKey = (source: string, opts: DrawOptions) =>
  `${opts.maxWidth ?? 0}\n${opts.fontFamily ?? ""}\n${opts.fontFamilyMono ?? ""}\n${source}`

const CACHE_MAX = 64
const cache = new Map<string, Promise<Drawn>>()

// Draws one source at one width. The result is cached, so a streamed snapshot
// that re-renders the same closed block draws it once. A failure that is not
// the source's fault (a chunk that did not load) is not kept, so the next try
// loads again.
export function drawMermaid(source: string, opts: DrawOptions = {}): Promise<Drawn> {
  const key = cacheKey(source, opts)
  const hit = cache.get(key)
  if (hit) return hit
  let run: Promise<Drawn> | null = null
  run = (async (): Promise<Drawn> => {
    try {
      const renderAsync = await (opts.load ?? loadPele)()
      const r = await renderAsync(source, peleOptions(source, opts))
      const svg = allowSvg(r.svg, opts.parse)
      if (!svg) return { ok: false, error: "This diagram has nothing this view can draw safely." }
      return { ok: true, svg, width: r.width, height: r.height, type: r.type }
    } catch (err) {
      // A PeleError is the source's own fault (syntax, a limit) and stays
      // cached. Anything else (a chunk that did not load) is tried again.
      // The name is read rather than `instanceof`, so the lazy chunk keeps
      // only what it uses.
      const sourceFault = err instanceof Error && err.name === "PeleError"
      if (!sourceFault && cache.get(key) === run) cache.delete(key)
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
