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
import { IMAGE,detectorsFor } from './checks.mjs';
import { replayEvidence } from '../../lib/proof-evidence.mjs';
const lab=fileURLToPath(new URL('./lab',import.meta.url));
const ws=mkdtempSync(join(tmpdir(),'touchstone-domains-smoke-'));
const network='touchstone-domains-'+process.pid;
const names=[];
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:60000});
let created=false;
function cleanup() {
  for(const name of names.reverse()) docker(['rm','-f',name]);
  if(created) docker(['network','rm',network]);
  rmSync(ws,{recursive:true,force:true});
}
try {
  cpSync(lab,ws,{recursive:true});
  if(process.argv.includes('--lab')) {
    docker(['network','create','--internal','--subnet','172.30.44.0/24',network]); created=true;
    for(const [suffix,ip,image,cmd,caps] of [
      ['dns','172.30.44.53','coredns/coredns:1.12.0@sha256:40384aa1f5ea6bfdc77997d243aec73da05f27aed0c5e9d65bfa98933c519d97',['-conf','/lab/Corefile'],['--cap-add','NET_BIND_SERVICE']],
      ['web','172.30.44.20','node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',['node','/lab/server.mjs'],[]]
    ]) {
      const name=network+'-'+suffix;
      docker(['run','-d','--name',name,'--network',network,'--ip',ip,'--cap-drop','ALL',...caps,'--security-opt','no-new-privileges','--user',process.getuid()+':'+process.getgid(),'-v',lab+':/lab:ro',image,...cmd]); names.push(name);
    }
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
