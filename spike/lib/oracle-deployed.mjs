// The `deployed` oracle: harm to a contract that already exists on a real chain.
//
// WHY THIS IS A SEPARATE ORACLE. Every other channel in lib/proof.mjs starts from
// the same premise: the victim is a contract the TEST deployed from source we can
// read (`scanTargets`: a CREATE whose init code matches a compiled scope artifact).
// That premise is what makes the offline gate close to unforgeable — the test
// builds the victim, so there is nothing real to lie about — and it is also what
// makes it blind to the case that matters most: a protocol that is already deployed,
// with (a) no source in the repo, and (b) live state the test cannot `new` up.
//
// Measured 2026-11-14: 901 of 901 incident reproductions in the DeFiHackLabs corpus
// fork a real chain and attack a real address. An offline gate scores zero on that
// corpus, by construction.
//
// THE FORGERY THIS MUST CLOSE. The moment a victim is a pinned address instead of
// something the test built, the test can fake harm in ways the old gate never had
// to consider:
//   - `vm.etch` code at the address, or `vm.deal` it ETH, then "drain" it;
//   - `vm.store` the balance slot, then withdraw it;
//   - `vm.mockCall` the address so it answers whatever the test wants;
//   - `vm.prank` AS the address, so the test moves its funds as itself.
// All four are already recorded by extractControlTrace, and this oracle refuses a
// pinned target with any of them, exactly as judgeHarm does for a scope target.
//
// THE SECOND FORGERY, WHICH THE OLD GATE DID NOT NEED. On a fork, an address can
// look real and be fabricated: a test can deploy its OWN contract at a chosen
// address with `vm.etch`, or `deployCodeTo`. So a pinned address is only a victim
// when the test did NOT create code there. `createdByTest` closes that: the replay
// must not have a CREATE/CREATE2 whose result is the pinned address.
//
// WHAT IT CANNOT CATCH, stated so nobody has to discover it later:
//   - a victim the test never touched but which lost value because of a THIRD
//     contract's actions (the loss table is per-address from the trace; a
//     multi-hop loss where the pinned contract is not the payer is invisible);
//   - a lock or an insolvency with no transfer at all (that is what the separate
//     `insolvent` channel would be for, and it does not exist yet);
//   - a loss the fork cannot see because the pin was chosen before the vulnerable
//     code was deployed (the operator's pin, not our judgement).
// The same lower-casing every gate in lib/proof.mjs uses. Kept local so this module
// has no dependency on proof.mjs, which imports it.
const lc = (v) => String(v ?? "").toLowerCase();

// The addresses a fork is told to treat as victims: the operator's pinned list.
// Returns null when this run has no pin, which is how every offline run stays on
// the old path untouched.
export function pinnedTargets(pin) {
  if (!pin || !Array.isArray(pin.addresses) || !pin.addresses.length) return null;
  const out = new Map();
  for (const raw of pin.addresses) {
    const a = lc(String(raw ?? "").trim());
    if (!/^0x[0-9a-f]{40}$/.test(a)) continue; // a malformed address is dropped, never guessed
    out.set(a, pin.label ?? "pinned contract");
  }
  return out.size ? out : null;
}

// Refuse the four fakes, for the pinned set only. Same sources judgeHarm uses, so a
// cheatcode that disqualifies a scope target disqualifies a pinned target too.
export function pinnedTamperNote(controlTrace, pinned) {
  const notes = [];
  if (!pinned || !pinned.size) return notes;
  const hit = (a) => pinned.has(lc(a));
  const sheets = (controlTrace?.etches ?? []).filter((e) => hit(e.target ?? e)).map((e) => lc(e.target ?? e));
  if (sheets.length) notes.push(`the test wrote code at pinned address ${sheets.join(", ")} with vm.etch, so it is not the deployed contract any more`);
  const pranks = (controlTrace?.pranks ?? []).filter(hit).map(lc);
  if (pranks.length) notes.push(`the test impersonated pinned address ${pranks.join(", ")} with a prank or broadcast; a contract the test acts as cannot be the victim`);
  const writes = (controlTrace?.tampers ?? []).filter((t) => t.target === "*" || hit(t.target)).map((t) => `${lc(t.target)} via vm.${t.how}`);
  if (writes.length) notes.push(`the test set the state of pinned address ${writes.join(", ")} with a cheatcode, so its loss may be what the cheatcode granted`);
  return notes;
}

