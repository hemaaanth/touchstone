// Fake local source bytes only. No browser, network, machine or real run data.
import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import * as fs from "node:fs";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync, symlinkSync, linkSync, truncateSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SESSION_ARTIFACT_LIMITS as L, writeSessionArtifacts, listSessionArtifacts, readSessionArtifact, releaseSessionScreenshot, sessionArtifactBinding, captureSessionArtifacts } from "../lib/session-artifacts.mjs";
import { recordSession, sessionLookup, candidateTool, SESSION_POC } from "../lib/candidate.mjs";
import { withAgent } from "../lib/event.mjs";

const who = { run: "run-test", agent: "a-1", poc: "session:a-1:1" };
const SECRET = "UpperCaseSecretValue99";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const shot = (n = 1) => ({ path: `/var/lib/touchstone/session/shot-${n}.png`, bytes: PNG, approved: true, approval: "released" });
const har = (url = "https://example.org/") => JSON.stringify({ log: { entries: [{ request: { method: "GET", url }, response: { status: 200 } }] } });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "session-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const save = (root, extra = {}) => writeSessionArtifacts(root, { ...who, transcript: "exported 4120 customer rows", ...extra });
const dirOf = (root) => join(root, who.run, who.agent, "s-1");
const manifestPath = (root) => join(dirOf(root), "manifest.json");
const refusal = (fn) => assert.throws(fn, { message: "session artifact unavailable" });

test("bounded private atomic snapshots expose opaque IDs and frozen owner binding", (t) => {
  const root = fixture(t);
  const manifest = save(root, { har: har(), screenshots: [shot()] });
  assert.deepEqual(Object.keys(manifest), ["version", "run", "agent", "sequence", "files"]);
  assert.deepEqual(sessionArtifactBinding(manifest), { version: 1, ...who, manifest: "m-1" });
  assert.deepEqual(listSessionArtifacts(root, who), manifest);
  assert.ok(!JSON.stringify(manifest).includes("/var/lib/"));
  assert.ok(!JSON.stringify(manifest).includes(root));
  assert.deepEqual(readdirSync(join(root, who.run, who.agent)), ["s-1"]);
  assert.equal(statSync(dirOf(root)).mode & 0o777, 0o700);
  assert.equal(statSync(manifestPath(root)).mode & 0o777, 0o600);
  for (const file of manifest.files) {
    assert.equal(statSync(join(dirOf(root), file.id)).mode & 0o777, 0o600);
    assert.match(file.id, /^a-[0-9a-f-]+$/);
    if (file.kind === "screenshot") continue;
    const result = readSessionArtifact(root, { ...who, id: file.id });
    assert.equal(result.data.length, file.bytes);
    assert.equal(createHash("sha256").update(result.data).digest("hex"), file.sha256);
    assert.equal(result.mime, file.mime);
  }
  assert.deepEqual(save(root, { transcript: "must not replace cited bytes" }), manifest);
  const file = manifest.files.find((f) => f.kind === "transcript");
  assert.equal(readSessionArtifact(root, { ...who, id: file.id }).data.toString(), "exported 4120 customer rows");
});

test("HAR bodies, all headers and cookies are dropped; known and encoded secrets are scrubbed", (t) => {
  const root = fixture(t);
  const forms = [SECRET, SECRET.toLowerCase(), encodeURIComponent(SECRET), Buffer.from(SECRET).toString("base64"), Buffer.from(SECRET).toString("hex")];
  const source = JSON.parse(har(`http://user:${SECRET}@${SECRET.toLowerCase()}.example.org/${SECRET}?token=${SECRET}`));
  const e = source.log.entries[0];
  e.request.headers = [{ name: "Cookie", value: "raw-cookie-secret" }, { name: "Authorization", value: "Bearer raw-auth-secret" }, { name: "X-Unknown", value: "raw-header-secret" }];
  e.request.cookies = [{ name: "plain", value: "raw-cookie-secret" }];
  e.request.postData = { params: [{ name: "plain", value: "raw-body-secret" }], text: "raw-body-secret" };
  e.response.content = { text: "raw-response-secret", encoding: "base64" };
  e.response.cookies = [{ name: "plain", value: "raw-cookie-secret" }];
  e.response.headers = [{ name: "Set-Cookie", value: "raw-cookie-secret" }];
  const manifest = save(root, { transcript: forms.join(" "), har: JSON.stringify(source), secrets: [SECRET] });
  const visible = manifest.files.map((f) => readSessionArtifact(root, { ...who, id: f.id }).data.toString()).join("\n");
  for (const secret of [...forms, "raw-cookie-secret", "raw-auth-secret", "raw-header-secret", "raw-body-secret", "raw-response-secret"]) assert.ok(!visible.includes(secret), secret);
  const harFile = manifest.files.find((f) => f.kind === "har");
  const clean = JSON.parse(readSessionArtifact(root, { ...who, id: harFile.id }).data).log.entries[0];
  assert.deepEqual(clean.request.headers, []);
  assert.deepEqual(clean.request.cookies, []);
  assert.equal(clean.request.postData, undefined);
  assert.equal(clean.response.content.text, undefined);
  assert.equal(clean.response.status, 200);
});

