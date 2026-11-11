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
// Reads are confined: the real path (symlinks resolved) must stay inside the
// workspace under src/, vendor/, or be BRIEF.md, and it must be a regular,
// allowlisted, non-secret file. fetch_source fetches only the scope's own repo
// links, on the host, into vendor/.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
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
  // Local folders sit under src/. A fetched repo sits at vendor/<repo>/ and a
  // fetched blob at vendor/files/, so classify the path inside that folder.
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
- The sandbox has no network. Only fetch_source reaches out, on the host, and
  only for the repos the scope lists.

How to review:
- Map the code first: entry points, trust boundaries, where input comes in, where
  secrets, money, or privileges are handled.
- Look for real, exploitable flaws: injection, auth and access-control gaps,
  unsafe deserialization, path traversal, SSRF, broken crypto, race conditions,
  unchecked arithmetic, and logic bugs specific to this code.
- Ignore style and hypothetical issues with no attacker path.

End with a lead list, worst first. One line per lead:
  severity (critical/high/medium/low) — file:line — what an attacker does — why you think it holds — what would prove it.
Then a short coverage note: what you read, and what you did not reach.`;

export const KICKOFF = "Review this scope. Read BRIEF.md, fetch any listed repos, map the code, and report a ranked lead list. Nothing here can be proven, so mark every item as a lead.";

export function tools(ws) {
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
    description: "Fetch one of the scope's GitHub repos into vendor/<repo>/. Pass a repo URL exactly as BRIEF.md lists it. The fetch runs on the host; the review stays offline.",
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

  return [listSources, readSource, searchSource, ...(moduleOn(cfg.modules, "fetch") && links.size ? [fetchSourceTool] : [])];
}

export default {
  id: "review",
  title: "Code review",
  tier: "P",
  proof: "none",
  system: () => SYSTEM,
  tools: (ws) => tools(ws),
  kickoff: () => KICKOFF,
  nudge: () => null,
  // No replay oracle fits this code. No finding may pass this pack.
  prove: async () => [],
};
