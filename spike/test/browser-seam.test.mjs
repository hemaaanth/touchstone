// Tests for the browser seam: a real browser, gated by the grant.
//
// The gate (grant check + log) is tested with a stub runner, so no Brave is
// launched. A page on a granted host opens and is logged; a page with no grant
// is refused before the runner is ever called. Uses a throwaway grant store via
// TOUCHSTONE_GRANTS_FILE.
//
//   node --test spike/test/browser-seam.test.mjs
import "./helpers/isolated-env.mjs";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "browser-seam-test-"));
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => rmSync(process.env.TOUCHSTONE_GRANTS_FILE, { force: true }));

const { addGrant } = await import("../lib/grant-store.mjs");
const { BrowserSeam } = await import("../lib/browser.mjs");
const { ScopeLog } = await import("../lib/scope-proxy.mjs");

// A stub runner records the bb-browser calls it would have made.
function stubRunner() {
  const calls = [];
  const runner = async (args) => { calls.push(args); return { stdout: args[0] === "read" ? "page text" : "", stderr: "" }; };
  runner.calls = calls;
  return runner;
}

test("open on a granted host runs bb-browser and logs an allow", async () => {
  addGrant({ hosts: ["example.com"], kind: "operator-owned", ownership: true });
  const runner = stubRunner();
  const log = new ScopeLog({ sink: () => {} });
  const seam = new BrowserSeam({ log, runner });
  const host = await seam.open("https://example.com/path");
  assert.equal(host, "example.com");
  assert.deepEqual(runner.calls[0], ["open", "https://example.com/path"]);
  assert.equal(log.records[0].decision, "allow");
  assert.equal(log.records[0].host, "example.com");
  assert.deepEqual(log.reached(), ["example.com"]);
});

test("open on a host with no grant is refused before the browser launches", async () => {
  addGrant({ hosts: ["example.com"], kind: "operator-owned", ownership: true });
  const runner = stubRunner();
  const log = new ScopeLog({ sink: () => {} });
  const seam = new BrowserSeam({ log, runner });
  await assert.rejects(() => seam.open("https://evil.com/"), /blocked evil\.com/i);
  assert.equal(runner.calls.length, 0); // the runner was never called
  assert.equal(log.records[0].decision, "block");
  assert.deepEqual(log.blocked(), ["evil.com"]);
});

test("an empty allow-list blocks everything (no grant, no reach)", async () => {
  const runner = stubRunner();
  const seam = new BrowserSeam({ log: new ScopeLog({ sink: () => {} }), runner });
  await assert.rejects(() => seam.open("https://example.com/"), /blocked example\.com/i);
  assert.equal(runner.calls.length, 0);
});

test("fetchPage opens, settles, and reads a granted page", async () => {
  addGrant({ hosts: ["*.site.com"], kind: "authorized", approvedBy: "pentest" });
  const runner = stubRunner();
  const seam = new BrowserSeam({ log: new ScopeLog({ sink: () => {} }), runner });
  const out = await seam.fetchPage("https://app.site.com/dashboard", { settleMs: 500 });
  assert.equal(out.host, "app.site.com");
  assert.equal(out.text, "page text");
  assert.deepEqual(runner.calls.map((c) => c[0]), ["open", "settle", "read"]);
});

test("read before open is an error, not a silent empty read", async () => {
  addGrant({ hosts: ["example.com"], kind: "operator-owned", ownership: true });
  const seam = new BrowserSeam({ log: new ScopeLog({ sink: () => {} }), runner: stubRunner() });
  await assert.rejects(() => seam.read(), /read before open/i);
});

test("a bad url is refused and logged", async () => {
  const seam = new BrowserSeam({ log: new ScopeLog({ sink: () => {} }), runner: stubRunner() });
  await assert.rejects(() => seam.open("not a url"), /bad URL/i);
});

test("the seam defaults its allow-list to the live grants", async () => {
  // No `allowed` passed: the seam reads the active grants itself.
  addGrant({ hosts: ["live.com"], kind: "operator-owned", ownership: true });
  const runner = stubRunner();
  const seam = new BrowserSeam({ log: new ScopeLog({ sink: () => {} }), runner });
  const host = await seam.open("https://live.com/");
  assert.equal(host, "live.com");
  await assert.rejects(() => seam.open("https://other.com/"), /blocked other\.com/i);
});
