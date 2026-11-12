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

// Replace comments with spaces. Keep newlines so line numbers stay right.
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
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

// A function is gated when its header carries an access modifier, or its body checks
// the caller. Three answers: "gated", "maybe" and "open".
// - gated: a known gate word, a file-local modifier that reads `msg.sender`, or a body that
//   puts `msg.sender` inside a `require`, `assert` or `if`.
// - maybe: a modifier or helper the scan cannot read (it may live in a base contract). The
//   gate may be real. A lead on such a function drops to Medium.
// - open: nothing looks like a gate.
const GATE_MODIFIER = /\b(onlyOwner|onlyAdmin|onlyRole|onlyProxy|onlyGovernance|onlyGuardian|onlyOperator|onlyAuthorized|requiresAuth|auth|authorized|whenNotInitialized|initializer|reinitializer|ifAdmin|onlyDelegateCall)\b/;
const GATE_BODY = /\b(msg\.sender\s*(==|!=)|_msgSender\(\)\s*(==|!=)|_checkOwner\s*\(|_checkRole\s*\(|_authorizeUpgrade\s*\(|hasRole\s*\(|isOwner\s*\(|isAuthorized\s*\(|_requireOwner|_onlyOwner|require\s*\(\s*owner\s*==)/;
const SENDER_CHECK = /\b(require|assert|if)\s*\([^;{]*?\b(msg\.sender|_msgSender\s*\(\s*\))/;
const CALLER_WORDS = /\b(msg\.sender|_msgSender\s*\(\s*\)|tx\.origin)\b/;
const HELPER_CALL = /\b_(?:check|only|require|enforce|ensure|auth|validate|assert)\w*\s*\(/;
const NOT_GATES = new Set(["external", "public", "internal", "private", "view", "pure", "payable", "virtual", "override", "returns", "nonReentrant", "whenNotPaused", "whenPaused", "noDelegateCall", "lock"]);

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
  const rest = (fn.after ?? "").replace(/\breturns\s*\([^)]*\)/g, " ").replace(/\boverride\s*\([^)]*\)/g, " ");
  return [...rest.matchAll(/\b([A-Za-z_]\w*)\s*(?:\([^)]*\))?/g)].map((m) => m[1]);
}

// `mods` is the map from localModifiers(). Without it only the word lists and the body count.
function gateOf(fn, mods = new Map()) {
  if (GATE_MODIFIER.test(fn.header) || GATE_BODY.test(fn.body) || SENDER_CHECK.test(fn.body)) return "gated";
  let maybe = HELPER_CALL.test(fn.body);
  for (const name of modifierNames(fn)) {
    if (NOT_GATES.has(name)) continue;
    if (!mods.has(name)) { maybe = true; continue; }
    const body = mods.get(name);
    if (CALLER_WORDS.test(body) || GATE_BODY.test(body) || HELPER_CALL.test(body)) return "gated";
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
// OpenZeppelin slot value. A local variable or a parameter of that name is not a write.
function writesImplementation(fn) {
  const text = `${fn.header}\n${fn.body}`;
  if (/\bsstore\s*\(/.test(text) && /implementation/i.test(text)) return true;
  if (/StorageSlot\.getAddressSlot\([^)]*\)\.value\s*=(?!=)/.test(text)) return true;
  for (const m of text.matchAll(/(?<![\w.])(_?implementation)\s*=(?!=)\s*\w/g)) {
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
