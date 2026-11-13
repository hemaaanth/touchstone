// The Review pack: read operator code in any language and report leads.
//
// This is the pack for scope content that has no replay oracle that fits it.
// Contracts proves Solidity with an offline Foundry test. Web, supply chain and
// the evidence packs replay against their own practice labs, so their oracles
// do not fit operator code. Rather than fake a proof, this pack only reads.
//
// The proof gate is structural here:
//   - there is no submit_finding tool, so the agent cannot submit a finding;
//   - prove() returns [], so the engine records nothing as proven.
// A lead is a lead. It never becomes "proven" under this pack.
//
// record_lead saves each lead the moment the agent ranks it, as a `lead` event
// with its evidence (file, line, reason). The event goes to EVENTS_FILE at once,
// so a lead survives a later model error, a stop, or a server restart. The run
// record and the run view read leads from those events.
//
// Reads are confined: the real path (symlinks resolved) must stay inside the
// workspace under src/, vendor/, or be BRIEF.md, and it must be a regular,
// allowlisted, non-secret file. fetch_source fetches only the scope's own repo
// links, on the host, into vendor/.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { readTouchstone } from "../../lib/sandbox.mjs";
import { moduleOn } from "../../lib/modules.mjs";
import { fetchSource } from "../../lib/fetch.mjs";
import { classifyPath, githubRepoUrl } from "../../lib/scopes-store.mjs";
import { event } from "../../lib/event.mjs";

const READ_ROOTS = ["src", "vendor"];
const FILE_READ_CAP = 512 * 1024;
const LIST_CAP = 2000;
const SEARCH_HITS = 100;

// May the agent see this workspace-relative path? Only allowlisted source under
// src/ or vendor/, never a hidden, secret, dependency, or build file.
export function visible(rel) {
  if (rel === "BRIEF.md") return true;
  const parts = rel.split(sep);
  if (parts.some((p) => !p || p.startsWith(".") || p === "..")) return false;
  // Local folders sit under src/. A fetched repo sits at vendor/<owner>__<repo>/
  // and a fetched blob under vendor/files/, so classify the path inside that folder.
  if (parts[0] === "src" && parts.length >= 2) return classifyPath(parts.slice(1).join("/")) === "keep";
  if (parts[0] === "vendor" && parts.length >= 3) return classifyPath(parts.slice(2).join("/")) === "keep";
  return false;
}

// Every visible regular file under src/ and vendor/. Symlinks are never
// followed or listed.
export function listFiles(ws) {
  const out = [];
  const walk = (rel) => {
    let names;
    try { names = readdirSync(join(ws, rel)); } catch { return; }
    for (const name of names.sort()) {
      if (out.length >= LIST_CAP || name.startsWith(".")) continue;
      const r = `${rel}/${name}`;
      const st = lstatSync(join(ws, r));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(r);
      else if (st.isFile() && visible(r)) out.push(r);
    }
  };
  for (const root of READ_ROOTS) walk(root);
  return out;
}

