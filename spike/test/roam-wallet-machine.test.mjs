import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openWalletMachine } from "../lib/roam-wallet-machine.mjs";

const config = () => ({ backend: "daytona", apiKey: "fake-private-api-token", apiUrl: "https://control.test/api", snapshot: "trusted-preloaded-dind", target: "fake-region" });
function service({ toolbox = "https://control.test/toolbox", failCreate = false, oversized = false } = {}) {
  const calls = [];
  const uploads = [];
  let state;
  let request;
  let failed = false;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    init.signal?.throwIfAborted();
    const u = new URL(url);
    if (init.method === "POST" && u.pathname === "/api/sandbox") {
      if (failCreate) throw new Error("fake-private-api-token");
      const body = JSON.parse(init.body);
      state = { id: "private-machine", state: "started", labels: { ...body.labels }, toolboxProxyUrl: toolbox };
      return Response.json(state);
    }
    if (init.method === "GET") return oversized ? new Response("x".repeat(262145)) : Response.json(state);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (u.pathname.endsWith("/files/upload-v2")) {
      const data = await init.body.get("file").text();
      const path = u.searchParams.get("path");
      uploads.push({ path, data });
      if (path.endsWith(".json")) request = JSON.parse(data);
      return new Response(null, { status: 204 });
    }
    if (u.pathname.endsWith("/process/execute")) {
      const { command } = JSON.parse(init.body);
      if (command.includes("python3") && command.includes(" < ")) {
        return Response.json({ exitCode: failed ? 1 : 0, result: failed ? "fake-private-api-token signed bytes" : JSON.stringify({ ok: true, lease: request.lease, chain_id: 31337, hash: "0x" + "12".repeat(32) }) });
      }
      return Response.json({ exitCode: 0, result: "" });
    }
    throw new Error("Unexpected fake endpoint");
  };
  return { calls, uploads, fetchImpl, get state() { return state; }, fail() { failed = true; } };
}
const open = (s, options = {}) => openWalletMachine("/fake/run", "a-1", { config, fetchImpl: s.fetchImpl, ...options });

test("private transport binds exact immutable labels and never uses root roam labels or a workspace", async () => {
  const s = service();
  const machine = await open(s);
  assert.equal(Object.isFrozen(machine), true);
  assert.deepEqual(Object.keys(machine).sort(), ["close", "id", "request"]);
  const created = JSON.parse(s.calls[0].init.body);
  assert.equal(created.labels.purpose, "wallet");
  assert.equal(created.labels.agent.length, 64);
  assert.equal(created.labels.run.length, 64);
  assert.equal(created.labels.lease.length, 48);
  assert.equal(created.autoStopInterval, 15);
  assert.equal(created.autoDeleteInterval, 60);
  assert.equal(created.snapshot, config().snapshot);
  assert.equal(s.uploads.length, 1);
  assert.ok(s.uploads[0].path.endsWith("/driver.py"));
  for (const { init } of s.calls) assert.equal(init.redirect, "error");
  await machine.close();
  await machine.close();
  assert.equal(s.calls.filter(({ init }) => init.method === "DELETE").length, 1);
});

test("signed bytes use private upload and stdin only, followed by private file removal", async () => {
  const s = service(); const machine = await open(s);
  const raw = "0x" + "ab".repeat(100);
  const result = await machine.request({ op: "submit", raw });
  assert.equal(result.hash, "0x" + "12".repeat(32));
  assert.ok(!JSON.stringify(result).includes(raw));
  const payload = s.uploads.find(({ path }) => path.endsWith(".json"));
  assert.equal(JSON.parse(payload.data).raw, raw);
  for (const { url, init } of s.calls) {
    assert.ok(!url.includes(raw));
    if (typeof init.body === "string") assert.ok(!init.body.includes(raw));
  }
  const commands = s.calls.filter(({ url }) => url.endsWith("/process/execute")).map(({ init }) => JSON.parse(init.body).command);
  assert.ok(commands.some((c) => c.includes(" < ") && c.includes("rm -f")));
  assert.ok(commands.some((c) => c.startsWith("rm -f")));
  await machine.close();
});

test("wrong labels, stopped machines and unexpected failure invalidate transport without replacement", async () => {
  for (const mutation of ["labels", "stopped", "driver"]) {
    const s = service(); const machine = await open(s);
    if (mutation === "labels") s.state.labels.lease = "other";
    if (mutation === "stopped") s.state.state = "stopped";
    if (mutation === "driver") s.fail();
    await assert.rejects(() => machine.request({ op: "status" }), /No fallback, retry or replacement/);
    await assert.rejects(() => machine.request({ op: "status" }), /unavailable/);
    assert.equal(s.calls.filter(({ url, init }) => init.method === "POST" && url.endsWith("/api/sandbox")).length, 1);
    assert.equal(s.calls.filter(({ init }) => init.method === "DELETE").length, 1);
  }
});

test("missing backend, create failure and oversized control response fail with fixed errors", async () => {
  let calls = 0;
  await assert.rejects(() => openWalletMachine("/fake/run", "a-1", { config: () => ({ backend: "local" }), fetchImpl: async () => { calls++; } }), /unavailable/);
  assert.equal(calls, 0);
  for (const options of [{ failCreate: true }, { oversized: true }]) {
    const s = service(options);
    await assert.rejects(() => open(s), { message: "Private wallet machine unavailable. No fallback, retry or replacement is permitted." });
    assert.equal(s.calls.filter(({ init, url }) => init.method === "POST" && url.endsWith("/api/sandbox")).length, 1);
  }
});

