import { AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool, LiveDoc, ProviderDoc, ROOT_CONVERSATION_ID, UsageDoc } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { event, withAgent } from "./event.mjs";
import { watchCognition } from "./cognition.mjs";

const C = "coordinator";
const who = (conv) => conv === ROOT_CONVERSATION_ID ? C : `a-${conv}`;
const reply = (value) => ({ output: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const textOf = (message, type = "text") => (message?.content ?? []).filter((b) => b.type === type).map((b) => b[type]).join("");
const empty = () => ({ agents: [], jobs: {}, bulletin: [] });
const Fleet = defineDoc({ kind: "touchstone.fleet", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: empty, checkpointWhen: () => false });

export const COORDINATOR_INSTRUCTIONS = `You are the fleet coordinator. Spawn only when splitting the work helps.
Give each child one clear angle. Children share the pack tools, workspace, PoC limits, and run budget.
Use spawn_agent with a unique name, task, and area. Do not repeat a child's work.
Use bulletin_read to see the roster and shared Bulletin. Use message_agent with a name or id to give direction.
Children report their final answers to you. Use bulletin_post for useful notes and leads, not verdicts.
If the operator says "retry <name>", use message_agent to ask that child to retry its task.
If the operator says "reassign <name>'s task", read the roster and give that task to another child by message_agent or spawn_agent.
A failed child is not a failed audit. Cover its angle another way if the budget allows.`;

export function createFleet({ system, costOf, max = process.env.FLEET_MAX ?? 4 } = {}) {
  if (process.env.FLEET === "0") return undefined;
  max = Number(max);
  if (!Number.isInteger(max) || max < 1) throw new Error("FLEET_MAX must be a positive integer.");
  let harness;
  let packQueue = Promise.resolve();
  const watches = new Map();
  const sessions = new Map();

  async function observe(agent, ctx) {
    if (watches.has(agent.id)) return watches.get(agent.id);
    // Save the promise before awaiting, so two messages cannot install two watches.
    const pending = (async () => {
      const provider = await harness.snapshot(ProviderDoc, agent.conv, ctx);
      if (provider) sessions.set(provider.sessionId, agent.id);
      const cognition = await watchCognition(harness, agent.conv, { agent: agent.id, skipStale: true, uniqueTurns: true }, ctx);
      const usage = await harness.watchDoc(UsageDoc, agent.conv, ctx);
      const spend = (doc) => {
        let usd = 0;
        for (const [model, u] of Object.entries(doc?.models ?? {})) {
          usd += costOf(model.slice(model.indexOf("/") + 1), u.input ?? 0, u.output ?? 0);
        }
        event("agent-spend", { agent: agent.id, id: agent.id, usd });
      };
      if (usage) {
        spend(usage.value);
        usage.start(async (call) => { if (call.kind === "value") spend(call.value); });
      }
      return { cognition, usage, spend };
    })();
    watches.set(agent.id, pending);
    return pending;
  }

  const Anchor = defineTask({
    name: "touchstone.fleet-anchor", version: 1, initial: () => ({ phase: "done" }),
    phases: { done: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx) },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });

  const Reporter = defineTask({
    name: "touchstone.fleet-reporter", version: 1, initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const { agent, text, from } = task.input;
        const watch = await observe(agent, ctx);
        event("agent-status", { agent: agent.id, id: agent.id, state: "working" });
        let status = "done", error, answer, final, finalTask;
        try {
          const child = await runtime.conversation(agent.conv, ctx);
          const submission = await child.submit({ type: "input", content: `[From ${from}] ${text}`, requestId: `fleet:${task.id}`, whenBusy: "steer" }, ctx);
          const settled = await submission.wait(ctx);
          await child.waitForIdle(ctx);
          if (settled.status !== "done") {
            status = "failed";
            error = String(settled.detail ?? settled.reason ?? "Child did not answer");
          } else if (settled.type === "input") {
            answer = settled.answer;
            const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), ctx);
            final = entry?.model?.[0];
            finalTask = entry?.byTaskId;
          }
        } catch (err) {
          if (runtime.signal.aborted) throw err;
          status = "failed";
          error = String(err?.message ?? err);
        }
        watch.cognition?.flush(textOf(final), textOf(final, "thinking"), finalTask);
        watch.spend(await harness.snapshot(UsageDoc, agent.conv, ctx));
        await runtime.commit(async (tx) => {
          const board = await tx.doc(Fleet, ROOT_CONVERSATION_ID);
          const stored = board.agents.find((a) => a.id === agent.id);
          const receipt = answer ?? `failed:${task.id}`;
          if (stored.reported.includes(receipt)) return { status: "running", checkpoint: { phase: "report" } };
          stored.reported.push(receipt);
          stored.status = status;
          // A message steered into a busy child shares that turn. Its reporter
          // gets an empty answer; the reporter that owns the turn reports it.
          if (status !== "failed" && !textOf(final).trim()) return { status: "running", checkpoint: { phase: "report" } };
          const report = status === "failed" ? `${agent.name} failed: ${error}` : `${agent.name} completed: ${textOf(final)}`;
          return { status: "running", checkpoint: { phase: "report", report, status, ...(error ? { error } : {}) } };
        }, ctx);
        // The checkpoint is read in the next phase. A duplicate steer has no new report.
      },
      report: async (task, runtime, ctx) => {
        const { agent } = task.input;
        const { report, status, error } = task.state.checkpoint;
        if (report !== undefined) {
          event("subagent-done", { agent: agent.id, id: agent.id, status, ...(error ? { error } : {}) });
          const message = { id: `m-report-${task.id}`, from: agent.id, to: C, text: report };
          event("agent-message", { agent: agent.id, ...message });
          const root = await runtime.conversation(ROOT_CONVERSATION_ID, ctx);
          await root.submit({ type: "input", requestId: `fleet-report:${task.id}`, content: `[Fleet report, no reply needed unless more work is required] ${report}`, whenBusy: "followUp" }, ctx);
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const background = { ownership: { kind: "conversation" }, background: true };

  const spawn = defineTool({
    name: "spawn_agent", description: `Start one trusted child on one clear task. At most ${max} children per run. Use message_agent to retry an existing child.`,
    parameters: obj({ name: str(), task: str(), area: str() }), replay: "safe",
    execute: async ({ name, task, area }, api, ctx) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error("Only the coordinator can spawn agents.");
      if (![name, task, area].every((v) => v.trim())) throw new Error("name, task, and area must not be empty.");
      const created = await api.commit(async (tx) => {
        const board = await tx.doc(Fleet, ROOT_CONVERSATION_ID);
        if (board.jobs[api.taskId]) return { agent: board.agents.find((a) => a.spawn === api.taskId), fresh: false };
        if (board.agents.some((a) => a.name === name)) throw new Error(`${name} already exists. Use message_agent to retry or reassign.`);
        if (board.agents.length >= max) throw new Error(`Fleet limit reached (${max}). Message an existing child instead.`);
        const anchor = await tx.createTask(Anchor, null, background);
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await configure(tx, child.id, {
          tools: { remove: [spawn] },
          instructions: `${system}\n\nYou are trusted child ${name} (${who(child.id)}). Work only on this angle: ${area}.\nTask: ${task}\nOther children may work at the same time. Use unique proof contract names.\nUse bulletin_read to see the roster and notes. Post useful notes or leads with bulletin_post.\nUse message_agent to contact the coordinator or another child by name or id.\nDo not spawn children. Finish with a short report. Your final answer goes to the coordinator.`,
        });
        const agent = { id: who(child.id), conv: child.id, name, title: task, area, spawn: api.taskId, status: "working", reported: [] };
        board.agents.push(agent);
        board.jobs[api.taskId] = await tx.createTask(Reporter, { agent, text: task, from: C }, background);
        return { agent, fresh: true };
      }, ctx);
      const { agent } = created;
      if (created.fresh) event("subagent-spawned", { id: agent.id, name, title: task, area, tier: "T1", parent: null, conv: String(agent.conv) });
      await api.details({ conversationId: agent.conv }, ctx);
      return reply({ id: agent.id, name, task: agent.title, area, conv: String(agent.conv) });
    },
  });
  const message = defineTool({
    name: "message_agent", description: "Send a message to the coordinator or a child by id or name. An idle or failed child starts again. A busy child is steered. Read bulletin_read for the roster and tasks.",
    parameters: obj({ to: str(), text: str() }), replay: "unsafe",
    execute: async ({ to, text }, api, ctx) => {
      if (!text.trim()) throw new Error("Message text must not be empty.");
      const from = who(api.conversationId);
      const board = await api.snapshot(Fleet, ROOT_CONVERSATION_ID, ctx) ?? empty();
      const target = board.agents.find((a) => a.id === to || a.name === to);
      const destination = to === C ? C : target?.id;
      if (!destination) throw new Error(`Unknown agent: ${to}. Read bulletin_read for the roster.`);
      if (destination === from) throw new Error("Send the message to another agent.");
      if (destination === C) {
        const root = await api.conversation(ROOT_CONVERSATION_ID, ctx);
        await root.submit({ type: "input", content: `[From ${from}] ${text}`, requestId: `fleet-message:${api.taskId}`, whenBusy: "steer" }, ctx);
      } else {
        await api.commit(async (tx) => {
          const current = await tx.doc(Fleet, ROOT_CONVERSATION_ID);
          current.agents.find((a) => a.id === destination).status = "working";
          current.jobs[api.taskId] = await tx.createTask(Reporter, { agent: target, text, from }, background);
        }, ctx);
      }
      event("agent-message", { id: `m-${api.taskId}`, from, to: destination, text });
      return reply(`Sent to ${destination}.`);
    },
  });
  const post = defineTool({
    name: "bulletin_post", description: "Post a shared note or lead. A lead is not a proven finding.",
    parameters: obj({ text: str(), kind: oneOf(["note", "lead"]), severity: opt(oneOf(["critical", "high", "medium", "low"])), tags: opt(arr(str())) }), replay: "unsafe",
    execute: async (args, api, ctx) => {
      if (!args.text.trim()) throw new Error("Bulletin text must not be empty.");
      const note = { ...args, id: `b-${api.taskId}`, author: who(api.conversationId), lane: "trusted" };
      await api.commit(async (tx) => { (await tx.doc(Fleet, ROOT_CONVERSATION_ID)).bulletin.push(note); }, ctx);
      event("bulletin-post", note);
      return reply(note);
    },
  });
  const read = defineTool({
    name: "bulletin_read", description: "Read the shared Bulletin and roster, including each child's task and status.",
    parameters: obj({}), replay: "safe",
    execute: async (_args, api, ctx) => {
      const board = await api.snapshot(Fleet, ROOT_CONVERSATION_ID, ctx) ?? empty();
      return reply({ agents: board.agents.map(({ id, name, title, area, status }) => ({ id, name, task: title, area, status })), bulletin: board.bulletin });
    },
  });

  function tag(tool, serialize = false) {
    return { ...tool, execute: (args, api, ctx) => withAgent(api.conversationId === ROOT_CONVERSATION_ID ? undefined : who(api.conversationId), async () => {
      if (!serialize) return tool.execute(args, api, ctx);
      const before = packQueue;
      let release;
      packQueue = new Promise((resolve) => { release = resolve; });
      await before;
      try {
        // This also rejects a call that was aborted while it waited for the workspace.
        await api.agent(ctx);
        return await tool.execute(args, api, ctx);
      } finally { release(); }
    }) };
  }

  return {
    extension: defineExtension({ name: "fleet", tasks: [Anchor, Reporter], tools: [spawn, message, post, read].map((t) => tag(t)) }),
    wrapTools: (tools) => tools.map((t) => tag(t, true)),
    agentForSession: (sessionId) => sessions.get(sessionId),
    async attach(value, ctx) {
      harness = value;
      const board = await harness.snapshot(Fleet, ROOT_CONVERSATION_ID, ctx) ?? empty();
      for (const agent of board.agents) {
        const provider = await harness.snapshot(ProviderDoc, agent.conv, ctx);
        if (provider) sessions.set(provider.sessionId, agent.id);
      }
    },
    async drain(ctx) {
      // Reports can start coordinator turns, which can create more children or messages.
      for (;;) {
        const before = await harness.snapshot(Fleet, ROOT_CONVERSATION_ID, ctx) ?? empty();
        await Promise.all(Object.values(before.jobs).map((id) => harness.waitForTask(id, ctx)));
        const root = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
        await root.waitForIdle(ctx);
        const after = await harness.snapshot(Fleet, ROOT_CONVERSATION_ID, ctx) ?? empty();
        if (Object.keys(before.jobs).length === Object.keys(after.jobs).length) break;
      }
      const live = await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, ctx);
      if (live?.runFailure) return { status: "unanswered", reason: live.runFailure.reason, detail: live.runFailure.detail };
    },
    async close() {
      for (const pending of watches.values()) {
        const watch = await pending;
        watch.cognition?.stop();
        watch.usage?.stop();
      }
    },
  };
}
