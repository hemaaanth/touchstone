// Source checks for the Keys and Chain watch packs. These are our own crypto-gap
// checks over Solidity text. They are pure: text in, leads out. No Docker, no network.
//
// Why they exist. Slither and Aderyn find generic bugs. They do not know that a
// function that changes a proxy implementation must be gated, that an `ecrecover`
// result must be checked against zero, or that a signature needs a nonce and a
// chain id. These checks know. A lead is not a finding. The agent must still prove
// each lead with a Foundry test.
//
// The scan reads each function on its own. It strips comments first, so a word
// inside a comment never counts.

const IMPACT = { High: "High", Medium: "Medium", Low: "Low" };

// ONE pass that neutralizes the file before anything else reads it. Comments and the
// insides of string literals become spaces. Newlines stay, so line numbers stay right. The
// walk is string-aware: a `//` inside a string is not a comment (`"see http://x.io"`), and a `(`
// or a quote inside a comment or a string is not code. Every later step (functions, modifiers,
// paren matching, gates) reads this text, so none of them can be fooled by a string.
export function stripComments(source) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      let end = source.indexOf("\n", i);
      if (end < 0) end = source.length;
      out += " ".repeat(end - i);
      i = end;
    } else if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close < 0 ? source.length : close + 2;
      out += blank(source.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      const closed = source[j] === c;
      out += c + blank(source.slice(i + 1, Math.min(j, source.length))) + (closed ? c : "");
      i = closed ? j + 1 : Math.min(j, source.length);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// Cut a source file into contracts and functions. Returns functions with their
// header (name, parameters, modifiers, visibility) and body.
export function functionsOf(clean) {
  const out = [];
  const contracts = [];
  for (const m of clean.matchAll(/\b(?:abstract\s+)?(contract|library|interface)\s+(\w+)[^{;]*\{/g)) {
    contracts.push({ name: m[2], kind: m[1], at: m.index });
  }
  const re = /\b(function\s+(\w+)|constructor|fallback|receive)\s*\(/g;
  for (const m of clean.matchAll(re)) {
    const open = clean.indexOf("(", m.index);
    const closeParams = matchClose(clean, open, "(", ")");
    if (closeParams < 0) continue;
    // The header runs from the parameters to the first `{` or `;`.
    let i = closeParams + 1;
    while (i < clean.length && clean[i] !== "{" && clean[i] !== ";") i++;
    const header = clean.slice(m.index, i);
    const hasBody = clean[i] === "{";
    const end = hasBody ? matchClose(clean, i, "{", "}") : i;
    if (end < 0) continue;
    const owner = [...contracts].reverse().find((c) => c.at < m.index);
    out.push({
      name: m[2] ?? m[1], contract: owner?.name ?? null, kind: owner?.kind ?? null,
      header, params: clean.slice(open + 1, closeParams), after: clean.slice(closeParams + 1, i),
      body: hasBody ? clean.slice(i + 1, end) : "", hasBody,
      line: lineOf(clean, m.index),
      external: /\b(external|public)\b/.test(header) || m[1] === "fallback" || m[1] === "receive",
      view: /\b(view|pure)\b/.test(header),
    });
  }
  return out;
}

// Contracts of one file: kind, name, the text after the name (`is A, B`), and the body.
function contractsOf(clean) {
  const out = [];
  for (const m of clean.matchAll(/(\babstract\s+)?\b(contract|library|interface)\s+(\w+)([^{;]*)\{/g)) {
    const open = m.index + m[0].length - 1;
    const end = matchClose(clean, open, "{", "}");
    out.push({ name: m[3], kind: m[2], abstract: Boolean(m[1]), heritage: m[4], at: m.index, body: clean.slice(open + 1, end < 0 ? undefined : end) });
  }
  return out;
}

const basesOf = (c) => c.heritage.replace(/^\s*is\s+/, "").replace(/\([^)]*\)/g, "").split(",").map((b) => b.trim().split(/\s+/)[0]).filter(Boolean);

function matchClose(text, from, open, close) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

// A function is gated when a modifier gates it, or its body checks the caller. Three answers:
// "gated", "maybe" and "open".
// - gated: a known gate modifier, a file-local modifier whose body guards on the caller, or a
//   body with a guard statement (`require`, `assert`, `if`) that COMPARES the caller inside
//   its own parenthesised condition.
// - maybe: a modifier or helper the scan cannot read (it may live in a base contract). The
//   gate may be real. A lead on such a function drops to Medium.
// - open: nothing looks like a gate. Mentioning `msg.sender` is not a gate: emitting it,
//   storing it, or passing it to `transferFrom` checks nothing. `tx.origin` is never a gate.
const GATE_MODIFIERS = new Set(["onlyOwner", "onlyAdmin", "onlyRole", "onlyProxy", "onlyGovernance", "onlyGuardian", "onlyOperator", "onlyAuthorized", "requiresAuth", "auth", "authorized", "whenNotInitialized", "initializer", "reinitializer", "ifAdmin", "onlyDelegateCall"]);
const GATE_BODY = /\b(_checkOwner\s*\(|_checkRole\s*\(|_authorizeUpgrade\s*\(|_requireOwner|_onlyOwner)/;
const CALLER = "(?:msg\\.sender|_msgSender\\s*\\(\\s*\\))";
const ROLE_CALL = "(?:hasRole|isOwner|isAdmin|isAuthorized|isOperator|isGuardian|isGovernor|isMinter|isSigner|hasAccess|canCall|checkRole|checkOwner)";
// Role helpers that take the caller. `_isOwner(msg.sender)` counts: a leading underscore is allowed.
const ROLE_RE = new RegExp(`(?<![A-Za-z0-9])_*${ROLE_CALL}\\s*\\(`, "g");
// Not an auth target: comparing the caller to zero or to `tx.origin` proves nothing.
const NOT_AUTH_TARGET = /^(?:tx\.origin|address\(0(?:x0*)?\))$/;
const LOOSE_COMPARE = /\b(?:hasRole|isOwner|isAuthorized)\s*\(/;
const HELPER_CALL = /\b_(?:check|only|require|enforce|ensure|auth|validate|assert)\w*\s*\(/;
const NOT_GATES = new Set(["external", "public", "internal", "private", "view", "pure", "payable", "virtual", "override", "returns", "nonReentrant", "whenNotPaused", "whenPaused", "noDelegateCall", "lock"]);
const ARGS = "\\((?:[^()]|\\([^()]*\\))*\\)";

// How one condition tests the caller: { pos, neg } or null. Counts only a real auth test:
// the caller compared (`==`, `!=`) to something that is not zero or `tx.origin`, the caller
// looked up as the WHOLE condition (`admins[msg.sender]`, `!blocked[msg.sender]`), or the caller
// handed to a role helper. `lastm[msg.sender] > 0` or `msg.sender != address(0)` are not tests.
function callerTests(cond) {
  const c = cond.replace(/_msgSender\s*\(\s*\)/g, "msg.sender").replace(/(?<![\w$])\(\s*msg\.sender\s*\)/g, "msg.sender");
  const out = { pos: false, neg: false };
  const note = (op, other) => {
    if (NOT_AUTH_TARGET.test(other.replace(/\s+/g, ""))) return;
    if (op === "!=") out.neg = true; else out.pos = true;
  };
  const side = "([\\w.$]+(?:\\s*\\([^()]*\\))?)";
  for (const m of c.matchAll(new RegExp(`msg\\.sender\\s*([=!]=)\\s*${side}`, "g"))) note(m[1], m[2]);
  for (const m of c.matchAll(new RegExp(`${side}\\s*([=!]=)\\s*msg\\.sender`, "g"))) note(m[2], m[1]);
  const lookup = c.trim().match(/^(!?)\s*[\w.$]+(?:\[[^\[\]]*\])*\[\s*msg\.sender\s*\]\s*(?:==\s*true)?$/);
  if (lookup) { if (lookup[1]) out.neg = true; else out.pos = true; }
  for (const m of c.matchAll(ROLE_RE)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(c, open, "(", ")");
    if (!/msg\.sender/.test(c.slice(open + 1, close < 0 ? undefined : close))) continue;
    if (c.slice(0, m.index).trimEnd().endsWith("!")) out.neg = true; else out.pos = true;
  }
  return out.pos || out.neg ? out : null;
}

// The text before the first top-level comma: `require(cond, "message")` has the condition first.
function firstArg(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if ("([{".includes(text[i])) depth++;
    else if (")]}".includes(text[i])) depth--;
    else if (text[i] === "," && depth === 0) return text.slice(0, i);
  }
  return text;
}

// ---- A small statement reader, so a gate is judged by control flow, not by where words appear.
// The text is already neutral (see stripComments). `statements(body)` returns the top-level
// statements of one body in order. `unchecked { ... }` is read as if its inside were top level.
// Each statement is { type, text, end } plus: a "guard" (`require`, `assert`) has `cond`; an
// "if" has `cond`, `then` and `else` (the text of each branch, `else` is null when absent).
const BLOCK_WORDS = new Set(["unchecked", "do", "else", "assembly", "try", "catch"]);

function readBranch(body, from) {
  let i = from;
  while (i < body.length && /\s/.test(body[i])) i++;
  if (body[i] === "{") {
    const close = matchClose(body, i, "{", "}");
    return close < 0 ? { text: body.slice(i + 1), end: body.length } : { text: body.slice(i + 1, close), end: close + 1 };
  }
  const st = readStatement(body, i);
  return { text: body.slice(i, st.end), end: st.end };
}

function readStatement(body, i) {
  const head = body.slice(i).match(/^(if|require|assert)\s*\(/);
  if (head) {
    const open = i + head[0].length - 1;
    const close = matchClose(body, open, "(", ")");
    if (close < 0) return { type: "other", text: body.slice(i), end: body.length };
    const cond = body.slice(open + 1, close);
    if (head[1] !== "if") {
      const semi = body.indexOf(";", close);
      const end = semi < 0 ? body.length : semi + 1;
      return { type: "guard", cond, text: body.slice(i, end), end };
    }
    const then = readBranch(body, close + 1);
    let end = then.end;
    let other = null;
    const after = body.slice(end).match(/^\s*else\b/);
    if (after) {
      other = readBranch(body, end + after[0].length);
      end = other.end;
    }
    return { type: "if", cond, then: then.text, else: other ? other.text : null, text: body.slice(i, end), end };
  }
  let depth = 0;
  for (let j = i; j < body.length; j++) {
    const c = body[j];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) return { type: "other", text: body.slice(i, j + 1), end: j + 1 };
    else if (c === "{" && depth === 0) {
      const word = body.slice(i, j).match(/([A-Za-z_]\w*)\s*$/)?.[1];
      const options = word && !BLOCK_WORDS.has(word) && /[.\w]\s*$/.test(body.slice(i, j)); // call{value: v}(...) or new C{salt: s}()
      if (options) continue;
      const close = matchClose(body, j, "{", "}");
      const end = close < 0 ? body.length : close + 1;
      return { type: /^unchecked\b/.test(body.slice(i)) ? "unchecked" : "other", text: body.slice(i, end), inner: body.slice(j + 1, close < 0 ? undefined : close), end };
    }
  }
  return { type: "other", text: body.slice(i), end: body.length };
}

function statements(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    const st = readStatement(body, i);
    if (st.type === "unchecked") out.push(...statements(st.inner));
    else out.push(st);
    i = Math.max(st.end, i + 1);
  }
  return out;
}

// A local declaration (`bool z = ...`, `S storage s = ...`) is not a state write.
const LOCAL_DECL = /^(?:address(?:\s+payable)?|bool|string|bytes\d*|u?int\d*|[A-Z][\w.]*)(?:\[\d*\])*\s+(?:(?:memory|storage|calldata)\s+)?[A-Za-z_]\w*\s*(?:=|;)/;
const BARE_CALL = /^(?!emit\b|revert\b|return\b|require\b|assert\b|_\s*;)[A-Za-z_$][\w$.]*\s*(?:\{[^{}]*\})?\s*\(/;
// Does a statement change state? Unsure counts as yes: a missed write would hide a gap, and a
// wrongly counted write only keeps a lead alive.
function writesState(st) {
  if (st.type === "guard") return false;
  if (st.type === "if") return statements(st.then).some(writesState) || (st.else ? statements(st.else).some(writesState) : false);
  const text = st.text.trim();
  if (st.inner !== undefined) return statements(st.inner).some(writesState);
  if (LOCAL_DECL.test(text) && !/\.(?:call|delegatecall|transfer|send)\b/.test(text)) return false;
  return /(?<![=!<>])=(?![=>])|\bdelete\b|\+\+|--|\.(?:call|delegatecall|transfer|send)\b|\b(?:selfdestruct|sstore)\s*\(/.test(text) || BARE_CALL.test(text);
}

// True when a guard DOMINATES the work: the call cannot get past it without passing the test.
// - `require` / `assert` at top level: a failed test reverts, and a revert undoes any write
//   made before it, so position does not matter. One nested in a branch is not a gate.
// - a top-level `if` whose branch reverts is the same. A branch that only `return`s (after a
//   negative test) is a gate only when no write ran before it: the write would stay.
// - a positive test (`if (msg.sender == owner) { ... }`) is a gate only when every state write
//   of the body sits inside that block, or the other branch reverts. A write before or after
//   the block is not gated by it.
function guardsCaller(text) {
  const sts = statements(text);
  for (let k = 0; k < sts.length; k++) {
    const st = sts[k];
    if (st.type !== "guard" && st.type !== "if") continue;
    const tests = callerTests(firstArg(st.cond));
    if (!tests) continue;
    if (st.type === "guard") return true;
    if (/\brevert\b|\bthrow\b/.test(st.then)) return true;
    if (tests.neg && /\breturn\b/.test(st.then) && !sts.slice(0, k).some(writesState)) return true;
    if (tests.pos && st.else && /^\s*revert\b/.test(st.else)) return true;
    if (tests.pos && !sts.some((other, j) => j !== k && writesState(other))) return true;
  }
  return false;
}

// Modifiers written in this file, by name, with their bodies.
function localModifiers(clean) {
  const out = new Map();
  for (const m of clean.matchAll(/\bmodifier\s+(\w+)\s*(?:\([^)]*\))?[^{;]*\{/g)) {
    const open = m.index + m[0].length - 1;
    const end = matchClose(clean, open, "{", "}");
    out.set(m[1], clean.slice(open + 1, end < 0 ? undefined : end));
  }
  return out;
}

function modifierNames(fn) {
  const rest = (fn.after ?? "").replace(new RegExp(`\\b(?:returns|override)\\s*${ARGS}`, "g"), " ");
  return [...rest.matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\s*(?:${ARGS})?`, "g"))].map((m) => m[1]);
}

// `mods` is the map from localModifiers(). Modifiers are read from the text after the
// parameters, so a parameter named `auth` is not a gate.
function gateOf(fn, mods = new Map()) {
  const names = modifierNames(fn);
  if (names.some((name) => GATE_MODIFIERS.has(name)) || GATE_BODY.test(fn.body) || guardsCaller(fn.body)) return "gated";
  let maybe = HELPER_CALL.test(fn.body) || LOOSE_COMPARE.test(fn.body);
  for (const name of names) {
    if (NOT_GATES.has(name)) continue;
    if (!mods.has(name)) { maybe = true; continue; }
    const body = mods.get(name);
    if (guardsCaller(body) || GATE_BODY.test(body) || HELPER_CALL.test(body)) return "gated";
  }
  return maybe ? "maybe" : "open";
}
const gated = (fn, mods) => gateOf(fn, mods) === "gated";

// Impact of an "ungated" lead, or null when the function is gated. Unknown gates give Medium.
function ungatedImpact(fn, mods) {
  const gate = gateOf(fn, mods);
  return gate === "gated" ? null : gate === "maybe" ? "Medium" : "High";
}
const MAYBE_NOTE = " It has a modifier or helper this scan could not read, so a gate may exist. Read it first.";

const CONTROL_NAMES = /^(upgradeTo|upgradeToAndCall|setImplementation|upgrade|changeAdmin|setAdmin|transferOwnership|setOwner|addOwner|addOwnerWithThreshold|removeOwner|swapOwner|changeThreshold|enableModule|disableModule|setGuard|setFallbackHandler|grantRole|revokeRole|setThreshold|setSigner|setTrustedSigner|setMinter|setOperator)$/;
// A function writes the proxy implementation when it stores to a slot that the code names
// "implementation", assigns a state variable named `implementation`, or sets an
// OpenZeppelin slot value. A member write counts too (`$.implementation = n` in ERC-7201
// namespaced storage). A local variable or a parameter of that name is not a write.
function writesImplementation(fn) {
  const text = `${fn.header}\n${fn.body}`;
  if (/\bsstore\s*\(/.test(text) && /implementation/i.test(text)) return true;
  if (/StorageSlot\.getAddressSlot\([^)]*\)\.value\s*=(?!=)/.test(text)) return true;
  for (const m of text.matchAll(/(?<!\w)(_?implementation)\s*=(?!=)\s*\w/g)) {
    if (/\b(address|payable|memory|storage|calldata|bytes32|bytes|uint\d*|bool|I[A-Z]\w*)\s*$/.test(text.slice(0, m.index))) continue; // a local declaration
    if (new RegExp(`\\b\\w+\\s+(?:payable\\s+|memory\\s+|calldata\\s+)?${m[1]}\\b`).test(fn.params)) continue; // a parameter
    return true;
  }
  return false;
}

const lead = (fn, file, check, impact, description, extra = {}) => ({
  engine: "Touchstone source", check, impact: IMPACT[impact] ?? impact,
  where: `${fn.contract ? fn.contract + "." : ""}${fn.name}`, file, lines: [fn.line],
  description, ...extra,
});

// One file in, leads out. `file` is the path shown to the agent.
export function scanSource(file, source) {
  const clean = stripComments(source);
  const leads = [];
  const fns = functionsOf(clean);
  const fileHas = (re) => re.test(clean);
  const mods = localModifiers(clean);

  for (const fn of fns) {
    if (!fn.hasBody || fn.kind === "interface") continue;
    const text = `${fn.header}\n${fn.body}`;

    // --- signatures
    const usesEcrecover = /\becrecover\s*\(/.test(fn.body);
    const usesLibraryRecover = /\b(ECDSA\.recover|ECDSA\.tryRecover|SignatureChecker\.|\.recover\s*\()/.test(fn.body);
    if (usesEcrecover) {
      if (!/\b(address\s*\(\s*0\s*\)|ZeroAddress|!=\s*address\(0\))/.test(fn.body)) {
        leads.push(lead(fn, file, "ecrecover-zero-address", "High",
          `\`${fn.name}\` calls \`ecrecover\` and never checks that the result is not \`address(0)\`. A bad signature returns \`address(0)\`. If the expected signer is unset or zero, any junk signature passes.`));
      }
      if (!/0x7[fF]{7}5[dD]576[eE]7357[aA]4501[dD][dD][fF][eE]92[fF]46681[bB]20[aA]0|\bs\s*(<=|<)|\buint256\(\s*s\s*\)\s*(<=|<)/.test(fn.body) && !usesLibraryRecover) {
        leads.push(lead(fn, file, "signature-malleability", "Medium",
          `\`${fn.name}\` calls \`ecrecover\` with no upper bound on \`s\`. Each signature has a second valid form \`(s', v')\`. A signature hash used as a unique id can be replayed in its twin form.`));
      }
    }
    if (usesEcrecover || usesLibraryRecover) {
      const nonce = /\bnonces?\b|\bused(Signatures|Hashes|Digests)?\b|\bexecuted\b|\bconsumed\b/i.test(text) || fileHas(/\bmapping\s*\([^)]*\)\s*(public|private|internal)?\s*(nonces?|used\w*|executed\w*|consumed\w*)\b/);
      const domain = /\b(chainid|block\.chainid|DOMAIN_SEPARATOR|_domainSeparator|_hashTypedDataV4|EIP712|eip712Domain)\b/i.test(text) || fileHas(/\bEIP712\b|\bDOMAIN_SEPARATOR\b|\bblock\.chainid\b/);
      if (!nonce) {
        leads.push(lead(fn, file, "signature-replay-no-nonce", "High",
          `\`${fn.name}\` checks a signature but no nonce or used-hash record is tied to it. The same signature can be sent again and again.`));
      }
      if (!domain) {
        leads.push(lead(fn, file, "signature-no-domain", "Medium",
          `\`${fn.name}\` checks a signature but the signed data has no chain id, contract address or EIP-712 domain. The signature can be replayed on another chain or another contract.`));
      }
    }

    // --- caller checks
    if (/\btx\.origin\s*(==|!=)|require\s*\(\s*tx\.origin\b/.test(fn.body)) {
      leads.push(lead(fn, file, "tx-origin-auth", "High",
        `\`${fn.name}\` trusts \`tx.origin\`. A contract the owner calls can pass this check. Use \`msg.sender\`.`));
    }

    // --- control functions with no gate
    const open = fn.external && !fn.view ? ungatedImpact(fn, mods) : null;
    if (open) {
      const note = open === "High" ? "" : MAYBE_NOTE;
      if (CONTROL_NAMES.test(fn.name)) {
        leads.push(lead(fn, file, "unprotected-control-function", open,
          `\`${fn.name}\` changes who controls the contract (owner, admin, implementation, role or Safe setting). It has no access modifier and does not check \`msg.sender\`. Any caller may run it.${note}`));
      } else if (writesImplementation(fn)) {
        leads.push(lead(fn, file, "unprotected-implementation-write", open,
          `\`${fn.name}\` writes the proxy implementation and has no access check. Any caller can swap the logic of the proxy.${note}`));
      }
      if (/\bexecTransactionFromModule(ReturnData)?\s*\(/.test(fn.body)) {
        leads.push(lead(fn, file, "module-no-access-control", open,
          `\`${fn.name}\` makes the Safe spend through \`execTransactionFromModule\` and does not check the caller. Once this module is enabled, any caller moves the Safe funds with no owner signature.${note}`));
      }
    }

    // --- silent state change: the implementation slot is written but an event is not always emitted
    if (fn.external && writesImplementation(fn)) {
      const emits = [...fn.body.matchAll(/\bemit\s+\w+/g)];
      const conditional = emits.length && /\bif\s*\([^)]*\)\s*\{?\s*emit\b/.test(fn.body);
      if (!emits.length || conditional) {
        leads.push(lead(fn, file, "silent-upgrade-path", "Medium",
          `\`${fn.name}\` changes the implementation slot ${emits.length ? "but emits the upgrade event only on one path" : "and emits no event"}. A monitor that reads only events misses this change. Watch the storage slot.`));
      }
    }

    // --- UUPS and initializers
    // An empty body is safe when the header carries the gate: `internal override onlyOwner {}`.
    if (fn.name === "_authorizeUpgrade" && fn.hasBody && fn.body.trim() === "") {
      const impact = ungatedImpact(fn, mods);
      if (impact) leads.push(lead(fn, file, "uups-authorize-empty", impact,
        `\`_authorizeUpgrade\` has an empty body and no access modifier. Anyone can upgrade this UUPS proxy.${impact === "High" ? "" : MAYBE_NOTE}`));
    }
    if (/^(initialize|init|__init)\w*$/.test(fn.name) && fn.external && !/\b(initializer|reinitializer|onlyInitializing)\b/.test(fn.header)
        && !/\b(initialized|_initialized|inited)\b/.test(fn.body)) {
      leads.push(lead(fn, file, "initializer-unprotected", "High",
        `\`${fn.name}\` is public, has no \`initializer\` modifier and sets no initialized flag. Anyone can call it and take ownership, again and again.`));
    }

    // --- dangerous primitives
    if (fn.external && /\.delegatecall\s*\(/.test(fn.body) && /\baddress\b/.test(fn.params) && !gated(fn, mods)) {
      leads.push(lead(fn, file, "delegatecall-user-target", "High",
        `\`${fn.name}\` runs \`delegatecall\` to an address the caller can pick. That code runs with this contract's storage and funds.`));
    }
    if (/\bselfdestruct\s*\(/.test(fn.body) && fn.external && !gated(fn, mods)) {
      leads.push(lead(fn, file, "unprotected-selfdestruct", "High",
        `\`${fn.name}\` can run \`selfdestruct\` and has no access check.`));
    }
  }

  // UUPS implementation that leaves its initializer open. Search the contract's own body and
  // its file-local base contracts. A later contract in the same file never counts.
  const contracts = contractsOf(clean);
  const byName = new Map(contracts.map((c) => [c.name, c]));
  const reach = (c, seen = new Set()) => {
    if (!c || seen.has(c.name)) return "";
    seen.add(c.name);
    return c.body + "\n" + basesOf(c).map((name) => reach(byName.get(name), seen)).join("\n");
  };
  for (const c of contracts) {
    if (c.kind !== "contract" || c.abstract || !/\bUUPSUpgradeable\b/.test(c.heritage)) continue;
    if (/\b_disableInitializers\s*\(/.test(reach(c))) continue;
    leads.push({ engine: "Touchstone source", check: "implementation-initializable", impact: "Medium",
      where: c.name, file, lines: [lineOf(clean, c.at)],
      description: `\`${c.name}\` is an upgradeable implementation and never calls \`_disableInitializers()\`. Anyone can initialize the bare implementation.` });
  }

  // A private key in source. 32 bytes of hex bound to a key-like name, or a known test key.
  for (const m of clean.matchAll(/\b(\w*(?:private|priv|secret|signer)\w*key\w*|\w*PRIVATE_KEY\w*|\w*pk)\b[^;=]*=\s*(0x[0-9a-fA-F]{64})\b/gi)) {
    leads.push({ engine: "Touchstone source", check: "hardcoded-private-key", impact: "High",
      where: m[1], file, lines: [lineOf(clean, m.index)],
      description: `\`${m[1]}\` is set to a 32-byte hex literal (${m[2].slice(0, 6)}…redacted). If it is a real key, anyone who reads the source owns the account.` });
  }
  return leads;
}

// Many files in, one ranked list out. `files` is [{ path, content }].
export function scanSources(files) {
  const rank = { High: 0, Medium: 1, Low: 2 };
  return files.flatMap((f) => scanSource(f.path, f.content))
    .sort((a, b) => (rank[a.impact] ?? 9) - (rank[b.impact] ?? 9) || String(a.file).localeCompare(String(b.file)) || (a.lines[0] ?? 0) - (b.lines[0] ?? 0));
}
