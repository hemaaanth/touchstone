import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import domains from './pack.mjs';
import surface from '../surface/pack.mjs';
import { runTool } from '../../lib/wrap.mjs';
import { captureTools,compareTakeovers } from './tools.mjs';
import { startLab } from './labctl.mjs';
import { IMAGE,detectorsFor } from './checks.mjs';
import { replayEvidence } from '../../lib/proof-evidence.mjs';
const lab=fileURLToPath(new URL('./lab',import.meta.url));
const ws=mkdtempSync(join(tmpdir(),'touchstone-domains-smoke-'));
let network,lab_;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:60000});
function cleanup() {
  lab_?.stop();
  rmSync(ws,{recursive:true,force:true});
}
try {
  cpSync(lab,ws,{recursive:true});
  if(process.argv.includes('--lab')) {
    lab_=startLab(lab); network=lab_.network;
    const capture=await runTool({image:IMAGE,ws,network,cmd:['capture'],timeoutMs:15000});
    assert.equal(capture.code,0,capture.stderr);
    if(process.argv.includes('--pin')) {
      // Maintenance: write a fresh snapshot and re-pin it in both labs. Review the diff before you commit.
      const bytes=JSON.stringify(JSON.parse(capture.stdout)),hash=createHash('sha256').update(bytes).digest('hex');
      for(const dir of [lab,join(lab,'../../surface/lab')]) {
        writeFileSync(join(dir,'snapshot.json'),bytes);
        const cfg=JSON.parse(readFileSync(join(dir,'.touchstone.json'),'utf8')); cfg.evidenceSnapshot.sha256=hash;
        writeFileSync(join(dir,'.touchstone.json'),JSON.stringify(cfg,null,2));
      }
      console.log('pinned',hash); cleanup(); process.exit(0);
    }
    assert.deepEqual(JSON.parse(capture.stdout),JSON.parse(readFileSync(join(lab,'snapshot.json'),'utf8')),'Fresh lab must match the pinned snapshot');
    const reports=await captureTools(ws,network);
    assert(reports.dnsx.some(r=>r.host==='old.touchstone.test' && r.cname?.includes('removed.touchstone.test')));
    assert(reports.httpx.some(r=>r.url==='http://www.touchstone.test:8080' && r.status_code===200));
    const comparison=await compareTakeovers(ws,network);
    assert.equal(comparison.dnsReaper.code,0,comparison.dnsReaper.stderr);
    assert.equal(comparison.nuclei.code,0,comparison.nuclei.stderr);
    const observatory=await runTool({image:'touchstone-observatory:1.7.2',ws,network,cmd:['172.30.44.20:8080'],timeoutMs:30000});
    assert.equal(observatory.code,0,observatory.stderr);
    const headerReport=JSON.parse(observatory.stdout);
    assert.equal(headerReport.tests['content-security-policy'].result,'csp-not-implemented');
    assert.equal(headerReport.tests['subresource-integrity'].pass,false);
    // Live path: a scope with a domain and no snapshot. The prepass captures it with the real tools and pins it.
    const live=mkdtempSync(join(tmpdir(),'touchstone-domains-live-'));
    try {
      const reach={network,resolver:lab_.resolver,ports:[{scheme:'http',port:8080}],scope:['touchstone.test']};
      writeFileSync(join(live,'.touchstone.json'),JSON.stringify({pack:'domains',domain:'touchstone.test',reach}));
      const liveRun=await domains.prepass(live,{emit:()=>{}});
      const snap=JSON.parse(readFileSync(join(live,'snapshot.json'),'utf8'));
      assert(snap.discovery.hosts.includes('staging.touchstone.test'),'brute force must find the host the lab hides from its own host list');
      assert(snap.discovery.nuclei.some(h=>h.template==='github-takeover' && h.url.includes('docs.touchstone.test')));
      assert(snap.discovery.coverage.every(c=>c.status==='ran'),JSON.stringify(snap.discovery.coverage));
      const checks=new Set(liveRun.record.leads.map(l=>l.check));
      for(const check of ['wallet-drainer-behavior','subdomain-takeover-fingerprint','dangling-cname','weak-csp','wallet-cdn-without-sri','missing-frame-protection']) assert(checks.has(check),'live capture must show '+check);
      assert.deepEqual(liveRun.record.leads.find(l=>l.check==='subdomain-takeover-fingerprint').engines,['touchstone','nuclei']);
      const lead=liveRun.record.leads.find(l=>l.check==='wallet-drainer-behavior');
      const proof=await replayEvidence(live,{check:lead.check,where:lead.where,snapshotHash:liveRun.record.snapshotHash},{detectors:detectorsFor('domains')});
      assert.equal(proof.status,'pass');
      var liveSummary={hosts:snap.discovery.hosts.length,leads:liveRun.record.leads.length,coverage:liveRun.record.coverage.map(c=>c.engine+':'+c.status+':'+c.leads)};
    } finally { rmSync(live,{recursive:true,force:true}); }
    console.log(JSON.stringify({liveCapture:liveSummary}));
    console.log(JSON.stringify({capture:'matches pinned snapshot',dnsx:reports.dnsx.length,httpx:reports.httpx.length,takeovers:comparison,observatory}));
  }
  const prep=await domains.prepass(ws,{emit:()=>{}});
  assert(prep.record.leads.some(l=>l.check==='dangling-cname'));
  assert(prep.record.leads.some(l=>l.check==='wallet-cdn-without-sri'));
  assert(prep.record.leads.some(l=>l.check==='weak-csp'));
  const state={poc:0,passed:new Map(),found:[]};
  const submit=domains.tools(ws,state).find(t=>t.name==='submit_finding');
  for(const lead of prep.record.leads) {
    const result=await submit.execute({lead_id:lead.id,explanation:lead.description+' Fix: Review and correct this captured control.'});
    assert.equal(Boolean(result.isError), Boolean(lead.reviewOnly));
  }
  const findings=await domains.prove(ws,state.found,[],()=>{});
  assert.equal(findings.length,state.found.length);
  const inventory=await surface.prepass(ws,{emit:()=>{}});
  assert(inventory.record.leads.some(l=>l.where==='old.touchstone.test'));
  assert(inventory.record.leads.some(l=>l.where==='http://rpc.touchstone.test:8080'));
  const asset=inventory.record.leads[0];
  assert.equal((await replayEvidence(ws,{check:asset.check,where:asset.where,snapshotHash:prep.record.snapshotHash},{detectors:detectorsFor('surface')})).status,'pass');
  assert.deepEqual(await surface.prove(ws,state.found,[],()=>{}),[]);
  writeFileSync(join(ws,'snapshot.json'),'{}');
  assert.deepEqual(await domains.prove(ws,state.found,[],()=>{}),[]);
  console.log(JSON.stringify({domains:findings.length,surface:inventory.record.leads.length,tamper:'rejected',spendUSD:0}));
} finally {
  cleanup();
}
