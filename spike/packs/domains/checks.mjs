import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../../lib/wrap.mjs';
import { sha256, loadSnapshot } from '../../lib/proof-evidence.mjs';
import { emailLeads } from './email.mjs';
import { tlsLeads } from './tls.mjs';

export const IMAGE = 'touchstone-domains-tools:wave2';
// Build the tools image from this folder when it is missing. This builds our own image. It runs no third-party code.
let imageReady;
export function ensureImage() {
  if (imageReady) return;
  try { execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }); }
  catch { execFileSync('docker', ['build', '-t', IMAGE, fileURLToPath(new URL('.', import.meta.url))], { stdio: 'ignore', timeout: 600000 }); }
  imageReady = true;
}
export async function analyzeSnapshot(snapshot) {
  ensureImage();
  if (snapshot.schema !== 1 || typeof snapshot.zone !== 'string' || !Array.isArray(snapshot.http) || !Array.isArray(snapshot.dns)) throw new Error('Invalid DNS/HTTP snapshot');
  const ws = mkdtempSync(join(tmpdir(), 'touchstone-evidence-'));
  try {
    writeFileSync(join(ws, 'snapshot.json'), JSON.stringify(snapshot));
    const result = await runTool({ image: IMAGE, ws, cmd: [], timeoutMs: 60000 });
    if (result.code !== 0 || result.timedOut) throw new Error('Snapshot analyzer failed: ' + result.stderr.slice(-1000));
    return JSON.parse(result.stdout);
  } finally { rmSync(ws, { recursive: true, force: true }); }
}
// A where is a string, or an object of cited cells. The object keys become cells in the evidence viewer.
const stable = value => typeof value === 'string' ? value : JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)));
const sameWhere = (a, b) => (typeof a === 'string' || (a && typeof a === 'object')) && stable(a) === stable(b);
// Unclaimed-resource pages, per provider. A CNAME to the provider plus this page means the name can be claimed.
// The page is the provider's own: a 404 on the root, in the provider's markup, and not huge.
// The real GitHub page is about 9 KB. The markup shape does the work. The size cap only stops a giant page.
// The same words in a 200 page, a script or a blog post are not the unclaimed page.
const PAGE_LIMIT = 32768;
const PROVIDERS = [
  { name: 'GitHub Pages', target: /\.github\.io$/i, status: 404, shape: /<(?:p|h1|h2|strong|title)\b[^>]*>(?:\s*<[^>]+>)*\s*There isn't a GitHub Pages site here\./i },
  { name: 'Heroku', target: /\.herokuapp\.com$/i, status: 404, shape: /<title>\s*No such app\s*<\/title>/i },
  { name: 'Amazon S3', target: /\.s3[.-][a-z0-9.-]*amazonaws\.com$/i, status: 404, shape: /<Code>\s*NoSuchBucket\s*<\/Code>|<li>\s*Code:\s*NoSuchBucket\s*<\/li>/ },
];
export function unclaimedPage(response, provider) {
  const type = response.headers['content-type'] ?? '';
  return new URL(response.url).pathname === '/' && /html|xml/i.test(type) && !/javascript/i.test(type)
    && response.status === provider.status && response.body.length <= PAGE_LIMIT && provider.shape.test(response.body);
}
const fqdn = (name, root) => name === '@' ? root : name.endsWith('.') ? name.slice(0, -1) : name + '.' + root;
const validSRI = value => String(value).split(/\s+/).some(token => {
  const match = token.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/);
  return match && Buffer.from(match[2], 'base64').length === {sha256:32,sha384:48,sha512:64}[match[1]];
});