test("pixels stay unavailable without exact explicit approval; release survives reopen", (t) => {
  const root = fixture(t);
  const manifest = save(root, { screenshots: [shot()] });
  const file = manifest.files.find((f) => f.kind === "screenshot");
  const selector = { ...who, id: file.id, sha256: file.sha256 };
  assert.equal(file.approval, "pending", "untrusted source approval is ignored");
  refusal(() => readSessionArtifact(root, selector));
  for (const patch of [{}, { approved: false }, { approved: "true" }, { approved: true, sha256: "0".repeat(64) }, { approved: true, agent: "a-11" }, { approved: true, poc: "session:a-1:2" }, { approved: true, run: "another-run" }, { approved: true, id: "a-00000000-0000-0000-0000-000000000000" }]) refusal(() => releaseSessionScreenshot(root, { ...selector, ...patch }));
  const released = releaseSessionScreenshot(root, { ...selector, approved: true });
  assert.equal(released.files.find((f) => f.id === file.id).approval, "released");
  assert.equal(listSessionArtifacts(root, who).files.find((f) => f.id === file.id).approval, "released");
  assert.deepEqual(readSessionArtifact(root, selector).data, PNG);
  assert.deepEqual(releaseSessionScreenshot(root, { ...selector, approved: true }), released);
  const text = manifest.files.find((f) => f.kind === "transcript");
  refusal(() => releaseSessionScreenshot(root, { ...who, id: text.id, sha256: text.sha256, approved: true }));
});

test("owner selectors cannot cross run, agent, sequence or filesystem boundaries", (t) => {
  const root = fixture(t);
  const first = save(root);
  save(root, { agent: "a-11", poc: "session:a-11:1" });
  const file = first.files[0];
  for (const patch of [{ run: "../elsewhere" }, { agent: "../a-1" }, { poc: "session:a-11:1" }, { poc: "session:a-1:01" }, { poc: "session:a-1:1/../../x" }, { poc: "session:a-1:2" }, { agent: "a-11", poc: "session:a-11:1" }, { id: "../manifest.json" }, { id: "/etc/passwd" }, { run: "other" }]) refusal(() => readSessionArtifact(root, { ...who, id: file.id, ...patch }));
});

test("malformed, traversal and oversized manifests are rejected before reads", (t) => {
  const root = fixture(t);
  const clean = save(root);
  const bad = [null, [], {}, { ...clean, version: 2 }, { ...clean, run: "wrong" }, { ...clean, agent: "a-11" }, { ...clean, sequence: 2 }, { ...clean, extra: "no" }, { ...clean, files: [] }, { ...clean, files: [clean.files[0], clean.files[0]] }, ...[
    { id: "../../outside" }, { id: `a-${"-".repeat(36)}` }, { kind: ["transcript"] }, { bytes: -1 }, { bytes: L.text + 1 }, { bytes: "1" }, { sha256: "invalid" }, { mime: "text/html" }, { kind: "html" }, { approval: "released" }, { path: "../../outside" },
  ].map((patch) => ({ ...clean, files: [{ ...clean.files[0], ...patch }] }))];
  for (const value of bad) {
    writeFileSync(manifestPath(root), JSON.stringify(value), { mode: 0o600 });
    refusal(() => listSessionArtifacts(root, who));
  }
  for (const value of ["{broken", " ".repeat(L.manifest + 1)]) {
    writeFileSync(manifestPath(root), value);
    refusal(() => listSessionArtifacts(root, who));
  }
});

test("symlinks, hardlinks, public permissions and tampered artifact bytes fail closed", (t) => {
  const root = fixture(t);
  const manifest = save(root);
  const file = manifest.files[0], path = join(dirOf(root), file.id);
  writeFileSync(path, "x".repeat(file.bytes));
  refusal(() => readSessionArtifact(root, { ...who, id: file.id })); // Same size, wrong hash.
  writeFileSync(path, "tampered");
  refusal(() => readSessionArtifact(root, { ...who, id: file.id })); // Wrong size.
  truncateSync(path, L.text + 1);
  refusal(() => readSessionArtifact(root, { ...who, id: file.id })); // Bounded read.
  rmSync(path);
  symlinkSync(manifestPath(root), path);
  refusal(() => readSessionArtifact(root, { ...who, id: file.id }));
  rmSync(path);
  linkSync(manifestPath(root), path);
  refusal(() => listSessionArtifacts(root, who));
  rmSync(path);
  chmodSync(manifestPath(root), 0o644);
  refusal(() => listSessionArtifacts(root, who));
  chmodSync(manifestPath(root), 0o600);
  const alias = join(root, "alias");
  symlinkSync(join(root, who.run), alias);
  refusal(() => listSessionArtifacts(alias, who));
});

