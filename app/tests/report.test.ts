import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
// The report module is plain .mjs (server side). We test its pure builders with
// hand-built findings shaped exactly like app/server/findings.mjs normalize():
// a forge proof carries balances/transfers/gas; an http proof carries an oracle
// and exchanges. No filesystem, no server.
// @ts-expect-error — plain .mjs module, no types
import { buildReport, buildReplayBundle, renderReportHtml, renderReportMarkdown, splitExplanation } from "../server/report.mjs"
// @ts-expect-error — plain .mjs module, no types
import { loadRecordedReplay } from "../server/replay-bundle.mjs"
// @ts-expect-error — plain .mjs module, no types
import { snapshotForgeReplay } from "../../spike/lib/replay-bundle.mjs"

// A proven forge finding, with a "Fix:" line in its explanation.
const forgeFinding = {
  id: "run-x.1",
  runId: "run-x",
  title: "Reentrancy drains the vault",
  severity: "critical",
  module: "Contracts",
  proofKind: "forge",
  target: "Vault.sol",
  stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
  hypothesis: "contract Vault { function withdraw() ... }",
  explanation:
    "Vault.withdraw() sends ETH before it zeroes the balance.\n\n" +
    "PoC (contract VaultTest): the attacker re-enters and drains the vault.\n\n" +
    "Fix: zero the balance before the external call, or add a reentrancy guard.",
  proof: {
    tool: "Foundry",
    test: "testReentrancyDrainsVault",
    contract: "VaultTest",
    gas: 246929,
    pass: true,
    transfers: [{ label: "attacker", address: "0xA", net: "+10 ETH", gained: true }],
    balances: [{ label: "Vault balance", before: "10 ETH", after: "0 ETH" }],
    assertions: ["assertEq(address(vault).balance, 0);"],
    testSource: "contract VaultTest is Test { ... }",
  },
  model: "ds",
  usage: { usd: 0.42 },
  ms: 1234,
}

describe("report: honesty", () => {
  test("extracts the fix only from a stated Fix label, never invents one", () => {
    const r = buildReport(forgeFinding)
    expect(r.fixStated).toBe(true)
    expect(r.fix).toContain("zero the balance before the external call")
    // The PoC/mechanism prose stays in the narrative; only the Fix line is the fix.
    expect(r.fix).not.toContain("re-enters and drains")
    expect(r.narrative).toContain("sends ETH before it zeroes")
  })

  test("a finding with no Fix label reports no fix, and says so", () => {
    const noFix = { ...forgeFinding, explanation: "Just a mechanism description, no remediation." }
    const r = buildReport(noFix)
    expect(r.fixStated).toBe(false)
    expect(r.fix).toBeNull()
    expect(renderReportMarkdown(r)).toContain("did not state a fix")
    expect(renderReportHtml(r)).toContain("does not invent one")
  })

  test("the harm is read from the proof's own numbers", () => {
    const r = buildReport(forgeFinding)
    const harm = r.harm.join(" ")
    expect(harm).toContain("Vault balance: 10 ETH → 0 ETH")
    expect(harm).toContain("246929")
    expect(harm).toContain("attacker gained +10 ETH")
  })

  test("an unproven finding is labelled not proven, never a finding", () => {
    const lead = { ...forgeFinding, stages: { ...forgeFinding.stages, proven: false } }
    const r = buildReport(lead)
    expect(r.proven).toBe(false)
    expect(r.status).toContain("Not proven")
    expect(renderReportHtml(r)).toContain("Not proven")
    expect(renderReportHtml(r)).not.toContain("Proven by replay")
  })
})

