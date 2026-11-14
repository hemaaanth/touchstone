// Host bridge only. Chromium, the driver, HAR and PNG files live on Daytona.
// record(entry) is I6's ONLY redactor. The model receives its returned output.
// Capture controls expose metadata, never download or publish raw artifacts.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { roamMachine } from "./daytona.mjs";
import { currentAgent } from "./event.mjs";
import { DRIVER_PATH, SESSION_DIR, RESPONSE_BYTES, validateBrowserRequest } from "../roam/browser-driver.mjs";

const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const READY = `printf '%s' '{"action":"status"}' | node ${DRIVER_PATH} request`;
const START = `sh -c ${shq(`mkdir -p ${SESSION_DIR} && chmod 700 ${SESSION_DIR} || exit 1; ${READY} >/dev/null 2>&1 && exit 0; (nohup node ${DRIVER_PATH} serve >/dev/null 2>&1 &); for i in $(seq 1 20); do ${READY} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`)}`;
const started = new Map();
const errors = new Set(["INVALID_REQUEST", "TIMEOUT", "BROWSER_FAILED", "BROWSER_CLOSED", "BROWSER_PAUSED", "BUSY", "SCREENSHOT_LIMIT", "CAPTURE_FAILED", "RESPONSE_LIMIT", "DRIVER_UNAVAILABLE"]);

async function ensureDriver(machine) {
  let ready = started.get(machine.id);
  if (!ready) {
    ready = (async () => {
      await machine.upload(DRIVER_PATH, readFileSync(new URL("../roam/browser-driver.mjs", import.meta.url)));
      const r = await machine.exec(START, 60);
      if (r?.exitCode !== 0) throw new Error("DRIVER_UNAVAILABLE");
    })();
    started.set(machine.id, ready);
    ready.catch(() => { if (started.get(machine.id) === ready) started.delete(machine.id); });
  }
  return ready;
}

const boundedString = (s, n) => typeof s === "string" && s.length <= n;
function fileMeta(value, screenshot = false) {
  const path = value?.path;
  const name = typeof path === "string" ? path.slice(SESSION_DIR.length + 1) : "";
  if (path !== `${SESSION_DIR}/${name}` || !(screenshot ? /^shot-([1-9]|1[0-2])\.png$/ : /^browser\.har$/).test(name)) throw new Error();
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error();
  if (!screenshot) return { path, bytes: value.bytes };
  if (!Number.isFinite(value.t) || !boundedString(value.url, 2000)) throw new Error();
  return { path, bytes: value.bytes, t: value.t, url: value.url };
}

function checkedReply(value, action) {
  if (value?.ok === false && errors.has(value.error)) return { ok: false, error: value.error };
  if (value?.ok !== true) throw new Error();
  if (["pause", "resume", "status"].includes(action)) {
    if (["paused", "active", "closed", "failed"].some((key) => typeof value[key] !== "boolean")) throw new Error();
    return { ok: true, paused: value.paused, active: value.active, closed: value.closed, failed: value.failed };
  }
  if (["capture", "close"].includes(action)) {
    if (value.closed !== true || !Array.isArray(value.screenshots) || value.screenshots.length > 12) throw new Error();
    return { ok: true, closed: true, har: value.har === null ? null : fileMeta(value.har), screenshots: value.screenshots.map((v) => fileMeta(v, true)) };
  }
  if (!boundedString(value.title, 512) || !boundedString(value.url, 2000) || !boundedString(value.text, 8000)) throw new Error();
  if (value.status !== null && (!Number.isInteger(value.status) || value.status < 100 || value.status > 599)) throw new Error();
  return { ok: true, title: value.title, url: value.url, text: value.text, status: value.status, ...(value.screenshot ? { screenshot: fileMeta(value.screenshot, true) } : {}) };
}