// Did this replay CREATE code at any pinned address? A fork's addresses exist
// before the test runs, so a CREATE there means the test put its own contract at a
// victim's address. That is a forgery regardless of what the trace looks like.
export function createdByTest(traces, pinned) {
  if (!pinned || !pinned.size) return [];
  const out = [];
  for (const entry of Array.isArray(traces) ? traces : []) {
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    for (const node of arena) {
      const t = node?.trace ?? {};
      if (t.kind !== "CREATE" && t.kind !== "CREATE2") continue;
      const a = lc(t.address);
      if (a && pinned.has(a)) out.push(a);
    }
  }
  return [...new Set(out)];
}


// ---------------------------------------------------------------- ERC-20 on a fork
//
// The first real incident this oracle was tried on (Qubit, $80M, 2022-01) moves
// ERC-20, not ETH: the attacker drains a token pool. A native-ETH-only channel
// scores zero on it, which measurement said immediately. So the pinned oracle reads
// Transfer logs too — and it can, soundly, in a way the offline gate deliberately
// cannot.
//
// WHY THIS IS SOUND HERE AND NOT OFFLINE. Everyone can deploy a contract that
// emits a Transfer log for any numbers. Offline, the gate therefore trusts a log
// only when the emitting token is a scope contract AND its balance slot really
// moved (lib/proof.mjs tokenDrains). On a fork at a pinned block, the token at an
// address is the REAL token from the chain: nobody in the test controls what it
// emits. So a fork gives the missing guarantee — the emitter is not the test's
// invention — and a log becomes evidence rather than a claim.
//
// The remaining refusal: the test must not have put its own code at the emitter
// address (checked by createdByTest / vm.etch in pinnedTamperNote above).
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (t) => { const h = String(t ?? "").replace(/^0x/, ""); return h.length >= 40 ? "0x" + h.slice(-40) : null; };

// Net units of every ERC-20 a pinned address lost, from the replay body only:
// success-gated, and a rolled-back transfer contributes nothing. Returns
// [{ victim, token, lostUnits, gainedBy }], biggest loss first.
export function pinnedTokenDrains(traces, pinned) {
  if (!pinned || !pinned.size) return [];
  const net = new Map(); // token -> Map(holder -> signed units)
  const bump = (token, holder, delta) => {
    if (!holder) return;
    const m = net.get(token) ?? new Map();
    m.set(holder, (m.get(holder) ?? 0n) + delta);
    net.set(token, m);
  };
  for (const entry of Array.isArray(traces) ? traces : []) {
    // Body only. setUp funding is the fixture, and a fork's own history is not a
    // thing the attacker did.
    if ((Array.isArray(entry) ? entry[0] : null) !== "Execution") continue;
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    const ok = (i) => { for (let n = arena[i]; n; n = arena[n.parent]) if (!n.trace?.success) return false; return true; };
    arena.forEach((node, i) => {
      if (!ok(i)) return;
      const t = node?.trace ?? {};
      // A DELEGATECALL runs the callee's code in the caller's account, which is also
      // where the log's address points. Same rule the offline channel uses.
      const token = (t.kind === "DELEGATECALL" || t.kind === "CALLCODE") ? lc(t.caller) : lc(t.address);
      if (!token) return;
      for (const log of node?.logs ?? []) {
        const raw = log?.raw_log ?? log;
        const topics = raw?.topics;
        if (!Array.isArray(topics) || topics.length < 3 || lc(topics[0]) !== TRANSFER_TOPIC) continue;
        let amount = 0n;
        try { amount = BigInt(raw.data ?? "0x0"); } catch { amount = 0n; }
        // 0-value transfers and NFT transfers (indexed tokenId, empty data) are not
        // a fungible drain.
        if (amount <= 0n) continue;
        bump(token, topicAddr(topics[1]), -amount);
        bump(token, topicAddr(topics[2]), amount);
      }
    });
  }
  const out = [];
  for (const [token, holders] of net.entries()) {
    for (const [holder, delta] of holders.entries()) {
      if (delta >= 0n || !pinned.has(holder)) continue;
      // The counterparty that gained this token. Same reasoning as the ETH channel:
      // value that vanishes is a burn, not a theft.
      const gainer = [...holders.entries()].find(([a, d]) => d > 0n && !pinned.has(a));
      out.push({ victim: holder, token, lostUnits: (-delta).toString(), gainedBy: gainer ? gainer[0] : null });
    }
  }
  out.sort((a, b) => (BigInt(a.lostUnits) > BigInt(b.lostUnits) ? -1 : 1));
  return out;
}

