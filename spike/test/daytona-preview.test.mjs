import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { roamAccountBinding } from "../lib/daytona-state.mjs";
import { execConfig, findRoamMachine, shq } from "../lib/daytona.mjs";

const ERROR = "The free-roam control request failed.";
const PRIVATE = "X".repeat(43);
const json = (x) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json" } });
const fixed = async (p) => assert.rejects(p, (e) => {
  assert.equal(e.message, ERROR);
  assert.equal(e.cause, undefined);
  return true;
});

async function fixture(fn) {
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-preview-"));
  const names = ["TOUCHSTONE_EXEC", "DAYTONA_API_KEY", "DAYTONA_API_URL"];
  const saved = names.map((k) => process.env[k]);
  const fetch = globalThis.fetch;
  const f = {
    calls: [], uploads: [], execs: [], hook: null,
    meta: { id: "m-1", state: "started", toolboxProxyUrl: "https://tb.test", labels: { touchstone: "1", agent: "a-1", run: createHash("sha256").update(ws).digest("hex").slice(0, 12), loadout: "free-roam" } },
    desktop: { kind: "configured", port: 8890, expires: Date.now() + 850_000 },
    artifact: Buffer.from("untrusted artifact bytes"),
    sourceKind: "file", snapshot: null,
  };
  const sidecar = (data = { "roam:a-1": { id: "m-1", toolbox: "https://untrusted.invalid/ignored", account: roamAccountBinding(execConfig()) } }) => writeFileSync(`${ws}.daytona.json`, JSON.stringify(data));
  try {
    process.env.TOUCHSTONE_EXEC = "daytona";
    process.env.DAYTONA_API_KEY = "FAKE_PRIVATE_DAYTONA_KEY";
    process.env.DAYTONA_API_URL = "https://api.test/api";
    sidecar();
    globalThis.fetch = async (url, init) => {
      const u = new URL(url);
      f.calls.push({ url, init });
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer FAKE_PRIVATE_DAYTONA_KEY");
      assert.ok(init.signal instanceof AbortSignal);
      const response = await f.hook?.(u, init);
      if (response) return response;
      if (u.href === "https://api.test/api/sandbox/m-1" && init.method === "GET") return json(f.meta);
      if (u.pathname.endsWith("/signed-preview-url")) {
        const port = Number(u.pathname.split("/").at(-2));
        return json({ sandboxId: "m-1", port, token: "signed-123", url: `https://${port}-signed-123.proxy.test` });
      }
      if (u.pathname.endsWith("/expire")) return new Response(null, { status: 204 });
      if (u.pathname.endsWith("/files/upload-v2")) {
        f.uploads.push({ path: u.searchParams.get("path"), bytes: Buffer.from(await init.body.get("file").arrayBuffer()) });
        return json({});
      }
      if (u.pathname.endsWith("/files/download")) return new Response(f.snapshot);
      if (u.pathname.endsWith("/process/execute")) {
        const body = JSON.parse(init.body);
        assert.equal(body.timeout, 45);
        f.execs.push(body.command);
        if (body.command.includes("/opt/touchstone/roam/desktop/entry.mjs")) return json({ exitCode: 0, result: JSON.stringify(f.desktop) });
        if (body.command.startsWith("node -e ")) {
          // Exercise the actual fixed remote program with fake file descriptors.
          // No program or untrusted artifact is executed on the host filesystem.
          const end = body.command.indexOf(" '/var/lib/touchstone/session/");
          const source = body.command.slice(8, end).slice(1, -1).replaceAll("'\\''", "'");
          const args = body.command.slice(end + 1).split(" ").map((s) => s.replace(/^'|'$/g, ""));
          let fd = 0, reads = 0;
          let stdout = "";
          const proc = { argv: ["node", ...args], stdout: { write: (s) => { stdout += s; } }, exitCode: 0 };
          const fs = {
            constants,
            openSync(path, flags) {
              if (path === "/") assert.ok(flags & constants.O_DIRECTORY);
              else {
                assert.ok(flags & constants.O_NOFOLLOW);
                if (path.startsWith("/proc/self/fd/")) {
                  if (f.sourceKind === "parent symlink" && path.endsWith("/session")) throw Error("outside source root");
                  if (f.sourceKind === "file symlink" && /\.(png|har)$/.test(path)) throw Error("outside source root");
                } else {
                  assert.equal(path, args[1]);
                  assert.ok(flags & constants.O_EXCL);
                }
              }
              return ++fd;
            },
            fstatSync: () => ({ isFile: () => f.sourceKind !== "fifo", size: f.artifact.length, mtimeMs: 1 }),
            readSync(_fd, data, at, length) {
              const source = f.sourceKind === "growing" ? Buffer.alloc(Number(args[2]) + 1) : f.artifact;
              const count = Math.min(length, source.length - reads);
              source.copy(data, at, reads, reads + count);
              reads += count;
              return count;
            },
            writeFileSync(_fd, data) { f.snapshot = Buffer.from(data); },
            closeSync() {},
          };
          runInNewContext(source, { Buffer, process: proc, require: (name) => name === "node:fs" ? fs : { createHash } }, { timeout: 1000 });
          return json({ exitCode: proc.exitCode, result: stdout });
        }
        return json({ exitCode: 0, result: "" });
      }
      throw Error(`Unexpected fake request: ${u.pathname}`);
    };
    await fn({ ws, f, sidecar, lookup: () => findRoamMachine(ws, "a-1") });
  } finally {
    globalThis.fetch = fetch;
    names.forEach((k, i) => saved[i] === undefined ? delete process.env[k] : process.env[k] = saved[i]);
    rmSync(`${ws}.daytona.json`, { force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

test("lookup never creates, starts, replaces, or uses a sidecar toolbox URL", async () => {
  await fixture(async ({ ws, f, lookup, sidecar }) => {
    assert.equal(await findRoamMachine(ws, "a-2"), null);
    assert.equal(f.calls.length, 0);
    const m = await lookup();
    assert.deepEqual(Object.keys(m).sort(), ["expirePreview", "id", "previewGrant", "readArtifact", "request"]);
    assert.equal(m.id, "m-1");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.method, "GET");
    f.meta.state = "stopped";
    assert.equal(await lookup(), null);
    f.meta.state = "started";
    sidecar({ "a-1": { id: "confined" } });
    assert.equal(await lookup(), null);
    assert.ok(f.calls.every(({ init }) => init.method === "GET"));
  });
});

test("lookup refuses invalid identifiers and wrong ownership without an action", async () => {
  await fixture(async ({ ws, f, lookup, sidecar }) => {
    for (const agent of ["../a", "a/1", "a%2f1", "a".repeat(61), "", 1]) await fixed(findRoamMachine(ws, agent));
    await fixed(findRoamMachine("relative", "a-1"));
    assert.equal(f.calls.length, 0);
    for (const id of ["../m", "m/1", "m?x", "m".repeat(129), 123]) {
      sidecar({ "roam:a-1": { id } });
      await fixed(lookup());
    }
    assert.equal(f.calls.length, 0);
    sidecar();
    for (const [key, value] of [["agent", "a-2"], ["run", "other"], ["loadout", "confined"], ["touchstone", "0"]]) {
      const previous = f.meta.labels[key];
      f.meta.labels[key] = value;
      await fixed(lookup());
      f.meta.labels[key] = previous;
    }
    f.meta.id = "m-2";
    await fixed(lookup());
    assert.ok(f.calls.every(({ init }) => init.method === "GET"));
  });
});

test("unsafe toolbox URLs are refused before sending credentials to a toolbox", async () => {
  await fixture(async ({ f, lookup }) => {
    for (const url of ["http://tb.test", "https://user:pass@tb.test", "https://tb.test?secret=1", "https://tb.test/#secret", "https://tb.test/a/../b", null]) {
      f.meta.toolboxProxyUrl = url;
      await fixed(lookup());
    }
    assert.ok(f.calls.every(({ url }) => url === "https://api.test/api/sandbox/m-1"));
  });
});

test("every handle operation rechecks ownership and refuses a replaced sidecar", async () => {
  await fixture(async ({ f, lookup, sidecar }) => {
    const m = await lookup();
    const actions = [() => m.request(Buffer.from('{"action":"status"}')), () => m.previewGrant(8890), () => m.expirePreview(8890, "signed-123"), () => m.readArtifact("/var/lib/touchstone/session/browser.har", 100)];
    f.meta.labels.agent = "a-2";
    for (const action of actions) await fixed(action());
    assert.ok(f.calls.every(({ init }) => init.method === "GET"));
    sidecar({ "roam:a-1": { id: "m-2" } });
    const count = f.calls.length;
    for (const action of actions) await fixed(action());
    assert.equal(f.calls.length, count);
  });
});

test("signed single-port grant and encoded revocation only", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    const before = Date.now();
    const grant = await m.previewGrant(8890);
    assert.equal(grant.url, "https://8890-signed-123.proxy.test");
    assert.equal(grant.revokeToken, "signed-123");
    assert.ok(grant.expires >= before + 60_000 && grant.expires <= Date.now() + 60_000);
    assert.deepEqual(Object.keys(grant).sort(), ["expires", "revokeToken", "url"]);
    assert.ok(f.calls.some(({ url }) => url.endsWith("/ports/8890/signed-preview-url?expiresInSeconds=60")));
    f.meta.state = "stopped";
    await m.expirePreview(8890, "opaque/with?reserved#%+");
    assert.equal(f.calls.at(-1).url, "https://api.test/api/sandbox/m-1/ports/8890/signed-preview-url/opaque%2Fwith%3Freserved%23%25%2B/expire");
    assert.equal(f.calls.at(-1).init.method, "POST");
    assert.ok(!f.calls.some(({ url }) => /\/preview-url(?:\?|$)/.test(url)));
  });
});

