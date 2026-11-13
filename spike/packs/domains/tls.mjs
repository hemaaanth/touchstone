// testssl.sh evidence and leads. The tool runs as a separate process in Docker
// (GPL-2.0, no code copied). Its JSON is narrowed to the graded findings and
// stored in the snapshot, so replay reads the pin, not a new handshake.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../lib/proof-evidence.mjs';
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

const report = (endpoint, doc) => {
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
  return { raw: sha256(JSON.stringify(doc)), url: endpoint.origin, host: endpoint.host, port: Number(endpoint.port), service: doc.scanResult?.[0]?.service ?? null, tools: 'testssl.sh ' + String(doc.version ?? '').trim(), grade, scans, problems: (doc.clientProblem1 ?? []).map(p => String(p.finding ?? '').slice(0, 200)) };
};

export function parseTestssl(text, endpoint) {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc?.scanResult) || !doc.scanResult.length) throw new Error('testssl.sh scanned no address for ' + endpoint.origin);
  // A scan row with no measured address or no grade is not a result.
  for (const scan of doc.scanResult) {
    if (!scan?.ip || !scan?.port || !scan?.targetHost) throw new Error('testssl.sh returned no measured address for ' + endpoint.origin);
    if (!(scan.rating ?? []).some(f => f.id === 'overall_grade' && String(f.finding ?? '').trim())) throw new Error('testssl.sh returned no grade for ' + endpoint.origin);
    if (scan.scanProblem?.severity === 'FATAL') throw new Error('testssl.sh could not scan ' + endpoint.origin + ': FATAL: ' + String(scan.scanProblem.finding ?? scan.scanProblem.code ?? 'FATAL scan problem').slice(0, 200));
  }
  return report(endpoint, doc);
}

// `run` is the caller's coverage-wrapped runTool. Each endpoint gets one file.
// A failed endpoint and an unparsable answer both come back as an error.
export async function captureTls(run, ws, targets, ipOf) {
  const runs = [], entries = [], evidence = [], errors = [];
  for (const [i, endpoint] of targets.entries()) {
    const file = '/work/.live/tls-' + i + '.json';
    const ip = ipOf(endpoint.host);
    const engine = 'testssl:' + endpoint.host + ':' + endpoint.port;
    const result = await run(engine, { image: TESTSSL, cmd: ['--jsonfile-pretty', file, '--severity', 'LOW', '--quiet', '--warnings', 'off', '--color', '0', '--connect-timeout', '10', '--openssl-timeout', '10', ...(ip ? ['--ip', ip] : []), endpoint.host + ':' + endpoint.port], timeoutMs: 240000 });
    const gap = error => { runs.push({ engine, error }); entries.push({ url: endpoint.origin, host: endpoint.host, port: Number(endpoint.port), error }); errors.push(error); };
    if (result.code || result.timedOut) { gap(result.stderr.trim().slice(-160) || (result.timedOut ? 'timed out' : 'exit code ' + result.code)); continue; }
    let text;
    try { text = readFileSync(join(ws, '.live', 'tls-' + i + '.json'), 'utf8'); }
    catch { gap('output file missing'); continue; }
    try { const report = parseTestssl(text, endpoint); runs.push({ engine, report }); entries.push(report); evidence.push(report); }
    catch (error) { gap(error.message); }
  }
  return { runs, entries, evidence, errors };
}

const hashOf = entry => /^[0-9a-f]{64}$/.test(String(entry?.raw ?? '')) ? 'Tool output sha256: ' + String(entry.raw).slice(0, 12) + '. ' : '';
const checkOf = id => 'tls-' + (id.toLowerCase().replace(/\s*<[^>]*>/g, '').replace(/[^a-z0-9_.-]+/g, '-') || 'finding');
const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', WARN: 'low' };
// What a stored report needs before a lead may rest on it. A hand-edited or old
// entry that fails this becomes a gap, never a clean result.
const usable = entry => Boolean(entry && /^[0-9a-f]{64}$/.test(String(entry.raw ?? ''))
  && typeof entry.grade === 'string' && entry.grade.trim()
  && Array.isArray(entry.scans) && entry.scans.length
  && entry.scans.every(scan => Array.isArray(scan?.findings)));

// TLS leads from the stored evidence. The handshake was measured once; a lead
// is the tool's graded opinion, not proof that a weakness is exploitable.
export function tlsLeads(snapshot) {
  const root = String(snapshot.root ?? '');
  if (!Array.isArray(snapshot.tls) || !snapshot.tls.length) {
    const coverage = (snapshot.discovery?.coverage ?? []).find(c => String(c.engine).startsWith('testssl'));
    const why = coverage?.status === 'unavailable'
      ? ' testssl.sh did not run: ' + String(coverage.reason ?? 'no reason given').slice(0, 160)
      : ' The snapshot was captured without a TLS handshake scan.';
    return [{ check: 'tls-evidence-missing', where: root, severity: 'informational', description: 'The snapshot has no TLS handshake evidence, so this run does not cover the TLS configuration.' + why + ' This does not prove the TLS is fine.' }];
  }
  const leads = [];
  for (const endpoint of snapshot.tls) {
    // An endpoint that was not measured keeps its own gap lead.
    if (endpoint.error) leads.push({ check: 'tls-evidence-missing', where: endpoint.url, severity: 'informational', description: 'The TLS handshake for ' + endpoint.url + ' was not measured: ' + endpoint.error + '. The other endpoints are unaffected. This does not prove the endpoint is clean.' });
    if (endpoint.error) continue;
    if (!usable(endpoint)) { leads.push({ check: 'tls-evidence-missing', where: endpoint.url, severity: 'informational', description: 'The stored TLS report for ' + endpoint.url + ' is incomplete (no hash, grade or scans), so this run does not prove the handshake. ' + hashOf(endpoint) + 'This does not prove the endpoint is clean.' }); continue; }
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
  return leads;
}
