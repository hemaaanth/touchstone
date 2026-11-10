import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pack from './pack.mjs';
const ws=mkdtempSync(join(tmpdir(),'people-brand-smoke-'));
try {
  cpSync(fileURLToPath(new URL('./lab',import.meta.url)),ws,{recursive:true});
  const prepass=await pack.prepass(ws);
  const state={poc:0,passed:new Map(),found:[]};
  const tools=pack.tools(ws,state);
  const leads=JSON.parse((await tools.find(t=>t.name==='snapshot_leads').execute({})).output[0].text).leads;
  const submit=tools.find(t=>t.name==='submit_finding');
  for(const lead of leads.filter(l=>!l.reviewOnly)) assert(!(await submit.execute({lead_id:lead.id,explanation:lead.description+' Fix: Restore the approved domain, identity, address, link, or organization setting.'})).isError);
  assert((await submit.execute({lead_id:leads[0].id,explanation:'Duplicate'})).isError);
  assert((await submit.execute({lead_id:'unknown',explanation:'Unsupported'})).isError);
  const proven=await pack.prove(ws,state.found,[],()=>{});
  assert.equal(proven.length,11);
  assert(proven.every(f=>f.proof.kind==='evidence'&&f.proof.status==='pass'));
  const summary={pack:pack.id,snapshotHash:prepass.record.snapshotHash,leads:leads.length,submitted:state.found.length,proven:proven.length,severity:Object.fromEntries(['high','medium','low'].map(s=>[s,proven.filter(f=>f.severity===s).length])),coverage:prepass.record.coverage,groupedHost:leads.find(l=>l.where==='astralharb0r.test').signals.map(s=>s.check)};
  writeFileSync(join(ws,'snapshot.json'),'{}');
  assert.deepEqual(await pack.prove(ws,state.found,[],()=>{}),[]);
  summary.tamperedSnapshotProven=0;
  console.log(JSON.stringify(summary,null,2));
} finally {rmSync(ws,{recursive:true,force:true});}
