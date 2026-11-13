// testssl.sh evidence and leads. The tool runs as a separate process in Docker
// (GPL-2.0, no code copied). The snapshot stores its JSON file and the sha256
// of the file bytes. Leads re-parse that file, so replay reads the pin, not a
// new handshake.
import { isIP } from 'node:net';
import { join } from 'node:path';
import { sha256 } from '../../lib/proof-evidence.mjs';
import { runTool } from '../../lib/wrap.mjs';
import { PUBLIC_SUFFIXES } from '../../lib/grant-store.mjs';
import { readOutputFile, readStored, storedRecord } from './stored.mjs';
export const TESTSSL = 'drwetter/testssl.sh:3.2@sha256:64bab3c1fd8eee440f68d5e020dd633c1f2d375fe0ae593bdfec2725110a7e29';
// Severities testssl grades. OK and INFO carry no finding a person must read.
const KEEP = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'WARN']);
const SECTIONS = ['protocols', 'ciphers', 'fs', 'serverDefaults', 'headerResponse', 'vulnerabilities', 'rating'];
export const MAX_TARGETS = 2;
const isHttps = url => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };

// Captured https origins, one per origin, capped so capture stays bounded.
export function testsslTargets(urls) {
  const origins = new Map();
  for (const url of urls) {
    if (!isHttps(url)) continue;
    const parsed = new URL(url);
    if (!origins.has(parsed.origin)) origins.set(parsed.origin, { origin: parsed.origin, host: parsed.hostname, port: parsed.port || '443' });
  }
  return [...origins.values()].slice(0, MAX_TARGETS);
}

const report = (endpoint, doc, text) => {
  const grade = doc.scanResult?.flatMap(scan => scan.rating ?? []).find(f => f.id === 'overall_grade')?.finding ?? null;
  const scans = (doc.scanResult ?? []).map(scan => ({
    ip: scan.ip ?? null,
    findings: SECTIONS.flatMap(section => (scan[section] ?? []).filter(f => KEEP.has(f.severity)).map(f => ({
      id: String(f.id ?? 'unknown').slice(0, 80),
      severity: f.severity,
      finding: String(f.finding ?? '').slice(0, 300),
      ...(f.cwe ? { cwe: f.cwe } : {}),
    }))),
  }));
  return { raw: sha256(text), url: endpoint.origin, host: endpoint.host, port: Number(endpoint.port), service: doc.scanResult?.[0]?.service ?? null, tools: 'testssl.sh ' + String(doc.version ?? '').trim(), grade, scans, problems: (doc.clientProblem1 ?? []).map(p => String(p.finding ?? '').slice(0, 200)) };
};

export function parseTestssl(text, endpoint) {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc?.scanResult) || !doc.scanResult.length) throw new Error('testssl.sh scanned no address for ' + endpoint.origin);
  // A scan row with no measured address or no grade is not a result.
  for (const scan of doc.scanResult) {
    if (!scan?.ip || !scan?.port || !scan?.targetHost) throw new Error('testssl.sh returned no measured address for ' + endpoint.origin);
    // The scan must be of this endpoint, so a stored file cannot move to another url.
    if (scan.targetHost !== endpoint.host || String(scan.port) !== String(endpoint.port)) throw new Error('testssl.sh scanned ' + String(scan.targetHost).slice(0, 80) + ':' + String(scan.port).slice(0, 8) + ', not ' + endpoint.host + ':' + endpoint.port);
    if (!(scan.rating ?? []).some(f => f.id === 'overall_grade' && String(f.finding ?? '').trim())) throw new Error('testssl.sh returned no grade for ' + endpoint.origin);
    // testssl writes a scan problem as {id:"scanProblem",severity:"FATAL"} inside
    // whichever section array was open when it stopped. Look in every one.
    const fatal = Object.values(scan).filter(Array.isArray).flat().find(f => f?.id === 'scanProblem' && f?.severity === 'FATAL');
    if (fatal) throw new Error('testssl.sh could not scan ' + endpoint.origin + ': FATAL: ' + String(fatal.finding ?? 'FATAL scan problem').slice(0, 200));
  }
  return report(endpoint, doc, text);
}

