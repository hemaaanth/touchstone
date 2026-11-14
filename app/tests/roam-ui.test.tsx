import { TEST_STORE_DIR } from "./helpers/isolated-env"
import { test, expect } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { reduceEvents, type RunState } from "../src/lib/runModel"
import { HumanQueue } from "../src/components/human-queue"
import { AskHuman, AskHumanProvider, PendingAskLinks } from "../src/components/ask-human"
import { SessionEvidence } from "../src/components/session-evidence"
import { candidateFrom } from "../src/lib/candidate"
import { runStartBody, answerRunAsk, AskAnswerError } from "../src/lib/api"
import { OptionList } from "../src/components/assistant-ui/elements/option-list"
import { formatAskChoiceReply, isAskPresentation, type AskPresentation } from "../src/lib/types"
import { SandboxDesktop } from "../src/components/sandbox-desktop"
import { execFileSync } from "node:child_process"

const spawn = { ev: "subagent-spawned", id: "a-1", name: "Scout", loadout: "free-roam", model: "test-model", t: 1 }
const first = { ev: "ask-human", id: "one", agent: "a-1", kind: "login", question: "Open test account", t: 2 }
const second = { ...first, id: "two", agent: "a-2", question: "Check test wallet" }
const askHtml = (state: RunState, live = true) => renderToStaticMarkup(<AskHumanProvider runId="r1" state={state} live={live}>{state.humanAsks.map((ask) => <AskHuman key={ask.id} ask={ask} />)}</AskHumanProvider>)

test("inline questions keep exact agent identity without duplicate top forms", () => {
  const state = reduceEvents([spawn, first, second, first, { ev: "ask-answered", id: "one", agent: "a-2", answer: "done" }])
  expect(state.humanAsks.filter((a) => !a.answer).map((a) => a.id)).toEqual(["one", "two"])
  const html = askHtml(state)
  expect(html).toContain("Open test account")
  expect(html).toContain("Check test wallet")
  expect(html).toContain("Never put passwords or codes in Reply")
  expect(html).toContain("Reply and Cancel do not approve it")
  const settled = reduceEvents([spawn, first, second, { ev: "ask-answered", id: "one", agent: "a-1", answer: "reply" }])
  for (const label of [">Watch<", ">Take control<", ">Release<"]) expect(html).not.toContain(label)
  expect(settled.humanAsks.filter((a) => !a.answer).map((a) => a.id)).toEqual(["two"])
  const desktop = renderToStaticMarkup(<HumanQueue runId="r1" state={state} live />)
  expect(desktop).not.toContain("Open test account")
  expect(desktop).not.toContain("Check test wallet")
  const links = renderToStaticMarkup(<AskHumanProvider runId="r1" state={state} live><PendingAskLinks onOpen={() => {}} /></AskHumanProvider>)
  expect(links).toContain('aria-label="Pending questions"')
  expect(links).toContain("Scout")
  expect(links).toContain("a-2")
})

test("closed, stopped, or restarted asks never become approvals on followup", () => {
  for (const marker of ["closed", "stop-requested", "phase-restarted"]) {
    const state = reduceEvents([first, { ev: marker }, { ev: "reply-start" }, { ...first, id: "fresh" }])
    expect(state.humanAsks[0]).toMatchObject({ answer: "cancel", interrupted: true })
    expect(state.humanAsks.filter((a) => !a.answer).map((a) => a.id)).toEqual(["fresh"])
  }
})

test("per-run options reach the start request without changing the selected model", () => {
  expect(runStartBody("alias", "scope", 5, ["web"], "fleet", { freeRoam: true, options: [] })).toMatchObject({ alias: "alias", targetId: "scope", mode: "fleet", freeRoam: true, options: [] })
})

