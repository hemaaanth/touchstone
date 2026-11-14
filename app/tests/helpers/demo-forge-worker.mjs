import "../../../spike/test/helpers/isolated-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
const remote = "data:text/javascript," + encodeURIComponent("export const SOLC_VERSION='0.8.38';export const daytonaOn=()=>false;export const closeRun=async()=>{};export const remoteDocker=()=>{throw Error('Remote execution forbidden')};");
const hooks = registerHooks({ resolve(spec, ctx, next) { return spec === "./daytona.mjs" && ctx.parentURL?.endsWith("/spike/lib/sandbox.mjs") ? { url: remote, shortCircuit: true } : next(spec, ctx); } });
const { forgeTest, forgeTestJson, warmSolc } = await import("../../../spike/lib/sandbox.mjs");
hooks.deregister();
// Use the actual engine's stop setup without importing model/roam dependencies.
const source = readFileSync(new URL("../../../spike/agent-run.mjs", import.meta.url), "utf8");
const start = source.indexOf("  let opened, completed = false;", source.indexOf("async function child("));
const end = source.indexOf("  try {\n    const state = auditState", start);
if (start < 0 || end <= start) throw Error("Engine stop setup not found");
const [method, workspace, result] = process.argv.slice(2);
process.env.TOUCHSTONE_PARENT_PIPE = method === "pipe" ? "1" : "0";
Function("disposeAsks", source.slice(start, end))(() => {});
globalThis.fetch = () => { throw Error("Network forbidden"); };
const output = method === "warm" ? await warmSolc("0.8.38") : method === "json" ? await forgeTestJson(workspace, { timeoutMs: 1500 }) : await forgeTest(workspace, { timeoutMs: 1500 });
writeFileSync(result, JSON.stringify(output));
