// Offline checks for the phishing pack. They read only the pinned snapshot.
// dnstwist runs again with no network, so a captured row counts only when dnstwist itself made that name.
import { createHash } from 'node:crypto';
import { runTool } from '../../lib/wrap.mjs';
import { loadSnapshot } from '../../lib/proof-evidence.mjs';

// Built from ./Dockerfile. runTool never pulls, so a missing image fails closed.
export const IMAGE = 'touchstone-phishing-dnstwist:20250130';
export const BUILD_HINT = 'Build it once with: docker build -t ' + IMAGE + ' spike/packs/phishing';
const sha = text => createHash('sha256').update(text).digest('hex');
const stable = value => typeof value === 'string' ? value : JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)));
const sameWhere = (a, b) => (typeof a === 'string' || (a && typeof a === 'object')) && stable(a) === stable(b);
const name = value => String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^[0-9a-f:]+:[0-9a-f:.]*$/i;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;
const COMMIT = /^[0-9a-f]{40}$/;

// The real MetaMask list, vendored as an exact run of lines from config.json at one commit.
// Line numbers stay the upstream line numbers, so anyone can check them on GitHub.
export const METAMASK = {
  name: 'metamask-eth-phishing-detect', format: 'metamask-blacklist-slice', file: 'blocklists/metamask-blacklist-slice.txt',
  source: 'https://github.com/MetaMask/eth-phishing-detect/blob/82d3512c593b6d85d24e885bfb19afa7f5e452fa/src/config.json',
  commit: '82d3512c593b6d85d24e885bfb19afa7f5e452fa', firstLine: 76,
  sha256: 'f6d7b2c17f1eb545f0f7414e441866aa915d8a79a0957866b348fb8596754696', license: 'DBAD-1.2, read only. See NOTICE.',
};

// Valid answers only. dnstwist writes '!ServFail' when the resolver fails. That is not a record.
export function recordsOf(row = {}) {
  const pick = (key, test) => (Array.isArray(row[key]) ? row[key] : []).map(name).filter(v => test.test(v));
  return { A: pick('dns_a', IPV4), AAAA: pick('dns_aaaa', IPV6), MX: pick('dns_mx', HOST), NS: pick('dns_ns', HOST) };
}

// One blocklist to { entries: Map(domain -> line), problem }. A problem means the list is not proof.
export function parseList(list = {}, { lab = false } = {}) {
  const text = typeof list.text === 'string' ? list.text : '';
  const entries = new Map();
  const add = (domain, line) => { const d = name(domain); if (d && !entries.has(d)) entries.set(d, line); };
  if (!text.trim()) return { entries, problem: 'The list is empty.' };
  if (list.sha256 !== sha(text)) return { entries, problem: 'The list bytes do not match the recorded sha256.' };
  if (list.synthetic === true ? !lab : !COMMIT.test(list.commit ?? '')) return { entries, problem: list.synthetic ? 'A synthetic list counts only in a lab snapshot.' : 'The list has no recorded 40-hex commit.' };
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  try {
    if (list.format === 'metamask-blacklist-slice') {
      const first = Number.isInteger(list.firstLine) && list.firstLine > 0 ? list.firstLine : null;
      if (!first) return { entries, problem: 'The slice has no first line number.' };
      for (const [i, line] of lines.entries()) {
        const m = /^\s*"([^"\\]+)",?\s*$/.exec(line);
        if (!m) return { entries: new Map(), problem: 'Slice line ' + (first + i) + ' is not a list entry.' };
        add(m[1], first + i);
      }
    } else if (list.format === 'metamask-config' || list.format === 'json-array') {
      const data = JSON.parse(text);
      const block = list.format === 'json-array' ? data : data?.blacklist;
      if (!Array.isArray(block)) return { entries, problem: 'The list has no blacklist array.' };
      const allowed = new Set((list.format === 'metamask-config' && Array.isArray(data.whitelist) ? data.whitelist : []).map(name));
      const wanted = new Set(block.map(name).filter(d => !allowed.has(d)));
      // MetaMask keeps the blacklist after the whitelist. Count lines only inside it.
      let start = 0;
      if (list.format === 'metamask-config') start = lines.findIndex(l => /^\s*"blacklist"\s*:\s*\[/.test(l)) + 1;
      if (start < 0) return { entries, problem: 'The list has no blacklist array.' };
      for (let i = start; i < lines.length; i++) {
        const m = /^\s*"([^"\\]+)",?\s*$/.exec(lines[i]);
        if (m && wanted.has(name(m[1]))) add(m[1], i + 1);
        if (list.format === 'metamask-config' && /^\s*\]/.test(lines[i])) break;
      }
    } else return { entries, problem: 'Unknown list format ' + list.format + '.' };
  } catch { return { entries: new Map(), problem: 'The list does not parse.' }; }
  if (!entries.size) return { entries, problem: 'The list has no entries. A stub is not evidence.' };
  return { entries, problem: null };
}

