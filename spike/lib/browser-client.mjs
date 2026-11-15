// The browser client of a capture: Playwright drives Chromium through mitm.
//
// WHY A BROWSER AT ALL. A script client can hold a session, but it cannot run a
// page: a login form, a wallet extension prompt, a JS-rendered route, a captcha.
// Most real applications need one. This file is the client program; the network
// wiring is lib/intercept.mjs, so the order stays
//   browser -> mitm (records the HAR) -> the run's proxy (gate or recorder)
// and the browser has no other route.
//
// TRUST. The proxy terminates TLS, so the context sets `ignoreHTTPSErrors`. That
// is honest for capture (the traffic is ours) and wrong for a PINNED key, which
// still fails. Chromium also runs `--no-sandbox`: the container already drops
// every capability, so the browser sandbox cannot set itself up.
//
// SESSION. A context is created from a storageState file when the scope has one,
// and can export the state after the steps (`save_session`). Storage state is
// the real session object (cookies plus localStorage); the pasted request
// headers stay the fallback for the script client.
//
// STEPS. Declarative, so a model writes data instead of arbitrary browser code.
// Every step writes one JSON line to stdout, so a failure names the step.
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureThrough, MITM_PORT } from "./intercept.mjs";

export const BROWSER_IMAGE = "touchstone/web-browser:1.65.1";
export const MAX_STEPS = 30;
const SHOT_LIMIT = 6;

// The steps a model may use, as data. Unknown keys are refused before any
// browser starts, so a typo is a message and not a silent no-op.
export const STEP_KINDS = ["goto", "fill", "click", "press", "waitFor", "expectText", "expectStatus", "screenshot", "evaluate"];

export function checkSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error("give at least one step");
  if (steps.length > MAX_STEPS) throw new Error(`use at most ${MAX_STEPS} steps`);
  return steps.map((raw, i) => {
    const step = raw && typeof raw === "object" ? raw : null;
    if (!step) throw new Error(`step ${i + 1} must be an object`);
    const kinds = Object.keys(step).filter((k) => STEP_KINDS.includes(k));
    if (kinds.length !== 1) throw new Error(`step ${i + 1} needs exactly one of: ${STEP_KINDS.join(", ")}`);
    const kind = kinds[0];
    const value = step[kind];
    const need = (type) => {
      if (type === "string" && (typeof value !== "string" || !value.trim())) throw new Error(`step ${i + 1} (${kind}) needs a non-empty string`);
      if (type === "number" && !Number.isInteger(value)) throw new Error(`step ${i + 1} (${kind}) needs a whole number`);
    };
    if (kind === "waitFor") need("number");
    else if (kind === "expectStatus") need("number");
    else if (kind === "fill") {
      if (!step.target) throw new Error(`step ${i + 1} (fill) needs a target selector`);
      if (typeof value !== "string") throw new Error(`step ${i + 1} (fill) needs a value`);
    } else need("string");
    return { [kind]: value, ...(step.target ? { target: step.target } : {}), ...(step.wait != null ? { wait: step.wait } : {}) };
  });
}

// The client program. CJS on purpose: `require("playwright")` resolves through
// NODE_PATH, which an ESM bare import does not.
export function clientProgram({ baseUrl, steps, saveState, shotLimit = SHOT_LIMIT }) {
  return `
const { chromium } = require("playwright");
const { writeFileSync } = require("node:fs");
const BASE = ${JSON.stringify(baseUrl)};
const STEPS = ${JSON.stringify(steps)};
const SAVE = ${saveState ? "true" : "false"};
const SHOTS = ${shotLimit};
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");

(async () => {
  const statePath = process.env.TOUCHSTONE_STATE || "";
  const shotDir = process.env.TOUCHSTONE_SHOTS || "";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--proxy-server=" + process.env.TOUCHSTONE_PROXY_URL, "--proxy-bypass-list=<-loopback>"],
  });
  let shots = 0;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(process.env.TOUCHSTONE_HAS_STATE === "1" ? { storageState: statePath } : {}),
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    for (let i = 0; i < STEPS.length; i++) {
      const s = STEPS[i];
      const kind = Object.keys(s).find((k) => ${JSON.stringify(STEP_KINDS)}.includes(k));
      const started = Date.now();
      try {
        if (kind === "goto") await page.goto(new URL(s.goto, BASE).href, { waitUntil: "domcontentloaded" });
        else if (kind === "fill") await page.fill(s.target, s.fill);
        else if (kind === "click") await page.click(s.click);
        else if (kind === "press") await page.keyboard.press(s.press);
        else if (kind === "waitFor") await page.waitForTimeout(s.waitFor);
        else if (kind === "expectText") {
          const body = await page.innerText("body");
          if (!body.includes(s.expectText)) throw new Error("page text does not contain " + JSON.stringify(s.expectText));
        } else if (kind === "expectStatus") {
          const r = await page.waitForResponse((res) => res.url().startsWith(BASE));
          if (r.status() !== s.expectStatus) throw new Error("last response was " + r.status() + ", not " + s.expectStatus);
        } else if (kind === "screenshot") {
          if (shots >= SHOTS) throw new Error("screenshot limit reached");
          shots += 1;
          await page.screenshot({ path: shotDir + "/" + String(shots).padStart(2, "0") + ".png", fullPage: false });
        } else if (kind === "evaluate") {
          const out = await page.evaluate(s.evaluate);
          say({ step: i + 1, kind, value: out === undefined ? null : out });
          continue;
        }
        say({ step: i + 1, kind, ok: true, url: page.url(), ms: Date.now() - started });
      } catch (err) {
        say({ step: i + 1, kind, ok: false, url: page.url(), error: String(err && err.message || err).slice(0, 300) });
        if (SAVE) await context.storageState({ path: statePath || undefined }).catch(() => {});
        process.exitCode = 1;
        return;
      }
    }
    say({ done: true, url: page.url(), title: await page.title().catch(() => "") });
    if (SAVE) { await context.storageState({ path: statePath || undefined }); say({ saved: true }); }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((err) => { console.error(String(err && err.stack || err)); process.exit(1); });
`;
}

