// Which of a scope's GitHub members a run actually read.
//
// fetch_source emits one `source-fetch` event per attempt (lib/fetch.mjs). A run
// that ends with no finding is a clean result only if every member landed. A
// member that was refused (for example over the file cap) or never fetched is a
// gap: the scan did not read it, so it never means clean.
import { githubRepoUrl, MAX_MEMBERS } from "./scopes-store.mjs";

// The same normalization as memberUrl in lib/fetch.mjs (kept here so the server
// does not load the fetch code).
function memberUrl(raw) {
  try { return githubRepoUrl(String(raw ?? "").trim()).replace(/\/+$/, "").replace(/\.git$/, ""); } catch { return null; }
}

// links: the scope's member links. events: the run's events.
// Returns null when the scope has no GitHub members (nothing to fetch), else
// { members: [{ url, status, where?, files?, reason? }], fetched, total, complete }.
// The last attempt for a member decides its status. fetch_source takes only the
// first MAX_MEMBERS links, so every link past that is a gap: it can never be read.
export function sourceCoverage(links, events) {
  const all = [...new Set((links ?? []).map(memberUrl).filter(Boolean))];
  if (!all.length) return null;
  const urls = all.slice(0, MAX_MEMBERS);
  const last = new Map();
  for (const e of events ?? []) {
    if (e?.ev !== "source-fetch") continue;
    const u = memberUrl(e.url);
    if (u && urls.includes(u)) last.set(u, e);
  }
  const members = urls.map((url) => {
    const e = last.get(url);
    if (!e) return { url, status: "not-fetched", reason: "the agent did not fetch it" };
    if (e.ok) return { url, status: "fetched", where: e.where ?? null, files: Number(e.files) || 0 };
    return { url, status: "refused", reason: String(e.error ?? "the fetch failed").slice(0, 1500) };
  });
  for (const url of all.slice(MAX_MEMBERS)) members.push({ url, status: "not-fetched", reason: `over the ${MAX_MEMBERS}-member limit` });
  const fetched = members.filter((m) => m.status === "fetched").length;
  return { members, fetched, total: members.length, complete: fetched === members.length };
}

// An error record for a run that would otherwise end clean but did not read its
// whole scope, or null when the coverage is complete (or there is none).
// Same shape as the server's failureInfo, kind "coverage".
export function coverageFailure(cov, { spentUsd = null } = {}) {
  if (!cov || cov.complete) return null;
  const read = cov.members.filter((m) => m.status === "fetched");
  const gaps = cov.members.filter((m) => m.status !== "fetched");
  const detail = [
    read.length ? `Read:\n${read.map((m) => `- ${m.url} → ${m.where ?? "(not saved)"} (${m.files} file${m.files === 1 ? "" : "s"})`).join("\n")}` : "Read: nothing from GitHub.",
    `Not read:\n${gaps.map((m) => `- ${m.url}: ${m.reason}`).join("\n")}`,
  ].join("\n\n");
  const none = read.length === 0;
  return {
    kind: "coverage",
    retryable: false,
    reason: "source-not-covered",
    spentUsd,
    title: none ? "The scope was not read" : "Part of the scope was not read",
    message: `No finding, but ${gaps.length} of ${cov.total} scope member${cov.total === 1 ? " was" : "s were"} not read, so this is not a clean result.`,
    detail,
    hint: "This is not a clean result. If a repo is over the file cap, edit the scope and replace it with folder URLs (https://github.com/<owner>/<repo>/tree/<branch>/<folder>) that together fit under the cap, then start a new run.",
  };
}
