// Private session artifacts. Only scrubbed text is written. Pixels are
// quarantined until the authenticated app records an explicit human release.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, parse, resolve } from "node:path";
import { currentAgent } from "./event.mjs";
import { scrubSessionValue, sessionLookup } from "./candidate.mjs";

export const SESSION_ARTIFACT_LIMITS = Object.freeze({ manifest: 64 * 1024, text: 2 * 1024 * 1024, screenshot: 5 * 1024 * 1024, screenshots: 12, entries: 1000, run: 256 * 1024 * 1024 });
const L = SESSION_ARTIFACT_LIMITS;
const ID = /^a-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const digest = (data) => createHash("sha256").update(data).digest("hex");
const fail = () => { throw new Error("session artifact unavailable"); };
const keys = (o, names) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join(",") === [...names].sort().join(",");
const mime = { transcript: "text/plain; charset=utf-8", har: "application/json", screenshot: "image/png" };

function owner({ run, agent, poc }) {
  if (typeof run !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run) || typeof agent !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agent)) fail();
  const prefix = `session:${agent}:`;
  if (typeof poc !== "string" || !poc.startsWith(prefix)) fail();
  const suffix = poc.slice(prefix.length);
  const sequence = Number(suffix);
  if (!/^[1-9][0-9]*$/.test(suffix) || !Number.isSafeInteger(sequence)) fail();
  return { run, agent, sequence };
}

function privateDir(path, create = false) {
  if (!isAbsolute(path) || resolve(path) !== path) fail();
  let part = parse(path).root;
  for (const name of path.slice(part.length).split("/").filter(Boolean)) {
    part = join(part, name);
    let st;
    try { st = lstatSync(part); }
    catch (e) {
      if (!create || e.code !== "ENOENT") fail();
      mkdirSync(part, { mode: 0o700 });
      st = lstatSync(part);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) fail();
  }
  if ((lstatSync(path).mode & 0o077) !== 0) fail();
  return path;
}

function location(root, selector, create = false) {
  const who = owner(selector);
  privateDir(root, create);
  const runDir = privateDir(join(root, who.run), create);
  const agentDir = privateDir(join(runDir, who.agent), create);
  return { ...who, runDir, agentDir, dir: join(agentDir, `s-${who.sequence}`) };
}

