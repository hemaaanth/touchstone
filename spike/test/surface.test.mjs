import {before,test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import surface from '../packs/surface/pack.mjs';
import {analyzeSnapshot,surfaceLeads,detectorsFor,IMAGE} from '../packs/domains/checks.mjs';
import {skipUnlessImages} from './docker-skip.mjs';
import {pinSnapshot,replayEvidence} from '../lib/proof-evidence.mjs';
const skip = skipUnlessImages(IMAGE);
const test = (name, fn) => nodeTest(name, { skip }, fn);
const snapshot=JSON.parse(readFileSync(new URL('../packs/surface/lab/snapshot.json',import.meta.url),'utf8'));
let analysis;
before(async()=>{ if (skip) return; analysis=await analyzeSnapshot(snapshot); });

test('inventory distinguishes advertised DNS services from observed HTTP services',()=>{
  const leads=surfaceLeads(snapshot,analysis);
  assert(leads.some(l=>l.type==='host' && l.where==='old.touchstone.test' && l.nextPack==='domains'));
  assert(leads.some(l=>l.type==='service' && l.where==='http://rpc.touchstone.test:8080' && l.nextPack==='web'));
  assert(leads.some(l=>l.where==='tcp://rpc.touchstone.test:8080' && l.description.includes('advertises')));
  assert.equal(leads.some(l=>l.where==='http://old.touchstone.test:8080'),false);
  assert.equal(leads.filter(l=>l.where==='http://www.touchstone.test:8080').length,1);
});

test('replay confirms captured inventory but rejects invented assets',async()=>{
  const ws=mkdtempSync(join(tmpdir(),'surface-test-'));
  try {
    const snapshotHash=pinSnapshot(ws,snapshot);
    const evidence={check:'discovered-service',where:'http://rpc.touchstone.test:8080',snapshotHash};
    const options={detectors:detectorsFor('surface')};
    assert.equal((await replayEvidence(ws,evidence,options)).status,'pass');
    assert.equal((await replayEvidence(ws,{...evidence,where:'http://old.touchstone.test:8080'},options)).status,'fail');
    const state={poc:0,passed:new Map(),found:[]};
    assert.equal(surface.tools(ws,state).some(t=>t.name==='submit_finding'),false);
    assert.deepEqual(await surface.prove(ws,[{evidence}],[],()=>{}),[]);
  } finally {rmSync(ws,{recursive:true,force:true});}
});
