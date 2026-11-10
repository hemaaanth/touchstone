import {cpSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,domainToASCII} from 'node:url';
import {runTool} from '../../lib/wrap.mjs';
import {loadSnapshot,sha256} from '../../lib/proof-evidence.mjs';
export const ANALYSIS_IMAGE='touchstone-people-analysis:wave2';
export const PERMUTATION_IMAGE='touchstone-people-dnstwist:20250130';
const OPA='openpolicyagent/opa:0.63.0-static@sha256:b181f9f31a5544870a96ae69ad3613d8d07f7757c4ab32f774bd4e9f4cb305d9';
const POLICIES=fileURLToPath(new URL('./policies',import.meta.url));
export const canonicalHost=value=>domainToASCII(String(value).trim().replace(/\.$/,'').toLowerCase());
const approvedHost=(s,host)=>s.official.domains.some(d=>host===canonicalHost(d)||host.endsWith('.'+canonicalHost(d)));
const checks=['impersonation-domain','lookalike-identity','official-link-off-brand','address-poisoning-docs','github-two-factor-not-required','github-public-repo-creation','github-default-permissions'];
const policies=[['two_factor_authentication_not_required_for_org','two_factor_requirement_enabled','github-two-factor-not-required','high'],['non_admins_can_create_public_repositories','members_can_create_public_repositories','github-public-repo-creation','medium'],['default_repository_permission_is_not_none','default_repository_permission','github-default-permissions','high']];
const knownField=(s,field)=>typeof s.github?.organization?.login==='string'&&s.official.identities.some(o=>o.kind==='github'&&o.handle.toLowerCase()===s.github.organization.login.toLowerCase())&&(field==='default_repository_permission'?['none','read','write','admin'].includes(s.github?.organization?.[field]):typeof s.github?.organization?.[field]==='boolean');
let cached;
function cachedAnalysis(snapshot) {
  const hash=sha256(JSON.stringify(snapshot));
  if(cached?.hash!==hash) cached={hash,promise:analyze(snapshot)};
  return cached.promise;
}

export async function analyze(snapshot) {
  if(snapshot.schema!==1||snapshot.scope!=='lab'||snapshot.passive!==true||!Array.isArray(snapshot.official?.domains)||!snapshot.official.domains.length||snapshot.official.domains.some(d=>!canonicalHost(d).endsWith('.test'))) throw new Error('A made-up passive .test lab is required');
  for(const key of ['dns','certificates','blocklists','identities','pages','docs']) if(!Array.isArray(snapshot[key])) throw new Error('Invalid snapshot section: '+key);
  const ws=mkdtempSync(join(tmpdir(),'people-brand-tools-'));
  try {
    writeFileSync(join(ws,'snapshot.json'),JSON.stringify(snapshot));
    writeFileSync(join(ws,'github.json'),JSON.stringify(snapshot.github??{}));
    cpSync(POLICIES,join(ws,'policies'),{recursive:true});
    const [parsed,permutation,posture]=await Promise.all([
      runTool({image:ANALYSIS_IMAGE,ws,cmd:[],timeoutMs:60000}),
      Promise.all(snapshot.official.domains.map(domain=>runTool({image:PERMUTATION_IMAGE,ws,cmd:['--format','list',canonicalHost(domain)],timeoutMs:60000}))),
      runTool({image:OPA,ws,cmd:['eval','--data','/work/policies','--input','/work/github.json','--format','json','data.organization'],timeoutMs:30000})
    ]);
    for(const [name,result] of Object.entries({parsed,...Object.fromEntries(permutation.map((r,i)=>['permutation'+i,r])),posture})) if(result.code||result.timedOut) throw new Error(name+' failed (exit '+result.code+'). Check the pinned tool image.');
    return {...JSON.parse(parsed.stdout),permutations:[...new Set(permutation.flatMap(r=>r.stdout.trim().split('\n').map(canonicalHost).filter(Boolean)))],posture:JSON.parse(posture.stdout).result?.[0]?.expressions?.[0]?.value??{}};
  } finally {rmSync(ws,{recursive:true,force:true});}
}

