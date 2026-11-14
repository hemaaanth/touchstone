import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP, SocketAddress } from "node:net";
import { DEMO, DEMO_MODEL, DEMO_TARGETS } from "./demo-config.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = "[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}";
const fail = (status, message) => Object.assign(new Error(message), { status });
const send = (res, status, body) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
const equal = (a, b) => typeof a === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function demoRoute(method, raw) {
  if (typeof raw !== "string" || raw.length > 2048 || !/^\/[a-zA-Z0-9/._?=&-]*$/.test(raw) || raw.includes("//") || raw.split(/[/?]/).some((s) => s === "." || s === "..")) return null;
  const [path, query = "", extra] = raw.split("?");
  if (extra !== undefined || raw.endsWith("?")) return null;
  if (query && !/^[a-zA-Z]+=[a-zA-Z0-9_-]+(?:&[a-zA-Z]+=[a-zA-Z0-9_-]+)*$/.test(query)) return null;
  const params = new URLSearchParams(query);
  if ([...params.keys()].some((k) => params.getAll(k).length !== 1)) return null;
  let kind = null, match, allowed = [];
  if (method === "GET" && ["/api/models", "/api/scopes", "/api/findings", "/api/runs"].includes(path)) {
    kind = path.slice(5); if (kind === "runs") allowed = ["requestId"];
  } else if (method === "POST" && path === "/api/runs") kind = "start";
  else if ((match = new RegExp(`^/api/runs/(${ID})(?:/(stream|stop))?$`).exec(path))) {
    if (method === "GET" && match[2] !== "stop") { kind = match[2] ?? "run"; if (kind === "stream") allowed = ["since"]; }
    if (method === "POST" && match[2] === "stop") kind = "stop";
  } else if (method === "GET" && (match = new RegExp(`^/api/findings/(${ID})(/report)?$`).exec(path))) {
    kind = match[2] ? "report" : "finding"; allowed = kind === "report" ? ["format"] : ["events"];
  }
  if (!kind || [...params.keys()].some((k) => !allowed.includes(k))) return null;
  if (params.has("requestId") && !UUID.test(params.get("requestId"))) return null;
  if (params.has("since") && (!/^\d{1,9}$/.test(params.get("since")))) return null;
  if (params.has("events") && !["0", "1"].includes(params.get("events"))) return null;
  if (params.has("format") && !["json", "md", "markdown", "html", "agent", "bundle", "zip", "bundle-check"].includes(params.get("format"))) return null;
  return { kind, id: match?.[1], params };
}

function privateFile(file) {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error("Demo state files must be private regular files.");
}
export function sessionSecret(file) {
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  privateFile(file);
  const secret = readFileSync(file, "utf8");
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid demo session secret.");
  return secret;
}