test("session evidence remains unproven and does not embed screenshot or raw HAR", () => {
  const candidate = candidateFrom({ ev: "candidate-submitted", candidate: { poc: "session:a-1:1", title: "Session", proven: true, evidence: { kind: "session", agent: "a-1", artifacts: { version: 1, run: "r1", agent: "a-1", poc: "session:a-1:1", manifest: "m-1" } } } })!
  const html = renderToStaticMarkup(<SessionEvidence runId="r1" candidate={candidate} />)
  expect(candidate.proven).toBe(false)
  expect(html).toContain("Session · unproven")
  expect(html).toContain("Show session files")
  expect(html).not.toContain("<img")
  expect(html).not.toContain("href=")
})

const options = [{ id: "scan", label: "Scan source", description: "Inspect the source first" }, { id: "test", label: "Run tests" }, { id: "review", label: "Review results" }]
const single: AskPresentation = { options, select: "single" }
const multiple: AskPresentation = { options, select: "multiple", min: 2, max: 2 }

test("old Ask events keep free-text Reply, Done and Cancel with no option controls", () => {
  const state = reduceEvents([spawn, first])
  expect(state.humanAsks[0].presentation).toBeUndefined()
  const html = askHtml(state)
  expect(html).toContain('aria-label="Reply to Scout"')
  expect(html).toContain(">Reply</button>")
  expect(html).toContain(">Done</button>")
  expect(html).toContain(">Cancel</button>")
  expect(html).not.toContain('data-slot="option-list"')
})

test("single option renders beside free text and formats only a Reply, never Done", () => {
  const state = reduceEvents([spawn, { ...first, kind: "question", presentation: single }])
  expect(state.humanAsks[0].presentation).toEqual(single)
  const html = askHtml(state)
  expect(html).toContain('data-slot="option-list"')
  expect(html).toContain('aria-label="Scan source"')
  expect(html).toContain("Inspect the source first")
  expect(html).toContain('aria-label="Reply to Scout"')
  expect(html).toContain(">Reply</button>")
  expect(html).toContain("Replies are visible to the agent")
  expect(html).toContain("Never put passwords or codes in Reply")
  expect(html).not.toContain(">Done</button>")
  expect(formatAskChoiceReply(single, ["test"])).toBe("Selected option: test (Run tests)")
  for (const ids of [[], ["scan", "test"], ["unknown"], ["scan", "scan"]]) expect(() => formatAskChoiceReply(single, ids)).toThrow()
})

test("multiple choice enforces min/max and emits option order rather than click order", () => {
  const html = renderToStaticMarkup(<OptionList aria-label="Checks" options={options} selectionMode="multiple" minSelections={2} maxSelections={2} onConfirm={() => {}} />)
  expect(html).toContain('role="checkbox"')
  expect(html).toContain('aria-checked="false"')
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm choices<\/button>/)
  expect(formatAskChoiceReply(multiple, ["review", "scan"])).toBe("Selected options:\n- scan (Scan source)\n- review (Review results)")
  for (const ids of [[], ["scan"], ["scan", "test", "review"], ["scan", "scan"], ["scan", "unknown"]]) expect(() => formatAskChoiceReply(multiple, ids)).toThrow()
  expect(formatAskChoiceReply({ options, select: "multiple" }, ["test"])).toBe("Selected options:\n- test (Run tests)")
})

test("overlong formatted answers refuse without truncation", () => {
  const long = { options: [{ id: "long", label: "x".repeat(4000) }], select: "single" } satisfies AskPresentation
  expect(() => formatAskChoiceReply(long, ["long"])).toThrow("4,000")
})

test("malformed saved presentation is ignored; long option content remains escaped and wrappable", () => {
  for (const presentation of [
    { options, select: "other" }, { options, select: "single", min: 1 },
    { options, select: "multiple", min: null }, { options, select: "multiple", max: null },
    { options: [{ id: "same", label: "A" }, { id: "same", label: "B" }], select: "single" },
    { options: [{ id: "missing" }], select: "single" },
    { options, select: "single", extra: true }, { options, select: { toString: "single" } },
  ]) {
    expect(isAskPresentation(presentation)).toBe(false)
    const state = reduceEvents([{ ...first, kind: "question", presentation }])
    expect(state.humanAsks[0].presentation).toBeUndefined()
    expect(askHtml(state)).not.toContain('data-slot="option-list"')
  }
  const action = reduceEvents([{ ...first, presentation: single }])
  expect(action.humanAsks[0].presentation).toBeUndefined()
  const long = [{ id: "long", label: `<script>${"unbroken".repeat(20)}`, description: "long description ".repeat(20) }, options[1]]
  const html = renderToStaticMarkup(<OptionList aria-label="Long choices" options={long} disabled onConfirm={() => {}} />)
  expect(html).not.toContain("<script>")
  expect(html).toContain("&lt;script&gt;")
  expect(html).toContain("overflow-wrap:anywhere")
  expect(html).toContain('aria-label="Long choices"')
  expect(html).toMatch(/<button[^>]*disabled/)
})