export function deriveLeads(s,a) {
  const leads=[];
  const add=(check,where,severity,description,signals=[],reviewOnly=false)=>leads.push({id:sha256(check+'\n'+where).slice(0,16),check,where,severity,impact:severity[0].toUpperCase()+severity.slice(1),description,signals,reviewOnly,file:'snapshot.json',lines:[],engine:check.startsWith('github-')?'Legitify/OPA':'people-brand'});
  const originals=a.pages.filter(p=>approvedHost(s,p.host));
  for(const domain of a.domains) {
    if(approvedHost(s,domain.host)) continue;
    const pages=a.pages.filter(p=>p.host===domain.host);
    const branded=pages.some(p=>p.text.toLowerCase().includes(s.official.name.toLowerCase()));
    const impersonates=branded&&pages.some(p=>/\b(?:official|airdrop|claim)\b/i.test(p.title)||originals.some(o=>o.shapeHash===p.shapeHash));
    const related=domain.similar||a.permutations.includes(domain.host)||impersonates;
    const resolved=s.dns.some(r=>canonicalHost(r.host)===domain.host&&r.status==='NOERROR'&&['A','AAAA','CNAME'].includes(r.type)&&r.answers?.length);
    if(!related||(!resolved&&!domain.certificates.length&&!pages.length)) continue;
    const signals=[];
    if(domain.similar||a.permutations.includes(domain.host)) signals.push({check:'lookalike-domain',detail:'A generated or Unicode-normalized lookalike occurs in the pinned DNS, certificate, or page capture.'});
    if(resolved) signals.push({check:'captured-dns',detail:'The snapshot contains a successful DNS answer. This is not a live lookup.'});
    if(domain.certificates.length) signals.push({check:'captured-certificate',detail:'A pinned certificate SAN contains this exact ASCII hostname.'});
    if(domain.blocklist.result&&domain.blocklist.type==='blocklist') signals.push({check:'blocklist-match',detail:'The pinned list '+domain.blocklist.name+' matches this host or a parent label. Lab list matches are synthetic, not vendor detections.'});
    let severe=false;
    for(const page of pages) {
      if(/(?:airdrop|claim (?:reward|tokens?))/i.test(page.text)&&branded&&!s.official.campaigns.includes(page.url)) signals.push({check:'unapproved-claim-page',detail:'A captured off-brand page advertises the project and a claim or airdrop absent from the approved campaign registry.'});
      const names=page.scripts.map(src=>new URL(src).pathname.split('/').at(-1));
      if(['seaport.js','wallet-connect.js','coinbase.js'].every(name=>names.includes(name))) signals.push({check:'drainer-kit-pattern',reviewOnly:true,detail:'Three script names match a published Inferno deployment pattern. Names alone do not prove malware.'});
      const exact=page.bundleHashes.find(h=>['8c1ea67e021fe82120a99d3bc33c92dec4845f5af94f192e17104e14ca04ecee','88930dc583b10fe369e8f3ec632c819d54c6cc6a812087eba17b9b7db6a86cba'].includes(h));
      if(exact) {signals.push({check:'known-drainer-script-hash',detail:'Captured script bytes match a published Inferno SHA-256 indicator.'});severe=true;}
      const copied=originals.some(original=>original.shapeHash===page.shapeHash);
      for(const property of page.addresses) {
        const role=/^contract/i.test(property.key)?'contract':property.key.toLowerCase();
        const expected=s.official.addresses.filter(v=>v.role===role).map(v=>v.value.toLowerCase());
        if(copied&&expected.length&&!expected.includes(property.value.toLowerCase())) {signals.push({check:'copied-dapp-address-swap',detail:'The captured page matches the official tag sequence and DOM text but its '+role+' literal is outside the approved address registry.'});severe=true;}
      }
      if(page.projectIds.some(p=>!s.official.walletConnectProjectIds.includes(p.value))) signals.push({check:'off-brand-walletconnect-id',detail:'The captured JavaScript has a projectId outside the approved WalletConnect registry. Project IDs are public identifiers, not secrets.'});
    }
    if(signals.length) add('impersonation-domain',domain.host,severe?'high':branded?'medium':'low','Unapproved brand-related host in the pinned snapshot. Review the grouped signals. Neither a certificate nor a similar name proves criminal ownership.',signals);
  }
  for(const identity of a.identities) {
    if(identity.approved||!identity.similar) continue;
    const claims=identity.bio?.toLowerCase().includes(s.official.name.toLowerCase());
    const seedRequest=identity.kind==='support'&&/recovery phrase|seed phrase|private key/i.test(identity.bio??'');
    add('lookalike-identity',identity.kind+':'+identity.handle,seedRequest?'high':'medium','Captured '+identity.kind+' identity resembles an approved handle but is not in the registry.'+(seedRequest?' Its support text requests recovery material.':''),[{check:identity.kind==='support'?'unapproved-support-contact':'unapproved-'+identity.kind+'-identity',detail:'Only pinned profile fields were compared. No account was contacted.'}],!claims);
  }
  for(const page of originals) for(const link of page.links??[]) {
    const target=new URL(link.url);
    if(!/\bofficial\b/i.test(link.text)&&!link.claimedOfficial) continue;
    if(approvedHost(s,canonicalHost(target.hostname))||s.official.links.includes(link.url)) continue;
    add('official-link-off-brand',page.url+'#link='+link.url,'medium','A link labeled as an official brand destination leaves the approved domain and link registry.');
  }
  for(const doc of s.docs) for(const address of doc.body.match(/0x[a-fA-F0-9]{40}\b/g)??[]) {
    const value=address.toLowerCase();
    if(s.official.addresses.some(a=>a.value.toLowerCase()===value)) continue;
    if(s.official.addresses.some(a=>a.value.toLowerCase().slice(0,8)===value.slice(0,8)&&a.value.toLowerCase().slice(-4)===value.slice(-4))) add('address-poisoning-docs',doc.url,'medium','The published document contains a different address with the same first six and last four hex digits as an approved address. No transfer or chain lookup was made.');
  }
  for(const [policy,field,check,severity] of policies) {
    if(!knownField(s,field)) continue;
    if(a.posture[policy]===true) add(check,s.github.organization.login,severity,'The original Legitify policy '+policy+' fails on the pinned organization export. This proves only the exported setting.');
  }
  const rank={high:0,medium:1,low:2,informational:3};
  return [...new Map(leads.map(l=>[l.id,l])).values()].sort((a,b)=>rank[a.severity]-rank[b.severity]||a.id.localeCompare(b.id));
}

export async function scanSnapshot(ws) {
  const {snapshot,snapshotHash}=loadSnapshot(ws);
  const analysis=await cachedAnalysis(snapshot);
  return {snapshotHash,leads:deriveLeads(snapshot,analysis),coverage:{permutations:analysis.permutations.length,certificates:snapshot.certificates.length,publicLists:snapshot.blocklists.filter(l=>!l.synthetic).map(l=>({name:l.name,entries:l.domains.length,source:l.source})),unparsedScripts:analysis.pages.reduce((n,p)=>n+p.parseErrors.length,0),missingOrgFields:policies.filter(([,field])=>!knownField(snapshot,field)).map(([,field])=>field)}};
}
export function detectorsFor() {
  const cache=new WeakMap();
  return Object.fromEntries(checks.map(check=>[check,async(snapshot,where)=>{
    if(!cache.has(snapshot)) cache.set(snapshot,cachedAnalysis(snapshot));
    const leads=deriveLeads(snapshot,await cache.get(snapshot));
    return {ok:leads.some(l=>l.check===check&&l.where===where&&!l.reviewOnly)};
  }]));
}
