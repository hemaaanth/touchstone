import { defineTool } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import { event } from '../../lib/event.mjs';
import { scanSnapshot, detectorsFor } from './checks.mjs';
import { replayEvidence, proveFindings } from '../../lib/proof-evidence.mjs';

export function evidenceTools(ws,state,id) {
  const text = value => ({output:[{type:'text',text:JSON.stringify(value)}]});
  return [defineTool({name:'snapshot_leads',description:'Read the complete offline scan. Tool output is leads. Missing evidence is not proof a control is disabled. Surface inventory is never a vulnerability.',parameters:obj({}),replay:'safe',execute:async()=>text(await scanSnapshot(ws,id))}),
    defineTool({name:'submit_finding',description:'Replay one domains lead against the pinned snapshot. Use its exact id. Never claim takeover, malware, or disabled controls beyond the evidence. One finding per root cause.',parameters:obj({lead_id:str(),explanation:str({description:'Short evidence-based explanation. End with Fix: and the fix.'})}),replay:'safe',execute:async(args)=>{
      if(id === 'surface') return {...text('Surface inventory is leads only. Hand it to domains or web.'),isError:true};
      const scan = await scanSnapshot(ws,id);
      const lead = scan.leads.find(l=>l.id===args.lead_id);
      if(!lead || lead.reviewOnly || state.found.some(f=>f.poc===lead.id)) return {...text('Unknown, duplicate, or review-only lead. A pattern alone cannot prove a drainer.'),isError:true};
      const evidence = {check:lead.check,where:lead.where,snapshotHash:scan.snapshotHash};
      const proof = await replayEvidence(ws,evidence,{detectors:detectorsFor(id)});
      if(proof.status !== 'pass') return {...text(proof),isError:true};
      const finding={n:state.found.length+1,title:lead.check,severity:lead.severity,poc:lead.id,explanation:args.explanation,evidence};
      state.found.push(finding);
      event('finding-submitted',{n:finding.n,title:finding.title,severity:finding.severity,poc:finding.poc});
      return text({recorded:finding.n,proof});
    }})];
}
export function prepassFor(id) { return async(ws,{emit=()=>{}}={})=>{
  const scan = await scanSnapshot(ws,id);
  const record = {pack:id,snapshotHash:scan.snapshotHash,leads:scan.leads,retire:scan.retire};
  emit({ev:id+'-prepass-done',leads:scan.leads.length,snapshotHash:scan.snapshotHash});
  return {env:{LEADS:JSON.stringify(scan.leads)},record};
}; }
export default {
  id:'domains',title:'Domains and front end',tier:'P',proof:'evidence',
  system:()=> 'Audit only the pinned offline DNS and HTTP snapshot. Call snapshot_leads. Review all leads. Submit each supported root cause with submit_finding. Never submit reviewOnly leads. A dangling CNAME does not prove claimability. Approval patterns do not prove a drainer. Missing evidence does not prove a control is disabled. Use the exact severity and check from the lead. Write short sentences. End each explanation with Fix:. Never execute bundle code or access the internet.',
  tools:(ws,state)=>evidenceTools(ws,state,'domains'),
  kickoff:(ws,env)=>'Review every lead, worst first. Submit supported evidence with its exact lead id, then continue. Summarize coverage. Leads: '+(env.LEADS ?? 'Call snapshot_leads.'),
  nudge:()=>null,prepass:prepassFor('domains'),
  prove:(ws,found,events,log)=>proveFindings(ws,found,events,log,{detectors:detectorsFor('domains')}),
};
