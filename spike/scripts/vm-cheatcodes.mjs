// Print every cheatcode in a vendored forge-std `Vm.sol`: which interface it is
// declared in, its name, its canonical signature (and so its 4-byte selector) and
// the first line of its doc comment.
//
//   node spike/scripts/vm-cheatcodes.mjs [path to Vm.sol]
//
// The harm gate needs a complete, classified table of the cheatcodes it may see
// in a replay, so that an unknown cheatcode cannot pass in silence. This script
// only parses; the classes live in lib/vm-cheatcodes.json and the test
// test/vm-cheatcodes.test.mjs keeps the two in step. That file also carries a
// few newer-forge overloads the pinned file does not declare; see its note.
//
// The canonical signature is what the 4-byte selector is derived from: the name,
// then the parameter types with no names and no spaces. A struct parameter is a
// tuple of its field types (recursively), an enum is `uint8`, `address payable`
// is `address`, and a contract type is `address` (there are none in Vm.sol, but
// a rewritten file may add them). A selector is the first 4 bytes of the
// keccak256 of that string.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toUtf8Bytes } from "ethers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_VM_SOL = resolve(ROOT, "lab/vault-reentrancy/lib/forge-std/src/Vm.sol");

const ELEMENTARY = /^(?:address|bool|bytes\d*|int\d*|uint\d*|string|byte)$/;
const LOCATION = /^(?:calldata|memory|storage)$/;

export const selectorOf = (signature) => keccak256(toUtf8Bytes(signature)).slice(0, 10);

// Struct fields and enum names of one source, in declaration order.
function collectTypes(lines) {
  const structs = new Map();
  const enums = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const struct = /^\s*struct\s+(\w+)\s*\{/.exec(lines[i]);
    if (struct) {
      const fields = [];
      for (let j = i + 1; j < lines.length && !/^\s*\}/.test(lines[j]); j += 1) {
        const field = /^\s*([\w$[\]().]+)\s+\w+\s*;/.exec(lines[j]);
        if (field) fields.push(field[1]);
      }
      structs.set(struct[1], fields);
      continue;
    }
    const enumDecl = /^\s*enum\s+(\w+)\s*\{/.exec(lines[i]);
    if (enumDecl) enums.add(enumDecl[1]);
  }
  return { structs, enums };
}

// One parameter as a type string: the first word is the type, the rest is the
// name. `payable`, `calldata`, `memory` and `storage` are not types.
function paramType(decl, { structs, enums }) {
  const words = decl
    .trim()
    .split(/\s+/)
    .filter((w) => w && !LOCATION.test(w) && w !== "payable");
  if (words.length === 0) throw new Error(`empty parameter in: ${decl}`);
  const [base, ...dims] = words[0].split(/(?=\[)/);
  const suffix = dims.join("");
  let type;
  if (ELEMENTARY.test(base)) type = base;
  else if (enums.has(base)) type = "uint8";
  else if (structs.has(base)) type = `(${structs.get(base).map((f) => paramType(f, { structs, enums })).join(",")})`;
  else type = "address"; // a contract or interface type
  return type + suffix;
}

// Split a parameter list on top-level commas (a struct tuple has none in Vm.sol).
function splitParams(list) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  const tail = list.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// Every function of every interface in the source, in file order.
export function parseVmSol(source) {
  const lines = source.split("\n");
  const types = collectTypes(lines);
  const out = [];
  let iface = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const open = /^\s*interface\s+(\w+)/.exec(line);
    if (!iface) {
      if (open) iface = open[1];
      continue;
    }
    if (/^\}/.test(line)) {
      iface = null;
      continue;
    }
    if (!iface || !/^\s*function\s+/.test(line)) continue;

    // The doc comment directly above: first line of that block.
    let doc = "";
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = /^\s*\/\/\/\s?(.*)$/.exec(lines[j]);
      if (!prev) break;
      doc = prev[1].trim();
    }

    // Join a declaration that wraps over several lines.
    let decl = line;
    while (!/\;\s*$/.test(decl) && i + 1 < lines.length) {
      i += 1;
      decl += " " + lines[i].trim();
    }
    const head = /^\s*function\s+(\w+)\s*\(([^)]*)\)/.exec(decl);
    if (!head) throw new Error(`unparsed declaration: ${decl}`);

    const params = splitParams(head[2]).map((p) => paramType(p, types));
    const signature = `${head[1]}(${params.join(",")})`;
    out.push({ name: head[1], signature, selector: selectorOf(signature), iface, doc });
  }
  return out;
}

export function parseFile(path = DEFAULT_VM_SOL) {
  return parseVmSol(readFileSync(path, "utf8"));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const path = process.argv[2] ?? DEFAULT_VM_SOL;
  const rows = parseFile(path);
  process.stdout.write(`iface\tselector\tsignature\tname\tdoc\n`);
  for (const r of rows) {
    process.stdout.write(`${r.iface}\t${r.selector}\t${r.signature}\t${r.name}\t${r.doc.replace(/\t/g, " ")}\n`);
  }
  process.stderr.write(`${rows.length} functions in ${path}\n`);
}