// dnstwist regenerates the permutation set for each official domain, offline.
// Only successful runs are cached, so a later run can recover.
const generated = new Map();
export async function regenerate(official) {
  const out = new Set();
  for (const domain of official) {
    if (!generated.has(domain)) {
      const result = await runTool({ image: IMAGE, cmd: ['--format', 'list', domain], network: 'none', timeoutMs: 120000 });
      const names = String(result.stdout ?? '').split('\n').map(name).filter(Boolean);
      if (result.code !== 0 || result.timedOut || !names.includes(domain)) {
        const tail = String(result.stderr ?? '').trim().slice(-200);
        const reason = result.timedOut ? 'Timed out. ' + tail : result.code === 125 ? 'Docker could not run the image ' + IMAGE + '. ' + BUILD_HINT + '. ' + tail : result.code !== 0 ? 'Exited with code ' + result.code + '. ' + tail : 'dnstwist did not list ' + domain + '.';
        return { ok: false, reason: reason.trim() };
      }
      generated.set(domain, new Set(names));
    }
    for (const n of generated.get(domain)) out.add(n);
  }
  return { ok: true, names: out };
}

function leadOf(check, where, severity, description, engine, extra = {}) {
  return { id: sha(check + '\n' + stable(where)).slice(0, 16), check, where, severity, impact: severity[0].toUpperCase() + severity.slice(1),
    description, engine, file: 'snapshot.json', lines: [], ...extra };
}

