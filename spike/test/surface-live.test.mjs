import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyHost, classifyService, surfaceLeads, analyzeSnapshot } from '../packs/domains/checks.mjs';
import { coverageOf } from '../packs/domains/pack.mjs';
import { prepassView } from '../lib/prepass-view.mjs';

const lab = JSON.parse(readFileSync(new URL('../packs/surface/lab/snapshot.json', import.meta.url), 'utf8'));
const page = (body, type = 'text/html', url = 'http://a.example.com/') => ({ url, status: 200, headers: { 'content-type': type }, body });

test('a service is typed from what it answered', () => {
  assert.equal(classifyService(page('<script src="/ethers.js"></script>')).kind, 'wallet-frontend');
  assert.equal(classifyService(page('<button>Connect wallet</button>')).next, 'domains');
  assert.equal(classifyService(page('{"ok":true}', 'application/json')).kind, 'api-endpoint');
  const unclaimed = { ...page('<html><body><p>There isn\'t a GitHub Pages site here.</p></body></html>'), status: 404 };
  assert.equal(classifyService(unclaimed).kind, 'provider-error-page');
  const real = { ...page(readFileSync(new URL('./fixtures/github-pages-404.html', import.meta.url), 'utf8')), status: 404 };
  assert.equal(classifyService(real).kind, 'provider-error-page', 'the real 9 KB GitHub page');
  assert.equal(classifyService(page(unclaimed.body)).kind, 'web-page', 'the same words in a 200 page are not the unclaimed page');
  assert.deepEqual([classifyService(page('<h1>hello</h1>')).kind, classifyService(page('<h1>hello</h1>')).next], ['web-page', 'web']);
});

test('a host is typed from its records', () => {
  const rec = (type, answers) => [{ host: 'x.example.com', type, status: 'NOERROR', answers }];
  assert.equal(classifyHost('example.com', 'example.com', []).kind, 'apex');
  assert.equal(classifyHost('x.example.com', 'example.com', rec('CNAME', ['me.github.io'])).kind, 'provider-cname');
  assert.equal(classifyHost('x.example.com', 'example.com', rec('CNAME', ['y.example.com'])).kind, 'cname');
  assert.equal(classifyHost('x.example.com', 'example.com', rec('A', ['1.2.3.4'])).kind, 'address');
});

test('every inventory lead says what it is, how it was found and who takes it next', async () => {
  const leads = surfaceLeads(lab, await analyzeSnapshot(lab));
  assert(leads.length > 10);
  for (const lead of leads) {
    assert.equal(lead.severity, 'informational');
    assert(['domains', 'web'].includes(lead.nextPack));
    assert.match(lead.description, /Kind: .* Found by: .* Next pack: (domains|web)\./);
  }
  assert.equal(leads.find(l => l.where === 'docs.touchstone.test').kind, 'provider-cname');
});

test('discovery sources show in the lead when the capture recorded them', async () => {
  const snap = { ...lab, discovery: { source: 'live', sources: { 'staging.touchstone.test': ['wordlist'], 'www.touchstone.test': ['subfinder', 'wordlist'] } } };
  const leads = surfaceLeads(snap, await analyzeSnapshot(snap));
  assert.equal(leads.find(l => l.where === 'staging.touchstone.test').foundBy, 'wordlist');
  assert.equal(leads.find(l => l.where === 'www.touchstone.test').foundBy, 'subfinder, wordlist');
  assert.equal(leads.find(l => l.where === 'www.touchstone.test').scope, 'live');
});

test('the prepass view names every tool that ran, capture first', async () => {
  const snap = { ...lab, discovery: { source: 'live', coverage: [{ engine: 'subfinder', status: 'ran', leads: 0 }, { engine: 'dnsx', status: 'ran', leads: 8 }, { engine: 'nuclei', status: 'unavailable', reason: 'Exited with code 1.', leads: 0 }] } };
  const leads = surfaceLeads(snap, await analyzeSnapshot(snap));
  const view = prepassView({ pack: 'surface', leads, coverage: coverageOf(snap, leads) });
  const names = view.tools.map(t => t.name);
  assert.deepEqual(names.slice(0, 3), ['subfinder', 'dnsx', 'nuclei']);
  assert(names.includes('dns-zonefile'));
  assert.equal(view.tools.find(t => t.name === 'nuclei').status, 'unavailable');
  assert.equal(view.tools.find(t => t.name === 'dns-zonefile').leads, leads.length - leads.filter(l => l.engine !== 'dns-zonefile').length);
});
