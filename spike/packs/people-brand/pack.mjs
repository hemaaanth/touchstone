import {defineTool} from '@earendil-works/pi-durable';
import {obj,str} from '@earendil-works/pi-schema';
import {event} from '../../lib/event.mjs';
import {scanSnapshot,detectorsFor} from './checks.mjs';
import {replayEvidence,proveFindings} from '../../lib/proof-evidence.mjs';
const text=value=>({output:[{type:'text',text:JSON.stringify(value)}]});
export default {
  id:'people-brand',title:'People and brand',tier:'P',proof:'evidence',
  system:()=> 'Audit the made-up pinned lab only. This pack is passive. Call snapshot_leads. Review every lead, worst first. Submit each supported root cause using its exact lead id. Never submit reviewOnly leads. Signals on one host form one finding, not separate findings. Script filenames alone do not prove a drainer. A similar handle or certificate does not prove malicious ownership. The synthetic lab list is not a vendor detection. Missing export fields do not prove disabled controls. Do not recommend claiming or registering an observed domain. Its availability and ownership are unknown. Recommend ownership review and authorized takedown procedures instead. Recovery phrases must never be shared, even with an approved support contact. Use short sentences. End each explanation with Fix: and a concrete fix. Never contact people, look up real brands, execute page code, or send transactions.',
  tools:(ws,state)=>[
    defineTool({name:'snapshot_leads',description:'Read all passive findings and coverage from the pinned lab. No live DNS, certificate, social, GitHub, npm, or HTTP requests occur.',parameters:obj({}),replay:'safe',execute:async()=>text(await scanSnapshot(ws))}),
    defineTool({name:'submit_finding',description:'Replay one lead by its exact id. Review-only patterns and duplicate roots are refused. The snapshot hash, detector, severity, and title come from the scan, not the model.',parameters:obj({lead_id:str(),explanation:str({description:'Short supported explanation. End with Fix: and the fix.'})}),replay:'safe',execute:async(args)=>{
      const scan=await scanSnapshot(ws);
      const lead=scan.leads.find(l=>l.id===args.lead_id);
      if(!lead||lead.reviewOnly||state.found.some(f=>f.poc===lead.id)) return {...text('Unknown, duplicate, or review-only lead.'),isError:true};
      const evidence={check:lead.check,where:lead.where,snapshotHash:scan.snapshotHash};
      const proof=await replayEvidence(ws,evidence,{detectors:detectorsFor()});
      if(proof.status!=='pass') return {...text(proof),isError:true};
      const finding={n:state.found.length+1,title:lead.check,severity:lead.severity,poc:lead.id,explanation:args.explanation,evidence};
      state.found.push(finding);
      event('finding-submitted',{n:finding.n,title:finding.title,severity:finding.severity,poc:finding.poc});
      return text({recorded:finding.n,proof});
    }})
  ],
  kickoff:(ws,env)=>'Review all supported roots. Use submit_finding for each. Summarize limits and coverage. Leads: '+(env.LEADS??'Call snapshot_leads.'),
  nudge:()=>null,
  prepass:async(ws,{emit=()=>{}}={})=>{
    const scan=await scanSnapshot(ws);
    emit({ev:'people-brand-prepass-done',leads:scan.leads.length,snapshotHash:scan.snapshotHash});
    return {env:{LEADS:JSON.stringify(scan.leads)},record:{pack:'people-brand',...scan}};
  },
  prove:(ws,found,events,log)=>proveFindings(ws,found,events,log,{detectors:detectorsFor()})
};