// Every lead the snapshot supports. The detectors call this too, so replay and scan agree.
export async function phishingLeads(snapshot) {
  if (snapshot?.schema !== 1 || snapshot.kind !== 'phishing' || !Array.isArray(snapshot.official) || !snapshot.official.length) throw new Error('Invalid phishing snapshot');
  const official = snapshot.official.map(name);
  const skip = new Set([...official, ...(snapshot.owned ?? []).map(name)]);
  const leads = [];
  const coverage = [...(snapshot.coverage ?? [])];
  const missing = (check, where, description, engine) => leads.push(leadOf(check, where, 'informational', description, engine, { reviewOnly: true }));
  const stats = { generated: 0, captured: 0, resolving: 0, bare: 0, notGenerated: 0 };

  const regen = await regenerate(official);
  coverage.push({ engine: 'dnstwist', status: regen.ok ? 'ran' : 'unavailable', leads: 0, ...(regen.ok ? {} : { reason: regen.reason }) });
  if (!regen.ok) missing('lookalike-evidence-missing', 'dnstwist', 'dnstwist could not regenerate the permutations, so no lookalike can be proven. ' + regen.reason, 'dnstwist');
  const names = regen.ok ? regen.names : new Set();
  stats.generated = Math.max(0, names.size - official.length);

  // Registered lookalikes come from the captured dnstwist rows.
  const capture = snapshot.dnstwist ?? {};
  const rows = Array.isArray(capture.rows) ? capture.rows : [];
  const officialRow = rows.find(r => official.includes(name(r.domain)));
  const answered = officialRow && Object.values(recordsOf(officialRow)).some(v => v.length);
  if (capture.code !== 0 || !rows.length) missing('lookalike-evidence-missing', 'dnstwist-capture', 'The DNS capture failed or is empty. An unregistered name is not proven.', 'dnstwist-capture');
  else if (!answered) missing('lookalike-evidence-missing', 'dnstwist-capture', 'The resolver gave no answer for the official domain. Missing records are not proof a name is free.', 'dnstwist-capture');
  if (regen.ok) for (const row of rows) {
    const domain = name(row.domain);
    if (skip.has(domain)) continue;
    if (!names.has(domain)) { stats.notGenerated++; continue; }
    stats.captured++;
    const r = recordsOf(row);
    if (r.A.length || r.AAAA.length || r.MX.length) {
      stats.resolving++;
      const where = { domain, fuzzer: String(row.fuzzer ?? ''), ...Object.fromEntries(['A', 'AAAA', 'MX'].filter(k => r[k].length).map(k => [k, r[k].join(' ')])) };
      leads.push(leadOf('registered-lookalike', where, 'medium', domain + ' is a ' + where.fuzzer + ' lookalike of ' + official.join(', ') + ' and it resolves (' + ['A', 'AAAA', 'MX'].filter(k => r[k].length).join(', ') + '). It can host a phishing page or receive mail.', 'dnstwist'));
    } else if (r.NS.length) {
      leads.push(leadOf('parked-lookalike', { domain, fuzzer: String(row.fuzzer ?? ''), NS: r.NS.join(' ') }, 'low', domain + ' has name servers but no A, AAAA or MX. It is registered but not live. Watch it.', 'dnstwist', { reviewOnly: true }));
    } else stats.bare++;
  }

  // Known scams: an exact match in a pinned list.
  const lists = Array.isArray(snapshot.blocklists) ? snapshot.blocklists : [];
  if (!lists.length) missing('blocklist-evidence-missing', 'no pinned blocklist', 'No pinned blocklist is in the snapshot. A lookalike cannot be checked against known scams.', 'blocklist');
  for (const list of lists) {
    const { entries, problem } = parseList(list, { lab: snapshot.lab === true });
    const engine = 'blocklist:' + list.name;
    let found = 0;
    if (problem) {
      coverage.push({ engine, status: 'unavailable', leads: 0, reason: problem });
      missing('blocklist-evidence-missing', { list: String(list.name ?? ''), problem }, String(list.name) + ' is not usable evidence. ' + problem, engine);
      continue;
    }
    const pin = list.synthetic ? 'sha256:' + list.sha256 : list.commit;
    const brands = official.map(d => d.split('.')[0]).filter(label => label.length >= 4);
    for (const [domain, line] of entries) {
      if (skip.has(domain)) continue;
      if (names.has(domain)) {
        found++;
        leads.push(leadOf('known-scam-lookalike', { domain, list: list.name, line: String(line), pin }, 'high', domain + ' is a lookalike of ' + official.join(', ') + ' and is on ' + list.name + (list.synthetic ? ' (synthetic lab list)' : '') + ' at line ' + line + '.', engine));
      } else if (brands.some(b => domain.split('.').some(part => part.includes(b)))) {
        found++;
        leads.push(leadOf('brand-on-blocklist', { domain, list: list.name, line: String(line), pin }, 'low', domain + ' carries the brand name and is on ' + list.name + ' at line ' + line + '. dnstwist did not generate it, so review by hand.', engine, { reviewOnly: true }));
      }
    }
    coverage.push({ engine, status: 'ran', leads: found });
  }
  const count = engine => leads.filter(l => l.engine === engine).length;
  for (const row of coverage) if (row.engine === 'dnstwist' && row.status === 'ran') row.leads = count('dnstwist');
  return { leads, coverage, stats };
}

export async function scanSnapshot(ws) {
  const { snapshot, snapshotHash } = loadSnapshot(ws);
  return { snapshotHash, ...(await phishingLeads(snapshot)) };
}

// Each confirmable check holds only when a fresh scan of the snapshot gives the exact same where.
const confirm = check => async (snapshot, where) => {
  const { leads } = await phishingLeads(snapshot);
  return { ok: leads.some(l => l.check === check && !l.reviewOnly && sameWhere(l.where, where)) };
};
export const detectors = { 'registered-lookalike': confirm('registered-lookalike'), 'known-scam-lookalike': confirm('known-scam-lookalike') };
