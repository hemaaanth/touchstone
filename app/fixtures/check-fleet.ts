// Reduce a run stream file and print its fleet state.
//   cd app && bun fixtures/check-fleet.ts <file.stream.jsonl | run-*.events>
import { readFileSync } from "node:fs"
import { reduceEvents, threadSteps } from "../src/lib/runModel"
const f = process.argv[2]
const evs = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l))
const s = reduceEvents(evs)
console.log("status", s.status, "activity", s.activity)
console.log(s.agents.map((a) => `${a.name} ${a.tier} ${a.state}/${a.activity} $${a.spendUsd} ${a.error ?? ""}`).join("\n"))
console.log("bulletin", s.bulletin.map((b) => `${b.author}:${b.kind}:${b.lane}`).join(" "))
console.log("MAIN", threadSteps(s.steps, null).map((x) => `${x.kind}[${x.key}]`).join(" "))
console.log("BETA", threadSteps(s.steps, "a-exploit").map((x) => `${x.kind}[${x.key}]`).join(" "))
