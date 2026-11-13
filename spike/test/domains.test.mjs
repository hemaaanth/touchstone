import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import domains from '../packs/domains/pack.mjs';
import {analyzeSnapshot,domainLeads,detectorsFor} from '../packs/domains/checks.mjs';
import {pinSnapshot,replayEvidence,loadSnapshot} from '../lib/proof-evidence.mjs';
const snapshot=JSON.parse(readFileSync(new URL('../packs/domains/lab/snapshot.json',import.meta.url),'utf8'));
let analysis;
before(async()=>{analysis=await analyzeSnapshot(snapshot);});
const has=(value,check)=>domainLeads(value,analysis).some(l=>l.check===check);
const workspace=()=>{const ws=mkdtempSync(join(tmpdir(),'domains-test-')); pinSnapshot(ws,snapshot); return ws;};

test('captured plants are separated from review-only approval patterns',()=>{
  const leads=domainLeads(snapshot,analysis);
  assert(leads.some(l=>l.check==='dangling-cname' && l.where==='old.touchstone.test'));
  assert(leads.some(l=>l.check==='wallet-cdn-without-sri' && l.severity==='medium'));
  assert.deepEqual(leads.filter(l=>l.check==='weak-csp').map(l=>l.where).sort(),['http://staging.touchstone.test:8080/','http://touchstone.test:8080/']);
  assert.equal(leads.some(l=>l.check==='weak-csp' && l.where.includes('docs.')),false,'an unclaimed 404 page has no CSP finding');
  assert(leads.find(l=>l.check==='wallet-unlimited-approval-pattern').reviewOnly);
  assert.equal(new Set(leads.map(l=>l.id)).size,leads.length);
});

test('DNS timeout and IPv6 NODATA do not prove a dangling CNAME',()=>{
  for(const status of ['ETIMEOUT','ENODATA','ESERVFAIL']) {
    const changed=structuredClone(snapshot);
    changed.dns.find(r=>r.host==='removed.touchstone.test' && r.type==='AAAA').status=status;
    assert.equal(has(changed,'dangling-cname'),false);
  }
});

test('registry transfer locks and missing evidence are not treated as DNSSEC or registry validation',()=>{
  const changed=structuredClone(snapshot);
  changed.rdap={status:['clientTransferProhibited']};
  assert(has(changed,'registry-lock-evidence-missing'));
  changed.rdap.status.push('server transfer prohibited');
  changed.dnssec={complete:true,delegation:'SECURE',signed:true,validatedChain:true,errors:[],warnings:[]};
  changed.contenthash={name:'touchstone.eth',value:'ipfs://bafy-lab-content',pinnedCid:'bafy-lab-content'};
  assert.equal(has(changed,'registry-lock-evidence-missing'),false);
  assert.equal(has(changed,'dnssec-evidence-missing'),false);
  assert.equal(has(changed,'frontend-content-pin-missing'),false);
});

test('real HTML and CSP parsers accept SRI and an enforcing strict policy',async()=>{
  const changed=structuredClone(snapshot);
  const sri='sha256-'+Buffer.alloc(32).toString('base64');
  for(const page of changed.http.filter(r=>r.headers['content-type'].includes('text/html'))) {
    page.body=page.body.replace('src="http://cdn.touchstone.test:8080/ethers.js"','integrity="'+sri+'" src="http://cdn.touchstone.test:8080/ethers.js"');
    page.headers['content-security-policy']="script-src 'nonce-12345678901234567890' 'strict-dynamic'; object-src 'none'; base-uri 'none'";
  }
  const parsed=await analyzeSnapshot(changed);
  const leads=domainLeads(changed,parsed);
  assert.equal(leads.some(l=>['weak-csp','wallet-cdn-without-sri'].includes(l.check)),false);
  const page=changed.http.find(r=>r.url==='http://www.touchstone.test:8080/');
  page.headers['content-security-policy-report-only']=page.headers['content-security-policy'];
  delete page.headers['content-security-policy'];
  const weak=domainLeads(changed,await analyzeSnapshot(changed)).filter(l=>l.check==='weak-csp');
  assert.deepEqual(weak.map(l=>l.where),['http://www.touchstone.test:8080/']);
});

test('replay rejects wrong location, inherited names, unproven malware and changed bytes',async()=>{
  const ws=workspace();
  try {
    const {snapshotHash}=loadSnapshot(ws);
    const options={detectors:detectorsFor()};
    const evidence={check:'dangling-cname',where:'old.touchstone.test',snapshotHash};
    assert.equal((await replayEvidence(ws,evidence,options)).status,'pass');
    for(const forged of [{...evidence,where:'www.touchstone.test'},{...evidence,check:'toString'},{...evidence,check:'wallet-unlimited-approval-pattern',where:'http://www.touchstone.test:8080/bundle.js'}]) assert.equal((await replayEvidence(ws,forged,options)).status,'fail');
    writeFileSync(join(ws,'snapshot.json'),JSON.stringify({...snapshot,root:'changed.test'}));
    assert.equal((await replayEvidence(ws,evidence,options)).status,'fail');
  } finally {rmSync(ws,{recursive:true,force:true});}
});

test('submission refuses review-only patterns, duplicate roots and later snapshot changes',async()=>{
  const ws=workspace();
  try {
    const state={poc:0,passed:new Map(),found:[]};
    const submit=domains.tools(ws,state).find(t=>t.name==='submit_finding');
    const leads=domainLeads(snapshot,analysis);
    const review=leads.find(l=>l.reviewOnly);
    assert((await submit.execute({lead_id:review.id,explanation:'not proof'})).isError);
    assert((await submit.execute({lead_id:'unknown',explanation:'not proof'})).isError);
    const lead=leads.find(l=>l.check==='dangling-cname');
    assert(!(await submit.execute({lead_id:lead.id,explanation:'Captured NXDOMAIN. Fix: Remove stale DNS.'})).isError);
    assert((await submit.execute({lead_id:lead.id,explanation:'duplicate'})).isError);
    assert.equal((await domains.prove(ws,state.found,[],()=>{})).length,1);
    writeFileSync(join(ws,'snapshot.json'),'{}');
    assert.deepEqual(await domains.prove(ws,state.found,[],()=>{}),[]);
  } finally {rmSync(ws,{recursive:true,force:true});}
});