// The absolute path of a readable file, or null. Resolves symlinks first, so a
// link that points out of the workspace (or at a hidden or secret file) fails.
export function resolveReadable(ws, raw) {
  const name = String(raw ?? "").trim().replace(/^\.\//, "");
  if (!name) return null;
  let root, abs;
  try {
    root = realpathSync(ws);
    abs = realpathSync(join(root, name));
  } catch { return null; }
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return null;
  if (!visible(rel)) return null;
  try { if (!lstatSync(abs).isFile()) return null; } catch { return null; }
  return abs;
}

export const SYSTEM = `You are an authorized security reviewer in an isolated sandbox.
The operator owns this code and asked you to review it. It can be in any language.

What this run can and cannot do:
- You can read the code. You cannot prove a finding here. No replay oracle fits
  this code, so there is no submit_finding tool and nothing you report is marked
  proven. Report leads, not verdicts.
- Read BRIEF.md first. It lists the scope's members: local folders (under src/)
  and GitHub repos. Fetch each repo with fetch_source before you read it.
- Use list_sources to see files, read_source to read one, and search_source to
  find a literal string across all files.
- Record each lead with record_lead as soon as you can point at a file and a
  line: severity, file, line, what an attacker does, why you think it holds, and
  what would prove it. Do not wait for the end. A lead that lives only in your
  final message is lost if the model fails first. A lead is not a finding;
  record_lead never marks anything proven. bulletin_post, where it exists, only
  shares a note with other agents; it does not record a lead.
- The sandbox has no network. Only fetch_source reaches out, on the host, and
  only for the repos the scope lists.

How to review:
- Map the code first: entry points, trust boundaries, where input comes in, where
  secrets, money, or privileges are handled.
- Look for real, exploitable flaws: injection, auth and access-control gaps,
  unsafe deserialization, path traversal, SSRF, broken crypto, race conditions,
  unchecked arithmetic, and logic bugs specific to this code.
- Ignore style and hypothetical issues with no attacker path.

End with a lead list, worst first, of the leads you recorded. One line per lead:
  severity (critical/high/medium/low) — file:line — what an attacker does — why you think it holds — what would prove it.
Then a short coverage note: what you read, and what you did not reach.`;

export const KICKOFF = "Review this scope. Read BRIEF.md, fetch any listed repos, map the code, record each lead with record_lead as you find it, and end with a ranked lead list. Nothing here can be proven, so every item is a lead.";

// The one nudge after a clean end: a review that recorded no lead must either
// record the leads it ranked or say it found none.
export const NUDGE = "You recorded no lead with record_lead. For each lead you ranked, call record_lead now with its severity, file, line, what an attacker does, why it holds, and what would prove it. If you found no lead, say so in one line.";

const SEVERITIES = ["critical", "high", "medium", "low"];
const TITLE_CAP = 300;
const REASON_CAP = 2000;
// Leads one run may record. Each is an event the run view reduces again on
// every update, so a runaway loop must stop here.
export const LEAD_CAP = 200;

export function tools(ws, state = {}) {
  const cfg = readTouchstone(ws);
  const links = new Set((cfg.links ?? []).map((u) => { try { return githubRepoUrl(u); } catch { return null; } }).filter(Boolean));
  const text = (t, isError = false) => ({ output: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

  const listSources = defineTool({
    name: "list_sources",
    description: "List every readable source file, as workspace-relative paths. Local folders are under src/. Fetched repos are under vendor/ (call fetch_source first).",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      event("list_sources");
      const files = listFiles(ws);
      return text(files.length ? files.join("\n") + (files.length >= LIST_CAP ? `\n…[list capped at ${LIST_CAP}]` : "") : "(no source files yet — fetch the repos BRIEF.md lists)");
    },
  });

  const readSource = defineTool({
    name: "read_source",
    description: "Read one file. Pass a path list_sources printed, or BRIEF.md.",
    parameters: obj({ file: str({ description: "a path from list_sources, or BRIEF.md" }) }),
    replay: "safe",
    execute: async (args) => {
      const raw = String(args.file ?? "");
      event("read_source", { file: raw });
      const abs = resolveReadable(ws, raw);
      if (!abs) return text(`Not readable: ${raw}. Pass a path list_sources shows, or BRIEF.md. Hidden, secret, dependency, and binary files are never readable.`, true);
      let body;
      try { body = readFileSync(abs, "utf8"); } catch { return text(`Could not read: ${raw}`, true); }
      if (body.length > FILE_READ_CAP) body = body.slice(0, FILE_READ_CAP) + `\n\n…[truncated at ${FILE_READ_CAP} bytes]`;
      return text(body);
    },
  });

  const searchSource = defineTool({
    name: "search_source",
    description: "Find a literal string (not a regex) in every readable file. Returns up to 100 file:line hits.",
    parameters: obj({ text: str({ description: "the exact text to find, at least 2 characters" }) }),
    replay: "safe",
    execute: async (args) => {
      const needle = String(args.text ?? "");
      event("search_source", { text: needle.slice(0, 80) });
      if (needle.length < 2) return text("Search for at least 2 characters.", true);
      const hits = [];
      for (const rel of listFiles(ws)) {
        const abs = resolveReadable(ws, rel);
        if (!abs) continue;
        let body;
        try { body = readFileSync(abs, "utf8"); } catch { continue; }
        if (body.length > FILE_READ_CAP) continue;
        const lines = body.split("\n");
        for (let i = 0; i < lines.length && hits.length < SEARCH_HITS; i++) {
          if (lines[i].includes(needle)) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
        if (hits.length >= SEARCH_HITS) break;
      }
      return text(hits.length ? hits.join("\n") : `No match for ${JSON.stringify(needle)}.`);
    },
  });

  const fetchSourceTool = defineTool({
    name: "fetch_source",
    description: "Fetch one of the scope's GitHub repos into vendor/<owner>__<repo>/. Pass a repo URL exactly as BRIEF.md lists it. The fetch runs on the host; the review stays offline.",
    parameters: obj({ url: str({ description: "a repo URL from BRIEF.md" }) }),
    replay: "unsafe",
    execute: async (args) => {
      const raw = String(args.url ?? "").trim();
      event("fetch_source", { url: raw });
      let url;
      try { url = githubRepoUrl(raw); } catch { url = null; }
      if (!url || !links.has(url)) return text(`Not one of this scope's repos: ${raw}. Fetch only a URL BRIEF.md lists.`, true);
      let report;
      try {
        report = await fetchSource(ws, url);
      } catch (e) {
        event("fetch_source-done", { url, ok: false, error: String(e?.message ?? e).slice(0, 200) });
        return text(`Could not fetch ${url}: ${String(e?.message ?? e)}`, true);
      }
      const n = report.where ? listFiles(ws).filter((f) => f.startsWith(report.where + "/") || f === report.where).length : 0;
      event("fetch_source-done", { url, ok: true, kind: report.kind, files: n });
      return text(`Fetched ${url} into ${report.where ?? "(not saved)"}: ${n} readable file${n === 1 ? "" : "s"}. Call list_sources to see them.`);
    },
  });

  // One lead per file:line, by a stable id. A second call on the same line
  // returns the first lead's id and writes no event.
  const recorded = new Set();
  const recordLead = defineTool({
    name: "record_lead",
    description: "Record one lead the moment you rank it, so it is saved even if the run fails later. Give the file and line it is on, what an attacker does, and why you think it holds. A lead is not a finding and is never marked proven.",
    parameters: obj({
      severity: oneOf(SEVERITIES),
      file: str({ description: "the file the lead is in, as list_sources prints it" }),
      line: int({ minimum: 1, description: "the 1-based line the lead points at" }),
      title: str({ description: "what an attacker does, in one line" }),
      reason: str({ description: "why you think it holds: the code path and the missing check" }),
      proof: opt(str({ description: "what would prove it" })),
    }),
    // Idempotent: the id is a hash of file:line and the run keeps one lead per
    // id, so a re-run after a crash writes the same lead again, not a new one.
    replay: "safe",
    execute: async (args) => {
      const severity = String(args.severity ?? "").toLowerCase();
      const raw = String(args.file ?? "");
      const line = Number(args.line);
      const title = String(args.title ?? "").trim().slice(0, TITLE_CAP);
      const reason = String(args.reason ?? "").trim().slice(0, REASON_CAP);
      const proof = String(args.proof ?? "").trim().slice(0, REASON_CAP);
      if (!SEVERITIES.includes(severity)) return text(`Severity must be one of ${SEVERITIES.join(", ")}.`, true);
      if (!title || !reason) return text("Give a title (what an attacker does) and a reason (why it holds).", true);
      const abs = resolveReadable(ws, raw);
      if (!abs) return text(`Not a readable source file: ${raw}. Pass a path list_sources shows.`, true);
      let body;
      try { body = readFileSync(abs, "utf8"); } catch { return text(`Could not read: ${raw}`, true); }
      const lines = body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
      if (!Number.isInteger(line) || line < 1 || line > lines) return text(`Line ${args.line} is not in ${raw}, which has ${lines} line${lines === 1 ? "" : "s"}.`, true);
      const file = relative(realpathSync(ws), abs).split(sep).join("/");
      const id = "lead-" + createHash("sha1").update(`${file}:${line}`).digest("hex").slice(0, 12);
      if (recorded.has(id)) return text(`Already recorded as ${id} (${file}:${line}). One lead per line.`);
      if (recorded.size >= LEAD_CAP) return text(`Lead cap reached: this run already recorded ${LEAD_CAP} leads, the most one run may record. This lead was not recorded. Stop recording and end with your ranked lead list.`, true);
      recorded.add(id);
      state.leads = recorded.size;
      event("lead", { id, severity, file, line, title, reason, ...(proof ? { proof } : {}) });
      return text(`Recorded ${id}: ${severity} — ${file}:${line} — ${title}. It stays a lead; nothing here is proven.`);
    },
  });

  return [listSources, readSource, searchSource, recordLead, ...(moduleOn(cfg.modules, "fetch") && links.size ? [fetchSourceTool] : [])];
}

export default {
  id: "review",
  title: "Code review",
  tier: "P",
  proof: "none",
  system: () => SYSTEM,
  tools: (ws, state) => tools(ws, state),
  kickoff: () => KICKOFF,
  nudge: (state) => (state?.leads ? null : NUDGE),
  // No replay oracle fits this code. No finding may pass this pack.
  prove: async () => [],
};