test("live free-roam desktops remain discoverable without asks or after a child turn ends", () => {
  for (const events of [[spawn], [spawn, { ev: "subagent-done", id: "a-1", t: 3 }]]) {
    const state = reduceEvents(events)
    expect(state.humanAsks).toEqual([])
    const html = renderToStaticMarkup(<HumanQueue runId="r1" state={state} live />)
    expect(html).toContain("Scout")
    expect(html).toContain("Model: test-model")
    expect(html).toContain("Desktop")
    expect(html).not.toContain("not enabled")
    expect(html).not.toContain("<select")
    expect(renderToStaticMarkup(<HumanQueue runId="r1" state={state} live={false} />)).toBe("")
  }
  const confined = reduceEvents([{ ...spawn, loadout: "confined" }])
  expect(renderToStaticMarkup(<HumanQueue runId="r1" state={confined} live />)).toBe("")
})

test("desktop starts closed with Watch only; a stopped worker has no enabled desktop action", () => {
  const live = renderToStaticMarkup(<SandboxDesktop runId="r1" agent="a-1" live closedAt={-1} />)
  expect(live).toContain('aria-label="Desktop for a-1"')
  expect(live).toContain(">Watch</button>")
  expect(live).not.toContain(">Take control</button>")
  expect(live).not.toContain(">Release</button>")
  expect(live).not.toContain("<iframe")
  const stopped = renderToStaticMarkup(<SandboxDesktop runId="r1" agent="a-1" live={false} closedAt={-1} />)
  expect(stopped).toMatch(/<button[^>]*disabled[^>]*>Watch<\/button>/)
})

