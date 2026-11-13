// DNSViz evidence and leads. The tool runs as a separate pair of processes in
// Docker (GPL-2.0, no code copied). Probe output is assessed once and the
// assessment is stored in the snapshot, so replay reads the pin.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const DNSVIZ = 'dnsviz/dnsviz@sha256:5a4c5e8293d591010bd57fb2e79a803865607d72457e74335229130f69265932';
const fqdn = domain => domain.endsWith('.') ? domain : domain + '.';
const text = (value, max = 300) => String(value ?? '').slice(0, max);
const list = value => (Array.isArray(value) ? value : []).map(e => ({ code: text(e?.code, 60), description: text(e?.description) })).slice(0, 10);

// One DNSViz assessment entry to the snapshot's dnssec evidence.
// delegation.status is the chain verdict: SECURE, INSECURE or a bogus state.
export function parseDnssec(text_, domain) {
  const doc = JSON.parse(text_);
  const entry = doc[fqdn(domain)];
  if (!entry) throw new Error('dnsviz assessed no entry for ' + domain);
  const errors = list(entry.errors), warnings = list(entry.warnings);
  const delegation = text(entry.delegation?.status, 30) || 'UNKNOWN';
  const signed = (entry.dnskey ?? []).length > 0;
  return {
    domain,
    status: text(entry.status, 30) || 'UNKNOWN',
    delegation,
    signed,
    validatedChain: signed && (delegation === 'SECURE' || delegation === 'VALID') && errors.length === 0,
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
  const assessed = await run('dnsviz-grok' + tag, { image: DNSVIZ, cmd: ['grok', '-r', probe, '-c', '-o', report, domain], timeoutMs: 60000 });
  try { return { evidence: parseDnssec(readFileSync(join(ws, '.live', 'dnssec' + tag + '.json'), 'utf8'), domain), error: null }; }
  catch (error) { return { evidence: null, error: error.message || ('grok exit code ' + assessed.code) }; }
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
  if (!dnssec.signed || dnssec.delegation === 'INSECURE') return [{ check: 'dnssec-unsigned', where: root, severity: 'low', description: 'The zone is not signed. No DNSKEY is published and the parent has no usable DS, so resolvers cannot validate the answers. The chain was measured once and says the zone is insecure, which is different from an unread chain.' }];
  if (!dnssec.validatedChain) return [{ check: 'dnssec-broken-chain', where: root, severity: 'high', description: 'The zone is signed but the chain does not validate (' + dnssec.delegation + '). ' + (dnssec.errors[0]?.description ?? 'DNSViz reported no usable chain.') + ' A resolver that validates may treat the zone as bogus.' }];
  if (dnssec.warnings.length) return [{ check: 'dnssec-warning', where: root, severity: 'low', description: 'The chain validates, but DNSViz warned: ' + dnssec.warnings[0].description }];
  return [];
}
