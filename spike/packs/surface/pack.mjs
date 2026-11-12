import { evidenceTools, prepassFor } from '../domains/pack.mjs';
export default {
  id:'surface',title:'Surface',tier:'P',proof:'evidence',
  // It reads the same live capture as Domains.
  live:true,
  system:()=> 'Discover hosts and services only from the pinned offline zone and HTTP snapshot. Call snapshot_leads. Return the typed inventory and nextPack handoffs. Every discovered asset is a lead, never a vulnerability. Do not call submit_finding. Do not access the internet. A zone record does not prove a host is reachable. A captured HTTP response does prove the service answered at capture time.',
  tools:(ws,state)=>evidenceTools(ws,state,'surface').filter(t=>t.name!=='submit_finding'),
  kickoff:(ws,env)=>'List discovered hosts and services and hand them to domains or web as leads. Include evidence and reachability limits. Leads: '+(env.LEADS ?? 'Call snapshot_leads.'),
  nudge:()=>null,prepass:prepassFor('surface'),
  // Inventory is not a vulnerability. No finding may pass this pack.
  prove:async()=>[],
};
