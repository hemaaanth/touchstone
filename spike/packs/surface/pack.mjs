import { evidenceTools, prepassFor } from '../domains/pack.mjs';
export default {
  // No submit_finding and prove() returns nothing, so no finding can be proven.
  id:'surface',title:'Surface',tier:'P',proof:'none',
  // It reads the same live capture as Domains. That capture runs on the open
  // bridge network (lib/targets.mjs prepareWorkspace).
  live:true,scanNet:'open',
  system:()=> 'Discover hosts and services only from the pinned offline zone and HTTP snapshot. Call snapshot_leads. Return the typed inventory and nextPack handoffs. Every discovered asset is a lead, never a vulnerability. Do not call submit_finding. Do not access the internet. A zone record does not prove a host is reachable. A captured HTTP response does prove the service answered at capture time. A crawled endpoint proves only that a page or script named it. A secret-pattern lead holds no value and does not prove the secret is real.',
  tools:(ws,state)=>evidenceTools(ws,state,'surface').filter(t=>t.name!=='submit_finding'),
  kickoff:(ws,env)=>'List discovered hosts, services and endpoints and hand them to domains or web as leads. Include evidence and reachability limits. Leads: '+(env.LEADS ?? 'Call snapshot_leads.'),
  nudge:()=>null,prepass:prepassFor('surface'),
  // Inventory is not a vulnerability. No finding may pass this pack.
  prove:async()=>[],
};
