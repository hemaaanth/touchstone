// One small Solidity source scanner, shared by the Halmos and Chimera adapters.
//
// codeOnly(src) gives the source with every comment and the text inside every
// string literal turned into spaces. Newlines and quote marks stay, so offsets
// and line numbers do not move. The scanner walks the source once, so:
//   - a declaration inside a comment or a string is not code;
//   - "/*" or "//" inside a string is not a comment;
//   - a quote inside a comment does not open a string;
//   - a backslash escape inside a string does not close it.
// With { keepStrings: true } only the comments go; the string text stays.
// Use it to read import paths.
//
// Line ends follow solc 0.8 (checked with solc 0.8.38): a "//" comment ends at
// LF, CR (so CR-only and CRLF files work), VT, FF, NEL, LS or PS. The last five
// then fail to compile, but we end the comment there too, as solc does. A plain
// string also ends at any of them (an error in solc). A backslash before CR,
// LF or CRLF inside a string is a line continuation, so the string goes on.
// Blanked text keeps every CR and LF, so line numbers do not move.
const LINE_END = /[\n\r\v\f\u0085\u2028\u2029]/;
const isLineEnd = (ch) => ch !== undefined && LINE_END.test(ch);

export function codeOnly(src, { keepStrings = false } = {}) {
  const s = String(src);
  const n = s.length;
  const out = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out.push(s[k] === "\n" || s[k] === "\r" ? s[k] : " ");
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === "/" && d === "/") {
      let j = i + 2;
      while (j < n && !isLineEnd(s[j])) j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      let j = s.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      // A string ends at its own quote. A line end also ends it (Solidity
      // has no multi-line string), so one bad quote cannot hide the rest of
      // the file. An escaped CRLF is one line continuation.
      let j = i + 1;
      while (j < n && s[j] !== c && !isLineEnd(s[j])) j += s[j] !== "\\" ? 1 : s[j + 1] === "\r" && s[j + 2] === "\n" ? 3 : 2;
      j = Math.min(j, n);
      out.push(c);
      if (keepStrings) out.push(s.slice(i + 1, j));
      else blank(i + 1, j);
      if (j < n && s[j] === c) {
        out.push(c);
        j++;
      }
      i = j;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}
