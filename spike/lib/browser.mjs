// The browser seam — a real browser, gated by the grant.
//
// WHY THIS EXISTS. The Domains, Surface, and Web modules read real sites. A
// plain headless browser trips a Cloudflare-style bot wall and is blocked, so
// the module sees a challenge page, not the site. bb-browser drives a real Brave
// with a pinned identity and a real profile, so the site answers normally. This
// file is the one seam a module uses to reach a page. A module never launches
// its own browser (WAVE2.md SEAM rule); the platform puts bb-browser behind this
// seam, and can later swap what is behind it with no change to any module.
//
// GATED LIKE THE PROXY. A browser request is target-bound traffic too, so it
// passes the same gate as a script request: before any navigation the seam
// checks the page's host against the grant allow-list (lib/grant-store.mjs) and
// records the attempt to a ScopeLog (lib/scope-proxy.mjs). A host with no grant
// is refused before Brave opens it. bb-browser's own egress cannot be pointed at
// the node proxy, so the gate for the browser path is this host check, enforced
// here, with the same allow-list and the same log shape as the proxy. The log is
// the evidence that the browser stayed in bounds.
//
// TESTABLE OFFLINE. The gate (grant check + log) is separate from the Brave
// call. The Brave call goes through an injected `runner`, so a test exercises the
// allow/block/record logic with a stub and never launches a browser.
import { execFile } from "node:child_process";
import { allowedHosts as grantAllowedHosts, requireGrant } from "./grant-store.mjs";
import { decide, ScopeLog } from "./scope-proxy.mjs";

// The default runner: shell out to bb-browser. One subcommand per call. Returns
// { stdout, stderr }. bb-browser fixes the executable, user agent, proxy, and
// profile; we pass only the subcommand and its args.
function bbRunner(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("bb-browser", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

// The browser seam. Make one per run. It holds the allow-list source and the
// log. `allowed` defaults to the live grant allow-list, so the seam and the
// scope proxy always agree. A test passes a fixed list and a stub runner.
export class BrowserSeam {
  constructor({ allowed, log, runner } = {}) {
    // A function returning the current allow-list. Default: the active grants.
    this.allowedHosts = allowed || grantAllowedHosts;
    this.log = log || new ScopeLog();
    this.runner = runner || bbRunner;
    this.openUrl = null; // the page bb-browser currently holds
  }

  // The gate. Check the page host against the grant, record the attempt, and
  // throw a clear refusal if no grant covers it. Returns the host on success.
  guard(url, method = "OPEN") {
    const host = hostOf(url);
    if (!host) {
      this.log.record({ host: null, method, url, allowed: false, reason: "bad url", status: 400 });
      throw new Error(`Browser seam: bad URL ${url}.`);
    }
    const allow = typeof this.allowedHosts === "function" ? this.allowedHosts() : this.allowedHosts;
    const verdict = decide(allow, host);
    if (!verdict.allowed) {
      this.log.record({ host, method, url, allowed: false, reason: verdict.reason, status: 403 });
      throw new Error(`Browser seam: blocked ${host}. ${verdict.reason}. No grant covers this host, so the browser will not open it.`);
    }
    // requireGrant throws the same refusal the live modules use, keeping one
    // message for "no grant". It also confirms the grant is active right now.
    requireGrant([host]);
    this.log.record({ host, method, url, allowed: true, reason: verdict.reason, status: 200 });
    return host;
  }

  // Open a page. Gated. Returns the host it opened.
  async open(url, { timeoutMs } = {}) {
    const host = this.guard(url, "OPEN");
    await this.runner(["open", url], { timeoutMs });
    this.openUrl = url;
    return host;
  }

  // Wait for the page to finish and go quiet. Not gated: it acts on the page
  // already open.
  async settle(ms = 3000) {
    await this.runner(["settle", String(ms)]);
  }

  // Read the open page's text. bb-browser `read` takes no URL; it reads the page
  // open() left. Returns the text.
  async read() {
    if (!this.openUrl) throw new Error("Browser seam: read before open. Call open(url) first.");
    const { stdout } = await this.runner(["read"]);
    return stdout;
  }

  // The accessibility snapshot of the open page.
  async snapshot() {
    if (!this.openUrl) throw new Error("Browser seam: snapshot before open. Call open(url) first.");
    const { stdout } = await this.runner(["snapshot"]);
    return stdout;
  }

  // Save a screenshot of the open page to a path.
  async screenshot(path) {
    if (!this.openUrl) throw new Error("Browser seam: screenshot before open. Call open(url) first.");
    await this.runner(["screenshot", path]);
    return path;
  }

  // Open, settle, and read in one call: the common "fetch a real page" path.
  async fetchPage(url, { settleMs = 3000, timeoutMs } = {}) {
    await this.open(url, { timeoutMs });
    await this.settle(settleMs);
    const text = await this.read();
    return { url, host: hostOf(url), text };
  }

  // Close this thread's browser windows. Safe to call when nothing is open.
  async close() {
    try { await this.runner(["thread", "close"]); } catch { /* best effort */ }
    this.openUrl = null;
  }
}
