// Live capture: turn one domain into the pinned snapshot the evidence checks read.
// Every tool runs through runTool(). The network comes from `reach`, never from this file.
//   reach = { network, granted, scope, resolver?, ports?, env? }
// Every capture needs a grant: `granted: true` and a `scope` list that covers the domain.
// The platform (Reach) fills `reach`. The lab fills its own, for the lab domain only.
// A network name is never a grant. A network named like the lab must also be --internal in Docker.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from '../../lib/wrap.mjs';
import { pinSnapshot } from '../../lib/proof-evidence.mjs';
import { IMAGE, ensureImage } from './checks.mjs';
import { checkEmail, emailLeads } from './email.mjs';
import { captureTls, testsslTargets, tlsLeads } from './tls.mjs';
import { captureDnssec, dnssecLeads } from './dnssec.mjs';
import { assertInternal } from './labctl.mjs';

const DNSX = 'projectdiscovery/dnsx:v1.2.2@sha256:8fced0bedf3655e06c9f1805f6277d60d4988a4b13209e24b3d7cde7baa656ec';
const HTTPX = 'projectdiscovery/httpx:v1.7.1@sha256:4458ef60897c6abd1d93f7efa82c10c23b783d8ec974e2abd17e4711ff52cb41';
const NUCLEI = 'projectdiscovery/nuclei:v3.4.2@sha256:d0e34e04a7180c6b944550b81fe50719f57383affcb18ae7a42c0045643d54af';
const SUBFINDER = 'projectdiscovery/subfinder:v2.6.8@sha256:bf8f25e6dfb8806afa917ff1d4741fabe9296152ef150a4a539115bb6a77e682';
const TEMPLATE = fileURLToPath(new URL('./templates/github-takeover.yaml', import.meta.url));
// A short list of names that real projects use. subfinder adds the names that public sources know.
export const WORDLIST = ['www', 'app', 'api', 'cdn', 'docs', 'staging', 'stage', 'dev', 'test', 'beta', 'old', 'static', 'assets', 'blog', 'status', 'admin', 'portal', 'rpc', 'wallet', 'bridge', 'swap', 'claim', 'airdrop', 'mint', 'stake', 'dashboard', 'mail', 'ns'];
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const LAB_NAME = /^touchstone-domains-/;

// A host is in scope when it is a listed name or a subdomain of one.
export const inScope = (host, scope) => scope.some(s => host === s || host.endsWith('.' + s));
export function assertReach(reach, domain) {
  if (!DOMAIN.test(domain ?? '')) throw new Error('Invalid domain');
  if (!reach || typeof reach.network !== 'string') throw new Error('Live capture needs reach.network from the platform');
  if (reach.granted !== true || !Array.isArray(reach.scope) || !inScope(domain, reach.scope)) throw new Error('Live capture needs a grant that covers ' + domain);
  if (LAB_NAME.test(reach.network)) assertInternal(reach.network);
  return reach.scope;
}
const lines = text => String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
const jsonl = text => lines(text).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const nameOf = value => String(value).toLowerCase().replace(/\.$/, '');

export const parseSubfinder = (stdout, scope) => [...new Set(jsonl(stdout).map(r => nameOf(r.host)).filter(h => DOMAIN.test(h) && inScope(h, scope)))];
// dnsx rows to dns evidence rows. NXDOMAIN becomes ENOTFOUND, an empty answer becomes ENODATA.
export function dnsRows(rows) {
  const out = [];
  for (const r of rows) {
    const host = nameOf(r.host), gone = r.status_code === 'NXDOMAIN';
    for (const [type, key] of [['A', 'a'], ['AAAA', 'aaaa'], ['CNAME', 'cname']]) {
      const answers = (r[key] ?? []).map(nameOf);
      out.push({ host, type, status: answers.length ? 'NOERROR' : gone ? 'ENOTFOUND' : 'ENODATA', answers });
    }
  }
  return out;
}
// A zone file in the lab's own style. dns-zonefile parses it in the analyzer.
export function synthZone(root, rows) {
  const out = ['$ORIGIN ' + root + '.', '$TTL 60', '@ IN SOA ns.' + root + '. hostmaster.' + root + '. ( 1 60 60 3600 60 )'];
  const by = new Map();
  for (const r of rows) if (r.answers.length && inScope(r.host, [root])) { by.set(r.host, by.get(r.host) ?? {}); by.get(r.host)[r.type] = r.answers; }
  for (const [host, t] of by) {
    const name = host === root ? '@' : host.slice(0, -root.length - 1);
    if (t.CNAME) out.push(name + ' IN CNAME ' + t.CNAME[0] + '.');
    else for (const [type, key] of [['A', 'A'], ['AAAA', 'AAAA']]) for (const ip of t[key] ?? []) out.push(name + ' IN ' + type + ' ' + ip);
  }
  return out.join('\n') + '\n';
}
export const originOf = (host, { scheme, port }) => scheme + '://' + host + ((scheme === 'http' && port === 80) || (scheme === 'https' && port === 443) ? '' : ':' + port);
const HIDE = new Set(['date', 'connection', 'keep-alive']);
// httpx -json -irr rows to http evidence rows. raw_header holds the headers. body holds the body.
export function httpRows(rows) {
  return rows.map(r => {
    const headers = {};
    for (const line of String(r.raw_header ?? '').split('\r\n').slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) { const key = line.slice(0, i).trim().toLowerCase(); if (!HIDE.has(key)) headers[key] = headers[key] ? headers[key] + ', ' + line.slice(i + 1).trim() : line.slice(i + 1).trim(); }
    }
    return { url: new URL(r.url).href, status: r.status_code, headers, body: String(r.body ?? '') };
  });
}
// Script URLs a page loads, limited to hosts the grant covers.
export function scriptUrls(pages, scope) {
  const urls = new Set();
  for (const page of pages) {
    if (!(page.headers['content-type'] ?? '').includes('text/html')) continue;
    for (const m of page.body.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      try { const u = new URL(m[1], page.url); if (/^https?:$/.test(u.protocol) && inScope(u.hostname, scope)) urls.add(u.href); } catch {}
    }
  }
  return [...urls];
}

