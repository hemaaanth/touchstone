// Offline checks for the phishing pack. They read only the pinned snapshot.
// dnstwist runs again with no network, so a captured row counts only when dnstwist itself made that name.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { runTool } from '../../lib/wrap.mjs';
import { loadSnapshot } from '../../lib/proof-evidence.mjs';

// Built from ./Dockerfile. runTool never pulls, so a missing image fails closed.
export const IMAGE = 'touchstone-phishing-dnstwist:20250130';
export const BUILD_HINT = 'Build it once with: docker build -t ' + IMAGE + ' spike/packs/phishing';
const sha = text => createHash('sha256').update(text).digest('hex');
const stable = value => typeof value === 'string' ? value : JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)));
const sameWhere = (a, b) => (typeof a === 'string' || (a && typeof a === 'object')) && stable(a) === stable(b);
// One DNS name in ASCII (punycode) form, so a Unicode name and its xn-- form are equal.
// An invalid name becomes '' and is dropped.
export const name = value => { const s = String(value ?? '').trim().replace(/\.$/, ''); return s ? domainToASCII(s).toLowerCase() : ''; };
// The client's owned names. A dropped entry would make the owner's own domain a lookalike,
// so an entry that is not a domain name (a URL, a typo) throws instead.
export const ownedNames = list => (Array.isArray(list) ? list : []).map(entry => {
  const n = name(entry);
  if (!n || !HOST.test(n)) throw new Error('owned entry ' + JSON.stringify(entry) + ' is not a domain name. Give the bare domain, for example tide-keep.test, not a URL.');
  return n;
});
// An address that cannot serve a page on the internet. Sinkholes use these.
// IPv4: 0/8, 10/8, 100.64/10 (carrier NAT), 127/8, 169.254/16, 172.16/12, 192.168/16.
// IPv6: ::, ::1, fe80::/10 (link-local), fc00::/7 (unique local), and ::ffff:a.b.c.d
// when the IPv4 address inside is one of the above.
const canonical6 = v => { try { return new URL('http://[' + v + ']').hostname.slice(1, -1); } catch { return v; } };
const dead4 = v => {
  const [a, b] = v.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
const dead6 = v => {
  const c = canonical6(v);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(c); // WHATWG writes ::ffff:127.0.0.1 as ::ffff:7f00:1
  if (mapped) { const [h, l] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)]; return dead4([h >> 8, h & 255, l >> 8, l & 255].join('.')); }
  if (c === '::' || c === '::1') return true;
  const first = parseInt(c.split(':')[0], 16);
  return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
};
const deadIP = v => isIP(v) === 4 ? dead4(v) : dead6(v);
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
// A and AAAA hold routable addresses only. Non-routable ones go to `sink`, for review.
export function recordsOf(row = {}) {
  const list = key => (Array.isArray(row[key]) ? row[key] : []).map(v => String(v ?? '').trim().toLowerCase());
  const ips = (key, family) => list(key).filter(v => isIP(v) === family);
  const hosts = key => list(key).map(name).filter(v => HOST.test(v));
  const v4 = ips('dns_a', 4), v6 = ips('dns_aaaa', 6);
  return { A: v4.filter(v => !deadIP(v)), AAAA: v6.filter(v => !deadIP(v)), MX: hosts('dns_mx'), NS: hosts('dns_ns'), sink: [...v4, ...v6].filter(deadIP) };
}
export const servFailed = (row = {}) => ['dns_ns', 'dns_a', 'dns_aaaa', 'dns_mx'].some(k => Array.isArray(row[k]) && row[k].includes('!ServFail'));