// A size check before allocation, O_NOFOLLOW, and a bounded read even if a
// file grows between stat and read. Artifact directories are host-owned.
function readBounded(file, max) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || st.size > max) fail();
    const out = Buffer.alloc(st.size + 1);
    let size = 0;
    while (size < out.length) {
      const n = readSync(fd, out, size, out.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size !== st.size || fstatSync(fd).size !== st.size) fail();
    return out.subarray(0, size);
  } catch { fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function validateManifest(value, who) {
  if (!keys(value, ["version", "run", "agent", "sequence", "files"]) || value.version !== 1 || value.run !== who.run || value.agent !== who.agent || value.sequence !== who.sequence || !Array.isArray(value.files) || value.files.length > L.screenshots + 2) fail();
  const ids = new Set();
  const counts = { transcript: 0, har: 0, screenshot: 0 };
  for (const f of value.files) {
    if (!keys(f, ["id", "kind", "sha256", "bytes", "mime", "approval"]) || typeof f.id !== "string" || !ID.test(f.id) || ids.has(f.id) || typeof f.kind !== "string" || !Object.hasOwn(mime, f.kind) || f.mime !== mime[f.kind] || typeof f.sha256 !== "string" || !HASH.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > (f.kind === "screenshot" ? L.screenshot : L.text)) fail();
    if (f.kind === "screenshot" ? !["pending", "released"].includes(f.approval) : f.approval !== "not-required") fail();
    ids.add(f.id);
    counts[f.kind]++;
  }
  if (counts.transcript !== 1 || counts.har > 1 || counts.screenshot > L.screenshots) fail();
  return value;
}

export function sessionArtifactBinding(manifest) {
  const selector = { run: manifest?.run, agent: manifest?.agent, poc: `session:${manifest?.agent}:${manifest?.sequence}` };
  validateManifest(manifest, owner(selector));
  return { version: 1, ...selector, manifest: `m-${manifest.sequence}` };
}

const json = (file) => JSON.parse(readBounded(file, L.manifest).toString("utf8"));
const shotPath = (path) => typeof path === "string" && /^\/var\/lib\/touchstone\/session\/shot-(?:[1-9]|1[0-2])\.png$/.test(path);
const machine = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
const sameOwner = (value, loc) => value.version === 1 && value.run === loc.run && value.agent === loc.agent && value.sequence === loc.sequence;
const fileIdentity = ({ approval, ...file }) => JSON.stringify(file);
const baseHash = (manifest) => digest(Buffer.from(JSON.stringify(manifest.files.map(fileIdentity))));
function presentDir(path) {
  try { lstatSync(path); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  privateDir(path);
  return true;
}
function bindingAt(loc) {
  privateDir(join(loc.dir, "binding"));
  const value = json(join(loc.dir, "binding", "binding.json"));
  if (!keys(value, ["version", "run", "agent", "sequence", "machineId"]) || !sameOwner(value, loc) || !machine(value.machineId)) fail();
  return value;
}

// Final capture is an immutable overlay. Original metadata is read afresh so
// legacy releases remain valid. New releases are monotonic separate receipts;
// neither a concurrent release nor finalization can overwrite the other.
function effective(root, selector) {
  const loc = location(root, selector);
  privateDir(loc.dir);
  const base = validateManifest(json(join(loc.dir, "manifest.json")), loc);
  let manifest = structuredClone(base), receipt = null;
  const finalDir = join(loc.dir, "final");
  if (presentDir(finalDir)) {
    manifest = validateManifest(json(join(finalDir, "manifest.json")), loc);
    receipt = json(join(finalDir, "receipt.json"));
    const binding = bindingAt(loc);
    if (!keys(receipt, ["version", "run", "agent", "sequence", "machineId", "baseSha256", "inputSha256", "sources"]) || !sameOwner(receipt, loc) || receipt.machineId !== binding.machineId || receipt.baseSha256 !== baseHash(base) || typeof receipt.inputSha256 !== "string" || !HASH.test(receipt.inputSha256) || !Array.isArray(receipt.sources) || receipt.sources.length > L.screenshots) fail();
    for (const file of base.files) {
      const kept = manifest.files.find((f) => f.id === file.id);
      if (!kept || fileIdentity(kept) !== fileIdentity(file)) fail();
      kept.approval = file.approval;
    }
    const ids = new Set(), paths = new Set();
    for (const source of receipt.sources) {
      if (!keys(source, ["id", "path", "sha256", "bytes"]) || !shotPath(source.path) || ids.has(source.id) || paths.has(source.path)) fail();
      const file = manifest.files.find((f) => f.id === source.id);
      if (!file || file.kind !== "screenshot" || file.sha256 !== source.sha256 || file.bytes !== source.bytes) fail();
      ids.add(source.id); paths.add(source.path);
    }
    for (const file of manifest.files) {
      if (base.files.some((f) => f.id === file.id)) continue;
      if (file.kind === "transcript" || (file.kind === "screenshot" && (!ids.has(file.id) || file.approval !== "pending"))) fail();
    }
  }
  const releases = join(loc.dir, "releases");
  if (presentDir(releases)) for (const file of manifest.files) {
    const released = join(releases, file.id);
    if (!presentDir(released)) continue;
    const value = json(join(released, "release.json"));
    if (!keys(value, ["version", "run", "agent", "sequence", "id", "sha256"]) || !sameOwner(value, loc) || file.kind !== "screenshot" || value.id !== file.id || value.sha256 !== file.sha256) fail();
    file.approval = "released";
  }
  return { loc, base, manifest, receipt, finalDir };
}

export function listSessionArtifacts(root, selector) {
  try { return effective(root, selector).manifest; } catch { fail(); }
}

function fileData(root, selector, allowPending = false) {
  const { loc, base, manifest, finalDir } = effective(root, selector);
  const file = manifest.files.find((f) => f.id === selector.id);
  if (!file || (!allowPending && file.approval === "pending")) fail();
  const dir = base.files.some((f) => f.id === file.id) ? loc.dir : finalDir;
  const data = readBounded(join(dir, file.id), file.kind === "screenshot" ? L.screenshot : L.text);
  if (data.length !== file.bytes || digest(data) !== file.sha256) fail();
  return { manifest, file, data, loc };
}

export function readSessionArtifact(root, selector) {
  try {
    const { data, file } = fileData(root, selector);
    const extension = { transcript: "txt", har: "har", screenshot: "png" }[file.kind];
    return { data, mime: file.mime, filename: `${file.id}.${extension}` };
  } catch { fail(); }
}

// Rename a nonempty directory once. A competing publication cannot replace
// the winner. Callers validate that winner rather than treating EEXIST as success.
function publish(parent, name, files) {
  const staging = join(parent, `.stage-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const { name: file, data } of files) writeFileSync(join(staging, file), data, { flag: "wx", mode: 0o600 });
    try { renameSync(staging, join(parent, name)); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
const jsonFile = (name, value) => ({ name, data: Buffer.from(JSON.stringify(value)) });

// TRUSTED APP ONLY. This is not a model tool. The app must authenticate the
// current explicit human request and bind these fields to its candidate.
export function releaseSessionScreenshot(root, selector) {
  try {
    if (selector.approved !== true || !HASH.test(selector.sha256)) fail();
    const { file, loc } = fileData(root, selector, true);
    if (file.kind !== "screenshot" || file.sha256 !== selector.sha256) fail();
    if (file.approval === "released") return listSessionArtifacts(root, selector);
    const releases = privateDir(join(loc.dir, "releases"), true);
    if (usedBytes(loc.runDir) + L.manifest > L.run) fail();
    publish(releases, file.id, [jsonFile("release.json", { version: 1, run: loc.run, agent: loc.agent, sequence: loc.sequence, id: file.id, sha256: file.sha256 })]);
    const manifest = listSessionArtifacts(root, selector);
    if (manifest.files.find((f) => f.id === file.id)?.approval !== "released") fail();
    return manifest;
  } catch { fail(); }
}

function sourceBytes(value, max) {
  if (!(typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array)) fail();
  if ((typeof value === "string" ? Buffer.byteLength(value) : value.byteLength) > max) fail();
  return Buffer.from(value);
}

function safeURL(value, secrets) {
  if (typeof value !== "string" || value.length > 2000) return "";
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return "";
    u.username = ""; u.password = "";
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, "[REDACTED]");
    u.hash = "";
    return scrubSessionValue(u.href, secrets);
  } catch { return ""; }
}

// Allowlist HAR metadata, then use the existing candidate/redactor path.
// Headers, cookies, request bodies and response bodies are never retained.
function cleanHAR(input, secrets) {
  let parsed;
  try { parsed = JSON.parse(sourceBytes(input, L.text).toString("utf8")); } catch { fail(); }
  const entries = parsed?.log?.entries;
  if (!Array.isArray(entries) || entries.length > L.entries) fail();
  const number = (v) => Number.isFinite(v) && v >= 0 && v <= 1e12 ? v : 0;
  const safe = { log: { version: "1.2", creator: { name: "Touchstone", version: "1" }, entries: entries.map((e) => {
    if (!e || typeof e !== "object" || !e.request || !e.response) fail();
    return {
      startedDateTime: typeof e.startedDateTime === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(e.startedDateTime) ? e.startedDateTime : "",
      time: number(e.time),
      request: { method: typeof e.request.method === "string" && /^[A-Z]{1,16}$/.test(e.request.method) ? e.request.method : "", url: safeURL(e.request.url, secrets), headers: [], cookies: [], queryString: [], headersSize: -1, bodySize: 0 },
      response: { status: Number.isInteger(e.response.status) && e.response.status >= 0 && e.response.status <= 599 ? e.response.status : 0, headers: [], cookies: [], content: { size: 0, mimeType: "" }, redirectURL: safeURL(e.response.redirectURL, secrets), headersSize: -1, bodySize: 0 },
      timings: { send: number(e.timings?.send), wait: number(e.timings?.wait), receive: number(e.timings?.receive) },
    };
  }) } };
  return Buffer.from(JSON.stringify(scrubSessionValue(safe, secrets)));
}

function png(input) {
  const data = sourceBytes(input, L.screenshot);
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") fail();
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) fail();
  return data;
}

function usedBytes(dir) {
  let total = 0, files = 0;
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      if (++files > 4096) fail();
      const child = join(path, name), st = lstatSync(child);
      if (st.isSymbolicLink()) fail();
      if (st.isDirectory()) walk(child);
      else if (st.isFile() && st.nlink === 1) total += st.size;
      else fail();
      if (total > L.run) fail();
    }
  };
  walk(dir);
  return total;
}

export function writeSessionArtifacts(root, { run, agent, poc, transcript, har = null, screenshots = [], secrets = [] }) {
  let staging;
  try {
    const selector = { run, agent, poc };
    const loc = location(root, selector, true);
    if (!Array.isArray(screenshots) || screenshots.length > L.screenshots) fail();
    const blobs = [{ kind: "transcript", data: Buffer.from(scrubSessionValue(sourceBytes(transcript, L.text).toString("utf8"), secrets)) }];
    if (har !== null) blobs.push({ kind: "har", data: cleanHAR(har, secrets) });
    const paths = new Set();
    for (const shot of screenshots) {
      if (!shot || !shotPath(shot.path) || paths.has(shot.path)) fail();
      paths.add(shot.path);
      blobs.push({ kind: "screenshot", data: png(shot.bytes) });
    }
    for (const b of blobs) if (b.data.length > (b.kind === "screenshot" ? L.screenshot : L.text)) fail();
    // A sequence is immutable: retries cannot replace files already cited.
    try {
      lstatSync(loc.dir);
      return listSessionArtifacts(root, selector);
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (usedBytes(loc.runDir) + blobs.reduce((n, b) => n + b.data.length, 0) + L.manifest > L.run) fail();
    const manifest = { version: 1, run, agent, sequence: loc.sequence, files: blobs.map((b) => ({ id: `a-${randomUUID()}`, kind: b.kind, sha256: digest(b.data), bytes: b.data.length, mime: mime[b.kind], approval: b.kind === "screenshot" ? "pending" : "not-required" })) };
    validateManifest(manifest, loc);
    staging = join(loc.agentDir, `.stage-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    blobs.forEach((b, i) => writeFileSync(join(staging, manifest.files[i].id), b.data, { flag: "wx", mode: 0o600 }));
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    renameSync(staging, loc.dir);
    staging = null;
    return manifest;
  } catch { fail(); }
  finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
}

// TRUSTED RUNTIME ONLY. D verifies accepted state.candidates membership and
// its exact evidence binding first. A private snapshot alone is not acceptance.
export function bindSessionCapture(root, selector) {
  try {
    if (!machine(selector.machineId)) fail();
    const { loc } = effective(root, selector);
    const dir = join(loc.dir, "binding");
    if (!presentDir(dir)) {
      if (usedBytes(loc.runDir) + L.manifest > L.run) fail();
      publish(loc.dir, "binding", [jsonFile("binding.json", { version: 1, run: loc.run, agent: loc.agent, sequence: loc.sequence, machineId: selector.machineId })]);
    }
    if (bindingAt(loc).machineId !== selector.machineId) fail();
  } catch { fail(); }
}

// Terminal capture is whole-browser-session evidence, not a submission cutoff.
// D intersects accepted membership and captures only the SAME existing machine.
// The atomic overlay also seals empty/partial input: different retries refuse.
export function finalizeSessionArtifacts(root, { run, agent, poc, machineId, har = null, screenshots = [], secrets = [] }) {
  try {
    const selector = { run, agent, poc };
    const current = effective(root, selector), { loc, base } = current;
    if (!machine(machineId) || bindingAt(loc).machineId !== machineId) fail();
    if (!Array.isArray(screenshots) || screenshots.length > L.screenshots) fail();
    const rawHAR = har === null ? null : sourceBytes(har, L.text);
    const safeHAR = rawHAR === null ? null : cleanHAR(rawHAR, secrets);
    if (safeHAR && safeHAR.length > L.text) fail();
    const paths = new Set();
    const shots = screenshots.map((shot) => {
      if (!shot || !shotPath(shot.path) || paths.has(shot.path)) fail();
      paths.add(shot.path);
      const data = png(shot.bytes);
      return { path: shot.path, data, sha256: digest(data), bytes: data.length };
    }).sort((a, b) => a.path.localeCompare(b.path));
    const inputSha256 = digest(Buffer.from(JSON.stringify({ har: rawHAR === null ? null : { raw: digest(rawHAR), scrubbed: digest(safeHAR) }, screenshots: shots.map(({ data, ...s }) => s) })));
    if (current.receipt) {
      if (current.receipt.inputSha256 !== inputSha256) fail();
      return current.manifest;
    }
    const manifest = structuredClone(base), blobs = [], sources = [], used = new Set();
    const add = (kind, data) => {
      const file = { id: `a-${randomUUID()}`, kind, sha256: digest(data), bytes: data.length, mime: mime[kind], approval: kind === "screenshot" ? "pending" : "not-required" };
      manifest.files.push(file);
      blobs.push({ name: file.id, data });
      return file;
    };
    if (safeHAR) {
      const prior = base.files.find((f) => f.kind === "har");
      if (prior && (prior.sha256 !== digest(safeHAR) || prior.bytes !== safeHAR.length)) fail();
      if (!prior) add("har", safeHAR);
    }
    for (const shot of shots) {
      const file = base.files.find((f) => f.kind === "screenshot" && !used.has(f.id) && f.sha256 === shot.sha256 && f.bytes === shot.bytes) ?? add("screenshot", shot.data);
      used.add(file.id);
      sources.push({ id: file.id, path: shot.path, sha256: shot.sha256, bytes: shot.bytes });
    }
    validateManifest(manifest, loc);
    const receipt = { version: 1, run, agent, sequence: loc.sequence, machineId, baseSha256: baseHash(base), inputSha256, sources };
    blobs.push(jsonFile("manifest.json", manifest), jsonFile("receipt.json", receipt));
    if (usedBytes(loc.runDir) + blobs.reduce((n, b) => n + b.data.length, 0) > L.run) fail();
    publish(loc.dir, "final", blobs);
    const published = effective(root, selector);
    if (published.receipt?.inputSha256 !== inputSha256 || published.receipt.machineId !== machineId) fail();
    return published.manifest;
  } catch { fail(); }
}

// TRUSTED APP ONLY. This returns metadata, never locally readable pending pixels.
// APP verifies accepted membership and the existing machine/viewer lease first.
export function getSessionReviewTarget(root, selector) {
  try {
    const { manifest, receipt } = effective(root, selector);
    if (!receipt || typeof selector.sha256 !== "string" || !HASH.test(selector.sha256)) fail();
    const file = manifest.files.find((f) => f.id === selector.id);
    const source = receipt.sources.find((s) => s.id === selector.id);
    if (!file || file.kind !== "screenshot" || file.sha256 !== selector.sha256 || !source || source.sha256 !== selector.sha256) fail();
    return { machineId: receipt.machineId, path: source.path, sha256: source.sha256 };
  } catch { fail(); }
}

// Pre-validation transcript snapshots do NOT close the browser. D supplies
// no HAR/pixels there, and binds only accepted candidates after submission.
// Caller identity comes from withAgent, never the model's candidate arguments.
export function captureSessionArtifacts(root, { run, agent, poc, state, har = null, screenshots = [] }) {
  if (!currentAgent() || String(currentAgent()) !== agent) fail();
  const session = sessionLookup(state)(poc);
  if (!session || session.evidence.agent !== agent) fail();
  const manifest = writeSessionArtifacts(root, { run, agent, poc, transcript: session.text, har, screenshots, secrets: state.sessionSecrets ?? [] });
  const artifacts = sessionArtifactBinding(manifest);
  const harFile = manifest.files.find((f) => f.kind === "har");
  const evidenceHar = harFile ? { entries: JSON.parse(readSessionArtifact(root, { run, agent, poc, id: harFile.id }).data).log.entries.length, sha256: harFile.sha256 } : null;
  state.sessionArtifacts ??= new Map();
  state.sessionArtifacts.set(agent, { artifacts, har: evidenceHar });
  return manifest;
}
