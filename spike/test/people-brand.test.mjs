import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pack from '../packs/people-brand/pack.mjs';
import {analyze,deriveLeads,detectorsFor} from '../packs/people-brand/checks.mjs';
import {pinSnapshot,replayEvidence,loadSnapshot} from '../lib/proof-evidence.mjs';
const snapshot=JSON.parse(readFileSync(new URL('../packs/people-brand/lab/snapshot.json',import.meta.url),'utf8'));
let analysis;
before(async()=>{analysis=await analyze(snapshot);});
const workspace=()=>{const ws=mkdtempSync(join(tmpdir(),'people-brand-test-'));pinSnapshot(ws,snapshot);return ws;};

test('Unicode certificates and copied dapp configuration become grouped host findings',()=>{
  const leads=deriveLeads(snapshot,analysis);
  const clone=leads.filter(l=>l.where==='astralharb0r.test');
  assert.equal(clone.length,1);
  assert.equal(clone[0].severity,'high');
  assert(clone[0].signals.some(s=>s.check==='copied-dapp-address-swap'));
  assert(clone[0].signals.some(s=>s.check==='off-brand-walletconnect-id'));
  const claim=leads.find(l=>l.where==='xn--astralhrbor-4ij.test');
  assert(claim.signals.some(s=>s.check==='unapproved-claim-page'));
  assert(claim.signals.find(s=>s.check==='drainer-kit-pattern').reviewOnly);
  assert.equal(claim.signals.some(s=>s.check==='known-drainer-script-hash'),false);
  assert(leads.find(l=>l.where==='astralharbro.test').signals.some(s=>s.check==='captured-certificate'));
  assert.equal(leads.some(l=>l.where==='unrelated.test'),false);
});

test('approved accounts are excluded while each impersonated namespace and support contact remains separate',()=>{
  const identities=deriveLeads(snapshot,analysis).filter(l=>l.check==='lookalike-identity');
  assert.deepEqual(new Set(identities.map(l=>l.where)),new Set(['social:astralharb0r','social:mira_astralharb0r','github:astralharb0r','npm:@astralharb0r','support:astralharb0r_help']));
  assert.equal(identities.find(l=>l.where.startsWith('support:')).severity,'high');
});

test('the real blocklist engine respects DNS label boundaries and global allowlists',async()=>{
  const changed=structuredClone(snapshot);
  changed.dns.push(...['child.astralharb0r.test','astralharb0r.test.evil.test','safe.astralharb0r.test'].map(host=>({host,type:'A',status:'NXDOMAIN',answers:[]})));
  changed.blocklists.at(-1).allowlist=['safe.astralharb0r.test'];
  const publicHost=changed.blocklists[0].domains[0];
  changed.dns.push({host:publicHost,type:'A',status:'NXDOMAIN',answers:[]});
  const parsed=await analyze(changed);
  const result=host=>parsed.domains.find(d=>d.host===host).blocklist;
  assert.equal(result('child.astralharb0r.test').result,true);
  assert.equal(result('astralharb0r.test.evil.test').result,false);
  assert.equal(result('safe.astralharb0r.test').result,false);
  assert.equal(result(publicHost).result,true);
  assert.equal(result(publicHost).name,'MetaMask pinned subset');
  assert.equal(deriveLeads(changed,parsed).some(l=>l.where===publicHost),false);
});

test('fixes remove address and WalletConnect signals without pretending the unapproved host went away',async()=>{
  const changed=structuredClone(snapshot);
  changed.pages[1].body=changed.pages[0].body;
  changed.pages[1].body=changed.pages[1].body.replace('</script>',"window.metrics={projectId:'unrelated-analytics-id'};</script>");
  changed.docs[0].body=changed.official.addresses.find(a=>a.role==='treasury').value.toUpperCase().replace('0X','0x');
  changed.github.organization.two_factor_requirement_enabled=true;
  changed.official.links.push('https://astralharb0r.test/support');
  const leads=deriveLeads(changed,await analyze(changed));
  const clone=leads.find(l=>l.where==='astralharb0r.test');
  assert.equal(clone.severity,'medium');
  assert.equal(clone.signals.some(s=>['copied-dapp-address-swap','off-brand-walletconnect-id'].includes(s.check)),false);
  assert.equal(leads.some(l=>['address-poisoning-docs','github-two-factor-not-required','official-link-off-brand'].includes(l.check)),false);
});

test('missing, malformed, and other-organization exports never prove disabled controls',()=>{
  for(const value of [undefined,null,'false',0]) {
    const changed=structuredClone(snapshot);
    changed.github.organization.two_factor_requirement_enabled=value;
    assert.equal(deriveLeads(changed,analysis).some(l=>l.check==='github-two-factor-not-required'),false);
  }
  const changed=structuredClone(snapshot);
  changed.github.organization.login='unrelated';
  assert.equal(deriveLeads(changed,analysis).some(l=>l.check.startsWith('github-')),false);
});

