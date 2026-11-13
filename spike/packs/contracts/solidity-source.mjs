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

export function codeOnly(src, { keepStrings = false } = {}) {
  const s = String(src);
  const n = s.length;
  const out = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out.push(s[k] === "\n" ? "\n" : " ");
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === "/" && d === "/") {
      let j = s.indexOf("\n", i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      let j = s.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      // A string ends at its own quote. A plain newline also ends it
      // (Solidity has no multi-line string), so one bad quote cannot hide
      // the rest of the file.
      let j = i + 1;
      while (j < n && s[j] !== c && s[j] !== "\n") j += s[j] === "\\" ? 2 : 1;
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
