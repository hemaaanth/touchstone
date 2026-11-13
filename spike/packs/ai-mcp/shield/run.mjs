// Run mcp-shield's own scanner on ONE MCP server and print its result as JSON.
//
//   node /opt/shield/run.mjs <mcp-url>     (bearer token in MCP_TOKEN, optional)
//
// mcp-shield's CLI prints a terminal tree only. So we call the scanner module
// the CLI calls (dist/scanner.js) and print the same result object as JSON.
// The Claude key argument is ALWAYS undefined: mcp-shield never makes its
// optional model call, and no tool text leaves the scan network.
//
// mcp-shield speaks stdio or legacy SSE only. bridge.mjs (ours) is its stdio
// "server": it forwards each JSON-RPC message to the URL as a Streamable HTTP
// POST with the token. mcp-shield swallows a connect error into a progress
// event, so we watch the events: no connection means exit 2, never a clean scan.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanMcpServer } from "mcp-shield/dist/scanner.js";

const url = process.argv[2];
const fail = (error) => { process.stdout.write(JSON.stringify({ ok: false, error: String(error).slice(0, 300) }) + "\n"); process.exit(2); };
if (!/^https?:\/\//.test(url ?? "")) fail("usage: run.mjs <http(s) MCP url>");

const dir = mkdtempSync(join(tmpdir(), "shield-"));
const config = join(dir, "mcp.json");
// The token stays in the environment the stdio child inherits, not in the file.
writeFileSync(config, JSON.stringify({ mcpServers: { target: { command: process.execPath, args: [new URL("./bridge.mjs", import.meta.url).pathname], env: { MCP_URL: url } } } }));

const events = { connected: null, error: null };
const progress = (e) => {
  if (e.type === "server-connected") events.connected = { toolCount: e.toolCount, tools: e.tools.map((t) => t.name) };
  if (e.type === "server-error") events.error = e.error;
};
try {
  const result = await scanMcpServer(config, progress, undefined, undefined, undefined);
  if (!events.connected) fail(events.error ?? "mcp-shield did not connect to the server");
  process.stdout.write(JSON.stringify({ ok: true, tool: "mcp-shield", version: "1.0.4", server: events.connected, vulnerabilities: result.vulnerabilities }) + "\n");
  // mcp-shield never clears its 30s connect timer; do not wait it out.
  process.exit(0);
} catch (e) {
  fail(e?.message ?? e);
}
