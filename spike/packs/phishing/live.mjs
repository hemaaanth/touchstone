// The capture step. It runs only for a live scope with an operator grant, or for the lab.
// dnstwist asks DNS for NS, A, AAAA and MX of each permutation. It never fetches pages,
// banners, WHOIS or screenshots: no -b, -w, -m, --lsh or --phash.
import { readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { runTool } from '../../lib/wrap.mjs';
import { pinSnapshot } from '../../lib/proof-evidence.mjs';
import { inScope, failReason } from '../domains/live.mjs';
import { assertInternal } from '../domains/labctl.mjs';
import { IMAGE, METAMASK, CONTROLS_PER_ZONE, name, ownedNames, zoneOf, regenerate, fingerprint } from './checks.mjs';

const PACK = fileURLToPath(new URL('.', import.meta.url));
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const sha = text => createHash('sha256').update(text).digest('hex');

// The grant must cover the official domain. The permutations are other people's names:
// the grant allows only DNS reads of them, which is what dnstwist does here.
export function assertReach(reach, domain) {
  if (!DOMAIN.test(domain ?? '')) throw new Error('Invalid domain');
  if (!reach || typeof reach.network !== 'string') throw new Error('Live capture needs reach.network from the platform');
  if (reach.granted !== true || !Array.isArray(reach.scope) || !inScope(domain, reach.scope)) throw new Error('Live capture needs a grant that covers ' + domain);
  if (/^touchstone-(?:phishing|domains)-/.test(reach.network)) assertInternal(reach.network);
  if (reach.resolver != null && !IPV4.test(reach.resolver)) throw new Error('reach.resolver must be an IPv4 address');
}

// Blocklists go into the snapshot as raw text with their pin. Operator lists live in the workspace.
// ScamSniffer is GPL-3.0, so the operator fetches and pins it; the pack does not ship it.
export function readBlocklists(ws, extra = []) {
  const lists = [{ ...METAMASK, text: readFileSync(join(PACK, METAMASK.file), 'utf8') }];
  for (const item of extra) {
    const file = resolve(ws, String(item.file ?? ''));
    const rel = relative(ws, file);
    if (!item.file || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Blocklist file must be inside the workspace');
    const text = readFileSync(file, 'utf8');
    lists.push({ name: String(item.name), format: item.format, file: rel, source: item.source ?? null, commit: item.commit ?? null,
      ...(item.firstLine ? { firstLine: item.firstLine } : {}), synthetic: item.synthetic === true, license: item.license ?? null, sha256: sha(text), text });
  }
  return lists;
}

// One dnstwist JSON run. Returns { code, reason, rows, stderr }.
async function dnstwistJson(cmd, network, timeoutMs) {
  const result = await runTool({ image: IMAGE, cmd, network, timeoutMs });
  let rows = [];
  let reason = result.code === 0 && !result.timedOut ? null : failReason(result, IMAGE);
  if (!reason) { try { rows = JSON.parse(result.stdout); if (!Array.isArray(rows)) throw new Error(); } catch { rows = []; reason = 'dnstwist output is not a JSON array.'; } }
  return { code: reason ? (result.code || 1) : 0, reason, rows, stderr: String(result.stderr ?? '').slice(-2000) };
}

// Capture one scope. Returns a snapshot. The coverage row says if the capture ran.
// After the main run it asks the same resolver about 3 random names per zone (the
// controls). They cannot exist, so an answer means the resolver wildcards. dnstwist
// gives a timeout and NXDOMAIN the same bare row, so the checks need all 3 bare.
// Then it runs dnstwist offline once more and stores the fingerprint of the name set.
export async function captureLookalikes({ ws, domain, owned = [], reach, blocklists = [], lab = false }) {
  assertReach(reach, domain);
  ownedNames(owned); // a bad owned entry stops the capture before any tool runs
  const ns = reach.resolver ? ['--nameservers', reach.resolver] : [];
  const cmd = ['--format', 'json', ...ns, domain];
  const started = new Date().toISOString();
  const main = await dnstwistJson(cmd, reach.network, 600000);
  const { rows, reason } = main;
  const controls = [];
  let generator = null;
  if (!reason) {
    const zones = [...new Set(rows.map(r => name(r.domain)).filter(Boolean).map(d => zoneOf(d, [domain])))].sort();
    for (const zone of zones) for (let i = 0; i < CONTROLS_PER_ZONE; i++) {
      const probe = 'ts-ctl-' + randomBytes(6).toString('hex') + '.' + zone;
      const ctlCmd = ['--format', 'json', '--fuzzers', '*original', ...ns, probe];
      const out = await dnstwistJson(ctlCmd, reach.network, 120000);
      controls.push({ zone, domain: probe, cmd: ctlCmd, code: out.code, rows: out.rows, ...(out.reason ? { reason: out.reason } : {}) });
    }
    const gen = await regenerate([domain]);
    if (gen.ok) generator = { ...fingerprint(gen.names), cmd: ['--format', 'list', domain], network: 'none' };
  }
  return {
    schema: 1, kind: 'phishing', ...(lab ? { lab: true } : {}), official: [domain], owned,
    dnstwist: { image: IMAGE, version: '20250130', cmd, network: reach.network, resolver: reach.resolver ?? 'container default', capturedAt: started,
      code: main.code, stderr: main.stderr, rows, controls, generator },
    blocklists: readBlocklists(ws, blocklists),
    coverage: [{ engine: 'dnstwist-capture', status: reason ? 'unavailable' : 'ran', leads: rows.length, ...(reason ? { reason } : {}) }],
  };
}

export async function pinLive(ws, cfg, reach) {
  const snapshot = await captureLookalikes({ ws, domain: cfg.domain, owned: cfg.owned ?? [], reach, blocklists: cfg.blocklists ?? [] });
  pinSnapshot(ws, snapshot);
  return snapshot;
}
