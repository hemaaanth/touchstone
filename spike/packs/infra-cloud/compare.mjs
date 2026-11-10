import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { makeLabWorkspace, captureSnapshot } from "./snapshot.mjs";
import { SCANNERS, scanSnapshot } from "./scanners.mjs";
const ws = makeLabWorkspace();
try {
  const snapshot = captureSnapshot(ws);
  const results = await Promise.all(Object.keys(SCANNERS).map((engine) => scanSnapshot(snapshot, engine)));
  const safe = results.map(({ engine, status, code, timedOut, leads }) => ({ engine, status, code, timedOut, total: leads.length, rules: [...new Set(leads.map((l) => l.check))], files: [...new Set(leads.map((l) => l.file))] }));
  console.log(JSON.stringify(safe, null, 2));
  mkdirSync(new URL("./validation/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./validation/tool-comparison.json", import.meta.url), JSON.stringify(safe, null, 2) + "\n");
  const catalog = results.flatMap((r) => [...new Map(r.leads.map((l) => [l.check, { engine: r.engine, image: SCANNERS[r.engine].image, id: l.check, title: l.title, impact: l.impact }])).values()]);
  writeFileSync(new URL("./rule-catalog.json", import.meta.url), JSON.stringify(catalog, null, 2) + "\n");
} finally { rmSync(ws, { recursive: true, force: true }); }