test("oversized and malformed sources never produce an artifact snapshot", (t) => {
  const root = fixture(t);
  const bad = [
    { transcript: "x".repeat(L.text + 1) }, { har: "x".repeat(L.text + 1) }, { har: "{}" }, { har: "{" },
    { har: JSON.stringify({ log: { entries: Array(L.entries + 1).fill({}) } }) },
    { screenshots: [shot(13)] }, { screenshots: [shot(), shot()] },
    { screenshots: [{ ...shot(), path: "/var/lib/touchstone/session/../shot-1.png" }] },
    { screenshots: [{ ...shot(), bytes: Buffer.alloc(L.screenshot + 1) }] },
    { screenshots: [{ ...shot(), bytes: Buffer.from("<svg onload=evil>") }] },
    { screenshots: Array(13).fill(shot()) },
  ];
  for (const extra of bad) refusal(() => save(root, extra));
  refusal(() => listSessionArtifacts(root, who));
  assert.deepEqual(readdirSync(join(root, who.run, who.agent)), []);
});

test("run byte budget rejects another snapshot rather than growing without bound", (t) => {
  const root = fixture(t);
  save(root);
  const path = join(root, who.run, "budget-test");
  writeFileSync(path, "", { mode: 0o600 });
  truncateSync(path, L.run); // Sparse fixture, not a large allocation.
  refusal(() => save(root, { poc: "session:a-1:2" }));
  assert.deepEqual(readdirSync(join(root, who.run, who.agent)), ["s-1"]);
});

test("long transcripts use the shared whole-text mask rather than unsafe splitting", (t) => {
  const root = fixture(t);
  const manifest = save(root, { transcript: "unknown text ".repeat(6000) });
  const text = readSessionArtifact(root, { ...who, id: manifest.files[0].id }).data.toString();
  assert.match(text, /^\[REDACTED/);
  assert.ok(!text.includes("unknown text"));
});

test("failed staging writes leave no readable partial snapshot or abandoned files", async (t) => {
  const root = fixture(t);
  const write = fs.writeFileSync;
  let writes = 0;
  const { default: unusedDefault, ...namedFS } = fs;
  const mocked = mock.module("node:fs", { namedExports: { ...namedFS, writeFileSync: (...args) => {
    if (String(args[0]).includes(".stage-") && ++writes === 2) throw new Error("fake disk failure");
    return write(...args);
  } } });
  try {
    const isolated = await import("../lib/session-artifacts.mjs?fake-disk-failure");
    refusal(() => isolated.writeSessionArtifacts(root, { ...who, transcript: "safe text", har: har() }));
    assert.equal(writes, 2);
    refusal(() => listSessionArtifacts(root, who));
    assert.deepEqual(readdirSync(join(root, who.run, who.agent)), []);
  } finally { mocked.restore(); }
});

test("browser-only capture attaches safe evidence, does not advance, and remains unproven", async (t) => {
  const root = fixture(t);
  const state = { found: [], passed: new Map(), sessionSecrets: [SECRET] };
  const { poc } = recordSession(state, { agent: who.agent, kind: "browser", sandbox: "machine", action: "read", output: `exported 4120 customer rows\nAPI_KEY=${SECRET}`, url: "https://example.org/", status: 200 });
  const manifest = withAgent(who.agent, () => captureSessionArtifacts(root, { ...who, poc, state, har: har(), screenshots: [shot()] }));
  assert.equal(state.sessionSequence.get(who.agent), 1);
  const lookup = withAgent(who.agent, () => sessionLookup(state)(poc));
  assert.deepEqual(lookup.evidence.artifacts, sessionArtifactBinding(manifest));
  assert.equal(lookup.evidence.har.entries, 1);
  assert.deepEqual(lookup.evidence.screenshots, []);
  assert.deepEqual(withAgent(who.agent, () => captureSessionArtifacts(root, { ...who, poc, state, har: har(), screenshots: [shot()] })), manifest);
  refusal(() => withAgent("a-11", () => captureSessionArtifacts(root, { ...who, poc, state })));
  refusal(() => captureSessionArtifacts(root, { ...who, poc, state }));
  const tool = candidateTool({ name: "submit_session_candidate", pack: "web", state, lookup: sessionLookup(state), poc: SESSION_POC });
  const result = await withAgent(who.agent, () => tool.execute({ title: "Open customer export", severity: "high", poc, evidence_lines: ["exported 4120 customer rows"], explanation: "Anyone can export private rows.\nFix: require login." }));
  assert.ok(!result.isError);
  assert.equal(state.candidates[0].proven, false);
  assert.deepEqual(state.candidates[0].evidence.artifacts, lookup.evidence.artifacts);
  assert.ok(!JSON.stringify(state.candidates).includes(SECRET));
  const next = recordSession(state, { agent: who.agent, kind: "browser", action: "read", output: "new page result" });
  assert.equal(next.poc, "session:a-1:2");
  assert.equal(withAgent(who.agent, () => sessionLookup(state)(next.poc)).evidence.artifacts, undefined);
});
