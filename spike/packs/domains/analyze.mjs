// Runs only in the tool container. Third-party parsers never run on the host.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parse } from 'parse5';
const require = createRequire(import.meta.url);
const zonefile = require('dns-zonefile').default;
const { CspParser } = require('csp_evaluator/dist/parser.js');
const { CspEvaluator } = require('csp_evaluator/dist/evaluator.js');
const { JSDOM } = require('jsdom');
if (process.argv[2] === 'capture') { await import('/work/capture.mjs'); process.exit(0); }
const snapshot = JSON.parse(readFileSync('/work/snapshot.json', 'utf8'));
const zone = zonefile.parse(snapshot.zone);
const pages = snapshot.http.map(response => {
  const scripts = [];
  const visit = node => {
    if (node.tagName === 'script') {
      const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
      if (attrs.src) scripts.push({ src: new URL(attrs.src, response.url).href, integrity: attrs.integrity ?? '', line: node.sourceCodeLocation?.startLine });
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  if ((response.headers['content-type'] ?? '').includes('text/html')) visit(parse(response.body, { sourceCodeLocationInfo: true }));
  const policy = response.headers['content-security-policy'] ?? '';
  const csp = new CspEvaluator(new CspParser(policy).csp).evaluate();
  return { url: response.url, scripts, policy, csp };
});
// Behavior replay. The page runs in jsdom with a fake wallet. No network is opened.
// The scripts come from the pinned snapshot, never from a live server.
// Each control that says Connect or Claim is clicked. We record what the wallet is asked to do.
const MAX = 2n ** 255n;
const CONTROL = /connect|claim|airdrop|mint|verify/i;
const NOT_CONTROL = /approve|swap|stake|deposit|send|bridge/i;
const word = (data, index) => BigInt('0x' + (data.slice(10 + index * 64, 74 + index * 64) || '0'));
const address = (data, index) => '0x' + data.slice(10 + index * 64 + 24, 74 + index * 64);
function decodeHarm(request) {
  const [first, second] = request.params ?? [];
  if (request.method === 'eth_sendTransaction') {
    const data = String(first?.data ?? '').toLowerCase();
    if (/^0x(095ea7b3|39509351)[0-9a-f]{128}$/.test(data)) return word(data, 1) >= MAX ? { kind: 'erc20-approve', asset: first.to, spender: address(data, 0), amount: 'unlimited' } : null;
    if (/^0xa22cb465[0-9a-f]{128}$/.test(data)) return word(data, 1) === 1n ? { kind: 'set-approval-for-all', asset: first.to, spender: address(data, 0), amount: 'all tokens' } : null;
    return null;
  }
  if (/^eth_signTypedData/.test(request.method)) {
    let typed; try { typed = typeof second === 'string' ? JSON.parse(second) : second; } catch { return null; }
    if (!/^Permit/i.test(typed?.primaryType ?? '')) return null;
    const message = typed.message ?? {};
    const details = message.details ?? message;
    const spender = message.spender ?? details.spender;
    let amount; try { amount = BigInt(details.value ?? details.amount ?? 0); } catch { return null; }
    return spender && amount >= MAX ? { kind: 'permit', asset: typed.domain?.verifyingContract ?? '', spender, amount: 'unlimited' } : null;
  }
  return null;
}
const answers = { eth_requestAccounts: ['0x00000000000000000000000000000000000a11ce'], eth_accounts: ['0x00000000000000000000000000000000000a11ce'], eth_chainId: '0x1', net_version: '1' };
async function behaviorOf(response) {
  const dom = new JSDOM(response.body, { url: response.url, runScripts: 'outside-only' });
  const w = dom.window;
  let requests = [];
  w.ethereum = { isMetaMask: true, request: async ({ method, params }) => { requests.push({ method, params }); return answers[method] ?? '0x' + '0'.repeat(64); } };
  const errors = [];
  for (const node of w.document.querySelectorAll('script')) {
    const src = node.getAttribute('src');
    const code = src ? snapshot.http.find(r => r.url === new URL(src, response.url).href)?.body : node.textContent;
    if (code == null) { errors.push('missing script ' + src); continue; }
    try { w.eval(code); } catch (e) { errors.push(String(e.message).slice(0, 120)); }
  }
  const controls = [];
  for (const el of w.document.querySelectorAll('button, [role=button], input[type=button], input[type=submit], a')) {
    const label = (el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!CONTROL.test(label) || NOT_CONTROL.test(label)) continue;
    requests = [];
    el.click();
    await new Promise(r => setTimeout(r, 100));
    controls.push({ selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), label, methods: requests.map(r => r.method), harm: requests.map(decodeHarm).filter(Boolean) });
  }
  w.close();
  return { url: response.url, controls, errors };
}
const behavior = [];
for (const response of snapshot.http) if ((response.headers['content-type'] ?? '').includes('text/html')) behavior.push(await behaviorOf(response));

const dir = mkdtempSync('/tmp/touchstone-retire-');
for (const [i, r] of snapshot.http.entries()) if ((r.headers['content-type'] ?? '').includes('javascript')) writeFileSync(dir + '/' + i + '.js', r.body);
const output = dir + '/report.json';
execFileSync('/opt/tools/node_modules/.bin/retire', ['--path', dir, '--jsrepo', '/opt/tools/jsrepository.json', '--outputformat', 'json', '--outputpath', output, '--exitwith', '0'], { timeout: 30000 });
console.log(JSON.stringify({ zone, pages, behavior, retire: JSON.parse(readFileSync(output, 'utf8')) }));
