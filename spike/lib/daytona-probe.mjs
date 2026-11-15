import { probeManagedShell } from "./roam.mjs";
import { pullEgressLog, startEgressLog } from "./roam-egress.mjs";
import { daytonaError } from "./daytona-api.mjs";

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const PREREQ_ERRORS = {
  71: "daytona_shell_commands_missing", 72: "daytona_shell_http_client_missing", 73: "daytona_shell_package_manager_missing",
  74: "daytona_shell_node_required", 75: "daytona_shell_linux_required", 76: "daytona_shell_root_required",
  77: "daytona_shell_tls_missing", 78: "daytona_shell_proc_unavailable", 79: "daytona_shell_tmp_unwritable", 80: "daytona_shell_log_unwritable",
  81: "daytona_shell_toolbelt_missing",
};
// The attacker toolbelt the machine-layer packs need on the machine. A snapshot
// without it forces every tool call back to a container image, which is the very
// capability this deployment mode exists to have.
const TOOLBELT = `sh -c 'for x in nmap tshark exiftool gdb readelf; do command -v "$x" >/dev/null || exit 81; done; python3 -c "import pwn" 2>/dev/null || exit 81'`;
const NODE_CHECK = `import fs from 'node:fs';import tls from 'node:tls';if(process.platform!=='linux')process.exit(75);if(process.getuid?.()!==0)process.exit(76);if(!tls.rootCertificates.length)process.exit(77);try{fs.readFileSync('/proc/self/stat')}catch{process.exit(78)}try{fs.accessSync('/tmp',fs.constants.W_OK)}catch{process.exit(79)}try{fs.mkdirSync('/var/log/touchstone',{recursive:true});fs.accessSync('/var/log/touchstone',fs.constants.W_OK)}catch{process.exit(80)}process.stdout.write('touchstone-prerequisites-ready');`;
const PREREQUISITES = `sh -c ${quote(`for x in sh nohup seq sleep base64 head tail; do command -v "$x" >/dev/null || exit 71; done; (command -v curl || command -v wget) >/dev/null || exit 72; (command -v apt-get || command -v apk || command -v dnf || command -v yum) >/dev/null || exit 73; command -v node >/dev/null || exit 74; node --input-type=module -e ${quote(NODE_CHECK)}`)}`;
const LOCAL_HTTP = `import http from 'node:http';const server=http.createServer((q,r)=>r.end('touchstone-egress-ready'));await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await new Promise((resolve,reject)=>{const q=http.get({host:'127.0.0.1',port:8899,path:'http://127.0.0.1:'+server.address().port+'/touchstone-probe',signal:AbortSignal.timeout(5000)},r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>r.statusCode===200&&text==='touchstone-egress-ready'?resolve():reject(new Error('probe')))});q.on('error',reject)});process.stdout.write('touchstone-egress-ready')}finally{server.close()}`;

export async function probeDaytonaShell(machine) {
  let stage = "prerequisites";
  try {
    const prerequisites = await machine.exec(PREREQUISITES, 15);
    if (PREREQ_ERRORS[prerequisites?.exitCode]) throw daytonaError(PREREQ_ERRORS[prerequisites.exitCode]);
    if (prerequisites?.exitCode !== 0 || prerequisites.result.trim() !== "touchstone-prerequisites-ready") throw new Error();
    stage = "toolbelt";
    const toolbelt = await machine.exec(TOOLBELT, 20);
    if (toolbelt?.exitCode !== 0) throw daytonaError(PREREQ_ERRORS[toolbelt?.exitCode] ?? "daytona_shell_toolbelt_missing");
    stage = "egress_start";
    await startEgressLog(machine);
    stage = "egress_http";
    const http = await machine.exec(`node --input-type=module -e ${quote(LOCAL_HTTP)}`, 15);
    if (http?.exitCode !== 0 || http.result.trim() !== "touchstone-egress-ready") throw new Error();
    stage = "egress_record";
    const records = await pullEgressLog(machine);
    if (!records.some((r) => r.host === "127.0.0.1" && r.method === "GET" && r.status === 200 && new URL(r.url).pathname === "/touchstone-probe")) throw new Error();
    stage = "supervisor";
    await probeManagedShell(machine);
  } catch (error) {
    if (Object.values(PREREQ_ERRORS).includes(error.code) || ["daytona_unreachable", "daytona_rejected", "daytona_response_invalid"].includes(error.code)) throw error;
    throw daytonaError(`daytona_shell_${stage}_failed`);
  }
}