test("a rejected issued grant is revoked only when its sandbox and port match", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    f.hook = (u) => u.pathname.endsWith("/signed-preview-url") ? json({ sandboxId: "m-1", port: 8890, token: "signed-123", url: "http://unsafe.test" }) : null;
    await fixed(m.previewGrant(8890));
    assert.equal(f.calls.at(-1).url, "https://api.test/api/sandbox/m-1/ports/8890/signed-preview-url/signed-123/expire");
    const count = f.calls.filter(({ init }) => init.method === "POST").length;
    f.hook = (u) => u.pathname.endsWith("/signed-preview-url") ? json({ sandboxId: "other", port: 8890, token: "signed-123", url: "http://unsafe.test" }) : null;
    await fixed(m.previewGrant(8890));
    assert.equal(f.calls.filter(({ init }) => init.method === "POST").length, count);
  });
});

test("bad port, TTL and revoke tokens are refused before HTTP", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    const count = f.calls.length;
    for (const port of [0, -1, 65536, 1.5, "8890", NaN]) await fixed(m.previewGrant(port));
    for (const ttl of [0, -1, 901, 1.5, "60", Infinity]) await fixed(m.previewGrant(8890, ttl));
    for (const token of ["", "..", ".", "a\nb", "a b", "x".repeat(513), null]) await fixed(m.expirePreview(8890, token));
    assert.equal(f.calls.length, count);
  });
});

