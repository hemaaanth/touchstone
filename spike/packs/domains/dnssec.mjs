// DNSViz evidence and leads. The tool runs as a separate pair of processes in
// Docker (GPL-2.0, no code copied). Probe output is assessed once and the
// assessment is stored in the snapshot, so replay reads the pin.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../lib/proof-evidence.mjs';
export const DNSVIZ = 'dnsviz/dnsviz@sha256:5a4c5e8293d591010bd57fb2e79a803865607d72457e74335229130f69265932';
const fqdn = domain => domain.endsWith('.') ? domain : domain + '.';
const text = (value, max = 300) => String(value ?? '').slice(0, max);
// CoreDNS always omits RA in the lab; it says nothing about the chain.
const IGNORED = new Set(['RECURSION_NOT_AVAILABLE']);
const VERDICTS = new Set(['SECURE', 'INSECURE', 'BOGUS']);
// Every graded error, including the ones nested under an RRSIG entry. Warnings
// live in their own arrays and are not errors.
function errorsOf(entry) {
  const out = new Map();
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (Array.isArray(node.errors)) for (const e of node.errors) {
      if (typeof e?.code !== 'string' || typeof e?.description !== 'string' || IGNORED.has(e.code)) continue;
      out.set(e.code + '\n' + e.description, { code: text(e.code, 60), description: text(e.description) });
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'errors') walk(value);
  };
  walk(entry);
  return [...out.values()].slice(0, 10);
}

// One DNSViz assessment entry to the snapshot's dnssec evidence.
// delegation.status is the chain verdict: SECURE, INSECURE or a bogus state.
export function parseDnssec(text_, domain) {
  const doc = JSON.parse(text_);
  const entry = doc[fqdn(domain)];
  if (!entry || typeof entry !== 'object') throw new Error('dnsviz assessed no entry for ' + domain);
  const warnings = (Array.isArray(entry.warnings) ? entry.warnings : []).map(e => ({ code: text(e?.code, 60), description: text(e?.description) })).slice(0, 10);
  const delegation = text(entry.delegation?.status, 30) || 'UNKNOWN';
  const dnskeys = Array.isArray(entry.dnskey) ? entry.dnskey : [];
  const signed = dnskeys.some(key => key && key.key_tag != null);
  const dsOk = (Array.isArray(entry.delegation?.ds) ? entry.delegation.ds : []).some(ds => ds?.status === 'SECURE' || ds?.status === 'VALID');
  const query = entry.queries?.[fqdn(domain) + '/IN/DNSKEY'];
  // A claim needs the fields it rests on; a missing field is incomplete evidence.
  const missing = [];
  if (!VERDICTS.has(delegation)) missing.push(delegation === 'UNKNOWN' ? 'no chain verdict' : 'unknown chain verdict ' + delegation);
  if (delegation === 'SECURE') { if (!signed) missing.push('no DNSKEY'); if (!dsOk) missing.push('no valid DS'); }
  // INSECURE is complete when the zone is signed with no DS at the parent, or
  // when the DNSKEY query definitely answered empty.
  if (delegation === 'INSECURE' && !signed && !((query?.nodata?.length) || (query?.nxdomain?.length))) missing.push('no DNSKEY answer');
  const errors = errorsOf(entry);
  const complete = missing.length === 0;
  return {
    domain,
    raw: sha256(text_),
    status: text(entry.status, 30) || 'UNKNOWN',
    delegation,
    signed,
    complete,
    reason: complete ? null : missing.join(', '),
    validatedChain: complete && delegation === 'SECURE' && errors.length === 0,
    errors,
    warnings,
  };
}

