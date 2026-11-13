import {before,test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import domains from '../packs/domains/pack.mjs';
import {analyzeSnapshot,domainLeads,detectorsFor,IMAGE} from '../packs/domains/checks.mjs';
import {skipUnlessImages} from './docker-skip.mjs';
import {pinSnapshot,replayEvidence} from '../lib/proof-evidence.mjs';
import {proofView} from '../lib/proof-view.mjs';
const skip = skipUnlessImages(IMAGE);
const test = (name, fn) => nodeTest(name, { skip }, fn);
const snapshot=JSON.parse(readFileSync(new URL('../packs/domains/lab/snapshot.json',import.meta.url),'utf8'));
const leadsOf=async value=>domainLeads(value,await analyzeSnapshot(value));
const sdk=value=>value.http.find(r=>r.url==='http://cdn.touchstone.test:8080/sdk.js');
const drainer=leads=>leads.find(l=>l.check==='wallet-drainer-behavior');
let leads;
before(async()=>{ if (skip) return; leads=await leadsOf(snapshot); });

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

// Benign sites that print a provider's words must not raise a takeover.
const DOCS='http://docs.touchstone.test:8080/';
const docsRow=value=>value.http.find(r=>r.url===DOCS);
const takeover=l=>l.check==='subdomain-takeover-fingerprint';
const onProvider=(target,row)=>{
  const changed=structuredClone(snapshot);
  const old='touchstone-lab.github.io';
  changed.zone=changed.zone.replace(old,target);
  for(const r of changed.dns) r.answers=r.answers.map(a=>a===old?target:a);
  Object.assign(docsRow(changed),row);
  return changed;
};
const HTML={'content-type':'text/html'};
// A real unclaimed GitHub Pages page, captured from a site that does not exist. It is 9115 bytes.
const GITHUB_404=readFileSync(new URL('./fixtures/github-pages-404.html',import.meta.url),'utf8');

test('the real unclaimed pages of GitHub Pages, Heroku and S3 still raise the takeover',async()=>{
  const github=await leadsOf(onProvider('x.github.io',{status:404,headers:HTML,body:'<html><body><p><strong>There isn\'t a GitHub Pages site here.</strong></p></body></html>'}));
  const heroku=await leadsOf(onProvider('x.herokuapp.com',{status:404,headers:HTML,body:'<!DOCTYPE html><html><head><title>No such app</title></head><body><h1>No such app</h1></body></html>'}));
  const s3=await leadsOf(onProvider('x.s3.amazonaws.com',{status:404,headers:{'content-type':'application/xml'},body:'<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>'}));
  for(const found of [github,heroku,s3]) assert.deepEqual(found.filter(takeover).map(l=>l.where),['docs.touchstone.test']);
});

test('a live Heroku app whose script says "No such app" is not a takeover',async()=>{
  const changed=onProvider('x.herokuapp.com',{status:200,headers:HTML,body:'<html><body>My app</body></html>'});
  changed.http.push({url:'http://docs.touchstone.test:8080/main.js',status:200,headers:{'content-type':'application/javascript'},body:'if(!app)throw new Error("No such app");'});
  assert.equal((await leadsOf(changed)).some(takeover),false);
});

test('a GitHub Pages blog that quotes the unclaimed words is not a takeover',async()=>{
  const body='<html><body><article><p>If you see "There isn\'t a GitHub Pages site here." check your CNAME file.</p></article></body></html>';
  assert.equal((await leadsOf(onProvider('x.github.io',{status:200,headers:HTML,body}))).some(takeover),false);
  assert.equal((await leadsOf(onProvider('x.github.io',{status:404,headers:HTML,body:body+' '.repeat(9000)}))).some(takeover),false,'the quote is not in the provider markup');
  assert.equal((await leadsOf(onProvider('x.github.io',{status:404,headers:HTML,body:GITHUB_404+' '.repeat(40000)}))).some(takeover),false,'a giant page is not the provider page');
});

test('an S3 docs page that mentions NoSuchBucket is not a takeover',async()=>{
  const body='<html><body><h2>Errors</h2><p>A missing bucket returns NoSuchBucket.</p><pre>&lt;Code&gt;NoSuchBucket&lt;/Code&gt;</pre></body></html>';
  assert.equal((await leadsOf(onProvider('x.s3.amazonaws.com',{status:200,headers:HTML,body}))).some(takeover),false);
  assert.equal((await leadsOf(onProvider('x.s3.amazonaws.com',{status:404,headers:HTML,body}))).some(takeover),false,'escaped text is not the XML error');
});

test('an unclaimed page with no CNAME in the snapshot is not a takeover',async()=>{
  const changed=structuredClone(snapshot);
  changed.dns=changed.dns.filter(r=>!(r.host==='docs.touchstone.test' && r.type==='CNAME'));
  assert.equal((await leadsOf(changed)).some(takeover),false);
});

// A legitimate Mint or Claim button may ask for an approval. Only Connect, Verify and Sign in never do.
const relabel=label=>{
  const changed=structuredClone(snapshot);
  const page=changed.http.find(r=>r.url==='http://www.touchstone.test:8080/');
  page.body=page.body.replace('Connect wallet',label);
  return changed;
};

test('a Mint or Claim button that asks for an unlimited approval is High, not Critical',async()=>{
  for(const label of ['Mint NFT','Claim rewards','Airdrop']){
    const found=drainer(await leadsOf(relabel(label)));
    assert(found,label+' still raises a lead, because the spender needs a person to read it');
    assert.equal(found.severity,'high',label);
    assert.match(found.description,/person must read the spender/);
  }
});

test('a Connect or Verify button that asks for an unlimited approval stays Critical',async()=>{
  for(const label of ['Connect wallet','Verify wallet','Connect and claim']) assert.equal(drainer(await leadsOf(relabel(label))).severity,'critical',label);
});

test('the real 9 KB GitHub Pages unclaimed page raises the takeover',async()=>{
  assert(GITHUB_404.length>9000);
  const found=await leadsOf(onProvider('x.github.io',{status:404,headers:{'content-type':'text/html; charset=utf-8'},body:GITHUB_404}));
  assert.deepEqual(found.filter(takeover).map(l=>l.where),['docs.touchstone.test']);
});

test('an S3 website endpoint unclaimed page raises the takeover',async()=>{
  const body='<html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1><ul><li>Code: NoSuchBucket</li><li>Message: The specified bucket does not exist</li><li>BucketName: x</li></ul></body></html>';
  const found=await leadsOf(onProvider('x.s3-website-us-east-1.amazonaws.com',{status:404,headers:HTML,body}));
  assert.deepEqual(found.filter(takeover).map(l=>l.where),['docs.touchstone.test']);
});

test('a Sign in button is not clicked, so it raises no drainer lead',async()=>{
  assert.equal(drainer(await leadsOf(relabel('Sign in'))),undefined);
});