test("signed response exactness rejects wrong IDs, ports, broad URLs and extra fields", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    const good = { sandboxId: "m-1", port: 8890, token: "signed-123", url: "https://8890-signed-123.proxy.test" };
    for (const change of [
      { sandboxId: "m-2" }, { port: "8890" }, { port: 8891 }, { token: "" }, { token: "standard-token" }, { previewToken: "STANDARD_SECRET" },
      ...["http://8890-signed-123.proxy.test", "https://8890-signed-123.proxy.test/path", "https://8890-signed-123.proxy.test?token=SECRET", "https://8890-signed-123.proxy.test#SECRET", "https://user:pass@8890-signed-123.proxy.test", "https://8890-signed-123.proxy.test:444", "https://8890-other.proxy.test", "https://8891-signed-123.proxy.test", "https://8890-signed-123.proxy.test/../", "https://8890-signed-123.localhost", "https://terminal.proxy.test"].map((url) => ({ url })),
    ]) {
      f.hook = (u) => u.pathname.endsWith("/signed-preview-url") ? json({ ...good, ...change }) : null;
      await fixed(m.previewGrant(8890));
    }
  });
});

test("control errors, malformed JSON, oversized bodies, and redirects never leak text", async () => {
  await fixture(async ({ f, lookup }) => {
    for (const response of [
      () => new Response("PRIVATE_ERROR_WITH_KEY", { status: 500 }),
      () => new Response("PRIVATE_BAD_JSON"),
      () => new Response("x".repeat(65537)),
      () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
      () => { throw Error("PRIVATE_FETCH_CREDENTIAL"); },
    ]) {
      f.hook = response;
      await fixed(lookup());
    }
    f.hook = () => new Response("not found SECRET", { status: 404 });
    assert.equal(await lookup(), null);
  });
});