export async function captureDomain({ ws, domain, reach, wordlist = WORDLIST }) {
  const scope = assertReach(reach, domain);
  ensureImage();
  const dir = join(ws, '.live');
  mkdirSync(dir, { recursive: true });
  const coverage = [], env = reach.env ?? {};
  const put = (name, items) => writeFileSync(join(dir, name), items.join('\n') + '\n');
  const run = async (engine, opts, leads = n => n) => {
    const result = await runTool({ ws, network: reach.network, env, ...opts });
    const status = result.code === 0 && !result.timedOut ? 'ran' : 'unavailable';
    coverage.push({ engine, status, code: result.code, timedOut: result.timedOut, reason: status === 'ran' ? undefined : result.stderr.slice(-200), leads: 0 });
    return Object.assign(result, { note: n => { coverage.find(c => c.engine === engine).leads = n; return n; } });
  };
  try {
    const passive = await run('subfinder', { image: SUBFINDER, env: { ...env, HOME: '/tmp' }, cmd: ['-d', domain, '-silent', '-oJ', '-duc', '-nW', '-timeout', '5', '-max-time', '1'], timeoutMs: 120000 });
    const found = parseSubfinder(passive.stdout, scope);
    passive.note(found.length);
    // Email authentication is DNS only. It keeps its own evidence key, so a
    // failed run is a coverage gap, never a clean result.
    const emailCheck = await checkEmail(run, domain, reach.resolver);
    const email = emailCheck.evidence;
    const emailCoverage = coverage.find(c => c.engine === 'checkdmarc');
    if (email) {
      emailCoverage.leads = emailLeads({ root: domain, email }).length;
      if (emailCheck.partial) { emailCoverage.status = 'unavailable'; emailCoverage.reason = emailCheck.error; }
    } else { emailCoverage.status = 'unavailable'; emailCoverage.reason = emailCoverage.reason || emailCheck.error; }
    // The DNSSEC chain is probed through the granted resolver. A failed chain
    // read is a coverage gap, not an unsigned zone.
    const dnssecCheck = await captureDnssec(run, ws, domain, reach.resolver);
    const dnssec = dnssecCheck.evidence;
    const dnssecCoverage = coverage.find(c => c.engine === 'dnsviz-probe');
    if (dnssec) dnssecCoverage.leads = dnssecLeads({ root: domain, dnssec }).length;
    else for (const row of coverage.filter(c => String(c.engine).startsWith('dnsviz'))) { row.status = 'unavailable'; row.reason = row.reason || dnssecCheck.error || 'the chain was not read'; }
    const wild = 'touchstone-nx-' + Math.random().toString(36).slice(2, 10) + '.' + domain;
    const candidates = [...new Set([domain, ...wordlist.map(w => w + '.' + domain), ...found, wild])];
    put('hosts.txt', candidates);
    const resolver = reach.resolver ? ['-r', reach.resolver] : [];
    const dnsArgs = ['-a', '-aaaa', '-cname', '-json', '-silent', '-duc', '-rl', '20', '-t', '5', '-retry', '1'];
    const brute = await run('dnsx', { image: DNSX, cmd: ['-l', '/work/.live/hosts.txt', ...resolver, ...dnsArgs], timeoutMs: 180000 });
    if (brute.timedOut || (brute.code && !brute.stdout)) throw new Error('dnsx failed: ' + brute.stderr.slice(-300));
    let rows = jsonl(brute.stdout);
    // A wildcard answers for any name. Drop hosts that only repeat its answer.
    const wildRow = rows.find(r => nameOf(r.host) === wild && r.status_code === 'NOERROR');
    const wildAnswers = wildRow ? JSON.stringify([wildRow.a ?? [], wildRow.cname ?? []]) : null;
    rows = rows.filter(r => nameOf(r.host) !== wild && r.status_code === 'NOERROR' && (r.a?.length || r.aaaa?.length || r.cname?.length) && JSON.stringify([r.a ?? [], r.cname ?? []]) !== wildAnswers);
    brute.note(rows.length);
    // Resolve the targets of CNAMEs too. A target that is gone is the dangling-cname evidence.
    const targets = [...new Set(rows.flatMap(r => (r.cname ?? []).map(nameOf)))].filter(t => !rows.some(r => nameOf(r.host) === t));
    let targetRows = [];
    if (targets.length) {
      put('targets.txt', targets);
      const t = await run('dnsx-cname-targets', { image: DNSX, cmd: ['-l', '/work/.live/targets.txt', ...resolver, ...dnsArgs], timeoutMs: 120000 });
      targetRows = jsonl(t.stdout); t.note(targetRows.length);
    }
    const dns = dnsRows([...rows, ...targetRows]);
    const zone = synthZone(domain, dns);
    const live = rows.filter(r => r.a?.length || r.aaaa?.length || r.cname?.length).map(r => nameOf(r.host)).filter(h => inScope(h, scope));
    const ports = reach.ports ?? [{ scheme: 'https', port: 443 }, { scheme: 'http', port: 80 }];
    const probe = async (engine, urls) => {
      put('urls.txt', urls);
      const res = await run(engine, { image: HTTPX, cmd: ['-l', '/work/.live/urls.txt', ...(reach.resolver ? ['-r', 'udp:' + reach.resolver + ':53'] : []), '-json', '-silent', '-duc', '-nfs', '-sc', '-title', '-irh', '-irr', '-rl', '5', '-t', '2', '-timeout', '10', '-retries', '1'], timeoutMs: 180000 });
      const out = httpRows(jsonl(res.stdout)); res.note(out.length);
      return out;
    };
    const pages = live.length ? await probe('httpx', live.flatMap(h => ports.map(p => originOf(h, p)))) : [];
    const scripts = scriptUrls(pages, scope).filter(u => !pages.some(p => p.url === u));
    const assets = scripts.length ? await probe('httpx-scripts', scripts) : [];
    const http = [...pages, ...assets].sort((a, b) => a.url < b.url ? -1 : 1);
    // TLS is measured only where the capture already found an https endpoint.
    // The A record is passed as --ip, so the lab needs no resolver in the container.
    const tlsCheck = await captureTls(run, ws, testsslTargets(http.map(r => r.url)), host => dns.find(r => r.host === host && r.type === 'A' && r.answers.length)?.answers[0]);
    for (const check of tlsCheck.runs) {
      const row = coverage.find(c => c.engine === check.engine);
      if (check.report) row.leads = tlsLeads({ root: domain, tls: [check.report] }).length;
      else { row.status = 'unavailable'; row.reason = row.reason || check.error || 'the handshake was not measured'; }
    }
    const hits = [];
    if (pages.length) {
      copyFileSync(TEMPLATE, join(dir, 'github-takeover.yaml'));
      put('pages.txt', pages.map(p => p.url));
      if (reach.resolver) put('resolvers.txt', [reach.resolver]);
      const nuclei = await run('nuclei', { image: NUCLEI, env: { ...env, HOME: '/tmp', XDG_CONFIG_HOME: '/tmp/.config' }, cmd: ['-l', '/work/.live/pages.txt', '-t', '/work/.live/github-takeover.yaml', ...(reach.resolver ? ['-r', '/work/.live/resolvers.txt'] : []), '-jsonl', '-silent', '-duc', '-ni', '-rl', '5', '-c', '2', '-timeout', '10', '-retries', '0'], timeoutMs: 180000 });
      for (const hit of jsonl(nuclei.stdout)) hits.push({ template: hit['template-id'], url: new URL(hit['matched-at']).href, severity: hit.info?.severity });
      nuclei.note(hits.length);
    }
    return { schema: 1, root: domain, zone, dns, http, email, tls: tlsCheck.entries, dnssec, rdap: null, contenthash: null, discovery: { source: 'live', hosts: live.sort(), sources: Object.fromEntries(live.map(h => [h, [...(found.includes(h) ? ['subfinder'] : []), ...(h === domain || wordlist.some(w => w + '.' + domain === h) ? [h === domain ? 'apex' : 'wordlist'] : [])]])), wildcard: Boolean(wildAnswers), nuclei: hits, coverage } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// Capture a domain and pin the snapshot in the workspace. The run then replays against the pin.
export async function pinLive(ws, domain, reach) {
  const snapshot = await captureDomain({ ws, domain, reach });
  pinSnapshot(ws, snapshot);
  return snapshot;
}