// `run` is the caller's coverage-wrapped runTool. Each endpoint gets one file.
// A failed endpoint and an unparsable answer both come back as an error.
// ipOf(host) is the one address the caller checked. testssl.sh gets it with --ip,
// which binds its TLS connections. Some checks still use the host name: the
// Winshock check fetches http://<name>/ with curl. So the container also gets the
// name pinned to that address (--add-host) and a resolver where nothing listens,
// and testssl.sh makes no DNS lookup of its own (--nodns none). An unknown path
// that needs any other name fails. With no address the endpoint is not run.
// The env is fixed (PHONE_OUT=false: no CRL, OCSP or pwnedkeys fetch); no other
// env reaches the container. One address per endpoint: the others are not scanned.
export const TESTSSL_ENV = { PHONE_OUT: 'false' };
// `entries` is what the snapshot stores: the endpoint plus the file text and
// its sha256, or the endpoint plus the error. `evidence` holds the parsed reports.
export async function captureTls(run, ws, targets, ipOf) {
  const runs = [], entries = [], evidence = [], errors = [];
  for (const [i, endpoint] of targets.entries()) {
    const file = '/work/.live/tls-' + i + '.json';
    const ip = ipOf(endpoint.host);
    const engine = 'testssl:' + endpoint.host + ':' + endpoint.port;
    const gap = error => { runs.push({ engine, error }); entries.push({ url: endpoint.origin, host: endpoint.host, port: Number(endpoint.port), error }); errors.push(error); };
    if (!ip) { gap('Not run: no checked address for ' + endpoint.host + '. testssl.sh would look the name up again by itself.'); continue; }
    const pin = isIP(endpoint.host) ? [] : [[endpoint.host, ip]];
    // testssl.sh connects over IPv4 unless told otherwise, so an IPv6 checked
    // address needs -6. The name stays pinned to that one address.
    const family = isIP(ip) === 6 ? ['-6'] : [];
    // A bad pin (an address or name our own validation refuses) fails this one
    // endpoint as a gap, never the whole capture.
    let result;
    try { result = await run(engine, { image: TESTSSL, env: TESTSSL_ENV, addHosts: pin, cmd: ['--jsonfile-pretty', file, '--severity', 'LOW', '--quiet', '--warnings', 'off', '--color', '0', '--connect-timeout', '10', '--openssl-timeout', '10', '--nodns', 'none', ...family, '--ip', ip, endpoint.host + ':' + endpoint.port], timeoutMs: 240000 }); }
    catch (error) { gap('the endpoint was not scanned: ' + String(error?.message ?? error).slice(0, 160)); continue; }
    if (result.code || result.timedOut) { gap(result.stderr.trim().slice(-160) || (result.timedOut ? 'timed out' : 'exit code ' + result.code)); continue; }
    let text;
    try { text = readOutputFile(join(ws, '.live', 'tls-' + i + '.json')); }
    catch (error) { gap(/not UTF-8/.test(error.message) ? error.message : 'output file missing'); continue; }
    try {
      const report = parseTestssl(text, endpoint);
      const entry = { url: endpoint.origin, host: endpoint.host, port: Number(endpoint.port), ...storedRecord(text) };
      runs.push({ engine, entry }); entries.push(entry); evidence.push(report);
    } catch (error) { gap(error.message); }
  }
  return { runs, entries, evidence, errors };
}

// CAA evidence. testssl.sh asks DNS for the CAA record, but the capture runs it
// with --nodns none (so a rebind cannot move its connection). So the capture asks
// the CAA question itself, through the granted resolver, with drill (it ships in
// the testssl image). A domain with no CAA record at any level up to the
// registrable domain lets any CA issue for it: a LOW lead, the same testssl made.
export const DRILL_IMAGE = TESTSSL;

// The names to ask: the granted name and each parent, stopping at the registrable
// domain (one label below the public suffix). The public-suffix set is the scope
// code's own `PUBLIC_SUFFIXES` (lib/grant-store.mjs), so `example.co.uk` asks
// `example.co.uk` but never `co.uk`. Most specific first.
export function caaNames(domain) {
  const labels = String(domain ?? '').split('.').filter(Boolean);
  if (labels.length < 2) return labels.length ? [labels.join('.')] : [];
  if (PUBLIC_SUFFIXES.has(labels.join('.'))) return [];
  let etld = 1; // labels in the public suffix; default a single TLD label
  for (let i = 2; i < labels.length; i++) if (PUBLIC_SUFFIXES.has(labels.slice(labels.length - i).join('.'))) etld = i;
  const registrable = etld + 1;
  if (labels.length < registrable) return [];
  const out = [];
  for (let i = 0; i <= labels.length - registrable; i++) out.push(labels.slice(i).join('.'));
  return out;
}