test("oversized streamed control response is cancelled, not truncated or fully drained", async () => {
  await fixture(async ({ f, lookup }) => {
    let cancelled = false;
    let pulls = 0;
    f.hook = () => new Response(new ReadableStream({
      pull(c) { pulls++; c.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }));
    await fixed(lookup());
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2);
  });
});

test("desktop upload is private; fixed stdin command and cleanup contain no credentials", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    const input = { action: "open", previewOrigin: "https://8890-signed-123.proxy.test", appOrigins: ["https://console.test"], token: PRIVATE, viewOnly: true };
    f.desktop = { kind: "open", port: 8890, expires: Date.now() + 800_000, viewOnly: true };
    assert.deepEqual(await m.request(Buffer.from(JSON.stringify(input))), f.desktop);
    assert.deepEqual(JSON.parse(f.uploads[0].bytes), input);
    assert.match(f.uploads[0].path, /^\/tmp\/touchstone-control-[a-f0-9]{32}\/request$/);
    assert.match(f.execs[0], /umask 077; mkdir/);
    const command = f.execs.find((c) => c.includes("/opt/touchstone/roam/desktop/entry.mjs"));
    assert.match(command, /chmod 600/);
    assert.match(command, /trap /);
    assert.match(command, /node \/opt\/touchstone\/roam\/desktop\/entry.mjs < /);
    assert.match(f.execs.at(-1), /rm -rf --/);
    assert.ok(f.execs.every((s) => !s.includes(PRIVATE) && !s.includes("FAKE_PRIVATE_DAYTONA_KEY") && !s.includes("console.test")));
  });
});

test("desktop configure, status and close return only exact safe protocol shapes", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    for (const action of ["configure", "status", "close"]) {
      if (action === "close") f.desktop = { kind: "closed" };
      assert.deepEqual(await m.request(Buffer.from(JSON.stringify({ action }))), f.desktop);
    }
    f.desktop = { kind: "closed" };
    await fixed(m.request(Buffer.from('{"action":"configure"}')));
    assert.match(f.execs.at(-1), /rm -rf --/);
  });
});