describe("report: http proof harm", () => {
  const httpFinding = {
    id: "run-h.1",
    runId: "run-h",
    title: "IDOR exposes another user's record",
    severity: "high",
    module: "Web",
    proofKind: "http",
    target: "app.example.com",
    stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
    explanation: "The endpoint does not check ownership.\n\nFix: check the record owner against the session.",
    proof: {
      kind: "http",
      pass: true,
      oracle: { name: "cross-tenant read", detail: "victim's email returned to the attacker token", passed: true },
      exchanges: [
        { label: "Request 1", request: { method: "GET", url: "/api/users/2" }, response: { status: 200 } },
      ],
      detail: "",
    },
    usage: { usd: null },
  }

  test("reads the oracle and the exchange, not a forge shape", () => {
    const r = buildReport(httpFinding)
    const harm = r.harm.join(" ")
    expect(harm).toContain("cross-tenant read")
    expect(harm).toContain("victim's email returned")
    expect(harm).toContain("1 request/response exchange")
    expect(harm).toContain("answered 200")
    expect(r.fixStated).toBe(true)
  })
})

describe("report: splitExplanation", () => {
  test("promotes a '## Fix' heading to the fix and keeps the rest as narrative", () => {
    const { fix, narrative } = splitExplanation("Mechanism paragraph.\n\n## Fix\n\nuse a guard.")
    expect(fix).toBe("use a guard.")
    expect(narrative).toBe("Mechanism paragraph.")
  })

  test("empty explanation yields no fix and empty narrative", () => {
    expect(splitExplanation("")).toEqual({ fix: null, narrative: "" })
    expect(splitExplanation(null)).toEqual({ fix: null, narrative: "" })
  })
})

describe("report: html is self-contained and safe", () => {
  test("one document, no external asset, html-escaped", () => {
    const evil = { ...forgeFinding, title: "<script>alert(1)</script> & \"bad\"" }
    const html = renderReportHtml(buildReport(evil))
    expect(html.startsWith("<!doctype html>")).toBe(true)
    // No remote asset: no external stylesheet or script src.
    expect(html).not.toMatch(/<link[^>]+href="https?:/i)
    expect(html).not.toMatch(/<script[^>]+src=/i)
    // The title is escaped, so no live script tag from finding text.
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })
})

describe("report: brand comes from the app's own files", () => {
  test("inlines the app's tokens, dark tokens as a media query, and the logo mark", () => {
    const { readFileSync } = require("node:fs")
    const tokens = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8")
    const html = renderReportHtml(buildReport(forgeFinding))
    // The same --background values the app uses, light and dark.
    for (const m of tokens.matchAll(/--background:\s*([^;]+);/g)) expect(html).toContain(`--background: ${m[1]};`)
    expect(html).toContain("@media (prefers-color-scheme: dark)")
    expect(html).not.toContain(".dark {")
    // The mark is inline SVG, and there is exactly one footer.
    expect(html).toContain('fill-rule="evenodd"')
    expect(html.match(/<footer/g)?.length).toBe(1)
  })
})

// A provider key and a bearer token planted in a fixture. Neither may survive
// into a bundle, under any filename.
const ALCHEMY_KEY = "pwc5rmJhrdoaSEfimoKEmsvOjKSmPDrP"
const BEARER = "super-secret-token-value"
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"

function unzip(buf: Buffer, dir: string) {
  const zip = path.join(dir, "bundle.zip")
  writeFileSync(zip, buf)
  execFileSync("unzip", ["-qo", zip, "-d", dir])
}

function readTree(dir: string) {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "bundle.zip") continue
      const abs = path.join(d, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else out.set(path.relative(dir, abs).split(path.sep).join("/"), readFileSync(abs, "utf8"))
    }
  }
  walk(dir)
  return out
}

function commands(readme: string) {
  return [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1].trim())
}

// The command under a README heading, e.g. "Replay (offline)".
function section(readme: string, heading: string) {
  const at = readme.indexOf(`## ${heading}\n`)
  if (at < 0) return null
  return commands(readme.slice(at))[0] ?? null
}

