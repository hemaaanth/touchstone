// The machine-layer packs: the session proof frame, the flag oracles, and the
// harm class. No Docker needed: the frame parser and every oracle are pure.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HARM_ORACLES, proofClass } from "../lib/proof-class.mjs";
import { isProven, proofKind, proofView } from "../lib/proof-view.mjs";
import { EXIT_MARK, RUN_MARK, SCRIPT_MARK, newFlag, parseRun } from "../lib/proof-session.mjs";
import { flagOracle } from "../lib/session-tool.mjs";

const { ORACLES: HOST } = await import("../packs/host/pack.mjs");
const { ORACLES: CRYPTO } = await import("../packs/crypto/pack.mjs");
const { ORACLES: FORENSICS } = await import("../packs/forensics/pack.mjs");
const { ORACLES: BINARY } = await import("../packs/binary/pack.mjs");
const ALL = [...HOST, ...CRYPTO, ...FORENSICS, ...BINARY];

const frame = (script, output, exit = 0) => `${SCRIPT_MARK}\n${script}\n${RUN_MARK}\n${output}\n${EXIT_MARK}${exit}\n`;

test("parseRun reads the script, the output and the exit status apart", () => {
  const run = parseRun(frame("nmap -Pn target", "22/tcp open ssh", 0));
  assert.equal(run.script, "nmap -Pn target");
  assert.equal(run.output, "22/tcp open ssh");
  assert.equal(run.exit, 0);
});

test("parseRun keeps a non-zero exit and an empty output", () => {
  const run = parseRun(frame("false", "", 1));
  assert.equal(run.output, "");
  assert.equal(run.exit, 1);
});

test("parseRun survives an unframed output instead of throwing", () => {
  const run = parseRun("raw text only");
  assert.equal(run.output, "raw text only");
  assert.equal(run.exit, null);
});

test("every machine-layer oracle name is a harm class", () => {
  const names = ALL.map((o) => o.name).sort();
  const harm = names.filter((n) => HARM_ORACLES.has(n));
  assert.deepEqual(harm, names, `every oracle must be in HARM_ORACLES, missing: ${names.filter((n) => !HARM_ORACLES.has(n))}`);
  assert.equal(new Set(names).size, names.length, "two oracles share a name, so the duplicate-root-cause guard would refuse the second");
});

test("a session oracle that passed makes a finding proven; a failed one does not", () => {
  const flag = "FLAG{0123456789abcdef01234567}";
  const [oracle] = HOST;
  const pass = oracle.check({ output: `uid=1001\n${flag}\n`, exit: 0 }, { flag });
  const fail = oracle.check({ output: "uid=1001\n", exit: 0 }, { flag });
  assert.equal(pass.pass, true);
  assert.equal(fail.pass, false);

  const proof = { kind: "session", status: "pass", oracle: { name: oracle.name, passed: true, detail: pass.detail }, log: [] };
  assert.equal(proofClass({ proof }), "harm");
  assert.equal(isProven({ proof, pocProved: true }), true);
  assert.equal(isProven({ proof: { ...proof, status: "fail" }, pocProved: true }), false);
});

test("a flag oracle does not let a suffixed route stand in for the bare one", () => {
  const flag = "FLAG{0123456789abcdef01234567}";
  const [user, , cron] = HOST; // user (bare), suid (-root), cron (-cron)
  const cronOutput = `$ append; cat /tmp/root.txt\n${flag}-cron\n`;
  assert.equal(user.check({ output: cronOutput }, { flag }).pass, false);
  assert.equal(cron.check({ output: cronOutput }, { flag }).pass, true);
  // And the plain value alone satisfies only the bare oracle.
  const userOutput = `$ cat ~/user.txt\n${flag}\n`;
  assert.equal(user.check({ output: userOutput }, { flag }).pass, true);
  assert.equal(cron.check({ output: userOutput }, { flag }).pass, false);
});

test("no oracle passes without an instance flag", () => {
  for (const oracle of ALL) {
    assert.equal(oracle.check({ output: "anything" }, {}).pass, false, oracle.name);
  }
});

test("an oracle throws only inside its own check, never out of the set", () => {
  const broken = flagOracle("broken", "x");
  assert.equal(broken.check({ output: undefined }, { flag: "F" }).pass, false);
});

test("newFlag is unique per call and looks like a flag", () => {
  const a = newFlag();
  const b = newFlag();
  assert.match(a, /^FLAG\{[0-9a-f]{24}\}$/);
  assert.notEqual(a, b);
});

test("proofView renders a session proof as commands, not exchanges", () => {
  const finding = {
    proof: {
      kind: "session",
      status: "pass",
      detail: "ok",
      oracle: { name: "host-user-flag", detail: "ok", passed: true },
      log: [{ label: "replayed script", request: { method: "sh", url: "script.sh", headers: {}, body: "id" }, response: { status: 0, headers: {}, body: "uid=1001" } }],
    },
  };
  assert.equal(proofKind(finding), "session");
  const view = proofView(finding);
  assert.equal(view.kind, "session");
  assert.equal(view.commands.length, 1);
  assert.equal(view.commands[0].request.body, "id");
  assert.equal(view.exchanges, undefined);
});
