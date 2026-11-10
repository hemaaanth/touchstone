// A small, dependency-free syntax tokenizer. It splits a code snippet into a
// handful of token classes — comment, string, number, keyword, type, plain —
// which the renderer colours with theme variables (see .syntax-* in index.css).
//
// This is deliberately a lexer, not a parser: it recognises the lexical shapes
// every C-family language shares (// and /* */ comments, quoted strings, number
// literals, identifiers) and then classifies identifiers against a per-language
// keyword set. That is enough to read code at a glance while keeping the muted,
// red/green-free palette the rest of the app holds to — and it never pulls a
// highlighter's own colour theme in to fight ours. The engine tells us the
// language by starting its fence with ```solidity / ```ts / … .
export type TokenClass = "comment" | "string" | "number" | "keyword" | "type" | "text"
export type Token = { cls: TokenClass; value: string }

type Lang = "solidity" | "js" | null

// Which keyword/type table (if any) to apply. Unknown languages still get
// comment / string / number colouring from the shared lexer below.
function langKey(lang: string | null): Lang {
  if (!lang) return null
  const l = lang.toLowerCase()
  if (l === "solidity" || l === "sol") return "solidity"
  if (["js", "jsx", "javascript", "mjs", "cjs", "ts", "tsx", "typescript"].includes(l)) return "js"
  return null
}

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

const KEYWORDS: Record<Exclude<Lang, null>, Set<string>> = {
  solidity: set(`
    pragma solidity import using is contract interface library abstract function
    modifier constructor event error enum struct mapping returns return if else
    for while do break continue new delete emit require revert assert try catch
    assembly unchecked public private external internal view pure payable virtual
    override constant immutable memory storage calldata indexed anonymous receive
    fallback this super true false wei gwei ether seconds minutes hours days weeks
  `),
  js: set(`
    const let var function return if else for while do break continue new delete
    this super class extends import export from default as async await yield try
    catch finally throw typeof instanceof in of void null undefined true false
    switch case interface type enum implements namespace declare public private
    protected readonly static abstract get set keyof infer satisfies
  `),
}

const TYPES: Record<Exclude<Lang, null>, Set<string>> = {
  solidity: set(`
    address bool string bytes byte uint int uint8 uint16 uint32 uint64 uint128
    uint256 int8 int16 int32 int64 int128 int256 bytes1 bytes4 bytes8 bytes16
    bytes32 msg block tx abi
  `),
  js: set(`
    string number boolean bigint symbol object unknown any never void Array
    Promise Record Map Set Partial Readonly ReturnType Awaited
  `),
}

// Order matters: comments and strings are matched before identifiers so that
// keyword-looking words inside them are not recoloured.
const LEX = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)/g

export function tokenize(code: string, lang: string | null): Token[] {
  const key = langKey(lang)
  const kw = key ? KEYWORDS[key] : null
  const ty = key ? TYPES[key] : null
  const toks: Token[] = []
  let last = 0
  let m: RegExpExecArray | null
  LEX.lastIndex = 0
  while ((m = LEX.exec(code)) !== null) {
    if (m.index > last) toks.push({ cls: "text", value: code.slice(last, m.index) })
    if (m[1] != null) toks.push({ cls: "comment", value: m[1] })
    else if (m[2] != null) toks.push({ cls: "string", value: m[2] })
    else if (m[3] != null) toks.push({ cls: "number", value: m[3] })
    else {
      const id = m[4]
      const cls: TokenClass = kw && kw.has(id) ? "keyword" : ty && ty.has(id) ? "type" : "text"
      toks.push({ cls, value: id })
    }
    last = m.index + m[0].length
  }
  if (last < code.length) toks.push({ cls: "text", value: code.slice(last) })
  return toks
}
