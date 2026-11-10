// One run event. The engine and every pack write events the same way: a line on
// stdout that the parent reads, plus a line in EVENTS_FILE when it is set.
import { appendFileSync } from "node:fs";

export function event(name, data = {}) {
  const line = JSON.stringify({ t: Date.now(), ev: name, ...data });
  console.log("EVENT " + line);
  if (process.env.EVENTS_FILE) appendFileSync(process.env.EVENTS_FILE, line + "\n");
}
