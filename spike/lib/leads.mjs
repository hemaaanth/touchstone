// Leads a run recorded, from its events. A `lead` event is written the moment
// an agent records a lead (Review's record_lead), so the list survives a later
// model error or a server stop. A lead is a claim with evidence, never a proven
// finding: this list never carries a proven flag, whatever an event says.

const RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// One lead per id (the latest event wins), worst first, then in order of first
// arrival. Other events, including free-text Bulletin posts, are ignored.
export function leadsFrom(events) {
  const byId = new Map();
  for (const e of events ?? []) {
    if (e?.ev !== "lead" || typeof e.id !== "string" || !e.id) continue;
    const { ev: _ev, proven: _proven, ...lead } = e;
    const first = byId.get(e.id)?.order ?? byId.size;
    byId.set(e.id, { order: first, lead });
  }
  return [...byId.values()]
    .sort((a, b) => (RANK[a.lead.severity] ?? 4) - (RANK[b.lead.severity] ?? 4) || a.order - b.order)
    .map((x) => x.lead);
}