// Judge harm to a pinned address from the replay's own trace. `net` is the signed
// ETH flow table `scanTargets` already builds (address -> net wei). Returns the
// same shape as the other channels, or { ok: false, reason }.
//
// The rule: a pinned address LOST native ETH in the body, and some other address
// GAINED it. One direction alone is not a drain — value that leaves a contract to
// nobody is a burn, and value that appears is a mint, and neither is theft.
export function judgePinnedHarm(traces, { pinned, net, controlTrace = null } = {}) {
  if (!pinned || !pinned.size) return { ok: false, reason: "no pinned address was given, so there is no deployed victim to judge" };
  const notes = pinnedTamperNote(controlTrace, pinned);
  if (notes.length) return { ok: false, reason: notes.join("; ") };
  const forged = createdByTest(traces, pinned);
  if (forged.length) {
    return { ok: false, reason: `the replay deployed its own code at pinned address ${forged.join(", ")}; a fork's addresses already exist, so that contract is the test's, not the chain's` };
  }
  // Body-only, success-gated: a rolled-back call moves no value, and setUp funding
  // is fixture. Reuses the same walk netFlows already applies, so the numbers agree
  // with the offline channels to the wei.
  const losses = [];
  for (const [addr, wei] of net.entries()) {
    if (!pinned.has(addr) || wei >= 0n) continue;
    losses.push({ victim: addr, lostWei: -wei });
  }
  losses.sort((a, b) => (a.lostWei > b.lostWei ? -1 : 1));

  // Native ETH first: it is the cheapest signal to read and the hardest to fake,
  // because value moves are the trace's own and not a log.
  const l = losses[0];
  if (l) {
    // The counterparty: some address that gained. Without a gainer the loss is a
    // burn, not a theft, and a burn is not an attacker taking funds.
    const gainer = [...net.entries()].find(([addr, wei]) => wei > 0n && !pinned.has(addr) && addr !== lc(controlTrace?.testContract));
    if (!gainer) {
      return { ok: false, reason: `pinned address ${l.victim} lost ${l.lostWei} wei but no address gained it (a burn is not a theft)` };
    }
    return { ok: true, kind: "funds", asset: "eth", victim: l.victim, lostWei: l.lostWei.toString(), gainedBy: gainer[0], onChain: true };
  }

  // No native ETH moved. Most real incidents move a token instead: Qubit, Balancer,
  // the whole class of pool drains. Read the Transfer logs, which on a fork are the
  // real token's own.
  const drains = pinnedTokenDrains(traces, pinned);
  if (drains.length) {
    const d = drains[0];
    return { ok: true, kind: "funds", asset: "token", victim: d.victim, token: d.token, lostUnits: d.lostUnits, gainedBy: d.gainedBy, onChain: true };
  }

  return { ok: false, reason: `no pinned address lost native ETH or an ERC-20 in the replay body (${[...pinned.keys()].join(", ")})` };
}
