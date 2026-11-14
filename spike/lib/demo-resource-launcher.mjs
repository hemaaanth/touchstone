// Separate from the library: workers import that library through sandbox.mjs.
import { closeSync, readFile } from "node:fs";
import { pathToFileURL } from "node:url";
import { demoLaunchAllowed, runRegisteredForge } from "./demo-resources.mjs";

try {
  const [mode, serialized, ...args] = process.argv.slice(2);
  const context = JSON.parse(serialized);
  const timer = setTimeout(() => process.exit(1), 5000);
  const gate = await new Promise((resolve, reject) => readFile(3, (error, bytes) => error ? reject(error) : resolve(bytes.toString())));
  closeSync(3); clearTimeout(timer);
  if (gate !== "go" || !demoLaunchAllowed(context, mode === "worker" ? "worker" : args[0])) throw Error("Launch refused");
  if (mode === "worker") {
    process.argv = [process.execPath, args[0], ...JSON.parse(args[1])];
    await import(pathToFileURL(args[0]).href);
  } else if (mode === "forge") {
    const result = await runRegisteredForge(context, args[0], JSON.parse(args[1]), Number(args[2]), Number(args[3]));
    process.stdout.write(JSON.stringify(result));
  } else throw Error("Launch refused");
} catch {
  process.stderr.write("Demo execution could not be completed safely.\n");
  process.exitCode = 1;
}