const safeName = (label) => String(label ?? "browser").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 40) || "browser";

/**
 * Drive a browser through the capture proxy.
 *
 * ctx          { net, upstream, origin } — the same context captureThrough takes
 * ws           run workspace (artifacts land under captures/<label>/)
 * storageState the scope's storageState object, or null
 * steps        checked with checkSteps
 * saveSession  export the resulting storageState into the workspace
 *
 * Rejects only on setup failure. A failed step resolves with `failed` set.
 */
export async function captureBrowser(ctx, ws, { baseUrl, steps, storageState = null, saveSession = false, label = "browser", timeoutMs = 120_000 } = {}) {
  const checked = checkSteps(steps);
  const name = safeName(label);
  const dir = mkdtempSync(join(tmpdir(), "touchstone-browser-"));
  mkdirSync(join(dir, "shots"), { recursive: true });
  try {
    chmodSync(dir, 0o777);
    const statePath = join(dir, "state.json");
    if (storageState) writeFileSync(statePath, JSON.stringify(storageState));
    writeFileSync(join(dir, "client.cjs"), clientProgram({ baseUrl, steps: checked, saveState: saveSession }));
    const run = await captureThrough(
      ctx,
      {
        image: BROWSER_IMAGE,
        cmd: ["/app/_run/client.cjs"],
        workdir: "/app",
        entrypoint: "node",
        rw: true,
        env: {
          TOUCHSTONE_PROXY_URL: `http://mitm:${MITM_PORT}`,
          TOUCHSTONE_STATE: "/app/_run/state.json",
          TOUCHSTONE_HAS_STATE: storageState ? "1" : "0",
          TOUCHSTONE_SHOTS: "/app/_run/shots",
        },
      },
      { dir, timeoutMs },
    );

    // Keep the artifacts next to the run, then drop the scratch folder.
    const outDir = join(ws, "captures", name);
    mkdirSync(join(outDir, "shots"), { recursive: true });
    const shots = [];
    for (const f of readdirSync(join(dir, "shots")).sort()) {
      copyFileSync(join(dir, "shots", f), join(outDir, "shots", f));
      shots.push(`captures/${name}/shots/${f}`);
    }
    let stateOut = null;
    if (saveSession) {
      try {
        const text = readFileSync(statePath, "utf8");
        writeFileSync(join(outDir, "state.json"), text);
        stateOut = { path: `captures/${name}/state.json`, state: JSON.parse(text) };
      } catch { /* no state was written */ }
    }
    let harPath = null;
    try {
      copyFileSync(join(dir, "capture.har"), join(outDir, "capture.har"));
      harPath = `captures/${name}/capture.har`;
    } catch { /* no HAR */ }

    const log = run.stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    return { ...run, harPath, shots, state: stateOut, log, failed: log.find((l) => l.ok === false) ?? null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A browser replay for one finding, against a FRESH lab. Same return shape as
// httpProof()/liveProof(), so the proof viewer renders it unchanged. The lab is
// started here and always torn down.
export async function browserProof({ image, steps }, oracle) {
  const { startLab, stopLab } = await import("./proof-http.mjs");
  const ws = mkdtempSync(join(tmpdir(), "touchstone-browser-proof-"));
  const handle = await startLab({ image });
  try {
    const run = await captureBrowser(
      { net: handle.net, upstream: handle.netBaseUrl, probeSecret: handle.probeSecret, origin: handle.netBaseUrl },
      ws,
      { baseUrl: handle.netBaseUrl, steps, label: "proof", timeoutMs: 180_000 },
    );
    let verdict;
    try { verdict = await oracle.check(run.transcript, run); } catch (err) { verdict = { pass: false, detail: `oracle threw: ${String(err?.message ?? err).slice(0, 300)}` }; }
    const detail = verdict.detail ?? "";
    return {
      kind: "http",
      status: verdict.pass ? "pass" : "fail",
      detail,
      oracle: { name: oracle.name ?? "", detail, passed: Boolean(verdict.pass) },
      log: run.transcript.map((e, i) => ({
        label: `${i + 1}. ${e.method} ${e.path}`,
        request: { method: e.method, url: e.url, headers: e.reqHeaders, body: e.reqBody },
        response: { status: e.status, headers: e.resHeaders, body: e.resBody },
      })),
    };
  } finally {
    await stopLab(handle);
    rmSync(ws, { recursive: true, force: true });
  }
}
