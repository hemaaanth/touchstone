// Session capture for a free-roam child (Wave 4, I6 smallest): recordSession,
// sessionLookup and the submit_session_candidate tool. No machine and no
// network: each entry is written by hand, as the shell tool will write it.
// Every secret here is made up.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_CAP, SESSION_DESCRIPTION, SESSION_POC, candidateTool, recordSession, sessionLookup } from "../lib/candidate.mjs";
import { sha256 } from "../lib/proof-evidence.mjs";
import { withAgent } from "../lib/event.mjs";

const VALUE = "q9Zk27fLmPw81xTr55aa";
const GH_TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ012345";

const newState = () => ({ passed: new Map(), found: [] });
const shell = (state, agent, command, output, extra = {}) => recordSession(state, { agent, kind: "shell", t: 1, sandbox: `sb-${agent}`, command, exit_code: 0, output, ...extra });
const egress = (state, agent, method, url, status) => recordSession(state, { agent, kind: "egress", t: 2, method, url, status });
const lookupAs = (state, agent, poc) => withAgent(agent, () => sessionLookup(state)(poc));
// The tool as lane D builds it in agent-run.mjs.
const sessionTool = (state) => candidateTool({ name: "submit_session_candidate", description: SESSION_DESCRIPTION, pack: "web", state, lookup: sessionLookup(state), poc: SESSION_POC });
const submit = (state, agent, args) => withAgent(agent, () => sessionTool(state).execute(args));
const said = (r) => r.output[0].text;
const args = (poc, line, n = 1) => ({ title: `Admin export is open (${n})`, severity: "high", poc, evidence_lines: [line], explanation: "Anyone can read the export.\nFix: require a login." });
// Everything the engine keeps or sends: the stored entries and the candidates.
const kept = (state) => JSON.stringify([[...(state.session ?? [])], state.candidates ?? []]);

test("recordSession returns the per-agent session id and the output", () => {
  const state = newState();
  assert.deepEqual(shell(state, "a-1", "id", "uid=0(root)\n"), { poc: "session:a-1:1", output: "uid=0(root)\n" });
  // An egress entry does not move the id, and has no output.
  assert.deepEqual(egress(state, "a-1", "GET", "http://example.org/", 200), { poc: "session:a-1:1", output: "" });
  assert.equal(shell(state, "a-1", "ls /", "bin\netc\n").poc, "session:a-1:2");
  // Another agent has its own count.
  assert.equal(shell(state, "a-2", "id", "uid=0(root)\n").poc, "session:a-2:1");
  assert.throws(() => recordSession(state, { kind: "shell", command: "id" }), /needs an agent/);
  assert.throws(() => recordSession(state, { agent: "a-1", kind: "browser" }), /unknown session entry kind/);
});