describe("report: replay bundle", () => {
  test("a forge snapshot zips the project, one replay command, and no secrets", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-ws-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      mkdirSync(path.join(ws, "lib", "forge-std", "src"), { recursive: true })
      mkdirSync(path.join(ws, "lib", "forge-std", "test"), { recursive: true })
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = ["lib"]\neth_rpc_url = "https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_KEY}"\nfork_block_number = 18000000\n\n[rpc_endpoints]\nmainnet = "https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_KEY}"\n`)
      writeFileSync(path.join(ws, "src", "Vault.sol"), `// Authorization: Bearer ${BEARER}\ncontract Vault {}\n`)
      writeFileSync(path.join(ws, "src", "Key.sol"), `// ${PEM}\ncontract Key {}\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest is Test { function testDrain() public {} }\n`)
      writeFileSync(path.join(ws, "lib", "forge-std", "src", "HasKey.sol"), `// https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_KEY}\ncontract HasKey { uint256 privateKey = uint256(1); }\n`)
      writeFileSync(path.join(ws, "lib", "forge-std", "test", "Leak.t.sol"), `// ${ALCHEMY_KEY}\ncontract Leak {}\n`)
      const replay = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      const zip = buildReplayBundle({
        finding: { title: "Reentrancy drains the vault", proofKind: "forge", proof: { kind: "forge", pass: true, test: "testDrain()" } },
        recorded: { replay, proof: { kind: "forge", pass: true, test: "testDrain()" } },
      })
      expect(Buffer.isBuffer(zip)).toBe(true)
      expect(zip.subarray(0, 2).toString()).toBe("PK")
      expect(zip.includes(ALCHEMY_KEY)).toBe(false)
      expect(zip.includes(BEARER)).toBe(false)
      expect(zip.includes("BEGIN PRIVATE KEY")).toBe(false)

      const dir = mkdtempSync(path.join(tmpdir(), "replay-zip-"))
      try {
        unzip(zip, dir)
        const files = readTree(dir)
        expect(files.has("src/Vault.sol")).toBe(true)
        expect(files.has("test/AgentPoc.t.sol")).toBe(true)
        expect(files.has("foundry.toml")).toBe(true)
        expect(files.has("lib/forge-std/src/HasKey.sol")).toBe(true)
        expect(files.get("lib/forge-std/src/HasKey.sol")).toContain("uint256 privateKey = uint256(1)")
        expect(files.has("lib/forge-std/test/Leak.t.sol")).toBe(false)
        expect(files.has("src/Key.sol")).toBe(false)
        expect(files.get("foundry.toml")).toContain('"${RPC_URL}"')
        expect(files.get("foundry.toml")).not.toContain(ALCHEMY_KEY)
        expect(files.get("src/Vault.sol")).toContain("${BEARER_TOKEN}")
        const fork = JSON.parse(files.get("fork.json") || "")
        expect(fork).toEqual({ rpc: "${RPC_URL}", block: 18000000, forked: true })
        const readme = files.get("README.md") || ""
        const cmd = section(readme, "Replay (offline)") || ""
        const prepare = section(readme, "Prepare (once, online)") || ""
        expect(commands(readme)).toEqual([prepare, cmd])
        // A fork keeps the network for the RPC, and nothing else is fetched.
        expect(cmd).toContain("docker run --rm --pull never -e RPC_URL ")
        expect(cmd).not.toContain("--network none")
        expect(cmd).toMatch(/ ghcr\.io\/foundry-rs\/foundry@sha256:[a-f0-9]{64} /)
        expect(cmd).not.toContain(":latest")
        expect(cmd).toContain("'forge test --offline --use 0.8.38 ")
        expect(cmd).toContain('--fork-url "$RPC_URL"')
        expect(cmd).toContain("--fork-block-number 18000000")
        expect(cmd).toContain("--match-contract PocTest")
        expect(cmd).toContain("--match-test testDrain")
        expect(cmd).not.toContain(ALCHEMY_KEY)
        expect(prepare).toContain("forge build --use 0.8.38")
        const proof = JSON.parse(files.get("proof.json") || "")
        expect(proof.replay.command).toBe(cmd)
        expect(proof.replay.prepare).toBe(prepare)
        expect(JSON.stringify(proof)).not.toContain(ALCHEMY_KEY)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("a finding recorded before snapshots says the proof cannot be rerun", () => {
    const zip = buildReplayBundle({ finding: forgeFinding })
    const dir = mkdtempSync(path.join(tmpdir(), "replay-old-"))
    try {
      unzip(zip, dir)
      const files = readTree(dir)
      expect(files.get("test/AgentPoc.t.sol")).toContain("contract VaultTest")
      expect(files.has("foundry.toml")).toBe(false)
      const readme = files.get("README.md") || ""
      expect(commands(readme)).toHaveLength(0)
      expect(readme).toContain("no command")
      const fork = JSON.parse(files.get("fork.json") || "")
      expect(fork.rpc).toBe("${RPC_URL}")
      expect(fork.block).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an http bundle keeps the script and says the lab cannot be bundled", () => {
    const script = `const r = await request("GET", "/api/users/2", { headers: { authorization: "Bearer ${BEARER}" } });\n`
    const proof = {
      kind: "http",
      status: "pass",
      oracle: { name: "cross-tenant read", detail: `returned Bearer ${BEARER}`, passed: true },
      log: [{ label: "1", request: { method: "GET", url: "/api/users/2", headers: { authorization: `Bearer ${BEARER}` } }, response: { status: 200, body: "ok" } }],
    }
    const zip = buildReplayBundle({
      finding: { title: "IDOR", proofKind: "http", script, proof },
      recorded: { script, proof },
    })
    expect(zip.includes(BEARER)).toBe(false)
    const dir = mkdtempSync(path.join(tmpdir(), "replay-http-"))
    try {
      unzip(zip, dir)
      const files = readTree(dir)
      const readme = files.get("README.md") || ""
      expect(commands(readme)).toHaveLength(0)
      expect(readme).toContain("What cannot be bundled")
      expect(readme).toContain("no command")
      expect(files.get("script.mjs")).toContain("${BEARER_TOKEN}")
      expect(files.get("script.mjs")).not.toContain(BEARER)
      expect(files.get("transcript.json")).not.toContain(BEARER)
      expect(files.get("proof.json")).not.toContain(BEARER)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("loadRecordedReplay reads the snapshot off the raw run, not the normalized view", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-runs-"))
    const prev = process.env.TOUCHSTONE_RESULTS_DIR
    process.env.TOUCHSTONE_RESULTS_DIR = dir
    try {
      const replay = { version: 1, kind: "forge", files: [{ path: "foundry.toml", text: "[profile.default]\n" }], command: "docker run example", fork: { rpc: "${RPC_URL}", block: 5, forked: true } }
      writeFileSync(path.join(dir, "run-demo-1.json"), JSON.stringify({
        result: { findings: [{ title: "one", script: "await request()", proof: { kind: "http", replay } }, { title: "two", proof: { kind: "forge" } }] },
      }))
      const first = loadRecordedReplay("demo-1.1")
      expect(first.replay.command).toBe("docker run example")
      expect(first.script).toBe("await request()")
      const second = loadRecordedReplay("demo-1.2")
      expect(second.proof.kind).toBe("forge")
      expect(second.replay).toBeNull()
      expect(loadRecordedReplay("../demo-1")).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.TOUCHSTONE_RESULTS_DIR
      else process.env.TOUCHSTONE_RESULTS_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The real vault lab, snapshotted by proveFindings, then rerun from the zip
  // with the README command, offline. Opt in with TOUCHSTONE_DOCKER_TESTS=1.
  // It needs the Foundry image and solc 0.8.38 in the foundry-svm volume
  // already; it never pulls and never fetches solc. The shared volume is only
  // read: the replay gets a private copy, removed at the end.
  const forgeReady = (() => {
    if (process.env.TOUCHSTONE_DOCKER_TESTS !== "1") return false
    try {
      execFileSync("docker", ["image", "inspect", "ghcr.io/foundry-rs/foundry:latest"], { stdio: "ignore" })
      execFileSync("docker", [
        "run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "sh",
        "-v", "foundry-svm:/svm:ro", "ghcr.io/foundry-rs/foundry:latest", "-c", "test -x /svm/0.8.38/solc-0.8.38",
      ], { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  })()
  ;(forgeReady ? test : test.skip)("proveFindings snapshot reruns offline with the README command", async () => {
    const { makeWorkspace } = await import("../../spike/lib/sandbox.mjs")
    const { proveFindings } = await import("../../spike/lib/record.mjs")
    // @ts-expect-error — plain .mjs module, no types
    const { REPLAY_SVM_VOLUME } = await import("../../spike/lib/replay-bundle.mjs")
    const volume = `touchstone-replay-test-${process.pid}`
    execFileSync("docker", ["volume", "create", volume], { stdio: "ignore" })
    execFileSync("docker", [
      "run", "--rm", "--pull", "never", "--network", "none", "-u", "0", "--entrypoint", "sh",
      "-v", "foundry-svm:/from:ro", "-v", `${volume}:/svm`,
      "ghcr.io/foundry-rs/foundry:latest", "-c", "cp -a /from/0.8.38 /svm/ && chown -R 1000:1000 /svm",
    ], { stdio: "ignore" })
    const lab = new URL("../../lab/vault-reentrancy/", import.meta.url).pathname
    const source = readFileSync(new URL("../../lab/vault-reentrancy/oracle/VaultExploit.t.sol", import.meta.url), "utf8")
    const ws = makeWorkspace(lab)
    const dir = mkdtempSync(path.join(tmpdir(), "replay-e2e-"))
    try {
      const [f] = await proveFindings(
        ws,
        [{ title: "reentrancy drains the vault", severity: "critical", poc: "VaultExploitTest", explanation: "drain", source }],
        [{ ev: "run_poc-done", passed: true, contract: "VaultExploitTest" }],
      )
      expect(f.pocProved).toBe(true)
      expect(f.proof.replay.files.some((file: { path: string }) => file.path === "src/Vault.sol")).toBe(true)
      expect(f.proof.replay.files.some((file: { path: string }) => file.path === "foundry.toml")).toBe(true)
      expect(f.proof.replay.files.some((file: { path: string }) => file.path === "test/AgentPoc.t.sol")).toBe(true)
      const zip = buildReplayBundle({
        finding: { title: f.title, proofKind: "forge", proof: f.proof },
        recorded: { proof: f.proof, replay: f.proof.replay },
      })
      // Sample keys baked into forge-std. They must not ride along in the zip.
      for (const secret of [ALCHEMY_KEY, "b9794ad1ddf84dfb8c34d6bb5dca2001", "WV407BEiBmjNJfKo9Uo_55u0z0ITyCOX"]) {
        expect(zip.includes(secret)).toBe(false)
      }
      unzip(zip, dir)
      const readme = readFileSync(path.join(dir, "README.md"), "utf8")
      const cmd = section(readme, "Replay (offline)") || ""
      expect(cmd.startsWith("docker run --rm --pull never --network none ")).toBe(true)
      expect(cmd).toMatch(/ ghcr\.io\/foundry-rs\/foundry@sha256:[a-f0-9]{64} /)
      expect(cmd).toContain("'forge test --offline --use 0.8.38 ")
      expect(cmd).toContain("--match-contract VaultExploitTest")
      expect(cmd).toContain("--match-test test_reentrancy_drains_vault")
      expect(cmd).not.toContain("--fork-url")
      expect(cmd).toContain(`-v ${REPLAY_SVM_VOLUME}:/home/foundry/.svm `)
      const run = cmd.replace(`-v ${REPLAY_SVM_VOLUME}:`, `-v ${volume}:`)
      let out = ""
      try {
        out = execFileSync("bash", ["-c", run], {
          cwd: dir,
          encoding: "utf8",
          timeout: 300_000,
          maxBuffer: 16 * 1024 * 1024,
        })
      } catch (err) {
        const failed = err as { stdout?: string; stderr?: string; message?: string }
        throw new Error(`replay command failed\n${cmd}\n${failed.stdout || ""}\n${failed.stderr || ""}\n${failed.message || ""}`)
      }
      expect(out).toContain("[PASS] test_reentrancy_drains_vault")
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
      execFileSync("docker", ["volume", "rm", "-f", volume], { stdio: "ignore" })
    }
  }, 600_000)
})
