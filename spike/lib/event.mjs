// One run event. The engine and every pack write events the same way: a line on
// stdout that the parent reads, plus a line in EVENTS_FILE when it is set.
import { appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

const agents = new AsyncLocalStorage();

export function withAgent(agent, fn) {
  return agents.run(agent, fn);
}

// The agent tag of the current call, or undefined for the root agent. The
// Daytona backend uses it to give each swarm child its own machine.
export function currentAgent() {
  return agents.getStore();
}

export function event(name, data = {}) {
  const agent = agents.getStore();
  const line = JSON.stringify({ t: Date.now(), ev: name, ...(agent ? { agent } : {}), ...data });
  console.log("EVENT " + line);
  if (process.env.EVENTS_FILE) appendFileSync(process.env.EVENTS_FILE, line + "\n");
}
