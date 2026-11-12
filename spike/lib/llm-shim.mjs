// A tiny OpenAI-compatible shim for one provider gap: the current gateway
// rejects `parallel_tool_calls`, and Strix sends it on every request. The shim
// is a loopback forwarder that drops the parameter and streams everything else
// back untouched.
//
// WHY NOT PATCH THE GATEWAY. The parameter is legal OpenAI; the gateway is the
// outlier, and another provider may accept it. Dropping it always is harmless:
// it only means the model may not issue parallel calls in one turn.
//
// One shim serves one provider for one process. Start it with startShim(provider)
// and stop it with the returned stop(). It binds 127.0.0.1 on an ephemeral port.
import http from "node:http";
import { writeFileSync } from "node:fs";

const DROP = ["parallel_tool_calls"];

function forwardJson(text) {
  try {
    const body = JSON.parse(text);
    for (const key of DROP) delete body[key];
    return JSON.stringify(body);
  } catch {
    return text; // not JSON: pass it through
  }
}

// provider: { baseUrl, key } — baseUrl ends in /v1.
export async function startShim({ baseUrl, key }) {
  const upstream = new URL(baseUrl);
  const basePath = upstream.pathname.replace(/\/$/, "");

  const server = http.createServer((req, res) => {
    // The client may call "<base>/chat/completions" (the URL we hand out) or
    // "/chat/completions". Normalize both to one upstream path.
    let path = req.url ?? "/";
    if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length) || "/";
    path = basePath + path;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const headers = { ...req.headers, host: upstream.host, authorization: `Bearer ${key}` };
      delete headers["content-length"];
      headers["accept-encoding"] = "identity"; // fetch decodes; a second decode would corrupt
      let body;
      if (raw) {
        body = forwardJson(raw);
        headers["content-length"] = String(Buffer.byteLength(body));
      }
      try {
        const up = await fetch(upstream.origin + path, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        });
        const out = Object.fromEntries(up.headers);
        // fetch already decoded the body, so its framing headers no longer hold.
        delete out["content-encoding"];
        delete out["content-length"];
        delete out["transfer-encoding"];
        res.writeHead(up.status, out);
        if (!up.body) return res.end();
        for await (const chunk of up.body) res.write(chunk);
        res.end();
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `shim upstream error: ${String(err?.message ?? err)}` } }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${basePath}`,
    stop: () => new Promise((resolve) => {
      // Strix keeps the SSE connection open; close() alone would wait for it.
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}


// Run as a program (inside the Strix image): take the upstream from the
// environment and publish the shim URL where the entrypoint can read it.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.UPSTREAM_BASE;
  const key = process.env.UPSTREAM_KEY;
  if (!base || !key) {
    console.error("shim needs UPSTREAM_BASE and UPSTREAM_KEY");
    process.exit(1);
  }
  const shim = await startShim({ baseUrl: base, key });
  writeFileSync(process.env.SHIM_URL_FILE ?? "/tmp/shim.url", shim.url);
  console.log(`shim ${shim.url}`);
}
