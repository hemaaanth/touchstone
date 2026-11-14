import { probeManagedShell } from "./roam.mjs";
import { pullEgressLog, startEgressLog } from "./roam-egress.mjs";
import { daytonaError } from "./daytona-api.mjs";

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const NODE_CHECK = `import fs from 'node:fs';import tls from 'node:tls';if(process.platform!=='linux'||process.getuid()!==0||!tls.rootCertificates.length)process.exit(1);fs.readFileSync('/proc/self/stat');fs.accessSync('/tmp',fs.constants.W_OK);fs.mkdirSync('/var/log/touchstone',{recursive:true});fs.accessSync('/var/log/touchstone',fs.constants.W_OK);process.stdout.write('touchstone-prerequisites-ready');`;
const PREREQUISITES = `sh -c ${quote(`for x in sh nohup seq sleep base64 head tail; do command -v "$x" >/dev/null || exit 1; done; (command -v curl || command -v wget) >/dev/null || exit 1; (command -v apt-get || command -v apk || command -v dnf || command -v yum) >/dev/null || exit 1; node --input-type=module -e ${quote(NODE_CHECK)}`)}`;
const LOCAL_HTTP = `import http from 'node:http';const server=http.createServer((q,r)=>r.end('touchstone-egress-ready'));await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await new Promise((resolve,reject)=>{const q=http.get({host:'127.0.0.1',port:8899,path:'http://127.0.0.1:'+server.address().port+'/touchstone-probe',signal:AbortSignal.timeout(5000)},r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>r.statusCode===200&&text==='touchstone-egress-ready'?resolve():reject(new Error('probe')))});q.on('error',reject)});process.stdout.write('touchstone-egress-ready')}finally{server.close()}`;

export async function probeDaytonaShell(machine) {
  let stage = "prerequisites";
  try {
    const prerequisites = await machine.exec(PREREQUISITES, 15);
    if (prerequisites?.exitCode !== 0 || prerequisites.result !== "touchstone-prerequisites-ready") throw new Error();
    stage = "egress_start";
    await startEgressLog(machine);
    stage = "egress_http";
    const http = await machine.exec(`node --input-type=module -e ${quote(LOCAL_HTTP)}`, 15);
    if (http?.exitCode !== 0 || http.result !== "touchstone-egress-ready") throw new Error();
    stage = "egress_record";
    const records = await pullEgressLog(machine);
    if (!records.some((r) => r.host === "127.0.0.1" && r.method === "GET" && r.status === 200 && new URL(r.url).pathname === "/touchstone-probe")) throw new Error();
    stage = "supervisor";
    await probeManagedShell(machine);
  } catch { throw daytonaError(`daytona_shell_${stage}_failed`); }
}