test("toolbox credentials require exact trusted origin; redirects and malformed configuration cannot relax it", async () => {
  const s = service({ toolbox: "https://foreign.test/toolbox" });
  await assert.rejects(() => open(s), /unavailable/);
  assert.ok(s.calls.every(({ url }) => new URL(url).origin === "https://control.test"));
  const trusted = service({ toolbox: "https://verified-toolbox.test/toolbox" });
  const machine = await open(trusted, { toolboxOrigins: ["https://verified-toolbox.test"] });
  await machine.close();
  for (const apiUrl of ["http://control.test/api", "https://secret@control.test/api", "https://control.test/api?token=private", "not a URL"]) {
    await assert.rejects(() => openWalletMachine("/fake/run", "a-1", { config: () => ({ ...config(), apiUrl }), fetchImpl: async () => { assert.fail("unsafe URL fetched"); } }), /unavailable/);
  }
});

test("request size and operation are bounded and aborted cleanup does not reuse the aborted signal", async () => {
  const s = service(); const ac = new AbortController(); const machine = await open(s, { signal: ac.signal });
  await assert.rejects(() => machine.request({ op: "rpc", method: "anvil_setBalance" }), /unavailable/);
  await assert.rejects(() => machine.request({ op: "submit", raw: "x".repeat(262144) }), /unavailable/);
  ac.abort();
  await assert.rejects(() => machine.request({ op: "status" }, { signal: ac.signal }), /unavailable/);
  const deletion = s.calls.find(({ init }) => init.method === "DELETE");
  assert.ok(deletion);
  assert.equal(deletion.init.signal.aborted, false);
});

test("fixed driver exercises isolation, lifecycle and payload gates using fake Docker and fake IPC only", () => {
  const path = fileURLToPath(new URL("../roam/wallet/driver.py", import.meta.url));
  const script = String.raw`
import copy, importlib.util, json, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location("wallet_driver", sys.argv[1])
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
lease = "ab" * 24; cid = "cd" * 32; image = "sha256:" + "ef" * 32
calls = []; rpcs = []
with tempfile.TemporaryDirectory() as root:
    directory = pathlib.Path(root) / ("touchstone-wallet-" + lease); directory.mkdir()
    container = {"Id":cid,"Image":image,"State":{"Running":True,"StartedAt":"fake-first-start"},"Config":{"Labels":{"touchstone.wallet":lease},"Entrypoint":["anvil"],"Cmd":d.COMMAND},"HostConfig":{"NetworkMode":"none","Privileged":False,"PublishAllPorts":False,"PortBindings":{},"Binds":[str(directory)+":/wallet"],"LogConfig":{"Type":"none"},"ReadonlyRootfs":True,"CapDrop":["ALL"]},"NetworkSettings":{"Ports":{"8545/tcp":None}}}
    def docker(args):
        calls.append(args)
        if args[:2] == ["image","inspect"]: return json.dumps([{"Id":image}])
        if args[0] == "run": return cid
        if args[0] == "inspect": return json.dumps([container])
        raise AssertionError(args)
    def rpc(directory, method, params):
        rpcs.append((method,params))
        return {"eth_chainId":"0x7a69","eth_getTransactionCount":"0x0","eth_gasPrice":"0x1","eth_estimateGas":"0x5208","eth_sendRawTransaction":"0x"+"12"*32}[method]
    d.docker=docker; d.rpc=rpc
    assert d.handle({"op":"start","lease":lease},directory)["chain_id"] == 31337
    run=next(c for c in calls if c[0]=="run")
    assert "--pull=never" in run and run[run.index("--network")+1]=="none"
    assert "-p" not in run and "--publish" not in run and "--fork-url" not in run
    assert run[run.index("--accounts")+1]=="0" and d.IMAGE in run
    d.handle({"op":"start","lease":lease},directory)
    assert sum(c[0]=="run" for c in calls)==1
    request={"op":"prepare","lease":lease,"from":"0x"+"12"*20,"to":"0x"+"34"*20,"value_wei":"1","data":"0x"}
    prepared=d.handle(request,directory); assert prepared["gas_limit"]=="0x5208"
    raw="0x"+"56"*100
    sent=d.handle({"op":"submit","lease":lease,"raw":raw},directory)
    assert sent["hash"]=="0x"+"12"*32 and raw not in json.dumps(sent)
    assert raw not in json.dumps(calls) and ("eth_sendRawTransaction",[raw]) in rpcs
    def rejects(fn):
        try: fn()
        except (ValueError, KeyError): return
        raise AssertionError("unsafe request accepted")
    rejects(lambda:d.handle({**request,"rpc_url":"https://live.invalid"},directory))
    rejects(lambda:d.handle({**request,"to":"someone.eth"},directory))
    rejects(lambda:d.handle({**request,"data":"0x0"},directory))
    rejects(lambda:d.handle({"op":"status","lease":"00"*24},directory))
    for field,value in [("NetworkMode","bridge"),("Privileged",True),("PortBindings",{"8545/tcp":[{"HostPort":"8545"}]}),("LogConfig",{"Type":"json-file"})]:
        previous=copy.deepcopy(container["HostConfig"][field]); container["HostConfig"][field]=value
        rejects(lambda:d.handle({"op":"status","lease":lease},directory))
        container["HostConfig"][field]=previous
    container["State"]["StartedAt"]="fake-restart"
    rejects(lambda:d.handle({"op":"status","lease":lease},directory))
    container["State"]["StartedAt"]="fake-first-start"
    container["State"]["Running"]=False
    rejects(lambda:d.handle({"op":"start","lease":lease},directory))
    assert sum(c[0]=="run" for c in calls)==1
print("offline driver fake checks passed")
`;
  const output = execFileSync("python3", ["-", path], { input: script, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.match(output, /offline driver fake checks passed/);
});
