// checkdmarc evidence and leads. The tool runs as a separate process in Docker
// (Apache-2.0, no code copied). Its JSON is narrowed to the records that matter
// here and stored in the snapshot, so replay reads the pin, not the network.
import { sha256 } from '../../lib/proof-evidence.mjs';
export const CHECKDMARC = 'letiemble/checkdmarc:6.0.3@sha256:be9d7e828fe80ace6140fdc0f4b499c10fffb2001be5f346718c3ec6dd6c90cd';
const FAIL = { fail: '-all', softfail: '~all', neutral: '?all', pass: '+all', permerror: '?all', temperror: '?all' };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

// A record is present when the tool returned it. Absence needs the tool's own
// "does not exist" answer; a missing field alone proves nothing.
const stateOf = part => {
  if (text(part?.record)) return 'present';
  return /^(?:An? (?:SPF|DMARC) record does not exist(?: for this domain or its parent domains)?\.?|The domain .+ does not exist\.?)$/i.test(text(part?.error) ?? '') ? 'absent' : 'unread';
};

// One checkdmarc JSON result to the snapshot's email evidence.
// Fields the tool omits stay omitted, so a partial result still parses.
export function parseCheckdmarc(stdout, domain) {
  const parsed = JSON.parse(stdout);
  const result = (Array.isArray(parsed) ? parsed.find(r => r.domain === domain) : parsed);
  if (!result || result.domain !== domain) throw new Error('checkdmarc returned no result for ' + domain);
  const warnings = list => (Array.isArray(list) ? list : []).filter(w => typeof w === 'string').map(w => w.slice(0, 200));
  return {
    domain,
    raw: sha256(stdout),
    spf: {
      state: stateOf(result.spf),
      record: text(result.spf?.record),
      valid: result.spf?.valid === true,
      all: FAIL[String(result.spf?.parsed?.all ?? '').toLowerCase()] ?? null,
      error: text(result.spf?.error),
      warnings: warnings(result.spf?.warnings),
    },
    dmarc: {
      state: stateOf(result.dmarc),
      record: text(result.dmarc?.record),
      valid: result.dmarc?.valid === true,
      policy: text(result.dmarc?.tags?.p?.value),
      reports: text(result.dmarc?.tags?.rua?.value) !== null,
      error: text(result.dmarc?.error),
      warnings: warnings(result.dmarc?.warnings),
    },
    mx: {
      hosts: (Array.isArray(result.mx?.hosts) ? result.mx.hosts : []).map(h => text(h?.hostname ?? h)).filter(Boolean),
      nullMx: warnings(result.mx?.warnings).some(w => /null MX/i.test(w)),
    },
    dnssec: result.dnssec === true,
  };
}

// `run` is the caller's coverage-wrapped runTool. A tool error and an unparsable
// answer both come back as `error`, so the caller records a coverage gap.
export async function checkEmail(run, domain, resolver) {
  const result = await run('checkdmarc', { image: CHECKDMARC, cmd: [domain, ...(resolver ? ['-n', resolver] : []), '-t', '5', '--retries', '1'], timeoutMs: 60000 });
  if (result.code || result.timedOut) return { evidence: null, error: result.stderr.trim().slice(-200) || (result.timedOut ? 'timed out' : 'exit code ' + result.code) };
  try {
    const evidence = parseCheckdmarc(result.stdout, domain);
    const unread = [evidence.spf, evidence.dmarc].filter(part => part.state === 'unread');
    return unread.length
      ? { evidence, partial: true, error: 'checkdmarc did not report ' + (unread.length === 2 ? 'SPF and DMARC' : unread[0] === evidence.spf ? 'SPF' : 'DMARC') + ' state' }
      : { evidence, error: null };
  } catch (error) { return { evidence: null, error: error.message }; }
}