const NEVER_APPROVES = /connect|verify/i;
export function domainLeads(snapshot, analysis) {
  const leads = [];
  const add = (check, where, severity, description, engine = 'touchstone') => leads.push({id:sha256(check + '\n' + stable(where)).slice(0,16),check,where,severity,impact:severity[0].toUpperCase()+severity.slice(1),description,engine,file:'snapshot.json',lines:[]});
  const root = analysis.zone.$origin.replace(/\.$/, '');
  for (const record of analysis.zone.cname ?? []) {
    const target = fqdn(record.alias, root);
    const missing = ['A','AAAA'].every(type => snapshot.dns.some(r => r.host === target && r.type === type && r.status === 'ENOTFOUND' && r.answers.length === 0));
    if (missing) add('dangling-cname', fqdn(record.name, root), 'low', 'The CNAME points to ' + target + ', which returned NXDOMAIN for A and AAAA. This proves stale DNS, not service claimability.');
  }
  for (const record of analysis.zone.cname ?? []) {
    const name = fqdn(record.name, root), target = fqdn(record.alias, root);
    const provider = PROVIDERS.find(p => p.target.test(target));
    if (!provider) continue;
    // The snapshot must show the CNAME too, so a lone page cannot raise this lead.
    const aliased = snapshot.dns.some(r => r.host === name && r.type === 'CNAME' && r.answers.includes(target));
    const page = aliased && snapshot.http.find(r => new URL(r.url).hostname === name && unclaimedPage(r, provider));
    if (page) {
      add('subdomain-takeover-fingerprint', name, 'high', 'The CNAME points to ' + target + ' (' + provider.name + '). At capture time the host served the provider page for an unclaimed resource. Anyone who claims that resource there could serve content on ' + name + '. The snapshot proves the page, not that a claim succeeds.');
      // A second engine that agrees ranks the lead first.
      if (snapshot.discovery?.nuclei?.some(h => h.template === 'github-takeover' && new URL(h.url).hostname === name)) leads.at(-1).engines = ['touchstone', 'nuclei'];
    }
  }
  const seenPolicies = new Set(), seenScripts = new Set();
  for (const page of analysis.pages) {
    const response = snapshot.http.find(r => r.url === page.url);
    if (!(response.headers['content-type'] ?? '').includes('text/html') || response.status >= 400) continue;
    const bodyHash = sha256(response.body);
    const policyKey = bodyHash + ':' + page.policy;
    if (!seenPolicies.has(policyKey) && page.csp.some(f => f.severity <= 30)) add('weak-csp',page.url,'low','The enforcing HTTP CSP has missing or unsafe directives: ' + [...new Set(page.csp.filter(f=>f.severity<=30).map(f=>f.directive))].join(', ') + '. Report-only policies do not enforce protection.','csp-evaluator');
    seenPolicies.add(policyKey);
    for (const script of page.scripts) {
      if (new URL(script.src).origin === new URL(page.url).origin || validSRI(script.integrity)) continue;
      const scriptKey = bodyHash + ':' + script.src;
      if (seenScripts.has(scriptKey)) continue;
      seenScripts.add(scriptKey);
      const wallet = /(?:ethers|web3|walletconnect|connect-kit|wagmi|viem)/i.test(new URL(script.src).pathname);
      add(wallet ? 'wallet-cdn-without-sri' : 'third-party-script-without-sri',page.url + '#script=' + script.src,'medium','The page loads a third-party ' + (wallet ? 'wallet library' : 'script') + ' without a valid SRI hash. A CDN change can change code served to wallet users.');
    }
  }
  // Behavior replay: the page ran in a fake wallet. A Connect or Claim click that asks for an unlimited approval is harm.
  const framed = [];
  for (const page of analysis.behavior ?? []) {
    const response = snapshot.http.find(r => r.url === page.url);
    if (page.controls.length) framed.push({ page, response });
    for (const control of page.controls) for (const harm of control.harm) {
      const kinds = { 'erc20-approve': 'an ERC-20 approve', 'set-approval-for-all': 'setApprovalForAll', permit: 'a Permit signature' };
      // Connect and Verify never need an approval, so an approval there is Critical.
      // Claim, Airdrop and Mint may ask for one, so the same request is High until a person reads it.
      const severity = NEVER_APPROVES.test(control.label) ? 'critical' : 'high';
      const need = severity === 'critical' ? 'A connect action only needs the account list.' : 'Some real claim and mint pages ask for an approval, so a person must read the spender.';
      add('wallet-drainer-behavior', { url: page.url, control: control.selector + ' "' + control.label + '"', wallet_request: kinds[harm.kind] ?? harm.kind, asset: harm.asset, spender: harm.spender, amount: harm.amount }, severity,
        'Clicking "' + control.label + '" makes the page ask the wallet for ' + kinds[harm.kind] + ' of ' + harm.amount + ' on ' + harm.asset + ' to spender ' + harm.spender + '. ' + need + ' The page ran against the pinned snapshot in a fake wallet. No transaction was sent.', 'jsdom-replay');
    }
  }
  const seenFrames = new Set();
  for (const { page, response } of framed) {
    if (response.status >= 400 || seenFrames.has(sha256(response.body))) continue;
    seenFrames.add(sha256(response.body));
    const csp = response.headers['content-security-policy'] ?? '';
    if (!response.headers['x-frame-options'] && !/(?:^|;)\s*frame-ancestors\s/i.test(csp)) add('missing-frame-protection', page.url, 'low', 'The page has a wallet connect control and no X-Frame-Options header or CSP frame-ancestors directive. Another site can frame it and trick a user into clicking.', 'touchstone');
  }
  for (const response of snapshot.http) {
    if (!(response.headers['content-type'] ?? '').includes('javascript')) continue;
    if (/(?:eth_signTypedData_v4|setApprovalForAll|approve\s*\()/i.test(response.body) && /(?:0x[fF]{64}|MaxUint256|2\s*\*\*\s*256)/.test(response.body) && /(?:spender|operator|recipient)/i.test(response.body)) add('wallet-unlimited-approval-pattern',response.url,'low','The captured bundle combines a wallet signing or approval API with an unlimited allowance and a spender or operator. This is a review lead, not proof of malware or theft.');
  }
  for (const lead of leads) if (lead.check === 'wallet-unlimited-approval-pattern') lead.reviewOnly = true;
  for (const file of analysis.retire.data ?? []) for (const result of file.results ?? []) {
    const index = Number(file.file?.match(/\/(\d+)\.js$/)?.[1]);
    const response = snapshot.http[index];
    if (response && result.vulnerabilities?.length) add('known-vulnerable-js',response.url,'medium','Retire.js matched ' + result.component + ' ' + result.version + ' against the pinned advisory data. Exploitability needs review.','retire.js');
  }
  // Email-authentication evidence. The records are stored in the snapshot, so replay reads the pin.
  for (const lead of emailLeads(snapshot)) add(lead.check, lead.where, lead.severity, lead.description, 'checkdmarc');
  // TLS evidence. Each lead is the tool's grade on a measured handshake, stored in the pin.
  for (const lead of tlsLeads(snapshot)) add(lead.check, lead.where, lead.severity, lead.description, 'testssl');
  if (!snapshot.dnssec?.validatedChain) add('dnssec-evidence-missing',root,'informational','The snapshot has no validated DNSSEC chain. This does not prove DNSSEC is disabled.');
  if (!snapshot.rdap?.status?.some(s => /server.*(?:transfer|update|delete).*prohibited/i.test(s.replaceAll(' ','')))) add('registry-lock-evidence-missing',root,'informational','The snapshot has no RDAP evidence of a registry lock. A registrar transfer lock alone is not a registry lock.');
  if (snapshot.contenthash && (!snapshot.contenthash.value?.startsWith('ipfs://') || !snapshot.contenthash.pinnedCid || snapshot.contenthash.value.slice(7) !== snapshot.contenthash.pinnedCid)) add('frontend-content-pin-missing',snapshot.contenthash.name,'informational','The captured ENS/IPFS configuration has no matching immutable content CID and pin receipt. This proves missing evidence, not lost content.');
  const rank = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
  return leads.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// Surface turns the snapshot into a typed inventory. Every row is a lead. None is a vulnerability.
// Each row says what it is, how it was found, and which pack takes it next.
const WALLET = /(?:ethers|web3|walletconnect|connect-kit|wagmi|viem|ethereum|wallet)/i;
export function classifyService(response) {
  const type = response.headers['content-type'] ?? '';
  if (PROVIDERS.some(p => unclaimedPage(response, p))) return { kind: 'provider-error-page', next: 'domains', why: 'it serves a cloud provider page for a missing resource' };
  if (/json/.test(type) || /\/rpc\b/.test(new URL(response.url).pathname)) return { kind: 'api-endpoint', next: 'web', why: 'it answers like an API or RPC endpoint' };
  if (type.includes('text/html') && (WALLET.test(response.body) || /connect\s+wallet/i.test(response.body))) return { kind: 'wallet-frontend', next: 'domains', why: 'the page loads wallet code or shows a connect control' };
  return { kind: 'web-page', next: 'web', why: 'it serves a web page' };
}
export function classifyHost(name, root, records) {
  const cname = records.find(r => r.type === 'CNAME' && r.answers.length)?.answers[0];
  if (name === root) return { kind: 'apex', next: 'domains', why: 'it is the registered domain' };
  if (cname && PROVIDERS.some(p => p.target.test(cname))) return { kind: 'provider-cname', next: 'domains', why: 'its CNAME points to ' + cname + ', a claimable provider name' };
  if (cname) return { kind: 'cname', next: 'domains', why: 'it is an alias of ' + cname };
  return { kind: 'address', next: 'domains', why: 'it resolves to an address' };
}
export function surfaceLeads(snapshot, analysis) {
  const assets = new Map();
  const root = analysis.zone.$origin.replace(/\.$/, '');
  const sources = snapshot.discovery?.sources ?? {};
  const add = (type, where, detail, source, info) => {
    const key = type + ':' + where;
    if (assets.has(key)) return;
    const found = (sources[type === 'host' ? where : new URL(where).hostname] ?? [source]).join(', ');
    assets.set(key, { id: sha256(key).slice(0, 16), check: 'discovered-' + type, type, where, kind: info.kind, foundBy: found, description: detail + ' Kind: ' + info.kind + ' (' + info.why + '). Found by: ' + found + '. Next pack: ' + info.next + '.', engine: source, impact: 'Informational', severity: 'informational', scope: snapshot.discovery?.source ?? 'lab', nextPack: info.next });
  };
  const hosts = new Set();
  for (const type of ['a', 'aaaa', 'cname', 'srv']) for (const record of analysis.zone[type] ?? []) hosts.add(fqdn(record.name, root));
  for (const name of [...hosts].sort()) add('host', name, 'Captured zone record.', 'dns-zonefile', classifyHost(name, root, snapshot.dns.filter(r => r.host === name)));
  // A site's root page names its kind. Other captured files only add the origin if no root page exists.
  const rootFirst = [...snapshot.http].sort((x, y) => (new URL(x.url).pathname === '/' ? 0 : 1) - (new URL(y.url).pathname === '/' ? 0 : 1));
  for (const response of rootFirst) add('service', new URL(response.url).origin, 'Captured HTTP status ' + response.status + '.', 'httpx', classifyService(response));
  for (const record of analysis.zone.srv ?? []) add('service', 'tcp://' + fqdn(record.target, root) + ':' + record.port, 'SRV record advertises this service. HTTP reachability is separate.', 'dns-zonefile', { kind: 'srv-service', next: 'web', why: 'a SRV record advertises it' });
  return [...assets.values()];
}

export async function scanSnapshot(ws, id = 'domains') {
  const {snapshot,snapshotHash} = loadSnapshot(ws);
  const analysis = await analyzeSnapshot(snapshot);
  return {snapshotHash,leads:(id === 'domains' ? domainLeads : surfaceLeads)(snapshot,analysis),retire:analysis.retire};
}

export function detectorsFor(id = 'domains') {
  const cache = new WeakMap();
  const checks = id === 'surface' ? ['discovered-host','discovered-service'] : ['dangling-cname','subdomain-takeover-fingerprint','wallet-drainer-behavior','missing-frame-protection','weak-csp','wallet-cdn-without-sri','third-party-script-without-sri','known-vulnerable-js','email-auth-evidence-missing','email-dmarc-missing','email-dmarc-policy-none','email-dmarc-no-reporting','email-spf-missing','email-spf-allows-all','tls-evidence-missing','dnssec-evidence-missing','registry-lock-evidence-missing','frontend-content-pin-missing'];
  const base = Object.fromEntries(checks.map(check => [check,async(snapshot,where) => {
    if (!cache.has(snapshot)) cache.set(snapshot,analyzeSnapshot(snapshot));
    const analysis = await cache.get(snapshot);
    return {ok:(id === 'surface' ? surfaceLeads : domainLeads)(snapshot,analysis).some(lead=>lead.check===check && sameWhere(lead.where,where))};
  }]));
  if (id === 'surface') return base;
  // testssl.sh check ids depend on the target and the tool version, so a tls-*
  // check is confirmed from the pinned evidence instead of a fixed name list.
  const tls = key => async (snapshot,where) => ({ok:tlsLeads(snapshot).some(lead=>lead.check===key && sameWhere(lead.where,where))});
  return new Proxy(base,{
    get:(target,key) => target[key] ?? (typeof key === 'string' && key.startsWith('tls-') ? tls(key) : undefined),
    getOwnPropertyDescriptor:(target,key) => Object.getOwnPropertyDescriptor(target,key) ?? (typeof key === 'string' && key.startsWith('tls-') ? {configurable:true,enumerable:true,value:tls(key)} : undefined),
  });
}