// One drill answer to the CAA records that apply to `name`, following the CNAME
// chain the answer returned (RFC 8659 counts the alias target's CAA). `ok` is true
// only for a full answer: not truncated (tc), and a definite rcode (NOERROR or
// NXDOMAIN). A truncated or odd answer is never read as "no record". `target` is a
// CNAME target with no CAA in this answer, so the caller can ask it at the resolver.
const fqdnName = name => String(name).toLowerCase().replace(/\.+$/, '') + '.';
export function parseCaaBlock(block, name) {
  const text = String(block ?? '');
  const flags = /flags:\s*([a-z ]*?)\s*;/.exec(text)?.[1] ?? '';
  const rcode = /rcode:\s*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase();
  const ok = !/\btc\b/.test(flags) && (rcode === 'NOERROR' || rcode === 'NXDOMAIN');
  const caa = new Map(), cname = new Map();
  for (const line of text.split('\n')) {
    let m = /^(\S+)\s+\d+\s+IN\s+CAA\s+(.+?)\s*$/.exec(line);
    if (m) { const o = m[1].toLowerCase(); if (!caa.has(o)) caa.set(o, []); caa.get(o).push(m[2].trim().slice(0, 200)); continue; }
    m = /^(\S+)\s+\d+\s+IN\s+CNAME\s+(\S+?)\.?\s*$/.exec(line);
    if (m) cname.set(m[1].toLowerCase(), fqdnName(m[2]));
  }
  let cur = fqdnName(name); const origin = cur; const seen = new Set();
  for (let hop = 0; hop < 8; hop++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    if (caa.has(cur)) return { ok, records: caa.get(cur), target: null };
    if (cname.has(cur)) { cur = cname.get(cur); continue; }
    return { ok, records: [], target: cur === origin ? null : cur.replace(/\.$/, '') };
  }
  return { ok, records: [], target: cur === origin ? null : cur.replace(/\.$/, '') };
}

