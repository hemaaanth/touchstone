// Extra prepass tools, beyond the three in scan.mjs (zap, nuclei, dalfox).
// Each tool lives in its own file and resolves with { coverage, leads } in
// scanWeb's shape. They are collected here so the pack's prepass folds them in
// at one call site and does not change again as more tools are wired.
//
// Every tool here must be fail-closed on its own: it resolves with an
// "unavailable" coverage row on error, never throws, never a clean result from
// a failed run.
import { scanFfuf } from "./ffuf.mjs";
import { scanArjun } from "./arjun.mjs";
import { scanSchemathesis } from "./schemathesis.mjs";

const cap = (s, n = 200) => String(s ?? "").slice(0, n);
const RANK = { High: 0, Medium: 1, Low: 2, Informational: 3 };

// The extra tools, in order. Each is called with { net, baseUrl, run }. Add a
// new tool by pushing its scan function here; pack.mjs does not change.
// ffuf finds hidden PATHS; arjun mines hidden PARAMETERS on known paths;
// schemathesis drives TYPED inputs at documented operations from the schema.
const TOOLS = [
  { name: "ffuf", scan: scanFfuf },
  { name: "arjun", scan: scanArjun },
  { name: "schemathesis", scan: scanSchemathesis },
];

// Run every extra tool against { net, baseUrl }. Always resolves. A tool that
// throws (it should not) is turned into an "unavailable" row so the prepass
// still reports it, fail-closed.
export async function extraScans({ net, baseUrl, run } = {}) {
  const out = [];
  for (const t of TOOLS) {
    try {
      out.push(await t.scan({ net, baseUrl, run }));
    } catch (e) {
      out.push({
        coverage: [{ engine: t.name, status: "unavailable", code: 1, timedOut: false, leads: 0, reason: cap(String(e?.message ?? e), 160) }],
        leads: [],
      });
    }
  }
  return out;
}

// Fold one extra scanner's { coverage, leads } into the running scan result.
// Coverage rows are appended. Leads are appended, then any path flagged by more
// than one engine is marked corroborated (the same rule scan.mjs's mergeLeads
// uses), and the whole list is re-sorted worst-first.
export function foldScan(base, extra) {
  const leads = [
    ...base.leads,
    ...extra.leads.map((l) => ({ ...l, engines: l.engines ?? [l.engine], corroborated: l.corroborated ?? false })),
  ];
  const enginesByPath = new Map();
  for (const l of leads) {
    const s = enginesByPath.get(l.path) ?? new Set();
    (l.engines ?? [l.engine]).forEach((e) => s.add(e));
    enginesByPath.set(l.path, s);
  }
  for (const l of leads) {
    if ((enginesByPath.get(l.path)?.size ?? 0) > 1 && l.impact !== "Informational") l.corroborated = true;
  }
  leads.sort((a, b) => (RANK[a.impact] ?? 9) - (RANK[b.impact] ?? 9));
  return { coverage: [...base.coverage, ...extra.coverage], leads };
}