export function demoSessions(config, secret = sessionSecret(config.secretFile), now = Date.now) {
  const hmac = (text) => createHmac("sha256", secret).update(text).digest("hex");
  const name = config.secure ? "__Host-touchstone-demo" : "touchstone-demo";
  return {
    session(req, res) {
      const cookies = String(req.headers.cookie ?? "").split(";").map((s) => s.trim()).filter((s) => s.startsWith(`${name}=`));
      let value = cookies.length === 1 ? cookies[0].slice(name.length + 1) : "";
      const [id, issued, sig] = value.split(".");
      const age = now() - Number(issued);
      if (!/^[a-f0-9]{64}\.\d{13}\.[a-f0-9]{64}$/.test(value) || age < 0 || age > 86400_000 || !equal(sig, hmac(`session:${id}.${issued}`))) {
        const data = `${randomBytes(32).toString("hex")}.${now()}`;
        value = `${data}.${hmac(`session:${data}`)}`;
        res.setHeader("set-cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${config.secure ? "; Secure" : ""}`);
      }
      return hmac(`owner:${value}`);
    },
    requestId(owner, requestId) {
      if (!UUID.test(requestId ?? "")) throw fail(400, "Invalid run request ID.");
      const hex = hmac(`request:${owner}:${requestId}`).slice(0, 32).split("");
      hex[12] = "4"; hex[16] = "89ab"[parseInt(hex[16], 16) % 4];
      const s = hex.join(""); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    },
    ip(req) {
      const peer = req.socket?.remoteAddress;
      if (!isIP(peer ?? "")) throw fail(400, "Client address is unavailable.");
      const normalize = (ip) => ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
      let ip = normalize(peer);
      if (config.proxyIp && normalize(config.proxyIp) === ip) {
        const real = req.headers["x-real-ip"];
        if (typeof real !== "string" || !isIP(real)) throw fail(400, "Proxy must supply one valid X-Real-IP address.");
        ip = normalize(real);
      }
      // Canonicalize IPv6 text so spelling changes cannot reset a quota.
      ip = new SocketAddress({ address: ip, family: isIP(ip) === 4 ? "ipv4" : "ipv6" }).address;
      return hmac(`ip:${ip}`);
    },
  };
}

// One synchronous reservation before acceptRun starts asynchronous setup.
export function demoStarts(file, now = Date.now) {
  let rows = [];
  if (existsSync(file)) {
    privateFile(file); rows = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(rows) || rows.some((r) => !/^[a-f0-9]{64}$/.test(r.owner) || !/^[a-f0-9]{64}$/.test(r.ip) || !Number.isFinite(r.at) || r.at > now())) throw new Error("Invalid demo start ledger.");
  }
  return {
    reserve(owner, ip) {
      rows = rows.filter((r) => now() - r.at < 3600_000);
      if (rows.filter((r) => r.owner === owner).length >= 2 || rows.filter((r) => r.ip === ip).length >= 5 || rows.length >= 10000) throw fail(429, "This demo has a start limit. Please try again later.");
      rows.push({ owner, ip, at: now() });
      writeFileSync(`${file}.tmp`, JSON.stringify(rows), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
    },
  };
}

async function body(req) {
  let raw = "", bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024) throw fail(413, "Demo request is too large.");
    raw += chunk;
  }
  try { return JSON.parse(raw); } catch { throw fail(400, "Send a JSON object."); }
}