// Selectors, text and URLs cross via upload bytes, never shell interpolation/argv.
// The only variable in this command is our random hex request filename.
export async function remoteBrowserRequest(machine, input) {
  const request = validateBrowserRequest(input);
  const path = `${SESSION_DIR}/request-${randomBytes(12).toString("hex")}.json`;
  try {
    await ensureDriver(machine);
    await machine.upload(path, Buffer.from(JSON.stringify(request)));
    const command = `sh -c ${shq(`node ${DRIVER_PATH} request < ${path}; rc=$?; rm -f ${path}; exit $rc`)}`;
    const r = await machine.exec(command, 40);
    if (r?.exitCode !== 0 || typeof r.result !== "string" || Buffer.byteLength(r.result) > RESPONSE_BYTES) throw new Error();
    return checkedReply(JSON.parse(r.result), request.action);
  } catch {
    // A timed-out transport never retries an action that may already have run.
    started.delete(machine.id);
    throw new Error("The remote browser did not answer. The action may have run.");
  }
}

export const pauseRoamBrowser = (machine) => remoteBrowserRequest(machine, { action: "pause" });
export const resumeRoamBrowser = (machine) => remoteBrowserRequest(machine, { action: "resume" });
export const roamBrowserStatus = (machine) => remoteBrowserRequest(machine, { action: "status" });
export const captureRoamBrowser = (machine) => remoteBrowserRequest(machine, { action: "capture" });
export const closeRoamBrowser = (machine) => remoteBrowserRequest(machine, { action: "close" });

export function roamBrowserTools(ws, { record, egress, machine = roamMachine }) {
  const logged = new Set();
  const turns = new Map();
  const owed = new Set();
  async function run(agent, request) {
    let m;
    try { m = await machine(ws, agent); } catch { throw new Error("The remote browser machine is not available."); }
    if (m.replaced) owed.add(agent);
    if (!logged.has(m.id)) {
      try { await egress.start(m); } catch { throw new Error("The request log did not start. No log, no browser."); }
      logged.add(m.id);
    }
    let result;
    try { result = await remoteBrowserRequest(m, request); }
    catch {
      record({ agent, kind: "browser", t: Date.now(), sandbox: m.id, action: request.action, url: "", status: null, output: "" });
      throw new Error("The remote browser did not answer. The action may have run.");
    }
    const output = result.ok ? `${result.title}\n${result.url}\n${result.text}${result.screenshot ? "\nScreenshot kept on the remote machine. It is not published." : ""}` : `Browser: ${result.error}`;
    const s = record({ agent, kind: "browser", t: Date.now(), sandbox: m.id, action: request.action,
      url: result.ok ? result.url : "", status: result.ok ? result.status : null, output,
      ...(result.screenshot ? { screenshot: result.screenshot } : {}),
    });
    let note = "";
    try {
      for (const rec of await egress.pull(m)) record({ agent, kind: "egress", t: rec.t, method: rec.method, url: rec.url, status: rec.status });
    } catch {
      logged.delete(m.id);
      note = "\nThe request log could not be read after this action. It is read again on the next call.";
    }
    return `${owed.delete(agent) ? "The machine was replaced. Files from before are gone.\n" : ""}session ${s.poc}\n${String(s.output).slice(0, 16000)}${note}`;
  }
  return [defineTool({
    name: "browse",
    description: "Use one persistent headed Chromium page on your remote machine. Actions: open (HTTP/S URL), read, click (selector), type (selector and text; replaces the field), screenshot (kept remote, not published). Visible text is capped at 8000 characters. Ask the human for login, payment or account actions. No browser action is allowed during human takeover. Use the returned session id for submit_session_candidate.",
    parameters: obj({ action: oneOf(["open", "read", "click", "type", "screenshot"]), url: opt(str()), selector: opt(str()), text: opt(str()) }),
    replay: "unsafe",
    execute: async (input) => {
      const agent = currentAgent();
      if (!agent) throw new Error("browse is only for a free-roam child agent. This call has no agent.");
      const request = validateBrowserRequest(input, false);
      const job = (turns.get(agent) ?? Promise.resolve()).then(() => run(agent, request));
      turns.set(agent, job.catch(() => {}));
      return { output: [{ type: "text", text: await job }] };
    },
  })];
}