// The stored drill output is one block per queried name, each after a
// "TOUCHSTONE-CAA <name>" marker. The walk returns the first level with a CAA
// record (present), or incomplete when a query before any record was not a full
// answer. A truncated stored answer therefore replays as incomplete, not "no record".
export function caaVerdict(output) {
  const parts = String(output ?? '').split(/^;; TOUCHSTONE-CAA (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim(), { ok, records } = parseCaaBlock(parts[i + 1] ?? '', name);
    if (records.length) return { present: true, name, records };
    if (!ok) return { incomplete: true, name };
  }
  return { present: false };
}

// `run` is runTool (a test stand-in replaces it), so the drill call gets runTool's
// guards: --pull=never, the capture's network, the hardening, a named container and
// the Daytona decision. drill asks the granted resolver directly over TCP (-t, so a
// large answer is not truncated), so no name of the target is resolved and no page is
// fetched. A CNAME target whose CAA is not inline is asked at the SAME resolver, with
// a small hop limit; a target name is only ever a question to the resolver. Returns
// { record, present } to store, or { error } so the caller gaps the row.
export async function captureCaa(domain, { resolver, network, env = {}, run = runTool, timeoutMs = 20000 } = {}) {
  const names = caaNames(domain);
  if (!resolver) return { record: null, present: null, error: 'no resolver, so the CAA question was not asked' };
  if (!names.length) return { record: null, present: null, error: 'no registrable name to ask CAA for' };
  const blocks = [];
  const asked = new Set();
  const ask = async (name) => {
    const res = await run({ image: DRILL_IMAGE, network, env, entrypoint: 'drill', cmd: ['-t', 'CAA', name, '@' + resolver], timeoutMs });
    if (res.timedOut || res.code) return { error: 'the CAA query for ' + name + ' did not run: ' + (String(res.stderr ?? '').trim().slice(-120) || (res.timedOut ? 'timed out' : 'exit code ' + res.code)) };
    blocks.push(';; TOUCHSTONE-CAA ' + name + '\n' + String(res.stdout ?? ''));
    return { out: String(res.stdout ?? '') };
  };
  for (const start of names) {
    let cur = start;
    for (let hop = 0; hop < 4; hop++) {
      if (asked.has(cur)) break;
      asked.add(cur);
      const a = await ask(cur);
      if (a.error) return { record: null, present: null, error: a.error };
      const p = parseCaaBlock(a.out, cur);
      if (!p.ok) return { record: null, present: null, error: 'the CAA answer for ' + cur + ' was not a full answer (truncated or no definite result), so CAA was not checked' };
      if (p.records.length) return { record: { domain, ...storedRecord(blocks.join('\n')) }, present: true };
      if (p.target && !asked.has(p.target)) { cur = p.target; continue; }
      break; // no CAA for this name and its CNAME chain; go to the parent
    }
  }
  return { record: { domain, ...storedRecord(blocks.join('\n')) }, present: false };
}

// A CAA lead from the stored drill output. No record anywhere up to the registrable
// domain is a LOW lead. The output is re-parsed, so replay reads the pin.
export function caaLeads(snapshot) {
  const root = String(snapshot.root ?? '');
  if (!snapshot.caa) return [];
  const read = readStored(snapshot.caa, output => caaVerdict(output));
  if (read.error || read.evidence.present !== false) return [];
  return [{ check: 'tls-dns_caarecord', where: root, severity: 'low', description: 'No CAA record is published for ' + root + ' or its parents up to the registrable domain, so any certificate authority may issue a certificate for the name. The capture asked the granted resolver, not the TLS scanner. This is a configuration gap, not proof of mis-issuance.' }];
}

const hashOf = entry => /^[0-9a-f]{64}$/.test(String(entry?.raw ?? '')) ? 'Tool output sha256: ' + String(entry.raw).slice(0, 12) + '. ' : '';
const checkOf = id => 'tls-' + (id.toLowerCase().replace(/\s*<[^>]*>/g, '').replace(/[^a-z0-9_.-]+/g, '-') || 'finding');
const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', WARN: 'low' };
// What a parsed report needs before a lead may rest on it. A report that fails
// this becomes a gap, never a clean result.
const usable = entry => Boolean(entry && /^[0-9a-f]{64}$/.test(String(entry.raw ?? ''))
  && typeof entry.grade === 'string' && entry.grade.trim()
  && Array.isArray(entry.scans) && entry.scans.length
  && entry.scans.every(scan => Array.isArray(scan?.findings) && scan.findings.every(isFinding)));
const isFinding = f => Boolean(f && typeof f === 'object' && typeof f.id === 'string' && f.id && typeof f.severity === 'string' && typeof f.finding === 'string');

// TLS leads from the stored testssl files. The handshake was measured once; a
// lead is the tool's graded opinion, not proof that a weakness is exploitable.
export function tlsLeads(snapshot) {
  const root = String(snapshot.root ?? '');
  if (!Array.isArray(snapshot.tls) || !snapshot.tls.length) {
    const coverage = (snapshot.discovery?.coverage ?? []).find(c => String(c.engine).startsWith('testssl'));
    const why = coverage?.status === 'unavailable'
      ? ' testssl.sh did not run: ' + String(coverage.reason ?? 'no reason given').slice(0, 160)
      : ' The snapshot was captured without a TLS handshake scan.';
    return [{ check: 'tls-evidence-missing', where: root, severity: 'informational', description: 'The snapshot has no TLS handshake evidence, so this run does not cover the TLS configuration.' + why + ' This does not prove the TLS is fine.' }, ...caaLeads(snapshot)];
  }
  const leads = [];
  for (const stored of snapshot.tls) {
    if (!stored || typeof stored !== 'object' || typeof stored.url !== 'string') { leads.push({ check: 'tls-evidence-missing', where: root, severity: 'informational', description: 'A stored TLS entry is not a report, so this run does not prove that handshake. This does not prove the endpoint is clean.' }); continue; }
    // An endpoint that was not measured keeps its own gap lead.
    if (stored.error) { leads.push({ check: 'tls-evidence-missing', where: stored.url, severity: 'informational', description: 'The TLS handshake for ' + stored.url + ' was not measured: ' + stored.error + '. The other endpoints are unaffected. This does not prove the endpoint is clean.' }); continue; }
    // The file must match its stored hash and parse for this endpoint. A
    // stored grade or finding is ignored; only the re-parsed file counts.
    const read = readStored(stored, text => parseTestssl(text, { origin: stored.url, host: stored.host, port: stored.port }));
    if (read.error) { leads.push({ check: 'tls-evidence-missing', where: stored.url, severity: 'informational', description: 'The stored TLS evidence for ' + stored.url + ' cannot be used (' + read.error + '), so this run does not prove the handshake. This does not prove the endpoint is clean.' }); continue; }
    const endpoint = read.evidence;
    if (!usable(endpoint)) { leads.push({ check: 'tls-evidence-missing', where: stored.url, severity: 'informational', description: 'The TLS report for ' + stored.url + ' is incomplete or damaged (no grade, scans or finding id), so this run does not prove the handshake. ' + hashOf(endpoint) + 'This does not prove the endpoint is clean.' }); continue; }
    const seen = new Set();
    for (const scan of endpoint.scans) for (const finding of scan.findings) {
      const check = checkOf(finding.id);
      if (seen.has(check)) continue;
      seen.add(check);
      leads.push({
        check,
        where: endpoint.url,
        severity: SEVERITY[finding.severity] ?? 'low',
        description: 'testssl.sh graded ' + finding.id + ' as ' + finding.severity + ': ' + finding.finding + (endpoint.grade ? ' The overall handshake grade is ' + endpoint.grade + '.' : '') + ' The handshake was measured once against ' + endpoint.host + ':' + endpoint.port + (scan.ip ? ' at ' + scan.ip : '') + '. This is the tool\'s grade, not proof of exploit. ' + hashOf(endpoint),
      });
    }
  }
  return [...leads, ...caaLeads(snapshot)];
}