test("desktop protocol rejects invalid input before action and unsafe output after cleanup", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    const count = f.calls.length;
    for (const bytes of [Buffer.alloc(8193), Buffer.from("SECRET_NOT_JSON"), Buffer.from('{"action":"shell"}'), Buffer.from('{"action":"status","token":"SECRET"}'), "not bytes"]) await fixed(m.request(bytes));
    assert.equal(f.calls.length, count);
    for (const output of [{ kind: "closed", token: "SECRET" }, { kind: "open", port: 0, expires: Date.now() + 1000, viewOnly: true }, { kind: "open", port: 8890, expires: Date.now() + 900_001_000, viewOnly: true }, { kind: "closed", extra: 1 }]) {
      f.desktop = output;
      await fixed(m.request(Buffer.from('{"action":"status"}')));
      assert.match(f.execs.at(-1), /rm -rf --/);
    }
  });
});

test("upload and startup execution failures still clean up and hide response bodies", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    for (const failure of ["upload", "exec", "large exec"]) {
      f.hook = (u, init) => {
        if (failure === "upload" && u.pathname.endsWith("upload-v2")) return new Response("PRIVATE_UPLOAD_ERROR", { status: 500 });
        if (u.pathname.endsWith("execute") && init.body.includes("/opt/touchstone/roam/desktop/entry.mjs")) {
          return failure === "exec" ? new Response("PRIVATE_PARSE_ERROR") : failure === "large exec" ? json({ exitCode: 0, result: "x".repeat(8193) }) : null;
        }
      };
      await fixed(m.request(Buffer.from('{"action":"configure"}')));
      assert.match(f.execs.at(-1), /rm -rf --/);
    }
  });
});

test("image review and clear use private stdin with exact action-bound acknowledgements", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    const sha256 = "a1".repeat(32);
    for (const n of [1, 9, 10, 12]) {
      const input = { action: "review-image", path: `/var/lib/touchstone/session/shot-${n}.png`, sha256 };
      f.desktop = { kind: "review-image", sha256, bytes: 5242880 };
      assert.deepEqual(await m.request(Buffer.from(JSON.stringify(input))), f.desktop);
      assert.deepEqual(JSON.parse(f.uploads.at(-1).bytes), input);
      assert.match(f.execs.at(-1), /rm -rf --/);
      assert.ok(f.execs.every((s) => !s.includes(input.path) && !s.includes(sha256)));
    }
    f.desktop = { kind: "review-cleared" };
    assert.deepEqual(await m.request(Buffer.from('{"action":"clear-review"}')), f.desktop);
    assert.deepEqual(JSON.parse(f.uploads.at(-1).bytes), { action: "clear-review" });
    assert.match(f.execs.at(-1), /rm -rf --/);
  });
});

test("image review rejects nonallowlisted paths, invalid hashes and extra fields before HTTP", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    const input = { action: "review-image", path: "/var/lib/touchstone/session/shot-1.png", sha256: "a1".repeat(32) };
    const invalid = [
      ...["/etc/passwd", "/var/lib/touchstone/session/browser.har", "/var/lib/touchstone/session/shot-0.png", "/var/lib/touchstone/session/shot-13.png", "/var/lib/touchstone/session/shot-01.png", "/var/lib/touchstone/session/../shot-1.png", `${input.path}\n`, `${input.path}\0`, "https://example.test/shot-1.png", null].map((path) => ({ ...input, path })),
      ...["A1".repeat(32), "g".repeat(64), "a".repeat(63), "a".repeat(65), `${input.sha256}\n`, null].map((sha256) => ({ ...input, sha256 })),
      { ...input, token: "SECRET" }, { action: "review-image", path: input.path },
      { action: "clear-review", path: input.path },
    ];
    const before = f.calls.length;
    for (const request of invalid) await fixed(m.request(Buffer.from(JSON.stringify(request))));
    assert.equal(f.calls.length, before);
  });
});