// The zone a name sits in, for the wildcard control: the official domain's parent if the
// name is under it, else the last label. tidekeep-test.com is in com; t.idekeep.test is in test.
export function zoneOf(domain, official) {
  const parents = official.map(d => d.split('.').slice(1).join('.')).filter(Boolean);
  return parents.find(p => domain.endsWith('.' + p)) ?? domain.split('.').at(-1);
}
// A control is a random label that cannot exist. If it answers, the resolver answers everything.
export const CONTROL = /^ts-ctl-[0-9a-f]{12}$/;
// dnstwist writes the same field-less row for NXDOMAIN and for a timeout. So one quiet
// control is weak. A zone is quiet only when 3 distinct controls all came back field-less.
export const CONTROLS_PER_ZONE = 3;
// A second guard: if more than 20% of the generated names in a zone (of at least 20)
// answer A, AAAA or MX, the resolver wildcards there, whatever the controls say.
export const WILDCARD_RATIO = 0.2, WILDCARD_MIN = 20;
// The generator fingerprint: sha256 of the sorted name set dnstwist made. Capture stores it;
// replay must get the same set from the local image, or nothing is proven.
export const fingerprint = names => ({ sha256: sha([...names].sort().join('\n')), count: names.size });

// One blocklist to { entries: Map(domain -> line), problem }. A problem means the list is not proof.
export function parseList(list = {}, { lab = false } = {}) {
  const text = typeof list.text === 'string' ? list.text : '';
  const entries = new Map();
  const add = (domain, line) => { const d = name(domain); if (d && !entries.has(d)) entries.set(d, line); };
  if (!text.trim()) return { entries, problem: 'The list is empty.' };
  if (list.sha256 !== sha(text)) return { entries, problem: 'The list bytes do not match the recorded sha256.' };
  // A list that claims to be the vendored MetaMask slice must be exactly that slice.
  // Its pin is checked against the constants, not against what the snapshot says.
  if (list.format === 'metamask-blacklist-slice' || list.name === METAMASK.name) {
    if (list.format !== METAMASK.format || list.sha256 !== METAMASK.sha256 || list.firstLine !== METAMASK.firstLine || list.commit !== METAMASK.commit)
      return { entries, problem: 'The list claims to be the vendored MetaMask slice but does not match its pin (sha256 ' + METAMASK.sha256.slice(0, 12) + '…, first line ' + METAMASK.firstLine + ', commit ' + METAMASK.commit.slice(0, 8) + '). Pin an operator copy under another name.' };
  }
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
// Every call runs the image again. There is no cache, so a rebuilt image is seen
// in the same process, and the fingerprint check compares the image as it is now.
export async function regenerate(official) {
  const out = new Set();
  for (const domain of official) {
    const result = await runTool({ image: IMAGE, cmd: ['--format', 'list', domain], network: 'none', timeoutMs: 120000 });
    const names = String(result.stdout ?? '').split('\n').map(name).filter(Boolean);
    if (result.code !== 0 || result.timedOut || !names.includes(domain)) {
      const tail = String(result.stderr ?? '').trim().slice(-200);
      const reason = result.timedOut ? 'Timed out. ' + tail : result.code === 125 ? 'Docker could not run the image ' + IMAGE + '. ' + BUILD_HINT + '. ' + tail : result.code !== 0 ? 'Exited with code ' + result.code + '. ' + tail : 'dnstwist did not list ' + domain + '.';
      return { ok: false, reason: reason.trim() };
    }
    for (const n of names) out.add(n);
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
  const official = snapshot.official.map(name).filter(Boolean);
  if (!official.length) throw new Error('Invalid phishing snapshot');
  const skip = new Set([...official, ...ownedNames(snapshot.owned)]);
  const ownHost = domain => [...skip].some(d => domain === d || domain.endsWith('.' + d));
  const leads = [];
  const coverage = [...(snapshot.coverage ?? [])].map(row => ({ ...row }));
  const missing = (check, where, description, engine) => leads.push(leadOf(check, where, 'informational', description, engine, { reviewOnly: true }));
  const stats = { generated: 0, captured: 0, resolving: 0, unverified: 0, bare: 0, notGenerated: 0, servfail: 0, missingRows: 0 };
  const capture = snapshot.dnstwist ?? {};
  const rows = Array.isArray(capture.rows) ? capture.rows : [];

  // Regenerate offline, and check the generator still makes the exact set it made at capture.
  let regen = await regenerate(official);
  if (regen.ok) {
    const now = fingerprint(regen.names), then = capture.generator;
    if (!then?.sha256) regen = { ok: false, reason: 'The snapshot has no dnstwist generator fingerprint, so replay cannot show the same generator made these names. Capture again.' };
    else if (then.sha256 !== now.sha256) regen = { ok: false, reason: 'The local image ' + IMAGE + ' now makes a different name set (' + now.count + ' names, sha256 ' + now.sha256.slice(0, 12) + '…) than at capture (' + then.count + ' names, sha256 ' + String(then.sha256).slice(0, 12) + '…). ' + BUILD_HINT + ', or capture again.' };
  }
  coverage.push({ engine: 'dnstwist', status: regen.ok ? 'ran' : 'unavailable', leads: 0, ...(regen.ok ? {} : { reason: regen.reason }) });
  if (!regen.ok) missing('lookalike-evidence-missing', 'dnstwist', 'dnstwist could not regenerate the permutations, so no lookalike can be proven. ' + regen.reason, 'dnstwist');
  const names = regen.ok ? regen.names : new Set();
  stats.generated = Math.max(0, names.size - official.length);

  // The capture must be complete. A failed, empty or partial capture is never a clean result.
  const officialRow = rows.find(r => official.includes(name(r.domain)));
  const answered = officialRow && Object.values(recordsOf(officialRow)).some(v => v.length);
  const captured = capture.code === 0 && rows.length > 0;
  if (!captured) missing('lookalike-evidence-missing', 'dnstwist-capture', 'The DNS capture failed or is empty. An unregistered name is not proven.', 'dnstwist-capture');
  else if (!answered) missing('lookalike-evidence-missing', 'dnstwist-capture', 'The resolver gave no answer for the official domain. Missing records are not proof a name is free.', 'dnstwist-capture');
  if (captured) {
    const seen = new Set(rows.map(r => name(r.domain)));
    stats.servfail = rows.filter(servFailed).length;
    stats.missingRows = [...names].filter(n => !seen.has(n)).length;
    if (stats.servfail || stats.missingRows) {
      const reason = stats.servfail + ' rows answered !ServFail and ' + stats.missingRows + ' generated names have no row. Those names are not checked. dnstwist also drops DNS timeouts without a mark, so a slow resolver can hide more.';
      const row = coverage.find(c => c.engine === 'dnstwist-capture');
      if (row) Object.assign(row, { status: 'partial', reason }); else coverage.unshift({ engine: 'dnstwist-capture', status: 'partial', leads: rows.length, reason });
      missing('lookalike-evidence-missing', { capture: 'partial', servfail: String(stats.servfail), missing: String(stats.missingRows) }, 'The DNS capture is partial. ' + reason, 'dnstwist-capture');
    }
  }

  // Wildcard controls: 3 random names per zone. A zone is 'answers' if any control
  // answers, 'quiet' only if 3 distinct controls ran and all were field-less, else 'unknown'.
  const perZone = new Map();
  for (const c of Array.isArray(capture.controls) ? capture.controls : []) {
    const zone = name(c?.zone), domain = name(c?.domain);
    if (!zone || !domain.endsWith('.' + zone) || !CONTROL.test(domain.slice(0, -zone.length - 1))) continue;
    const row = c.code === 0 && Array.isArray(c.rows) ? c.rows.find(r => name(r.domain) === domain) : null;
    const r = row ? recordsOf(row) : null;
    const values = r ? [...r.A, ...r.AAAA, ...r.MX, ...r.sink] : [];
    const state = !row || servFailed(row) ? 'unknown' : values.length || r.NS.length ? 'answers' : 'quiet';
    if (!perZone.has(zone)) perZone.set(zone, new Map());
    const seen = perZone.get(zone), prev = seen.get(domain);
    // The same label twice counts once, at its worst state.
    const rank = { quiet: 0, unknown: 1, answers: 2 };
    seen.set(domain, !prev || rank[state] > rank[prev.state] ? { state, values: [...(prev?.values ?? []), ...values] } : { ...prev, values: [...prev.values, ...values] });
  }
  const controls = new Map();
  for (const [zone, seen] of perZone) {
    const list = [...seen.values()];
    const state = list.some(c => c.state === 'answers') ? 'answers' : list.length >= CONTROLS_PER_ZONE && list.every(c => c.state === 'quiet') ? 'quiet' : 'unknown';
    controls.set(zone, { state, values: list.flatMap(c => c.values) });
  }
  // Ratio guard. Count generated names per zone, and those whose row answers A, AAAA or MX.
  const massZones = new Set();
  if (regen.ok) {
    const tally = new Map();
    for (const n of names) if (!skip.has(n)) { const z = zoneOf(n, official); tally.set(z, { names: (tally.get(z)?.names ?? 0) + 1, answer: new Set() }); }
    for (const row of rows) {
      const d = name(row.domain);
      if (!names.has(d) || skip.has(d)) continue;
      const r = recordsOf(row);
      if (r.A.length || r.AAAA.length || r.MX.length || r.sink.length) tally.get(zoneOf(d, official))?.answer.add(d);
    }
    for (const [zone, t] of tally) if (t.names >= WILDCARD_MIN && t.answer.size / t.names > WILDCARD_RATIO) {
      massZones.add(zone);
      controls.set(zone, { state: 'answers', values: controls.get(zone)?.values ?? [], ratio: t.answer.size + ' of ' + t.names });
    }
  }
  const wildValues = new Set([...controls.values()].flatMap(c => c.values));
  const noControl = new Set();
  let wild = false;

  if (regen.ok) for (const row of rows) {
    const domain = name(row.domain);
    if (!domain || skip.has(domain)) continue;
    if (!names.has(domain)) { stats.notGenerated++; continue; }
    stats.captured++;
    const r = recordsOf(row);
    const fuzzer = String(row.fuzzer ?? '');
    const kinds = ['A', 'AAAA', 'MX'].filter(k => r[k].length);
    if (kinds.length) {
      const where = { domain, fuzzer, ...Object.fromEntries(kinds.map(k => [k, r[k].join(' ')])) };
      const zone = zoneOf(domain, official), ctl = controls.get(zone);
      const reason = ctl?.state === 'answers' || kinds.some(k => r[k].some(v => wildValues.has(v))) ? 'wildcard' : ctl?.state !== 'quiet' ? 'no-control' : null;
      if (reason) {
        stats.unverified++;
        if (reason === 'wildcard') { if (!massZones.has(zone)) wild = true; } else noControl.add(zone);
        leads.push(leadOf('unverified-lookalike', { ...where, reason }, 'low', domain + ' answers (' + kinds.join(', ') + '), but ' + (reason === 'wildcard'
          ? (massZones.has(zone) ? 'more than ' + WILDCARD_RATIO * 100 + '% of the generated names in .' + zone + ' answer too (' + ctl.ratio + ').' : 'a random name that cannot exist in .' + zone + ' also answers, or gives the same answer.') + ' The resolver answers for names nobody registered, so this does not show ' + domain + ' is registered.'
          : 'the capture has no usable control row for .' + zone + ', so a resolver wildcard is not ruled out.') + ' Review by hand.', 'dnstwist', { reviewOnly: true }));
        continue;
      }
      stats.resolving++;
      const can = [r.A.length || r.AAAA.length ? 'can serve a page' : null, r.MX.length ? 'can receive mail' : null].filter(Boolean).join(' and ');
      leads.push(leadOf('registered-lookalike', where, 'medium', domain + ' is a ' + fuzzer + ' lookalike of ' + official.join(', ') + ' and it resolves (' + kinds.join(', ') + '). It ' + can + '. The records alone do not show phishing.', 'dnstwist'));
    } else if (r.sink.length) {
      stats.unverified++;
      leads.push(leadOf('unverified-lookalike', { domain, fuzzer, sink: r.sink.join(' '), reason: 'non-routable' }, 'low', domain + ' answers only with a non-routable address (' + r.sink.join(', ') + '). That is often a sinkhole or a blocked name, not a live host. Review by hand.', 'dnstwist', { reviewOnly: true }));
    } else if (r.NS.length) {
      leads.push(leadOf('parked-lookalike', { domain, fuzzer, NS: r.NS.join(' ') }, 'low', domain + ' has name servers but no A, AAAA or MX. It is registered but not live. Watch it.', 'dnstwist', { reviewOnly: true }));
    } else stats.bare++;
  }
  if (captured && !perZone.size) missing('lookalike-evidence-missing', 'no control rows', 'The capture has no wildcard control rows, so a resolver that answers every name cannot be ruled out. No resolving lookalike is confirmed. Capture again.', 'dnstwist-capture');
  else if (noControl.size) missing('lookalike-evidence-missing', { controls: 'missing', zones: [...noControl].sort().join(' ') }, 'No usable control row for ' + [...noControl].sort().map(z => '.' + z).join(', ') + '. Resolving names there are not confirmed.', 'dnstwist-capture');
  if (massZones.size) missing('lookalike-evidence-missing', { wildcard: 'ratio', zones: [...massZones].sort().join(' ') }, 'More than ' + WILDCARD_RATIO * 100 + '% of the generated names in ' + [...massZones].sort().map(z => '.' + z + ' (' + controls.get(z).ratio + ')').join(', ') + ' answer A, AAAA or MX. Real lookalike registrations are far rarer, so the resolver wildcards there even if its control names look quiet. No name in that zone is confirmed. Use a resolver that returns NXDOMAIN and capture again.', 'dnstwist-capture');
  if (wild) missing('lookalike-evidence-missing', 'resolver wildcards', 'The resolver wildcards: a random name that cannot exist got an answer. Names that answer the same way are review-only. Use a resolver that returns NXDOMAIN and capture again.', 'dnstwist-capture');

  // Known scams: an exact match in a pinned list.
  const lists = Array.isArray(snapshot.blocklists) ? snapshot.blocklists : [];
  if (!lists.length) missing('blocklist-evidence-missing', 'no pinned blocklist', 'No pinned blocklist is in the snapshot. A lookalike cannot be checked against known scams.', 'blocklist');
  const brands = official.map(d => d.split('.')[0]).filter(label => label.length >= 4);
  for (const list of lists) {
    const { entries, problem } = parseList(list, { lab: snapshot.lab === true });
    const engine = 'blocklist:' + list.name;
    let found = 0;
    if (problem) {
      coverage.push({ engine, status: 'unavailable', leads: 0, reason: problem });
      missing('blocklist-evidence-missing', { list: String(list.name ?? ''), problem }, String(list.name) + ' is not usable evidence. ' + problem, engine);
      continue;
    }
    // Only the vendored MetaMask commit is checked by the pack. An operator commit carries a prefix,
    // so the where cell cannot pass for a checked pin.
    const pin = list.synthetic ? 'sha256:' + list.sha256 : list.name === METAMASK.name ? list.commit : 'operator:' + list.commit;
    const source = list.synthetic ? ' (synthetic lab list)' : list.name === METAMASK.name ? ' (vendored copy; commit and sha256 checked by the pack)' : ' (commit ' + list.commit.slice(0, 12) + ' is operator-stated; the pack checked only the sha256 of the pinned bytes)';
    for (const [domain, line] of entries) {
      const at = { domain, list: list.name, line: String(line), pin };
      const parent = domain.split('.').map((_, i, a) => a.slice(i).join('.')).slice(1).find(p => names.has(p) && !skip.has(p));
      found++;
      if (ownHost(domain)) {
        leads.push(leadOf('own-host-on-blocklist', at, 'low', domain + ' is the client\'s own host (or under it) and is on ' + list.name + ' at line ' + line + '. It is not a lookalike. Check why the list flags it.', engine, { reviewOnly: true }));
      } else if (names.has(domain)) {
        leads.push(leadOf('known-scam-lookalike', at, 'high', domain + ' is a lookalike of ' + official.join(', ') + ' and is on ' + list.name + source + ' at line ' + line + '.', engine));
      } else if (parent) {
        leads.push(leadOf('lookalike-host-on-blocklist', at, 'low', domain + ' is a host under the generated lookalike ' + parent + ' and is on ' + list.name + ' at line ' + line + '. The list names the host, not ' + parent + ' itself, so review by hand.', engine, { reviewOnly: true }));
      } else if (brands.some(b => domain.split('.').some(part => part.includes(b)))) {
        leads.push(leadOf('brand-on-blocklist', at, 'low', domain + ' carries the brand name and is on ' + list.name + ' at line ' + line + '. dnstwist did not generate it, so review by hand.', engine, { reviewOnly: true }));
      } else found--;
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
