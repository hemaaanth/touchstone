import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execConfig, shq } from "./daytona.mjs";

const LIMIT = 256 * 1024;
const driver = new URL("../roam/wallet/driver.py", import.meta.url);
const operator = new URL("../roam/wallet/operator_fund.py", import.meta.url);
const fixedError = () => new Error("Private wallet machine unavailable. No fallback, retry or replacement is permitted.");
const canonical = (value) => {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw fixedError();
    return u;
  } catch { throw fixedError(); }
};
// Only a trusted host caller may supply config/fetch/toolboxOrigins. Cross-origin
// toolboxes need an explicit verified origin; metadata alone cannot forward auth.
export async function openWalletMachine(ws, agent, { config = execConfig, fetchImpl = globalThis.fetch, toolboxOrigins = [], signal } = {}) {
  if (typeof ws !== "string" || !ws || typeof agent !== "string" || !agent || agent === "coordinator") throw fixedError();
  let c;
  try { c = config(); } catch { throw fixedError(); }
  if (c.backend !== "daytona" || !c.apiKey) throw fixedError();
  const api = canonical(c.apiUrl);
  const lease = randomBytes(24).toString("hex");
  const labels = Object.freeze({ touchstone: "1", purpose: "wallet", run: createHash("sha256").update(ws).digest("hex"), agent: createHash("sha256").update(agent).digest("hex"), lease });
  const allowed = new Set([api.origin, ...toolboxOrigins.map((v) => canonical(v).origin)]);
  let id;
  let toolbox;
  let closed = false;
  let queue = Promise.resolve();
  const dir = `/tmp/touchstone-wallet-${lease}`;

  async function call(method, url, body, abortSignal = signal, max = LIMIT) {
    const target = canonical(url);
    if (!allowed.has(target.origin)) throw fixedError();
    const timeout = AbortSignal.timeout(300000);
    const init = { method, redirect: "error", headers: { Authorization: `Bearer ${c.apiKey}` }, signal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    let response;
    try {
      response = await fetchImpl(url, init);
      if (!response.ok) throw fixedError();
      if (Number(response.headers.get("content-length")) > max) throw fixedError();
      const chunks = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) return null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > max) throw fixedError();
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return size ? JSON.parse(Buffer.concat(chunks, size).toString("utf8")) : null;
    } catch { throw fixedError(); }
  }

  const endpoint = () => `${api.href.replace(/\/$/, "")}/sandbox/${encodeURIComponent(id)}`;
  async function check(abortSignal) {
    if (closed) throw fixedError();
    const state = await call("GET", endpoint(), undefined, abortSignal);
    if (state?.id !== id || state.state !== "started" || Object.entries(labels).some(([k, v]) => state.labels?.[k] !== v)) throw fixedError();
    if (state.toolboxProxyUrl && canonical(state.toolboxProxyUrl).href !== toolbox.base) throw fixedError();
  }
  async function exec(command, abortSignal) {
    const result = await call("POST", `${toolbox.url}/process/execute`, { command, timeout: 120 }, abortSignal);
    if (result?.exitCode !== 0 || typeof result.result !== "string" || Buffer.byteLength(result.result) > LIMIT) throw fixedError();
    return result.result;
  }
  async function upload(path, bytes, abortSignal) {
    if (bytes.byteLength > LIMIT) throw fixedError();
    const form = new FormData();
    form.append("file", new Blob([bytes]), "payload");
    // Query is fixed here, not a configurable URL or credential-bearing value.
    const url = new URL(`${toolbox.url}/files/upload-v2`);
    url.searchParams.set("path", path);
    // call forbids query on configured URLs; upload constructs its own safe path.
    const target = new URL(url);
    const response = await fetchImpl(target.href, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${c.apiKey}` }, body: form, signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) }).catch(() => { throw fixedError(); });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw fixedError();
  }
  async function close() {
    if (closed) return;
    closed = true;
    if (id) await call("DELETE", endpoint(), undefined, null);
  }

  try {
    const sb = await call("POST", `${api.href.replace(/\/$/, "")}/sandbox`, { snapshot: c.snapshot, target: c.target, user: "root", labels, autoStopInterval: 15, autoDeleteInterval: 60 });
    if (typeof sb?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sb.id)) throw fixedError();
    id = sb.id;
    const base = canonical(sb.toolboxProxyUrl);
    if (!allowed.has(base.origin)) throw fixedError();
    toolbox = { base: base.href, url: `${base.href.replace(/\/$/, "")}/${encodeURIComponent(id)}` };
    await check(signal);
    await exec(`sh -c ${shq(`umask 077; mkdir -m 700 ${shq(dir)} && command -v python3 >/dev/null && docker info >/dev/null 2>&1`)}`, signal);
    await upload(`${dir}/driver.py`, await readFile(driver), signal);
    await upload(`${dir}/operator_fund.py`, await readFile(operator), signal);
  } catch {
    await close().catch(() => {});
    throw fixedError();
  }

  return Object.freeze({
    id,
    async fundingInstructions({ signal: abortSignal } = {}) {
      await check(abortSignal);
      return { machine_id: id, command: `python3 ${dir}/operator_fund.py` };
    },
    async request(input, { signal: abortSignal } = {}) {
      const operation = async () => {
        const bytes = Buffer.from(JSON.stringify({ ...input, lease }));
        if (bytes.length > LIMIT || !["start", "status", "prepare", "balance", "submit"].includes(input?.op)) throw fixedError();
        const path = `${dir}/${randomBytes(12).toString("hex")}.json`;
        try {
          await check(abortSignal);
          await upload(path, bytes, abortSignal);
          const output = await exec(`sh -c ${shq(`umask 077; python3 ${shq(`${dir}/driver.py`)} < ${shq(path)}; code=$?; rm -f ${shq(path)}; exit "$code"`)}`, abortSignal);
          const result = JSON.parse(output);
          if (!result || result.lease !== lease || result.ok !== true) throw fixedError();
          return result;
        } catch {
          // Uncertain state is terminal. Never replay a possibly submitted tx.
          await close().catch(() => {});
          throw fixedError();
        } finally {
          bytes.fill(0);
          if (!closed) await exec(`rm -f ${shq(path)}`, null).catch(async () => { await close().catch(() => {}); });
        }
      };
      const next = queue.then(operation, operation);
      queue = next.catch(() => {});
      return next;
    },
    close,
  });
}