test("image review refuses mismatched, oversized and cross-action acknowledgements after cleanup", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    const input = { action: "review-image", path: "/var/lib/touchstone/session/shot-1.png", sha256: "a1".repeat(32) };
    const ack = { kind: "review-image", sha256: input.sha256, bytes: 100 };
    for (const output of [
      { ...ack, sha256: "b2".repeat(32) }, { ...ack, path: input.path },
      ...[0, -1, 1.5, "100", 5242881, null].map((bytes) => ({ ...ack, bytes })),
      { kind: "review-cleared" }, { kind: "closed" }, null,
    ]) {
      f.desktop = output;
      await fixed(m.request(Buffer.from(JSON.stringify(input))));
      assert.match(f.execs.at(-1), /rm -rf --/);
    }
    for (const output of [ack, { kind: "closed" }, { kind: "review-cleared", extra: "SECRET" }]) {
      f.desktop = output;
      await fixed(m.request(Buffer.from('{"action":"clear-review"}')));
      assert.match(f.execs.at(-1), /rm -rf --/);
    }
    for (const output of [ack, { kind: "review-cleared" }]) {
      f.desktop = output;
      await fixed(m.request(Buffer.from('{"action":"status"}')));
    }
    f.meta.labels.agent = "other-agent";
    const uploads = f.uploads.length;
    await fixed(m.request(Buffer.from(JSON.stringify(input))));
    await fixed(m.request(Buffer.from('{"action":"clear-review"}')));
    assert.equal(f.uploads.length, uploads);
  });
});

test("artifact snapshot uses no-follow descriptors, bounded download, hash and cleanup", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    for (const path of ["/var/lib/touchstone/session/browser.har", "/var/lib/touchstone/session/shot-1.png", "/var/lib/touchstone/session/shot-12.png"]) {
      assert.deepEqual(await m.readArtifact(path, 100), f.artifact);
      assert.match(f.execs.at(-1), /rm -rf --/);
      const download = f.calls.findLast(({ url }) => url.includes("/files/download"));
      assert.match(new URL(download.url).searchParams.get("path"), /^\/tmp\/touchstone-control-[a-f0-9]{32}\/request$/);
    }
  });
});

test("artifact path allowlist and caps cannot be bypassed", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    const count = f.calls.length;
    for (const path of ["/etc/passwd", "/var/lib/touchstone/session/../secret", "/var/lib/touchstone/session/shot-0.png", "/var/lib/touchstone/session/shot-13.png", "/var/lib/touchstone/session/shot-01.png", "/var/lib/touchstone/session/browser.har\0", "/var/lib/touchstone/session/%2e%2e/secret", null]) await fixed(m.readArtifact(path, 100));
    for (const limit of [0, -1, 1.5, "100", 2097153, Infinity]) await fixed(m.readArtifact("/var/lib/touchstone/session/browser.har", limit));
    await fixed(m.readArtifact("/var/lib/touchstone/session/shot-1.png", 5242881));
    assert.equal(f.calls.length, count);
  });
});

test("artifact symlinks, nonfiles, growth, oversize, truncation and substitutions fail closed", async () => {
  await fixture(async ({ f, lookup }) => {
    const m = await lookup();
    for (const kind of ["parent symlink", "file symlink", "fifo", "growing"]) {
      f.sourceKind = kind;
      const before = f.calls.filter(({ url }) => url.includes("/files/download")).length;
      await fixed(m.readArtifact("/var/lib/touchstone/session/browser.har", 100));
      assert.equal(f.calls.filter(({ url }) => url.includes("/files/download")).length, before);
      assert.match(f.execs.at(-1), /rm -rf --/);
    }
    f.sourceKind = "file";
    await fixed(m.readArtifact("/var/lib/touchstone/session/browser.har", 2));
    for (const bytes of [Buffer.alloc(101), f.artifact.subarray(1), Buffer.alloc(f.artifact.length, "z")]) {
      f.hook = (u) => u.pathname.endsWith("/files/download") ? new Response(bytes) : null;
      await fixed(m.readArtifact("/var/lib/touchstone/session/browser.har", 100));
      assert.match(f.execs.at(-1), /rm -rf --/);
    }
  });
});
