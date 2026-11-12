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
import { assertInternal } from './labctl.mjs';

const DNSX = 'projectdiscovery/dnsx:v1.2.2@sha256:8fced0bedf3655e06c9f1805f6277d60d4988a4b13209e24b3d7cde7baa656ec';
const HTTPX = 'projectdiscovery/httpx:v1.7.1@sha256:4458ef60897c6abd1d93f7efa82c10c23b783d8ec974e2abd17e4711ff52cb41';
const NUCLEI = 'projectdiscovery/nuclei:v3.4.2@sha256:d0e34e04a7180c6b944550b81fe50719f57383affcb18ae7a42c0045643d54af';
const SUBFINDER = 'projectdiscovery/subfinder:v2.6.8@sha256:bf8f25e6dfb8806afa917ff1d4741fabe9296152ef150a4a539115bb6a77e682';
export const KATANA = 'projectdiscovery/katana:v1.2.2@sha256:5dc4db5bea876732f2e393a460c2145de1e7385c1884b5d9129beb34acd4e45b';
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

// Crawl: katana in standard mode with JavaScript parsing (-jc). Headless mode is off.
// Its Chromium makes its own calls to hosts outside the grant, so it is not offline-safe.
// Limits match httpx: 5 requests a second, 2 at a time, 10 s timeout, 1 retry. Depth 3, 120 s at most.
// -or and -ob stay off: with no body, katana parses no JavaScript.
export const MAX_CRAWL = 100;
const quote = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const PORTS = [{ scheme: 'https', port: 443 }, { scheme: 'http', port: 80 }];
const isDefault = ({ scheme, port }) => (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
// Only granted hosts, their subdomains, and the granted scheme and port pairs.
export const crawlScope = (scope, ports = PORTS) => '^(?:' + ports.map(p => p.scheme + '://([a-z0-9-]+\\.)*(' + scope.map(quote).join('|') + ')' + (isDefault(p) ? '(:' + p.port + ')?' : ':' + p.port)).join('|') + ')(?:/|$)';
const portAllowed = (u, ports) => ports.some(p => p.scheme + ':' === u.protocol && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === p.port);
export const katanaArgs = (list, scope, resolver, ports = PORTS) => ['-list', list, '-jsonl', '-silent', '-duc', '-jc', '-kf', 'robotstxt,sitemapxml', '-d', '3', '-ct', '120s', '-iqp',
  '-rl', '5', '-c', '2', '-p', '2', '-timeout', '10', '-retry', '1', '-mrs', '2097152', '-cs', crawlScope(scope, ports),
  '-ef', 'png,jpg,jpeg,gif,svg,ico,webp,css,woff,woff2,ttf,eot,mp4', ...(resolver ? ['-r', 'udp:' + resolver + ':53'] : [])];
// katana -jsonl rows to crawl rows. Seed URLs have no source, and httpx already has them.
// A row with no status_code is a URL katana requested whose answer it did not keep (often an SPA fallback page).
export function parseKatana(stdout, scope, ports = PORTS) {
  const out = new Map();
  for (const r of jsonl(stdout)) {
    if (!r.request?.source) continue;
    let u; try { u = new URL(r.request.endpoint); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !inScope(u.hostname, scope) || !portAllowed(u, ports)) continue;
    u.hash = ''; u.search = '';
    if (out.has(u.href)) continue;
    const status = Number.isInteger(r.response?.status_code) ? r.response.status_code : null;
    out.set(u.href, { url: u.href, status, type: status ? String(r.response.headers?.['content-type'] ?? '') : '', tag: String(r.request.tag ?? ''), attribute: String(r.request.attribute ?? ''), source: r.request.source });
  }
  return [...out.values()].sort((a, b) => a.url < b.url ? -1 : 1);
}
// Why a tool did not run, in words an operator can act on.
export function failReason(result, image) {
  const tail = String(result.stderr ?? '').trim().slice(-200);
  if (result.timedOut) return 'Timed out. ' + tail;
  if (result.code === 125) return 'Docker could not run the image ' + image + '. ' + tail;
  return 'Exited with code ' + result.code + '. ' + tail;
}

// crawl: also run katana over the live pages. Surface sets it. Domains does not need it.
export async function captureDomain({ ws, domain, reach, wordlist = WORDLIST, crawl = false }) {
  const scope = assertReach(reach, domain);
  ensureImage();
  const dir = join(ws, '.live');
  mkdirSync(dir, { recursive: true });
  const coverage = [], env = reach.env ?? {};
  const put = (name, items) => writeFileSync(join(dir, name), items.join('\n') + '\n');
  const run = async (engine, opts, leads = n => n) => {
    const result = await runTool({ ws, network: reach.network, env, ...opts });
    const status = result.code === 0 && !result.timedOut ? 'ran' : 'unavailable';
    coverage.push({ engine, status, code: result.code, timedOut: result.timedOut, reason: status === 'ran' ? undefined : failReason(result, opts.image), leads: 0 });
    return Object.assign(result, { note: n => { coverage.find(c => c.engine === engine).leads = n; return n; } });
  };
  try {
    const passive = await run('subfinder', { image: SUBFINDER, env: { ...env, HOME: '/tmp' }, cmd: ['-d', domain, '-silent', '-oJ', '-duc', '-nW', '-timeout', '5', '-max-time', '1'], timeoutMs: 120000 });
    const found = parseSubfinder(passive.stdout, scope);
    passive.note(found.length);
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
    const ports = reach.ports ?? PORTS;
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
    let crawled = null;
    if (crawl && pages.length) {
      put('crawl.txt', [...new Set(pages.map(p => new URL(p.url).origin + '/'))]);
      const k = await run('katana', { image: KATANA, env: { ...env, HOME: '/tmp', XDG_CONFIG_HOME: '/tmp/.config' }, cmd: katanaArgs('/work/.live/crawl.txt', scope, reach.resolver, ports), timeoutMs: 180000 });
      const rows = parseKatana(k.stdout, scope, ports); k.note(rows.length);
      crawled = rows.slice(0, MAX_CRAWL);
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
    return { schema: 1, root: domain, zone, dns, http, rdap: null, contenthash: null, discovery: { source: 'live', hosts: live.sort(), sources: Object.fromEntries(live.map(h => [h, [...(found.includes(h) ? ['subfinder'] : []), ...(h === domain || wordlist.some(w => w + '.' + domain === h) ? [h === domain ? 'apex' : 'wordlist'] : [])]])), wildcard: Boolean(wildAnswers), nuclei: hits, ...(crawled ? { crawl: crawled } : {}), coverage } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// Capture a domain and pin the snapshot in the workspace. The run then replays against the pin.
export async function pinLive(ws, domain, reach, options = {}) {
  const snapshot = await captureDomain({ ws, domain, reach, ...options });
  pinSnapshot(ws, snapshot);
  return snapshot;
}
