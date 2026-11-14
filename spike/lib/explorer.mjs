// Verified source, by deployment address.
//
// WHY. DefiLlama and a block explorer both point at the same thing: a contract
// that is live, new and small. The harness already proves against source offline;
// what it lacked was a way to get that source for an address. Sourcify serves
// verified sources keyed by (chain, address) with no key and no account, so the
// operator can start from a deployment and back into the app.
//
// WHAT IT REFUSES. Sourcify answers with the whole verified file set, which for a
// real project is a monorepo-shaped tree. Files go through the same classifier as
// any other intake, so dependencies and build output are dropped and the scope's
// own caps apply. A contract that was never verified is a refusal with its own
// sentence: no guessing from bytecode here.
//
// Host-side and one-shot, at scope creation. The run's Foundry sandbox is still
// offline, so nothing about the proof changes.
import { classifyPath, secretContent } from "./scopes-store.mjs";

export const SOURCIFY = "https://sourcify.dev";

// A chain id is a positive safe integer; an address is 20 hex bytes.
export function checkDeployment(chainId, address) {
  const chain = Number(chainId);
  if (!Number.isSafeInteger(chain) || chain < 1) throw new Error("A verified-source fetch needs a positive chain ID.");
  const addr = String(address ?? "").trim();
  if (!/^0x[0-9a-f]{40}$/i.test(addr)) throw new Error("A verified-source fetch needs an address of 0x and 40 hex digits.");
  return { chainId: chain, address: addr.toLowerCase() };
}

// The verified sources for one deployment. Returns { files, contractName,
// dropped } where files are { path, content } ready for a folder member.
// `fetchText` is injected for tests.
export async function verifiedSources(chainId, address, { fetchText = hostFetch, limit = 4000 } = {}) {
  const dep = checkDeployment(chainId, address);
  const url = `${SOURCIFY}/server/v2/contract/${dep.chainId}/${dep.address}?fields=sources,compilation`;
  let raw;
  try {
    raw = await fetchText(url);
  } catch (err) {
    throw new Error(`Sourcify could not be reached for ${dep.address} on chain ${dep.chainId}: ${String(err?.message ?? err).slice(0, 120)}`);
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error("Sourcify answered with something that is not JSON."); }
  const sources = body?.sources;
  if (!sources || typeof sources !== "object" || !Object.keys(sources).length) {
    throw new Error(`No verified source for ${dep.address} on chain ${dep.chainId}. It is not verified on Sourcify, so there is nothing to compile: use the block explorer's verified-source tab if it has one, or a GitHub repo.`);
  }
  const files = [];
  const dropped = {};
  for (const [path, entry] of Object.entries(sources)) {
    const content = entry?.content;
    if (typeof content !== "string") { dropped["no content"] = (dropped["no content"] ?? 0) + 1; continue; }
    const why = classifyPath(path, { solidity: true });
    if (why !== "keep") { dropped[why] = (dropped[why] ?? 0) + 1; continue; }
    if (secretContent(content)) { dropped["secret file"] = (dropped["secret file"] ?? 0) + 1; continue; }
    files.push({ path, content });
    if (files.length >= limit) break;
  }
  if (!files.length) throw new Error("Every verified file was a dependency, a build file or a secret, so the scope would be empty.");
  return { files, dropped, contractName: String(body?.compilation?.name ?? "") || null };
}

async function hostFetch(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { accept: "application/json", "user-agent": "touchstone-scope-intake" } });
    if (res.status === 404) return JSON.stringify({});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).slice(0, 40 * 1024 * 1024);
  } finally {
    clearTimeout(timer);
  }
}
