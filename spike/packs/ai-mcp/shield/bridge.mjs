// A stdio MCP "server" that forwards every JSON-RPC line to one Streamable HTTP
// MCP endpoint (MCP_URL), with MCP_TOKEN as a bearer token. Ours; no deps.
// It goes to MCP_URL only: redirects are not followed.
import { createInterface } from "node:readline";

const url = process.env.MCP_URL;
const token = process.env.MCP_TOKEN;
let session = null;
let chain = Promise.resolve();

const reply = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function forward(line) {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(url, { method: "POST", headers, body: line, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  session = res.headers.get("mcp-session-id") ?? session;
  const text = await res.text();
  if (msg.id === undefined) return; // a notification has no reply
  const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  const bodies = sse ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()) : [text];
  let sent = false;
  for (const b of bodies) {
    try { const o = JSON.parse(b); if (o && o.jsonrpc) { reply(o); sent = true; } } catch { /* not JSON-RPC */ }
  }
  if (!sent) reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `HTTP ${res.status} with no JSON-RPC reply` } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  chain = chain.then(() => forward(line)).catch((e) => {
    process.stderr.write(`bridge: ${String(e?.message ?? e).slice(0, 200)}\n`);
    process.exit(3);
  });
});
