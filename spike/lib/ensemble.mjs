// The ensemble layer — this is OUR net-new contribution, not a vendored tool.
//
// Each analyzer we drive (Slither, Aderyn, Echidna, Medusa) is a black-box
// HYPOTHESIS GENERATOR: it reads the target and shouts out where a bug might be.
// None of them decides anything. The honest signal they cannot produce alone is
// AGREEMENT: when two engines that share no code independently point at the same
// spot, that spot deserves to be looked at first. This module turns a pile of
// noisy single-engine leads into one ranked suspect board, and marks the suspects
// two engines corroborate. The one truth gate stays where it always was — a
// deterministic Foundry replay — so a corroborated suspect is still only a lead
// until it is proven. Rank changes attention, never verdict.

// Slither's severity words, scariest first. Aderyn only emits High/Low; Medusa
// and Echidna break invariants we treat as High. We map everything onto this
// single scale so leads from different engines can be compared at all.
export const IMPACT_RANK = { High: 0, Medium: 1, Low: 2, Informational: 3, Optimization: 4 };
const rankOf = (impact) => IMPACT_RANK[impact] ?? 9;

// Two leads touch the "same spot" when they sit in the same file and their line
// numbers fall within a small window of each other. The window absorbs the
// off-by-a-line disagreement you get because each engine anchors a finding to a
// slightly different token (the call, the assignment, the function head).
const LINE_WINDOW = 3;
const linesNear = (a, b, window) =>
  a.some((x) => b.some((y) => Math.abs(x - y) <= window));

// A fixed display order for engines so a corroborated suspect always reads the
// same way ("Slither + Aderyn"), whichever engine happened to seed the cluster.
const ENGINE_ORDER = ["Slither", "Aderyn", "Echidna", "Medusa"];
const orderEngines = (names) =>
  [...names].sort((a, b) => {
    const ia = ENGINE_ORDER.indexOf(a);
    const ib = ENGINE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

// Does a lead belong to an existing cluster? Same file, and either their lines
// are near each other, or — when neither carries a line — they name the same
// place (Contract.function). A lead with no location anchor joins nothing.
function belongs(cluster, lead, window) {
  if (cluster.file !== lead.file) return false;
  if (cluster.lines.length && lead.lines.length) return linesNear(cluster.lines, lead.lines, window);
  if (!cluster.lines.length && !lead.lines.length) return Boolean(lead.where) && cluster.where === lead.where;
  return false;
}

// Fold one cluster of leads into a single suspect. The representative — the face
// of the suspect — is the scariest lead in the cluster, so a Low that an engine
// agrees on but a second engine rates High is promoted to High. We keep every
// contributing detector name and every engine, so the report can show exactly
// who flagged what.
function toSuspect(cluster) {
  const leads = cluster.leads;
  const rep = leads.reduce((best, l) => (rankOf(l.impact) < rankOf(best.impact) ? l : best));
  const engines = orderEngines(new Set(leads.map((l) => l.engine)));
  const checks = [...new Set(leads.map((l) => l.check))];
  const lines = [...new Set(leads.flatMap((l) => l.lines))].sort((a, b) => a - b);
  const where = (leads.find((l) => l.where) || {}).where || null;
  return {
    check: rep.check,
    checks,
    impact: rep.impact,
    confidence: rep.confidence ?? null,
    file: cluster.file,
    where,
    lines,
    description: rep.description || "",
    engines,
    corroborated: engines.length > 1,
  };
}

// Rank the suspect board. Severity leads — a solo High still outranks a
// corroborated Low, because agreement sharpens attention, it does not invent
// danger. Within one severity tier, the suspects two engines agree on float to
// the top, then we settle ties by source order so the board is stable run to run.
function rankSuspects(a, b) {
  return (
    rankOf(a.impact) - rankOf(b.impact) ||
    Number(b.corroborated) - Number(a.corroborated) ||
    (a.lines[0] ?? 1e9) - (b.lines[0] ?? 1e9) ||
    a.file.localeCompare(b.file)
  );
}

// Merge static leads from every engine into the ranked suspect board.
//
// `candidates` are leads strong enough to stand on their own (Slither
// High/Medium/Low, Aderyn High). `corroborators` are weak leads that we refuse
// to surface alone — Aderyn's Low tier is full of style notes like "unspecific
// pragma" — but that DO count when they land on top of a candidate, because a
// second independent engine pointing at the same line is real agreement. This
// asymmetry is deliberate: it keeps the board free of lint noise while still
// letting a weak second opinion raise a real suspect's rank.
export function mergeStatic(candidates, corroborators = [], { window = LINE_WINDOW } = {}) {
  const clusters = [];
  const seed = [...candidates].sort((a, b) => rankOf(a.impact) - rankOf(b.impact));
  for (const lead of seed) {
    let c = clusters.find((c) => belongs(c, lead, window));
    if (!c) {
      c = { file: lead.file, lines: [...lead.lines], where: lead.where ?? null, leads: [] };
      clusters.push(c);
    }
    c.leads.push(lead);
    c.lines = [...new Set([...c.lines, ...lead.lines])];
    if (!c.where && lead.where) c.where = lead.where;
  }
  for (const lead of corroborators) {
    const c = clusters.find((c) => belongs(c, lead, window));
    if (!c) continue; // a lone weak lead is never a suspect
    c.leads.push(lead);
    c.lines = [...new Set([...c.lines, ...lead.lines])];
  }
  return clusters.map(toSuspect).sort(rankSuspects);
}

// Merge broken-invariant leads from the fuzzers (Echidna, Medusa). Fuzzers do
// not report a line — they report a broken property and the call sequence that
// broke it — so corroboration keys on the (contract, invariant) pair instead of
// a line window. When both fuzzers break the SAME invariant on the same target,
// that is the strongest lead the whole pipeline can hand the agent short of a
// proof: two independent fuzzing engines, different internals, same drain. We
// keep the shortest breaking sequence, since the tightest counterexample is the
// easiest for the agent to turn into a PoC.
export function mergeFuzz(leads) {
  const byKey = new Map();
  for (const lead of leads) {
    const key = `${lead.where || lead.contract || "?"}::${lead.property || lead.check}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...lead, engines: [lead.engine], corroborated: false });
      continue;
    }
    if (!prev.engines.includes(lead.engine)) prev.engines.push(lead.engine);
    prev.corroborated = prev.engines.length > 1;
    // Prefer the shorter, non-empty breaking sequence — the tighter counterexample.
    const a = prev.sequence || [];
    const b = lead.sequence || [];
    if (b.length && (!a.length || b.length < a.length)) prev.sequence = b;
  }
  // Corroborated invariants first, then by impact, then by shortest sequence.
  return [...byKey.values()]
    .map((s) => ({ ...s, engines: orderEngines(s.engines) }))
    .sort(
    (a, b) =>
      Number(b.corroborated) - Number(a.corroborated) ||
      rankOf(a.impact) - rankOf(b.impact) ||
      (a.sequence?.length ?? 1e9) - (b.sequence?.length ?? 1e9),
  );
}
