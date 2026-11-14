// Private file-IPC daemon. Its containers are real detached OS processes;
// killing an attached CLI does not stop a container.
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.DEMO_TEST_DOCKER;
if (!dir) throw Error("Private fake Docker directory required");
const requests = join(dir, "requests"), replies = join(dir, "replies");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.argv[2] === "daemon") {
  mkdirSync(requests, { recursive: true }); mkdirSync(replies, { recursive: true });
  const containers = new Map(), waiting = new Map(), handled = new Set();
  const control = () => { try { return JSON.parse(readFileSync(join(dir, "control.json"), "utf8")); } catch { return {}; } };
  const snapshot = () => writeFileSync(join(dir, "containers.json"), JSON.stringify([...containers.values()].map(({ process, ...row }) => row)));
  const reply = (id, result) => writeFileSync(join(replies, id), JSON.stringify(result));
  const find = (key) => [...containers.values()].find((c) => c.Id === key || c.Name === "/" + key);
  const finish = (id, job) => {
    const args = job.args, flags = control();
    const option = (name) => args[args.indexOf(name) + 1];
    if (args[0] === "run") { reply(id, { code: 0, stdout: "[PASS] ownerTest()\nSuite result: ok. 1 passed; 0 failed\n" }); return true; }
    if (args[0] === "create") {
      if (flags.pauseCreate) { writeFileSync(join(dir, "create-waiting"), id); return false; }
      const name = option("--name");
      const labels = Object.fromEntries(args.flatMap((arg, i) => arg === "--label" ? [args[i + 1].split("=")] : []));
      const Id = createHash("sha256").update(name).digest("hex");
      containers.set(Id, { Id, Name: "/" + name, Config: { Labels: labels }, State: { Running: false, ExitCode: 0 }, args, pid: null });
      snapshot(); reply(id, { code: 0, stdout: Id + "\n" }); return true;
    }
    const row = find(args.at(-1));
    if (!row) { reply(id, { code: 1, stderr: "Error: No such container: " + args.at(-1) }); return true; }
    if (args[0] === "inspect") { const { process, ...data } = row; reply(id, { code: 0, stdout: JSON.stringify(data) }); return true; }
    if (args[0] === "start") {
      if (!row.process) {
        row.process = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
        row.pid = row.process.pid; row.State.Running = true; snapshot();
        row.process.once("exit", () => { row.State.Running = false; snapshot(); });
      }
      if (!flags.finish) return false;
      if (row.State.Running) { row.process.kill("SIGTERM"); return false; }
      reply(id, { code: 0, stdout: flags.output ?? "[PASS] testProof()\nSuite result: ok. 1 passed; 0 failed\n" }); return true;
    }
    if (args[0] === "rm") {
      if (flags.failRemove) { reply(id, { code: 1, stderr: "Synthetic removal failure" }); return true; }
      if (flags.keepAfterRm) { reply(id, { code: 0, stdout: row.Id }); return true; }
      if (row.State.Running) { row.process.kill("SIGKILL"); return false; }
      containers.delete(row.Id); snapshot(); reply(id, { code: 0, stdout: row.Id }); return true;
    }
    throw Error("Unexpected fake Docker command");
  };
  const tick = setInterval(() => {
    for (const id of readdirSync(requests)) {
      if (handled.has(id)) continue;
      const job = JSON.parse(readFileSync(join(requests, id), "utf8")); handled.add(id); waiting.set(id, job);
      writeFileSync(join(dir, "calls.jsonl"), JSON.stringify(job) + "\n", { flag: "a" });
    }
    for (const [id, job] of waiting) if (finish(id, job)) waiting.delete(id);
  }, 5);
  process.on("SIGTERM", () => { clearInterval(tick); for (const row of containers.values()) row.process?.kill("SIGKILL"); setTimeout(() => process.exit(0), 50); });
  writeFileSync(join(dir, "ready"), "ready");
} else {
  const id = randomUUID(), temporary = join(dir, `${id}.tmp`);
  writeFileSync(temporary, JSON.stringify({ args: process.argv.slice(2), pid: process.pid })); renameSync(temporary, join(requests, id));
  while (!existsSync(join(replies, id))) await sleep(5);
  const result = JSON.parse(readFileSync(join(replies, id), "utf8"));
  rmSync(join(replies, id)); process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); process.exitCode = result.code;
}
