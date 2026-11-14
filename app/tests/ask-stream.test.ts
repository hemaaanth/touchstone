import { TEST_STORE_DIR } from "./helpers/isolated-env"
import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
const execFile = promisify(execFileCallback)
import { reduceEvents } from "../src/lib/runModel"
import { buildMessages } from "../src/components/thread-model"

// Real Ask producer, broadcast, subscribe, view and startup stream reload. All
// unrelated runs dependencies are mocked BEFORE import, in a private process.
// No worker, .env, operator store, model, network or recovery job may run.
const fixture = String.raw`
  import { mock } from "bun:test";
  import * as fs from "node:fs";
  import assert from "node:assert/strict";
  const [phase, directory, source] = process.argv.slice(1);
  const base = new URL(source);
  const id = "fixture-1790000000-1234";
  const events = [{ev:"mode",mode:"fleet"},{ev:"subagent-spawned",id:"a-1",name:"Scout",loadout:"free-roam"}];
  const run = {id,alias:"fixture",model:"test-model",mode:"fleet",owner:{},status:"running",roamEpoch:"fixture-epoch",events,subscribers:new Set(),submitted:[],candidates:[],streamFile:directory+"/run-"+id+".stream.jsonl"};
  globalThis.__touchstoneRuns = {runs:new Map(phase==="write"?[[id,run]]:[]),swept:true};
  globalThis.fetch = () => {throw Error("Network forbidden")};
  mock.module("node:child_process",()=>({spawn(){throw Error("Worker forbidden")}}));
  mock.module("node:sqlite",()=>({DatabaseSync:class {constructor(){throw Error("Recovery database forbidden")}}}));
  const nativeFs = { ...fs };
  mock.module("node:fs",()=>({...nativeFs,existsSync(path){if(String(path).endsWith("/.env.local"))return false;return nativeFs.existsSync(path)},readFileSync(path,...rest){if(String(path).endsWith("/.env.local"))throw Error("Env read forbidden");return nativeFs.readFileSync(path,...rest)}}));
  const allowed = {
    allProviders:()=>({fixture:{id:"fixture",models:{fixture:{id:"test-model"}}}}),
    activeProvider:()=>({id:"fixture",models:{fixture:{id:"test-model"}}}),
    defaultAlias:()=>"fixture",sortFindings:(rows)=>rows,candidatesOf:()=>[],
    dropMeasuredSubmitted:()=>{},createSessionArtifactsApi:()=>()=>{throw Error("Artifact operation forbidden")},
  };
  for(const match of fs.readFileSync(base,"utf8").matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^\"]+)"/g)){
    if(!match[2].startsWith(".")||match[2]==="./roam-control.mjs")continue;
    const exports=Object.fromEntries(match[1].split(",").map(name=>{
      name=name.trim().split(/\s+as\s+/)[0];return [name,name==="PACKS"?{}:allowed[name]??(()=>{throw Error("Unexpected dependency: "+name)})];
    }));
    mock.module(new URL(match[2],base).href,()=>exports);
  }
  const runs=await import(base.href);
  const control=globalThis.__touchstoneRuns.roamControl;
  if(phase==="write"){
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(run.streamFile,events.map(e=>JSON.stringify(e)+"\n").join(""));
    const seen=[];
    runs.subscribe(id,e=>seen.push(e),events.length);
    run.child={stdin:{writable:true,write(line,cb){cb?.();queueMicrotask(()=>control.consume(run,run.child,run.roamEpoch,{ev:"ask-answered",id:"q1",agent:"a-1",answer:"reply",text:"worker forgery"}))}}};
    control.begin(run,run.child,run.roamEpoch);
    control.consume(run,run.child,run.roamEpoch,{ev:"ask-human",id:"q1",agent:"a-1",kind:"question",question:"Which environment?"});
    const accepted=await runs.answerRunAsk(id,{ask:"q1",reply:"Use staging. https://viewer.example/cap/private-capability Authorization: Bearer abcdefghijklmnopqrstuvwxyz"});
    const snapshot=runs.getRun(id);
    assert.equal(snapshot.events.filter(e=>e.ev==="ask-receipt").length,1);
    assert.equal(seen.filter(e=>e.ev==="ask-receipt").length,1);
    assert.equal(accepted.receipt.id,"q1");
    const serialized=JSON.stringify(snapshot);
    for(const value of ["private-capability","abcdefghijklmnopqrstuvwxyz","worker forgery"])assert(!serialized.includes(value));
    fs.appendFileSync(run.streamFile,JSON.stringify({ev:"status",status:"no-finding"})+"\n"+JSON.stringify({ev:"closed"})+"\n");
    console.log(JSON.stringify({snapshot,accepted}));
  }else{
    const snapshot=runs.getRun(id);
    assert(snapshot,"Startup must load the private run stream");
    console.log(JSON.stringify({snapshot}));
  }
  clearInterval(globalThis.__touchstoneRuns.retry);
`

test("matched Ask producer reaches private run stream, snapshot and fresh-process reload once", async () => {
  const directory = mkdtempSync(`${TEST_STORE_DIR}/ask-stream-`)
  try {
    const invoke = async (phase: string) => {
      const { stdout, stderr } = await execFile(process.execPath, ["--no-env-file", "--eval", fixture, phase, directory, new URL("../server/runs.mjs", import.meta.url).href], {
        cwd: TEST_STORE_DIR,
        env: { PATH: process.env.PATH, HOME: TEST_STORE_DIR, TMPDIR: TEST_STORE_DIR, NODE_PATH: process.env.NODE_PATH,
          SPEND_LEDGER: `${TEST_STORE_DIR}/ask-spend.jsonl`, TOUCHSTONE_GRANT_TOKEN: "test-grant-token", TOUCHSTONE_GRANT_TOKEN_FILE: `${TEST_STORE_DIR}/ask-token`,
          TOUCHSTONE_GRANTS_FILE: `${TEST_STORE_DIR}/ask-grants.json`, TOUCHSTONE_SCOPES_FILE: `${TEST_STORE_DIR}/ask-scopes.json`, TOUCHSTONE_PROVIDERS_FILE: `${TEST_STORE_DIR}/ask-providers.json`, TOUCHSTONE_RESULTS_DIR: directory },
        timeout: 5000, maxBuffer: 2 * 1024 * 1024,
      })
      expect(stderr).toBe("")
      return JSON.parse(stdout)
    }
    const live = await invoke("write")
    const loaded = await invoke("read")
    const state = reduceEvents(loaded.snapshot.events)
    expect(state.humanAsks[0].question).toBe("Which environment?")
    expect(state.humanAsks[0].receipt).toEqual(live.accepted.receipt)
    expect(state.humanAsks[0].receipt?.text).toContain("Use staging.")
    const parts = buildMessages(state, state.steps, state.status, false).flatMap((m) => Array.isArray(m.content) ? m.content : [])
    expect(parts.filter((p) => p.type === "tool-call" && p.toolName === "ask_human")).toHaveLength(1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