test('the original Legitify rules distinguish public creation and default permissions from 2FA',async()=>{
  const changed=structuredClone(snapshot);
  Object.assign(changed.github.organization,{two_factor_requirement_enabled:true,members_can_create_public_repositories:true,default_repository_permission:'write'});
  const parsed=await analyze(changed);
  assert.deepEqual(new Set(deriveLeads(changed,parsed).filter(l=>l.check.startsWith('github-')).map(l=>l.check)),new Set(['github-public-repo-creation','github-default-permissions']));
  changed.github.organization.members_can_create_public_repositories=null;
  changed.github.organization.default_repository_permission='unknown';
  assert.equal(deriveLeads(changed,parsed).some(l=>l.check.startsWith('github-')),false);
});

test('official links use hostname boundaries and accept approved subdomains and registered external profiles',async()=>{
  const changed=structuredClone(snapshot);
  changed.pages[3].body='<a href="https://help.astralharbor.test/">Official support</a><a href="https://codehost.test/astralharbor">Official GitHub</a><a href="https://astralharbor.test.evil.test/">Official support</a><a rel="noopener ME" href="https://social.test/astralharb0r">Profile</a>';
  const links=deriveLeads(changed,await analyze(changed)).filter(l=>l.check==='official-link-off-brand');
  assert.deepEqual(new Set(links.map(l=>l.where)),new Set(['https://astralharbor.test/support#link=https://astralharbor.test.evil.test/','https://astralharbor.test/support#link=https://social.test/astralharb0r']));
});

test('a brand mention in an article and a GitHub source citation do not establish impersonation',async()=>{
  const changed=structuredClone(snapshot);
  changed.pages.push({url:'https://news.test/story',body:'<title>Research roundup</title><p>We wrote an article about AstralHarbor.</p>',bundles:[]});
  changed.dns.push({host:'news.test',type:'A',status:'NOERROR',answers:['192.0.2.80']});
  changed.pages[3].body+='<a href="https://codehost.test/parser">GitHub parser source</a>';
  const leads=deriveLeads(changed,await analyze(changed));
  assert.deepEqual(leads.filter(l=>l.where==='news.test'||l.check==='official-link-off-brand').map(l=>l.where),['https://astralharbor.test/support#link=https://astralharb0r.test/support']);
});

test('a review-only identity and an uncaptured permutation are not proof',async()=>{
  const changed=structuredClone(snapshot);
  changed.identities[0].bio='An unrelated personal account';
  const parsed=await analyze(changed);
  assert(deriveLeads(changed,parsed).find(l=>l.where==='social:astralharb0r').reviewOnly);
  const ws=mkdtempSync(join(tmpdir(),'people-brand-review-'));
  try {
    pinSnapshot(ws,changed);
    const {snapshotHash}=loadSnapshot(ws);
    for(const evidence of [{check:'lookalike-identity',where:'social:astralharb0r',snapshotHash},{check:'impersonation-domain',where:'astralharbor0.test',snapshotHash}]) assert.equal((await replayEvidence(ws,evidence,{detectors:detectorsFor()})).status,'fail');
  } finally {rmSync(ws,{recursive:true,force:true});}
});

test('evidence replay rejects inherited checks, wrong locations, duplicate submissions, and tampered bytes',async()=>{
  const ws=workspace();
  try {
    const state={poc:0,passed:new Map(),found:[]};
    const submit=pack.tools(ws,state).find(t=>t.name==='submit_finding');
    const lead=deriveLeads(snapshot,analysis).find(l=>l.check==='github-two-factor-not-required');
    const {snapshotHash}=loadSnapshot(ws);
    const evidence={check:lead.check,where:lead.where,snapshotHash};
    const options={detectors:detectorsFor()};
    assert.equal((await replayEvidence(ws,evidence,options)).status,'pass');
    assert.equal((await replayEvidence(ws,{...evidence,check:'toString'},options)).status,'fail');
    assert.equal((await replayEvidence(ws,{...evidence,where:'unrelated'},options)).status,'fail');
    assert(!(await submit.execute({lead_id:lead.id,explanation:'The pinned export does not require 2FA. Fix: Require 2FA.'})).isError);
    assert((await submit.execute({lead_id:lead.id,explanation:'duplicate'})).isError);
    assert.equal((await pack.prove(ws,state.found,[],()=>{}))[0].proof.status,'pass');
    writeFileSync(join(ws,'snapshot.json'),'{}');
    assert.equal((await replayEvidence(ws,evidence,options)).status,'fail');
    assert.deepEqual(await pack.prove(ws,state.found,[],()=>{}),[]);
  } finally {rmSync(ws,{recursive:true,force:true});}
});

test('targets outside the passive made-up lab are refused before running tools',async()=>{
  const changed=structuredClone(snapshot);changed.official.domains=['real.example.com'];
  await assert.rejects(analyze(changed),/made-up passive/);
  changed.official.domains=['astralharbor.test'];changed.passive=false;
  await assert.rejects(analyze(changed),/made-up passive/);
});