test("retired component cleanup cannot release a newer session or replacement worker; expiry stays scoped", () => {
  const app = new URL("../", import.meta.url).pathname
  const probe = String.raw`
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {randomUUID} from 'node:crypto';
    import {runInNewContext} from 'node:vm';
    import {createRoamControlApi} from ${JSON.stringify(`${app}server/roam-control.mjs`)};
    const source=readFileSync(${JSON.stringify(`${app}src/components/sandbox-desktop.tsx`)},'utf8');
    const body=source.slice(source.indexOf('  const [view,'),source.indexOf('\n  return ('));
    const js=new Bun.Transpiler({loader:'tsx'}).transformSync('function component({runId,agent,live,closedAt}) {'+body+'\nreturn {changed,invalidate};}');
    function component(open,close,initialView){
      let states=0,refs=0;const timers=[];
      const make=runInNewContext(js+';component',{
        useState:value=>[states++===0&&initialView?initialView:value,()=>{}],
        useRef:value=>({current:refs++===2&&initialView?initialView.desktop:value}),
        useCallback:f=>f,useEffect:f=>f(),useLayoutEffect:f=>f(),
        setTimeout:f=>{timers.push(f);return timers.length},clearTimeout:()=>{},
        crypto:{randomUUID},openRunDesktop:open,closeRunDesktop:close,
      });
      return{...make({runId:'r1',agent:'a-1',live:true,closedAt:-1}),timers};
    }
    function backend(){
      const log=[],events=[],grants=new Set();let api,sequence=0,remote='closed';
      const run={id:'r1',owner:{},ws:'/synthetic',status:'running',roamEpoch:'epoch-1',events:[{ev:'subagent-spawned',id:'a-1',loadout:'free-roam',t:1}]};
      function child(epoch){const value={stdin:{writable:true,write(raw,cb){cb?.();const q=JSON.parse(raw).roamControl;if(q){log.push(q.op);queueMicrotask(()=>api.consume(run,value,epoch,{ev:'roam-control',...q,ok:true,state:q.op==='pause'?'paused':q.op==='cancel'?'closed':'running'}))}}}};return value}
      const machine={id:'machine-1',async request(bytes){const q=JSON.parse(bytes);log.push(q.action);if(q.action==='configure'){assert.equal(remote,'closed');remote='configured';sequence++;return{kind:'configured',port:9876,expires:900001}}if(q.action==='open'){assert.equal(remote,'configured');remote='open';return{kind:'open',port:9876,viewOnly:q.viewOnly,expires:900001}}remote='closed';return{kind:'closed'}},async previewGrant(){log.push('grant');const token='grant-'+sequence;grants.add(token);return{url:'https://synthetic.invalid/',expires:900001,revokeToken:token}},async expirePreview(port,token){assert.equal(port,9876);assert(grants.delete(token));log.push('revoke')}};
      api=createRoamControlApi({getRun:id=>id===run.id?run:null,emit:(_,event)=>events.push(event),machine:async()=>machine,now:()=>1,timeoutMs:1000});
      run.child=child(run.roamEpoch);api.begin(run,run.child,run.roamEpoch);
      return{api,run,machine,log,events,grants,async replace(){await api.invalidate(run,run.child,run.roamEpoch);run.roamEpoch='epoch-2';run.child=child(run.roamEpoch);machine.id='machine-2';api.begin(run,run.child,run.roamEpoch)}};
    }
    for(const replacement of [false,true]){
      const f=backend(),response=Promise.withResolvers(),opened=Promise.withResolvers(),arrival=Promise.withResolvers();let first=true,delayClose=replacement,pendingClose;
      const open=async(id,agent,viewOnly,desktop)=>{const hold=first;first=false;const value=await f.api.desktop(id,agent,viewOnly,'https://console.invalid',desktop);if(hold){opened.resolve(value);return response.promise}return value};
      const close=(id,agent,desktop)=>{if(delayClose){delayClose=false;return pendingClose=arrival.promise.then(()=>f.api.close(id,agent,desktop))}return pendingClose=f.api.close(id,agent,desktop)};
      try{
        const old=component(open,close),request=old.changed('watch'),oldResponse=await opened.promise;
        old.invalidate();const oldCleanup=pendingClose;
        if(replacement)await f.replace();else await oldCleanup;
        const newer=component(open,close);await newer.changed('watch');await newer.changed('control');
        assert.equal(f.events.at(-1).viewOnly,false);assert.equal(f.grants.size,1);
        const before=f.log.length;
        if(replacement){arrival.resolve();await oldCleanup}
        response.resolve(oldResponse);await request;
        assert.deepEqual(f.log.slice(before),[]);assert.equal(f.events.at(-1).viewOnly,false);assert.equal(f.grants.size,1);
        await newer.changed('close');assert.deepEqual(f.log.slice(-3),['close','revoke','resume']);assert.equal(f.grants.size,0);
      }finally{arrival.resolve();await f.api.invalidate(f.run)}
    }
    {
      const f=backend();let cleanup;
      const identity={id:randomUUID()};
      const open=(id,agent,viewOnly,desktop)=>f.api.desktop(id,agent,viewOnly,'https://console.invalid',desktop);
      const close=(id,agent,desktop)=>cleanup=f.api.close(id,agent,desktop);
      try{
        const watched=await open('r1','a-1',true,identity);
        const old=component(open,close,watched);assert.equal(old.timers.length,1);
        await old.changed('control');const before=f.log.length;old.timers[0]();await Bun.sleep(0);
        assert.deepEqual(f.log.slice(before),[]);assert.equal(f.events.at(-1).viewOnly,false);assert.equal(f.grants.size,1);
        const controlled={...watched,viewOnly:false};
        const current=component(open,close,controlled);current.timers[0]();await Bun.sleep(0);await cleanup;
        assert.deepEqual(f.log.slice(-3),['close','revoke','resume']);assert.equal(f.grants.size,0);
      }finally{await f.api.invalidate(f.run)}
    }
    console.log(JSON.stringify({retiredResponse:'ignored',replacementWorker:'untouched',staleExpiry:'ignored',currentReleaseAndExpiry:'closed-revoked-resumed'}));
  `
  const output = execFileSync(process.execPath, ["--no-env-file", "--eval", probe], {
    cwd: TEST_STORE_DIR, encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, HOME: TEST_STORE_DIR, TMPDIR: TEST_STORE_DIR, SPEND_LEDGER: `${TEST_STORE_DIR}/ui-spend.jsonl`, TOUCHSTONE_GRANT_TOKEN: "test-grant-token", TOUCHSTONE_GRANT_TOKEN_FILE: `${TEST_STORE_DIR}/ui-token`, TOUCHSTONE_GRANTS_FILE: `${TEST_STORE_DIR}/ui-grants.json`, TOUCHSTONE_SCOPES_FILE: `${TEST_STORE_DIR}/ui-scopes.json`, TOUCHSTONE_PROVIDERS_FILE: `${TEST_STORE_DIR}/ui-providers.json`, TOUCHSTONE_RESULTS_DIR: `${TEST_STORE_DIR}/ui-results` },
  })
  expect(JSON.parse(output)).toEqual({ retiredResponse: "ignored", replacementWorker: "untouched", staleExpiry: "ignored", currentReleaseAndExpiry: "closed-revoked-resumed" })
})

