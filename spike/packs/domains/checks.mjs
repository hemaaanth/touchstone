import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../../lib/wrap.mjs';
import { sha256, loadSnapshot } from '../../lib/proof-evidence.mjs';

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
const PROVIDERS = [
  { name: 'GitHub Pages', target: /\.github\.io$/i, fingerprint: "There isn't a GitHub Pages site here." },
  { name: 'Heroku', target: /\.herokuapp\.com$/i, fingerprint: 'No such app' },
  { name: 'Amazon S3', target: /\.s3[.-][a-z0-9.-]*amazonaws\.com$/i, fingerprint: 'NoSuchBucket' },
];
const fqdn = (name, root) => name === '@' ? root : name.endsWith('.') ? name.slice(0, -1) : name + '.' + root;
const validSRI = value => String(value).split(/\s+/).some(token => {
  const match = token.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/);
  return match && Buffer.from(match[2], 'base64').length === {sha256:32,sha384:48,sha512:64}[match[1]];
});

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
    const page = snapshot.http.find(r => new URL(r.url).hostname === name && r.body.includes(provider.fingerprint));
    if (page) add('subdomain-takeover-fingerprint', name, 'high', 'The CNAME points to ' + target + ' (' + provider.name + '). At capture time the host served the provider page for an unclaimed resource. Anyone who claims that resource there could serve content on ' + name + '. The snapshot proves the page, not that a claim succeeds.');
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
      add('wallet-drainer-behavior', { url: page.url, control: control.selector + ' "' + control.label + '"', wallet_request: kinds[harm.kind] ?? harm.kind, asset: harm.asset, spender: harm.spender, amount: harm.amount }, 'critical',
        'Clicking "' + control.label + '" makes the page ask the wallet for ' + kinds[harm.kind] + ' of ' + harm.amount + ' on ' + harm.asset + ' to spender ' + harm.spender + '. A connect action only needs the account list. The page ran against the pinned snapshot in a fake wallet. No transaction was sent.', 'jsdom-replay');
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
  if (!snapshot.dnssec?.validatedChain) add('dnssec-evidence-missing',root,'informational','The snapshot has no validated DNSSEC chain. This does not prove DNSSEC is disabled.');
  if (!snapshot.rdap?.status?.some(s => /server.*(?:transfer|update|delete).*prohibited/i.test(s.replaceAll(' ','')))) add('registry-lock-evidence-missing',root,'informational','The snapshot has no RDAP evidence of a registry lock. A registrar transfer lock alone is not a registry lock.');
  if (snapshot.contenthash && (!snapshot.contenthash.value?.startsWith('ipfs://') || !snapshot.contenthash.pinnedCid || snapshot.contenthash.value.slice(7) !== snapshot.contenthash.pinnedCid)) add('frontend-content-pin-missing',snapshot.contenthash.name,'informational','The captured ENS/IPFS configuration has no matching immutable content CID and pin receipt. This proves missing evidence, not lost content.');
  const rank = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
  return leads.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function surfaceLeads(snapshot, analysis) {
  const assets = new Map();
  const root = analysis.zone.$origin.replace(/\.$/, '');
  const add = (type, where, detail, source) => {
    const key = type + ':' + where;
    if (!assets.has(key)) assets.set(key,{id:sha256(key).slice(0,16),check:'discovered-'+type,type,where,description:detail,engine:source,impact:'Informational',severity:'informational',scope:'lab',nextPack:type === 'service' ? 'web' : 'domains'});
  };
  for (const type of ['a','aaaa','cname','srv']) for (const record of analysis.zone[type] ?? []) add('host',fqdn(record.name,root),'Captured zone record: ' + type.toUpperCase(),'dns-zonefile');
  for (const response of snapshot.http) add('service',new URL(response.url).origin,'Captured HTTP status ' + response.status,'httpx/capture');
  for (const record of analysis.zone.srv ?? []) add('service','tcp://' + fqdn(record.target,root) + ':' + record.port,'SRV record advertises this service. HTTP reachability is separate.','dns-zonefile');
  return [...assets.values()];
}

export async function scanSnapshot(ws, id = 'domains') {
  const {snapshot,snapshotHash} = loadSnapshot(ws);
  const analysis = await analyzeSnapshot(snapshot);
  return {snapshotHash,leads:(id === 'domains' ? domainLeads : surfaceLeads)(snapshot,analysis),retire:analysis.retire};
}

export function detectorsFor(id = 'domains') {
  const cache = new WeakMap();
  const checks = id === 'surface' ? ['discovered-host','discovered-service'] : ['dangling-cname','subdomain-takeover-fingerprint','wallet-drainer-behavior','missing-frame-protection','weak-csp','wallet-cdn-without-sri','third-party-script-without-sri','known-vulnerable-js','dnssec-evidence-missing','registry-lock-evidence-missing','frontend-content-pin-missing'];
  return Object.fromEntries(checks.map(check => [check,async(snapshot,where) => {
    if (!cache.has(snapshot)) cache.set(snapshot,analyzeSnapshot(snapshot));
    const analysis = await cache.get(snapshot);
    return {ok:(id === 'surface' ? surfaceLeads : domainLeads)(snapshot,analysis).some(lead=>lead.check===check && sameWhere(lead.where,where))};
  }]));
}
