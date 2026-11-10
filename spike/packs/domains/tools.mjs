import { runTool } from '../../lib/wrap.mjs';
const DNSX='projectdiscovery/dnsx:v1.2.2@sha256:8fced0bedf3655e06c9f1805f6277d60d4988a4b13209e24b3d7cde7baa656ec';
const HTTPX='projectdiscovery/httpx:v1.7.1@sha256:4458ef60897c6abd1d93f7efa82c10c23b783d8ec974e2abd17e4711ff52cb41';
// These inputs name only the owned lab. The caller creates its internal network.
export async function captureTools(ws,network) {
  if (!network.startsWith('touchstone-domains-')) throw new Error('Lab network required');
  const dnsx=await runTool({image:DNSX,ws,network,cmd:['-l','/work/hosts.txt','-r','172.30.44.53','-a','-aaaa','-cname','-json','-silent','-duc','-rl','5','-t','1','-retry','1']});
  const httpx=await runTool({image:HTTPX,ws,network,cmd:['-l','/work/urls.txt','-r','udp:172.30.44.53:53','-json','-silent','-duc','-nfs','-sc','-title','-irh','-irr','-rl','2','-t','1','-timeout','2','-retries','0']});
  for(const [name,result] of Object.entries({dnsx,httpx})) if(result.code || result.timedOut) throw new Error(name+' failed: '+result.stderr);
  const jsonl = output => output.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {dnsx:jsonl(dnsx.stdout),httpx:jsonl(httpx.stdout)};
}
export async function compareTakeovers(ws,network) {
  if (!network.startsWith('touchstone-domains-')) throw new Error('Lab network required');
  const dnsReaper=await runTool({image:'punksecurity/dnsreaper@sha256:6bd99203cf59f7137418f676d1dbf69cdc3193a808b2d91b420f5f9f33255649',ws,network,cmd:['single','--domain','old.touchstone.test','--resolver','172.30.44.53','--out','stdout','--out-format','json','--parallelism','1'],timeoutMs:60000});
  const nuclei=await runTool({image:'projectdiscovery/nuclei:v3.4.2@sha256:d0e34e04a7180c6b944550b81fe50719f57383affcb18ae7a42c0045643d54af',ws,network,env:{HOME:'/tmp',XDG_CONFIG_HOME:'/tmp/.config'},cmd:['-l','/work/urls.txt','-t','/work/github-takeover.yaml','-r','/work/resolvers.txt','-jsonl','-silent','-duc','-ni','-rl','2','-c','1','-timeout','2','-retries','0'],timeoutMs:60000});
  return {dnsReaper,nuclei};
}