// Email-authentication leads from the stored evidence. A record fact proves the
// published policy, never that a spoofed message reaches an inbox.
export function emailLeads(snapshot) {
  const root = String(snapshot.root ?? '');
  const email = snapshot.email;
  if (!email) {
    const coverage = (snapshot.discovery?.coverage ?? []).find(c => c.engine === 'checkdmarc');
    const why = coverage?.status === 'unavailable'
      ? ' checkdmarc did not run: ' + String(coverage.reason ?? 'no reason given').slice(0, 160)
      : ' The snapshot was captured without an email record scan.';
    return [{ check: 'email-auth-evidence-missing', where: root, severity: 'informational', description: 'The snapshot has no SPF or DMARC evidence, so this run does not cover email authentication.' + why + ' This does not prove the records are absent.' }];
  }
  const leads = [];
  const unread = [email.spf?.state === 'unread' && 'SPF', email.dmarc?.state === 'unread' && 'DMARC'].filter(Boolean);
  const hash = (email.raw ?? '') && ' Tool output sha256: ' + String(email.raw).slice(0, 12) + '.';
  const recorded = [email.spf?.state, email.dmarc?.state].every(state => ['present','absent','unread'].includes(state));
  if (!recorded || !/^[0-9a-f]{64}$/.test(String(email.raw ?? ''))) {
    const why = recorded ? 'no tool output hash' : 'SPF and DMARC state';
    return [{ check: 'email-auth-evidence-missing', where: root, severity: 'informational', description: 'The stored email evidence is incomplete (' + why + '), so this run does not prove the record state.' + (email.raw ? hash : '') + ' This does not prove a record is absent.' }];
  }
  const parts = unread.length === 2 ? 'SPF and DMARC' : unread[0];
  if (unread.length) leads.push({ check: 'email-auth-evidence-missing', severity: 'informational', description: 'checkdmarc returned no ' + parts + ' state, so this run does not cover ' + parts + ' for ' + root + '. The rest of the email evidence is kept. This does not prove the record is absent.' + hash });
  if (email.dmarc?.state === 'absent') leads.push({ check: 'email-dmarc-missing', severity: 'medium', description: 'No DMARC record was published for ' + root + ' (the tool reported that it does not exist). Receivers have no policy for the From header, so spoofed mail can pass as the domain. This proves the record is absent at capture time, not that a spoof reaches an inbox.' + hash });
  if (email.dmarc?.state === 'present' && !email.dmarc?.valid) leads.push({ check: 'email-dmarc-invalid', severity: 'medium', description: 'A DMARC record exists for ' + root + ' but it does not parse: ' + (email.dmarc.error ?? email.dmarc.record) + '. Receivers may ignore it, so it enforces nothing.' + hash });
  if (email.dmarc?.state === 'present' && email.dmarc?.valid) {
    if (email.dmarc?.policy === 'none') leads.push({ check: 'email-dmarc-policy-none', severity: 'low', description: 'The DMARC policy is p=none, so receivers report failures but do not quarantine or reject them. The record asks for visibility only.' + hash });
    if (!email.dmarc?.reports) leads.push({ check: 'email-dmarc-no-reporting', severity: 'low', description: 'The DMARC record has no rua address, so receivers are not asked to send aggregate reports. Failed authentication stays invisible to the operator.' + hash });
  }
  if (email.spf?.state === 'absent') leads.push({ check: 'email-spf-missing', severity: 'low', description: 'No SPF record was published for ' + root + ' (the tool reported that it does not exist). Receivers cannot check that a sending server is authorised for the domain.' + hash });
  if (email.spf?.state === 'present' && !email.spf?.valid) leads.push({ check: 'email-spf-invalid', severity: 'low', description: 'An SPF record exists for ' + root + ' but it does not parse: ' + (email.spf.error ?? email.spf.record) + '. Receivers may treat it as a permanent error.' + hash });
  if (email.spf?.state === 'present' && email.spf?.valid && email.spf?.all === '+all') leads.push({ check: 'email-spf-allows-all', severity: 'low', description: 'The SPF record ends with +all, so every sending address passes the SPF check. The record is published but authorises any server.' + hash });
  return leads.map(lead => ({ ...lead, where: root }));
}
