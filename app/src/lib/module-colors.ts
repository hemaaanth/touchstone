import type { CSSProperties } from "react"

// One fixed colour per module (pack). Every screen reads this map, so a module
// has the same colour everywhere. The values are theme tokens from
// src/tokens.css (light and dark). No token is near red or green: those two
// belong to proof (docs/restraint.md).
//
// A new pack gets a line here and, if no free token is left, a new
// `--module-*` token in tokens.css. src/lib/module-colors.test.ts fails when a
// pack the server lists has no line, or when two packs share a token.

export const MODULE_TOKENS = [
  "--module-clay",
  "--module-sand",
  "--module-cyan",
  "--module-sky",
  "--module-blue",
  "--module-indigo",
  "--module-iris",
  "--module-violet",
  "--module-purple",
  "--module-orchid",
  "--module-pink",
  "--module-amber",
  "--module-olive",
  "--module-steel",
  "--module-periwinkle",
] as const

export type ModuleToken = (typeof MODULE_TOKENS)[number] | typeof MODULE_FALLBACK_TOKEN

// A module this map does not know (a new pack, a pipeline step) is neutral
// grey. It never borrows another module's colour.
export const MODULE_FALLBACK_TOKEN = "--module-neutral"

// Modules that show together sit far apart on the hue wheel: the three source
// modules, the five host modules, the three offline modules.
export const MODULE_COLOR: Readonly<Record<string, (typeof MODULE_TOKENS)[number]>> = {
  "contracts": "--module-indigo",
  "review": "--module-sand",
  "supply-chain": "--module-clay",
  "web": "--module-cyan",
  "domains": "--module-blue",
  "ai-mcp": "--module-iris",
  "surface": "--module-purple",
  "phishing": "--module-pink",
  "chain-watch": "--module-sky",
  "infra-cloud": "--module-violet",
  "keys": "--module-orchid",
  "host": "--module-amber",
  "crypto": "--module-olive",
  "forensics": "--module-steel",
  "binary": "--module-periwinkle",
}

export function moduleToken(id: string | null | undefined): ModuleToken {
  return (id != null && Object.hasOwn(MODULE_COLOR, id) ? MODULE_COLOR[id] : null) ?? MODULE_FALLBACK_TOKEN
}

// The CSS value for a style prop: `color: moduleColor("web")`.
export function moduleColor(id: string | null | undefined): string {
  return `var(${moduleToken(id)})`
}

// Sets `--module` on an element, so `text-(--module)` and `bg-(--module)/10`
// work on it and below it. For a dot, an icon or a bar in the module's colour.
export function moduleStyle(id: string | null | undefined): CSSProperties {
  return { "--module": moduleColor(id) } as CSSProperties
}

// The modules of one row, in the order of the server's module list. Every
// screen then shows the same module in the same place. An unknown module goes
// last and keeps its place among the unknown ones.
export function orderModules(ids: readonly string[], order: readonly string[]): string[] {
  const at = (id: string) => {
    const i = order.indexOf(id)
    return i === -1 ? order.length : i
  }
  return [...ids].sort((a, b) => at(a) - at(b))
}