export function createDemoHandler(config, backend, findings, handleReports, { now = Date.now } = {}) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const sessions = demoSessions(config, undefined, now);
  const starts = demoStarts(config.ratesFile, now);
  const traffic = new Map(), streams = new Map();
  return async (req, res, staticPage) => {
    res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    try {
      if (req.headers.origin !== undefined && req.headers.origin !== config.origin) throw fail(403, "Open the demo on its own page.");
      if (req.method === "POST") {
        if (req.headers.origin !== config.origin) throw fail(403, "Open the demo on its own page.");
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw fail(415, "Send application/json.");
        if (req.headers["content-encoding"] || (req.headers["content-length"] !== undefined && (!/^\d+$/.test(req.headers["content-length"]) || Number(req.headers["content-length"]) > 1024))) throw fail(413, "Demo request is too large.");
      }
      const route = demoRoute(req.method, req.url);
      if (!route && !staticPage) return send(res, 404, { error: "not found" });
      const ip = sessions.ip(req);
      const minute = Math.floor(now() / 60000);
      for (const [key, entry] of traffic) if (entry.minute !== minute) traffic.delete(key);
      const entry = traffic.get(ip) ?? { minute, count: 0 };
      if (++entry.count > 240 || traffic.size >= 10000) throw fail(429, "Too many demo requests. Please wait a minute.");
      traffic.set(ip, entry);
      const owner = sessions.session(req, res);
      if (staticPage) return staticPage();
      const allowRun = (id) => backend.runOwnedBy(id, owner);
      const notFound = () => send(res, 404, { error: "not found" });
      if (route.kind === "models") return send(res, 200, backend.demoCatalog());
      if (route.kind === "scopes") return send(res, 200, { scopes: [] });
      if (route.kind === "runs") {
        if (route.params.has("requestId")) {
          const run = backend.getRunByRequest(sessions.requestId(owner, route.params.get("requestId")));
          return run && allowRun(run.id) ? send(res, 200, { run }) : notFound();
        }
        return send(res, 200, { runs: backend.listRuns().filter((r) => allowRun(r.id)) });
      }
      if (route.kind === "start") {
        const input = await body(req);
        if (!input || Array.isArray(input) || Object.keys(input).sort().join(",") !== "requestId,targetId" || !DEMO_TARGETS.includes(input.targetId)) throw fail(400, "Choose one of the demo targets.");
        const requestId = sessions.requestId(owner, input.requestId);
        const prior = backend.getRunByRequest(requestId);
        if (prior && allowRun(prior.id)) {
          if (prior.scope?.id !== input.targetId) throw fail(409, "This request ID already names another target.");
          return send(res, 201, prior);
        }
        if (backend.demoBusy()) throw Object.assign(fail(429, "The sponsored demo is busy with another run. Please try again shortly."), { code: "demo_busy" });
        starts.reserve(owner, ip);
        const run = backend.acceptRun({ targetId: input.targetId, requestId, ownerHash: owner, deadlineAt: now() + DEMO.maxMinutes * 60000,
          alias: DEMO_MODEL, budgetUsd: DEMO.budgetUsd, mode: "fleet", freeRoam: false, options: [], pack: "contracts", modules: [] });
        return send(res, 201, run);
      }
      if (["run", "stream", "stop"].includes(route.kind)) {
        if (!allowRun(route.id)) return notFound();
        if (route.kind === "run") return send(res, 200, backend.getRun(route.id));
        if (route.kind === "stop") {
          const input = await body(req);
          if (!input || Array.isArray(input) || Object.keys(input).length) throw fail(400, "Stop accepts an empty object.");
          return send(res, 200, backend.stopRun(route.id));
        }
        const streamKeys = [`owner:${owner}`, `ip:${ip}`];
        if (streamKeys.some((key, index) => (streams.get(key) ?? 0) >= (index === 0 ? 3 : 8))) throw fail(429, "Too many open demo streams.");
        for (const key of streamKeys) streams.set(key, (streams.get(key) ?? 0) + 1);
        res.statusCode = 200; res.setHeader("content-type", "text/event-stream"); res.setHeader("connection", "keep-alive"); res.flushHeaders?.();
        const unsubscribe = backend.subscribe(route.id, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`), Number(route.params.get("since") ?? 0));
        const beat = setInterval(() => res.write(": beat\n\n"), 15000);
        const timer = setTimeout(() => res.end(), 11 * 60000);
        let closed = false;
        const close = () => { if (closed) return; closed = true; clearInterval(beat); clearTimeout(timer); unsubscribe?.(); for (const key of streamKeys) { streams.set(key, streams.get(key) - 1); if (!streams.get(key)) streams.delete(key); } };
        res.on("close", close); return;
      }
      if (route.kind === "findings") return send(res, 200, { findings: await findings.listFindings({ allowRun }), candidates: await findings.listCandidates({ allowRun }) });
      if (route.kind === "report") return await handleReports(req, res, { allowRun });
      const finding = await findings.getFinding(route.id, { allowRun, events: route.params.get("events") !== "0" });
      return finding ? send(res, 200, finding) : send(res, 404, await findings.nowCandidate(route.id, { allowRun }) ?? { error: "not found" });
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status ?? 503;
      if (status === 429) res.setHeader("retry-after", "60");
      send(res, status, { error: error.status ? error.message : "The demo cannot start or read this run right now. Please try again later.", ...(status === 429 ? { code: error.code === "demo_busy" ? "demo_busy" : "demo_rate_limited" } : {}) });
    }
  };
}