test("a session candidate is unproven, with the session evidence and its text lines", async () => {
  const state = newState();
  shell(state, "a-1", "curl -s http://example.org/admin/export", "exported 4120 customer rows\n", { sandbox: "sb-old" });
  egress(state, "a-1", "GET", "http://example.org/admin/export", 200);
  egress(state, "a-1", "CONNECT", "registry.npmjs.org:443", null);
  egress(state, "a-1", "GET", "http://example.org/again", 200);
  // The machine was replaced: the evidence names the machine of the last command.
  const { poc } = shell(state, "a-1", "id", "uid=0(root)\n", { exit_code: 1, sandbox: "sb-new" });
  assert.equal(poc, "session:a-1:2");

  const { evidence, text, ...rest } = await lookupAs(state, "a-1", poc);
  assert.deepEqual(rest, {}, "the lookup returns evidence and text only");
  assert.deepEqual(text.split("\n"), [
    "$ curl -s http://example.org/admin/export",
    "exit 0",
    "exported 4120 customer rows",
    "",
    "> GET http://example.org/admin/export 200",
    "> CONNECT registry.npmjs.org:443 tunnel",
    "> GET http://example.org/again 200",
    "$ id",
    "exit 1",
    "uid=0(root)",
    "",
  ]);
  const shellText = "$ curl -s http://example.org/admin/export\nexit 0\nexported 4120 customer rows\n\n$ id\nexit 1\nuid=0(root)\n";
  assert.deepEqual(evidence, {
    kind: "session",
    agent: "a-1",
    sandbox: "sb-new",
    shell: { commands: 2, sha256: sha256(shellText) },
    egress: { requests: 3, hosts: ["example.org", "registry.npmjs.org"], note: "proxy log; a request that does not use the proxy is not listed" },
    har: null,
    screenshots: [],
  });

  const r = await submit(state, "a-1", args(poc, "exported 4120 customer rows"));
  assert.match(said(r), /Recorded candidate #1/);
  const c = state.candidates[0];
  assert.equal(c.proven, false);
  assert.equal(c.candidate, true);
  assert.equal(c.provedBy, null);
  assert.equal(c.assertedBy, "agent");
  assert.equal(c.poc, poc);
  assert.equal(c.pack, "web");
  // The scrub at submit and the size cut leave the evidence as the lookup made it.
  assert.deepEqual(c.evidence, evidence);
});

test("the host list holds at most 60 hosts; the count is of every request seen by the log", async () => {
  const state = newState();
  shell(state, "a-1", "scan", "done\n");
  for (let i = 0; i < 70; i++) egress(state, "a-1", "CONNECT", `h${i}.example.org:443`, null);
  const { evidence } = await lookupAs(state, "a-1", "session:a-1:1");
  assert.equal(evidence.egress.requests, 70);
  assert.equal(evidence.egress.hosts.length, 60);
});

test("planted secrets are masked: in a command, an output, a URL query and a URL userinfo", async () => {
  const state = newState();
  const planted = ["cmdSecret7fLmPw81xTr55", "outSecret7fLmPw81xTr55", "qrySecret7fLmPw81xTr55", "usrSecret7fLmPw81xTr55", GH_TOKEN];
  const first = shell(state, "a-1", `curl -H "Authorization: Bearer ${planted[0]}" https://example.org/me`, `{"user":"alice"}\nAPI_KEY=${planted[1]}\ntoken ${GH_TOKEN}\nexported 4120 customer rows\n`);
  egress(state, "a-1", "GET", `http://example.org/cb?token=${planted[2]}&page=2`, 200);
  egress(state, "a-1", "GET", `http://alice:${planted[3]}@example.org/private`, 401);
  const second = shell(state, "a-1", `curl "https://example.org/cb?token=${planted[2]}"; curl https://alice:${planted[3]}@example.org/`, "ok\n");

  const { evidence, text } = await lookupAs(state, "a-1", second.poc);
  // The model sees only what recordSession returned, and may cite only `text`.
  const seen = [first.output, second.output, text, JSON.stringify(evidence), kept(state)].join("\n");
  for (const secret of planted) assert.ok(!seen.includes(secret), `${secret} must be masked`);
  // The lines stay readable around the mask.
  assert.match(text, /^\$ curl -H "Authorization: Bearer \[REDACTED\]" https:\/\/example\.org\/me$/m);
  assert.match(text, /^API_KEY=\[REDACTED\]$/m);
  assert.match(text, /^> GET http:\/\/example\.org\/cb\?token=\[REDACTED\]&page=2 200$/m);
  // The userinfo of a logged url is dropped whole, not masked.
  assert.match(text, /^> GET http:\/\/example\.org\/private 401$/m);
  assert.deepEqual(evidence.egress.hosts, ["example.org"]);

  // The record of a candidate from this session holds none of them either,
  // also when the agent writes one into its own prose.
  const r = await submit(state, "a-1", { ...args(second.poc, "exported 4120 customer rows"), title: `Leaked token ${GH_TOKEN}` });
  assert.match(said(r), /Recorded candidate #1/);
  for (const secret of planted) assert.ok(!kept(state).includes(secret) && !said(r).includes(secret), `${secret} must not be in the record`);
});

// THE SCRUB IS NOT COMPLETE. These are the eight cases of the Wave 4 plan
// review (finding 7), as the code behaves today. `masked: false` is a known
// limit, not a goal: such a value stays in the session text, in what the model
// sees, and can be cited into a candidate. When a rule starts to mask one,
// change its flag here. Nobody may read the scrub as "no secret in a record".
const B64 = Buffer.from(`alice:${VALUE}`).toString("base64");
const TG = "123456789:AAEhQ9zk27fLmPw81xTr55aaQ9zk27fLKbs";
const KNOWN_CASES = [
  { name: "a header with no secret name", masked: false, secret: VALUE, command: `curl -H "X-Custom: ${VALUE}" https://example.org/` },
  { name: "a token in a URL path", masked: false, secret: TG, command: `curl https://api.telegram.org/bot${TG}/getMe` },
  { name: "a reset link in the request log", masked: false, secret: VALUE, url: `http://example.org/reset/${VALUE}` },
  { name: "sshpass -p", masked: false, secret: VALUE, command: `sshpass -p ${VALUE} ssh root@example.org` },
  // The redactor alone keeps this one. The candidate's own rule (a value after a secret label) masks it.
  { name: "PGPASSWORD=", masked: true, secret: VALUE, command: `PGPASSWORD=${VALUE} psql -h example.org` },
  { name: "a bare value on an output line", masked: false, secret: VALUE, output: `${VALUE}\n` },
  { name: "a base64 form of a value", masked: false, secret: B64, output: `${B64}\n` },
  { name: "curl -u", masked: true, secret: VALUE, command: `curl -u alice:${VALUE} https://example.org/` },
  { name: "Authorization: Bearer", masked: true, secret: VALUE, command: `curl -H "Authorization: Bearer ${VALUE}" https://example.org/` },
  { name: "?token=", masked: true, secret: VALUE, url: `http://example.org/cb?token=${VALUE}` },
];

for (const k of KNOWN_CASES) {
  test(`known case, ${k.masked ? "masked" : "NOT masked today"}: ${k.name}`, async () => {
    const state = newState();
    const { output } = shell(state, "a-1", k.command ?? "true", k.output ?? "");
    if (k.url) egress(state, "a-1", "GET", k.url, 200);
    const { text } = await lookupAs(state, "a-1", "session:a-1:1");
    assert.equal(`${output}\n${text}\n${kept(state)}`.includes(k.secret), !k.masked);
  });
}

test("a known secret value (state.sessionSecrets) is masked where no shape rule sees it", async () => {
  const state = { ...newState(), sessionSecrets: [VALUE] };
  const { output, poc } = shell(state, "a-1", `sshpass -p ${VALUE} ssh root@example.org`, `${VALUE}\n`);
  egress(state, "a-1", "GET", `http://example.org/reset/${VALUE}`, 200);
  const { text } = await lookupAs(state, "a-1", poc);
  assert.equal(output, "[REDACTED]\n");
  assert.ok(!`${text}\n${kept(state)}`.includes(VALUE));
});

test("the output is cut to its last 16 000 characters, and the partial first line is dropped", () => {
  const state = newState();
  // The cut falls inside the token: its second half alone has no known shape.
  const tail = `${GH_TOKEN.slice(20)}\n${"plain output line.\n".repeat(841)}`;
  assert.equal(tail.length, 16_000);
  const { output } = shell(state, "a-1", "cat big.log", `${"x".repeat(30_000)}\ntoken ${GH_TOKEN.slice(0, 20)}${tail}`);
  assert.equal(output, "plain output line.\n".repeat(841));
  assert.ok(!kept(state).includes(GH_TOKEN.slice(20)));
  // A short output is kept whole.
  assert.equal(shell(state, "a-1", "echo hi", "hi\n").output, "hi\n");
});

test("one long line: the cut drops the leading partial token, so a value does not lose its label", () => {
  const state = newState();
  // A minified JSON body. The cut falls inside the value of "password".
  const tail = `${VALUE.slice(10)}",${'"kk":1,'.repeat(2284)}`;
  assert.equal(tail.length, 16_000);
  const { output } = shell(state, "a-1", "curl -s http://example.org/me.json", `${"x".repeat(30_000)}{"password":"${VALUE.slice(0, 10)}${tail}`);
  assert.equal(output, `",${'"kk":1,'.repeat(2284)}`);
  assert.ok(!kept(state).includes(VALUE.slice(10)));
  // A line with no break and no separator is one token: nothing of it stays.
  assert.equal(shell(state, "a-1", "yes", "y".repeat(40_000)).output, "");
});

test("a failed command: exit_code undefined is stored as null, and the session id still moves", async () => {
  const state = newState();
  assert.equal(shell(state, "a-1", "id", "uid=0(root)\n").poc, "session:a-1:1");
  // What the shell tool records when the machine call throws.
  const failed = shell(state, "a-1", "curl http://example.org/", "", { exit_code: undefined });
  assert.deepEqual(failed, { poc: "session:a-1:2", output: "" });
  assert.equal(state.session.get("a-1").at(-1).exit_code, null);
  const { text, evidence } = await lookupAs(state, "a-1", failed.poc);
  assert.deepEqual(text.split("\n").slice(-3), ["$ curl http://example.org/", "exit null", ""]);
  assert.equal(evidence.shell.commands, 2);
});

// The userinfo of a logged url. Only the first form has a shape the scrub
// knows, so the userinfo is dropped before the scrub.
const SECRET = "s3cretValue7fLmPw81";
const USERINFO = [
  { method: "GET", url: `http://alice:${SECRET}@host.example/x`, line: "> GET http://host.example/x 200" },
  { method: "GET", url: `http://:${SECRET}@host.example/x`, line: "> GET http://host.example/x 200" },
  { method: "GET", url: `http://${SECRET}@host.example/x`, line: "> GET http://host.example/x 200" },
  { method: "CONNECT", url: `alice:${SECRET}@host.example:443`, line: "> CONNECT host.example:443 200" },
];

for (const u of USERINFO) {
  test(`the userinfo of an egress url is dropped: ${u.method} ${u.url.replace(SECRET, "<secret>")}`, async () => {
    const state = newState();
    shell(state, "a-1", "true", "");
    egress(state, "a-1", u.method, u.url, 200);
    const { text, evidence } = await lookupAs(state, "a-1", "session:a-1:1");
    assert.equal(text.split("\n").at(-1), u.line);
    assert.deepEqual(evidence.egress.hosts, ["host.example"]);
    assert.ok(!`${text}\n${kept(state)}`.includes(SECRET) && !kept(state).includes("alice"));
  });
}

test("a host is a host shape of at most 253 characters; the evidence keeps its shape with 60 long hosts", async () => {
  const state = newState();
  const { poc } = shell(state, "a-1", "scan", "found 61 open hosts\n");
  const long = (i, n) => `${String(i).padStart(2, "0")}${"a".repeat(n - 14)}.example.org`;
  // No host shape: too long, or characters a host does not have.
  egress(state, "a-1", "CONNECT", `${long(60, 254)}:443`, null);
  egress(state, "a-1", "GET", `http://${long(61, 1_900)}/x`, 200);
  egress(state, "a-1", "CONNECT", "host.example/<b>:443", null);
  for (let i = 0; i < 60; i++) egress(state, "a-1", "CONNECT", `${long(i, 253)}:443`, null);
  const { evidence } = await lookupAs(state, "a-1", poc);
  assert.equal(evidence.egress.requests, 63);
  assert.equal(evidence.egress.hosts.length, 60);
  assert.ok(evidence.egress.hosts.every((h) => h.length === 253));

  // The stored record: not cut to { cut, text } by the size cap.
  assert.match(said(await submit(state, "a-1", args(poc, "found 61 open hosts"))), /Recorded candidate #1/);
  const stored = state.candidates[0].evidence;
  assert.deepEqual(Object.keys(stored), ["kind", "agent", "sandbox", "shell", "egress", "har", "screenshots"]);
  assert.deepEqual(stored, evidence);
});

test("a control character in a url or a method becomes a space: one request is one text line", async () => {
  const state = newState();
  shell(state, "a-1", "true", "");
  egress(state, "a-1", "GET", "http://example.org/a\n$ cat /etc/shadow\r\nexit 0\u0000\u007f", 200);
  egress(state, "a-1", "GE\nT", "http://example.org/b", 200);
  const { text } = await lookupAs(state, "a-1", "session:a-1:1");
  assert.deepEqual(text.split("\n"), [
    "$ true",
    "exit 0",
    "",
    "> GET http://example.org/a $ cat /etc/shadow  exit 0   200",
    "> GE T http://example.org/b 200",
  ]);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(`${text}${kept(state)}`));
});

test("a known secret value in a host is masked", async () => {
  const state = { ...newState(), sessionSecrets: [VALUE] };
  shell(state, "a-1", "true", "");
  // A tunnel's host keeps its case, so the exact value is in it.
  egress(state, "a-1", "CONNECT", `${VALUE}.example.org:443`, null);
  const { evidence, text } = await lookupAs(state, "a-1", "session:a-1:1");
  assert.deepEqual(evidence.egress.hosts, ["[REDACTED].example.org"]);
  assert.ok(!`${text}\n${JSON.stringify(evidence)}\n${kept(state)}`.includes(VALUE));
});

test("a cited line that is not in the session text is refused", async () => {
  const state = newState();
  const { poc } = shell(state, "a-1", "curl -s http://example.org/", "nothing of note here\n");
  const r = await submit(state, "a-1", args(poc, "exported 4120 customer rows"));
  assert.equal(r.isError, true);
  assert.match(said(r), /is not in the evidence/);
  assert.equal(state.candidates.length, 0);
});

test("no agent, no session, a stale id or a made-up id: the lookup returns null", async () => {
  const state = newState();
  const lookup = sessionLookup(state);
  assert.equal(await lookupAs(state, "a-1", "session:a-1:1"), null, "no session yet");
  const first = shell(state, "a-1", "id", "uid=0(root) gid=0(root)\n");
  assert.equal(lookup(first.poc), null, "no agent tag (the coordinator, or a tool the fleet did not tag)");
  assert.ok(await lookupAs(state, "a-1", first.poc));
  shell(state, "a-1", "ls /", "bin\netc\n");
  assert.equal(await lookupAs(state, "a-1", first.poc), null, "a stale id");
  for (const poc of ["session", "session:a-1", "session:a-1:3", "session:a-1:02", "a-1", ""]) assert.equal(await lookupAs(state, "a-1", poc), null, poc);
  // An agent with requests but no shell entry has no session to cite.
  egress(state, "a-3", "GET", "http://example.org/", 200);
  assert.equal(await lookupAs(state, "a-3", "session:a-3:0"), null);

  const r = await submit(state, "a-9", args("session:a-9:1", "uid=0(root) gid=0(root)"));
  assert.equal(r.isError, true);
  assert.match(said(r), /is not a recorded attempt in this session/);
});

test("a session lookup never returns { proved: true }", async () => {
  const state = newState();
  // Nothing in an entry, and nothing a pack's own lookup reads, opens a proved path.
  const { poc } = shell(state, "a-1", "id", "uid=0(root) gid=0(root)\n", { proved: true, matched: true, proof: { status: "pass" } });
  egress(state, "a-1", "GET", "http://example.org/", 200);
  state.passed.set(poc, "source");
  state.attempts = new Map([[poc, { matched: true, proof: { status: "pass" } }]]);
  const got = await lookupAs(state, "a-1", poc);
  assert.deepEqual(Object.keys(got).sort(), ["evidence", "text"]);
  assert.ok(!JSON.stringify(got).includes("proved"));
  assert.ok(!JSON.stringify([...state.session]).includes("proved"), "an entry keeps only its own fields");
  const r = await submit(state, "a-1", args(poc, "uid=0(root) gid=0(root)"));
  assert.match(said(r), /UNPROVEN/);
  assert.equal(state.candidates[0].proven, false);
  assert.equal(state.found.length, 0);
});

test("agent A never gets agent B's entries", async () => {
  const state = newState();
  const a = shell(state, "a-1", "cat /root/a-notes", "only agent one saw this line\n");
  egress(state, "a-1", "GET", "http://one.example.org/", 200);
  const b = shell(state, "a-2", "cat /root/b-notes", "only agent two saw this line\n");
  egress(state, "a-2", "GET", "http://two.example.org/", 200);
  assert.equal(a.poc, "session:a-1:1");
  assert.equal(b.poc, "session:a-2:1");

  // B's own session holds nothing of A's.
  const own = await lookupAs(state, "a-2", b.poc);
  assert.ok(!JSON.stringify(own).includes("agent one") && !JSON.stringify(own).includes("one.example.org"));
  assert.equal(own.evidence.agent, "a-2");
  assert.equal(own.evidence.sandbox, "sb-a-2");
  assert.deepEqual(own.evidence.egress.hosts, ["two.example.org"]);
  // B cannot name A's session.
  assert.equal(await lookupAs(state, "a-2", a.poc), null);
  assert.equal(await lookupAs(state, "a-1", b.poc), null);

  // Through the tool: B with A's id, and B citing A's line under its own id.
  const stolen = await submit(state, "a-2", args(a.poc, "only agent one saw this line"));
  assert.match(said(stolen), /is not a recorded attempt in this session/);
  const cited = await submit(state, "a-2", args(b.poc, "only agent one saw this line"));
  assert.match(said(cited), /is not in the evidence/);
  assert.equal(state.candidates.length, 0);
});

test("agent a-1 and agent a-11 do not share a session", async () => {
  const state = newState();
  const one = shell(state, "a-1", "cat /root/one", "only agent a-1 saw this\n");
  const eleven = shell(state, "a-11", "cat /root/eleven", "only agent a-11 saw this\n");
  assert.equal(one.poc, "session:a-1:1");
  assert.equal(eleven.poc, "session:a-11:1");
  // "session:a-1:1" is a prefix of "session:a-11:1", and the reverse read is "session:a-1" + "1:1".
  assert.equal(await lookupAs(state, "a-1", eleven.poc), null);
  assert.equal(await lookupAs(state, "a-11", one.poc), null);
  assert.equal(await lookupAs(state, "a-1", "session:a-1:11"), null);
  assert.equal((await lookupAs(state, "a-1", one.poc)).text, "$ cat /root/one\nexit 0\nonly agent a-1 saw this\n");
  assert.equal((await lookupAs(state, "a-11", eleven.poc)).text, "$ cat /root/eleven\nexit 0\nonly agent a-11 saw this\n");
});

test("a second candidate needs a new command; a fourth candidate in one run is refused", async () => {
  const state = newState();
  const first = shell(state, "a-1", "probe 1", "harm line number one\n");
  assert.match(said(await submit(state, "a-1", args(first.poc, "harm line number one", 1))), /Recorded candidate #1/);
  const again = await submit(state, "a-1", args(first.poc, "harm line number one", 2));
  assert.equal(again.isError, true);
  assert.match(said(again), /already recorded as candidate #1/);

  const second = shell(state, "a-1", "probe 2", "harm line number two\n");
  assert.match(said(await submit(state, "a-1", args(second.poc, "harm line number two", 2))), /Recorded candidate #2/);
  // The cap is the run's, not the agent's.
  const other = shell(state, "a-2", "probe 3", "harm line number three\n");
  assert.match(said(await submit(state, "a-2", args(other.poc, "harm line number three", 3))), /Recorded candidate #3/);
  assert.equal(state.candidates.length, CANDIDATE_CAP);

  const fourth = shell(state, "a-2", "probe 4", "harm line number four\n");
  const refused = await submit(state, "a-2", args(fourth.poc, "harm line number four", 4));
  assert.equal(refused.isError, true);
  assert.match(said(refused), /already has 3 candidates/);
  assert.equal(state.candidates.length, CANDIDATE_CAP);
  assert.ok(state.candidates.every((c) => c.proven === false && c.candidate === true));
});

test("candidateTool: the name and the description are optional, and the packs' tool is unchanged", () => {
  const state = newState();
  const packTool = candidateTool({ pack: "web", state, lookup: () => null, poc: "the label" });
  assert.equal(packTool.name, "submit_candidate");
  assert.match(packTool.description, /^Record a CANDIDATE: a serious problem your own attempt showed/);
  assert.match(packTool.description, /If the attempt proved, use submit_finding\. At most 3 per run\.$/);

  const tool = sessionTool(state);
  assert.equal(tool.name, "submit_session_candidate");
  assert.equal(tool.description, SESSION_DESCRIPTION);
  // A free-roam child has no submit_finding.
  assert.ok(!tool.description.includes("submit_finding"));
  assert.match(tool.description, /unproven/);
  assert.equal(tool.parameters.properties.poc.description, SESSION_POC);
  assert.equal(SESSION_POC, 'the session id from the line that starts with "session" in your last shell result, like session:a-12:3');
});