test("safe accepted history is escaped text; old ack-only records never invent a reply", () => {
  const ack = { ev: "ask-answered", id: "one", agent: "a-1", answer: "reply" }
  const old = reduceEvents([spawn, first, ack])
  expect(askHtml(old, false)).toContain("The answer text was not saved.")
  const state = reduceEvents([spawn, first, ack, { ev: "ask-receipt", id: "one", agent: "a-1", answer: "reply", text: "<script>not HTML</script>" }])
  const html = askHtml(state, false)
  expect(html).toContain("Open test account")
  expect(html).toContain("&lt;script&gt;not HTML&lt;/script&gt;")
  expect(html).not.toContain("<script>")
  expect(html).not.toContain("<form")
  expect(html).not.toContain("<input")
})

test("Ask client treats missing delivery metadata and lost HTTP as uncertain, not status-based not-sent", async () => {
  const original = globalThis.fetch
  try {
    for (const status of [400, 403, 409, 500]) {
      globalThis.fetch = (async () => Response.json({ error: "refused" }, { status })) as typeof fetch
      try { await answerRunAsk("r1", { ask: "one", reply: "first" }); throw Error("Expected refusal") }
      catch (error) { expect(error instanceof AskAnswerError).toBe(true); expect((error as AskAnswerError).uncertain).toBe(true) }
    }
    globalThis.fetch = (async () => Response.json({ error: "not sent", delivery: "not-sent" }, { status: 409 })) as typeof fetch
    await expect(answerRunAsk("r1", { ask: "one", reply: "first" })).rejects.toMatchObject({ uncertain: false })
    globalThis.fetch = (async () => { throw Error("synthetic connection loss") }) as typeof fetch
    await expect(answerRunAsk("r1", { ask: "one", reply: "first" })).rejects.toMatchObject({ uncertain: true })
  } finally { globalThis.fetch = original }
})


test("option list owns the custom reply while receipts stay read-only", () => {
  const open = renderToStaticMarkup(<OptionList options={options} onConfirm={() => {}}><form><input aria-label="Custom answer" /></form></OptionList>)
  expect(open).toContain('aria-label="Custom answer"')
  const receipt = renderToStaticMarkup(<OptionList options={options} choice={["scan"]}><form><input aria-label="Custom answer" /></form></OptionList>)
  expect(receipt).toContain("Selected:")
  expect(receipt).not.toContain("Custom answer")
  expect(receipt).not.toContain("Run tests")
})