// `run` is the caller's coverage-wrapped runTool. Probe needs DNS; grok does not.
// A failure at either step comes back as an error.
export async function captureDnssec(run, ws, domain, resolver, tag = '') {
  const probe = '/work/.live/dnssec-probe' + tag + '.json';
  const report = '/work/.live/dnssec' + tag + '.json';
  const probed = await run('dnsviz-probe' + tag, { image: DNSVIZ, cmd: ['probe', ...(resolver ? ['-s', resolver] : []), '-o', probe, domain], timeoutMs: 180000 });
  if (probed.code || probed.timedOut) return { evidence: null, error: probed.stderr.trim().slice(-160) || (probed.timedOut ? 'probe timed out' : 'probe exit code ' + probed.code) };
  const assessed = await run('dnsviz-grok' + tag, { image: DNSVIZ, network: 'none', cmd: ['grok', '-r', probe, '-c', '-o', report, domain], timeoutMs: 60000 });
  if (assessed.code || assessed.timedOut) return { evidence: null, error: assessed.stderr.trim().slice(-160) || (assessed.timedOut ? 'grok timed out' : 'grok exit code ' + assessed.code) };
  let text;
  try { text = readFileSync(join(ws, '.live', 'dnssec' + tag + '.json'), 'utf8'); }
  catch { return { evidence: null, error: 'output file missing' }; }
  try { return { evidence: parseDnssec(text, domain), error: null }; }
  catch (error) { return { evidence: null, error: error.message || ('grok exit code ' + assessed.code) }; }
}

// What the coverage rows should say about a stored assessment, or null when it
// is complete. Incomplete evidence must not read as a ran check.
export function assessmentCoverage(evidence) {
  return evidence && evidence.complete !== true ? { status: 'unavailable', reason: 'incomplete assessment: ' + (evidence.reason ?? 'missing fields') } : null;
}

// DNSSEC leads from the stored evidence. A signed and valid chain is reported
// only by the absence of a lead; it never proves the operator wants DNSSEC.
export function dnssecLeads(snapshot) {
  const root = String(snapshot.root ?? '');
  const dnssec = snapshot.dnssec;
  if (!dnssec) {
    const coverage = (snapshot.discovery?.coverage ?? []).find(c => String(c.engine).startsWith('dnsviz'));
    const why = coverage?.status === 'unavailable'
      ? ' DNSViz did not run: ' + String(coverage.reason ?? 'no reason given').slice(0, 160)
      : ' The snapshot was captured without a DNSSEC probe.';
    return [{ check: 'dnssec-evidence-missing', where: root, severity: 'informational', description: 'The snapshot has no DNSSEC chain evidence, so this run does not cover DNSSEC.' + why + ' This does not prove DNSSEC is disabled.' }];
  }
  const errors = Array.isArray(dnssec.errors) ? dnssec.errors : [], warnings = Array.isArray(dnssec.warnings) ? dnssec.warnings : [];
  const hash = /^[0-9a-f]{64}$/.test(String(dnssec.raw ?? '')) ? ' Tool output sha256: ' + String(dnssec.raw).slice(0, 12) + '.' : '';
  // A verdict and its error list must be stored, and the tool output hashed.
  if (dnssec.complete !== true || !Array.isArray(dnssec.errors) || !hash || !['SECURE','INSECURE','BOGUS'].includes(dnssec.delegation)) return [{ check: 'dnssec-evidence-missing', where: root, severity: 'informational', description: 'The stored DNSViz assessment is incomplete (' + (dnssec.reason ?? (dnssec.complete !== true ? 'no complete verdict' : !hash ? 'no tool output hash' : 'unknown chain verdict')) + '), so this run does not prove the chain state.' + hash + ' This does not prove DNSSEC is disabled.' }];
  if (dnssec.delegation === 'INSECURE' && dnssec.signed) return [{ check: 'dnssec-no-ds', where: root, severity: 'low', description: 'The zone is signed but its parent publishes no DS record, so validators treat the zone as insecure. The signatures are not anchored to the root trust chain.' + hash }];
  // A bogus verdict or an invalid signature is broken, whatever the signing state.
  if (dnssec.delegation === 'BOGUS' || dnssec.errors.length || (dnssec.signed && !dnssec.validatedChain)) return [{ check: 'dnssec-broken-chain', where: root, severity: 'high', description: (dnssec.signed ? 'The zone is signed but the chain does not validate' : 'The chain is bogus') + ' (' + dnssec.delegation + '). ' + (errors[0]?.description ?? 'DNSViz reported no usable chain.') + ' A resolver that validates may treat the zone as bogus.' + hash }];
  if (!dnssec.signed) return [{ check: 'dnssec-unsigned', where: root, severity: 'low', description: 'The zone is not signed. No DNSKEY is published and the parent has no usable DS, so resolvers cannot validate the answers. The chain was measured once and says the zone is insecure, which is different from an unread chain.' + hash }];
  if (warnings.length) return [{ check: 'dnssec-warning', where: root, severity: 'low', description: 'The chain validates, but DNSViz warned: ' + warnings[0].description + hash }];
  return [];
}
