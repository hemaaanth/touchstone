import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import domains from '../packs/domains/pack.mjs';
import {analyzeSnapshot,domainLeads,detectorsFor} from '../packs/domains/checks.mjs';
import {pinSnapshot,replayEvidence} from '../lib/proof-evidence.mjs';
import {proofView} from '../lib/proof-view.mjs';
const snapshot=JSON.parse(readFileSync(new URL('../packs/domains/lab/snapshot.json',import.meta.url),'utf8'));
const leadsOf=async value=>domainLeads(value,await analyzeSnapshot(value));
const sdk=value=>value.http.find(r=>r.url==='http://cdn.touchstone.test:8080/sdk.js');
const drainer=leads=>leads.find(l=>l.check==='wallet-drainer-behavior');
let leads;
before(async()=>{leads=await leadsOf(snapshot);});

test('the hidden approval is found only by running the page, not by a text pattern',()=>{
  const lead=drainer(leads);
  assert.equal(lead.severity,'critical');
  assert.equal(lead.where.spender,'0xdead00000000000000000000000000000000beef');
  assert.equal(lead.where.amount,'unlimited');
  assert.match(lead.where.control,/Connect wallet/);
  // The text pattern only sees the inert decoy in bundle.js. It never sees sdk.js.
  const patterns=leads.filter(l=>l.check==='wallet-unlimited-approval-pattern');
  assert.deepEqual(patterns.map(l=>l.where),['http://www.touchstone.test:8080/bundle.js']);
  assert(patterns[0].reviewOnly);
  assert.doesNotMatch(sdk(snapshot).body,/MaxUint256|setApprovalForAll|approve\s*\(|0x[fF]{64}/);
});

test('a connect click that only asks for accounts is not a drainer',async()=>{
  const changed=structuredClone(snapshot);
  sdk(changed).body=sdk(changed).body.replace(/await eth\.request\(\{ method: 'eth_sendTransaction'.*\n/,'');
  assert.equal(drainer(await leadsOf(changed)),undefined);
});

test('a limited approval is not flagged',async()=>{
  const changed=structuredClone(snapshot);
  sdk(changed).body=sdk(changed).body.replace("var amount = part(64, 'f');","var amount = part(63, '0') + '1';");
  assert.equal(drainer(await leadsOf(changed)),undefined);
});

test('the decoy function that is never called shows no behavior',async()=>{
  const changed=structuredClone(snapshot);
  sdk(changed).body='window.TouchstoneWallet={connect:async()=>window.ethereum.request({method:"eth_requestAccounts"})};';
  const found=await leadsOf(changed);
  assert.equal(drainer(found),undefined);
  assert(found.some(l=>l.check==='wallet-unlimited-approval-pattern' && l.reviewOnly),'the pattern stays a review-only lead');
});

test('the takeover needs a known provider and its unclaimed page',async()=>{
  const takeover=l=>l.check==='subdomain-takeover-fingerprint';
  assert.deepEqual(leads.filter(takeover).map(l=>l.where),['docs.touchstone.test']);
  const claimed=structuredClone(snapshot);
  claimed.http.find(r=>r.url==='http://docs.touchstone.test:8080/').body='<html>real docs</html>';
  assert.equal((await leadsOf(claimed)).some(takeover),false);
  assert.equal(leads.some(l=>takeover(l) && l.where==='old.touchstone.test'),false,'a CNAME to nowhere is a dangling lead, not a takeover');
});

test('frame protection headers close the framing lead',async()=>{
  assert(leads.some(l=>l.check==='missing-frame-protection'));
  const changed=structuredClone(snapshot);
  for(const page of changed.http.filter(r=>r.headers['content-type'].includes('text/html'))) page.headers['x-frame-options']='DENY';
  assert.equal((await leadsOf(changed)).some(l=>l.check==='missing-frame-protection'),false);
});

test('the drainer replays green, shows its harm in the viewer and rejects a forged spender',async()=>{
  const ws=mkdtempSync(join(tmpdir(),'domains-behavior-'));
  try {
    const snapshotHash=pinSnapshot(ws,snapshot);
    const state={poc:0,passed:new Map(),found:[]};
    const submit=domains.tools(ws,state).find(t=>t.name==='submit_finding');
    const lead=drainer(leads);
    const result=await submit.execute({lead_id:lead.id,explanation:'The Connect button requests an unlimited approval. Fix: Remove the approval from the SDK.'});
    assert(!result.isError,JSON.stringify(result));
    const proven=await domains.prove(ws,state.found,[],()=>{});
    assert.equal(proven.length,1);
    assert.equal(proven[0].proven,true);
    const view=proofView(proven[0]);
    assert(view.pass);
    const cells=Object.fromEntries(view.cited.map(c=>[c.name,c.value]));
    assert.equal(cells.spender,'0xdead00000000000000000000000000000000beef');
    assert.equal(cells.amount,'unlimited');
    assert.match(cells.wallet_request,/approve/);
    const options={detectors:detectorsFor('domains')};
    const forged={check:'wallet-drainer-behavior',where:{...lead.where,spender:'0x1111111111111111111111111111111111111111'},snapshotHash};
    assert.equal((await replayEvidence(ws,forged,options)).status,'fail');
    assert.equal((await replayEvidence(ws,{...forged,where:lead.where},options)).status,'pass');
  } finally {rmSync(ws,{recursive:true,force:true});}
});
