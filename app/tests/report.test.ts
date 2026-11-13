import "./helpers/isolated-env"
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { linkSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
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
import { bundleRefusal, bundleText, evidenceReplay, leakShapes, loadReplayFiles, NOT_PROVEN_REFUSAL, planReplayBundle, provenDate, replayStoreDir, snapshotForgeReplay, storeReplayFiles, vendoredLibs } from "../../spike/lib/replay-bundle.mjs"
// Resolved from spike/node_modules (the app does not depend on ethers); ethers ships its own types.
import { Mnemonic } from "../../spike/node_modules/ethers/lib.esm/index.js"

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
  test("a forge bundle ships the proof source, hashes and the re-run command, claims no re-run without a verdict, holds no secret", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-ws-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      mkdirSync(path.join(ws, "lib", "forge-std", "src"), { recursive: true })
      mkdirSync(path.join(ws, "lib", "forge-std", "test"), { recursive: true })
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = ["lib"]\neth_rpc_url = "https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_KEY}"\nfork_block_number = 18000000\n\n[rpc_endpoints]\nmainnet = "https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_KEY}"\n`)
      writeFileSync(path.join(ws, "src", "Vault.sol"), `// Authorization: Bearer ${BEARER}\ncontract Vault {}\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest is Test { function testDrain() public {} }\n`)
      writeFileSync(path.join(ws, "lib", "forge-std", "src", "HasKey.sol"), `// https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_KEY}\ncontract HasKey { uint256 privateKey = uint256(1); }\n`)
      writeFileSync(path.join(ws, "lib", "forge-std", "test", "Leak.t.sol"), `// ${ALCHEMY_KEY}\ncontract Leak {}\n`)
      const replay = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      // The record stores no forge command.
      expect(replay.command).toBeUndefined()
      expect(JSON.stringify(replay)).not.toContain("forge test")
      const zip = buildReplayBundle({
        finding: { stages: { proven: true }, title: "Reentrancy drains the vault", at: Date.UTC(2026, 0, 15), proofKind: "forge", proof: { kind: "forge", pass: true, test: "testDrain()", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "7" } } },
        recorded: { replay, proof: { kind: "forge", pass: true, test: "testDrain()", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "7" } } },
      })
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
        expect(files.has("lib/forge-std/test/Leak.t.sol")).toBe(false)
        expect(files.get("foundry.toml")).toContain('"${RPC_URL}"')
        expect(files.get("foundry.toml")).not.toContain(ALCHEMY_KEY)
        expect(files.get("src/Vault.sol")).toContain("// Authorization: Bearer [REDACTED]\n")
        const fork = JSON.parse(files.get("fork.json") || "")
        expect(fork).toEqual({ rpc: "${RPC_URL}", block: 18000000, forked: true })
        // No stored re-run verdict (an old-shaped record): no command at all.
        const readme = files.get("README.md") || ""
        expect(commands(readme)).toEqual([])
        expect(readme).not.toContain("forge test")
        expect(files.has("check-harm.mjs")).toBe(false)
        expect(files.has("harm.json")).toBe(false)
        expect(readme.split("\n")[0]).toBe("PROVEN: Touchstone proved this finding by its own replay on 2026-01-15 (harm: an ETH drain). This folder holds the proof's source files for reading; it has no re-run command.")
        // The hashes of every shipped file, and nothing about a command in proof.json.
        const sums = files.get("SHA256SUMS") || ""
        expect(sums).toContain("  test/AgentPoc.t.sol\n")
        expect(sums).not.toContain("README.md")
        execFileSync("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: dir, stdio: "ignore" })
        const proof = JSON.parse(files.get("proof.json") || "")
        expect(proof.replay.command).toBeUndefined()
        expect(proof.replay.prepare).toBeUndefined()
        expect(JSON.stringify(proof)).not.toContain(ALCHEMY_KEY)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("a forge bundle masks every shape the redactor knows and leaves out the ones it cannot mask", () => {
    // Made-up values. Each one must stay out of the record and the zip.
    const V = {
      alchemy: "Kd83nWq2Lx9Pz4Rt7Ys1Mv6Bc0Hj5Fg",
      infura: "7c1e9a4f2b8d6e3a0c5f9b2d7e4a1c8f",
      ankr: "5b7d9f1a3c5e7092b4d6f8a0c2e4f6a8b0d2f4a6c8e0a2c4e6f8a0b2d4f6a8c0",
      quiknode: "4e8a2c6f0b3d7e1a5c9f2b6d0e4a8c3f7b1d5e9a",
      etherscanTop: "ETHSCAN7Q2W9E4R6T1Y8U3I5O0PZ",
      etherscanKey: "QWERT9YUIOP2ASDFG7HJKL4ZXCV3BNM",
      cookie: "Zp4Lk8Qw2Mx7Vn3Rb9Tc",
      consoleToken: "Cn5Hq8Wr3Zk1Lp7Ty2Mv",
      apiKey: "Ap9Kx3Lm7Qr2Tv8Wz4Yb",
      awsQuoted: "Hq7Lm2Xp9Rt4Vw8Zb3Nc6Kd1Fg5Jy0Ts/Ua+Pe2W",
      awsBare: "Rb3Nc6Kd1Fg5Jy0Ts/Ua+Pe2Hq7Lm2Xp9Rt4Vw8Q",
      privateKey: "0x" + "9c4f1a7e3b8d2f6a0c5e9b1d7f3a8c2e6b0d4f9a1c7e3b5d8f2a6c0e4b9d1f7a",
      phrase: "orbit lemon cradle vivid tunnel amber frost gravel nephew silent wagon plume",
      user: "/home/alice",
    }
    expect(V.awsQuoted).toHaveLength(40)
    expect(V.awsBare).toHaveLength(40)
    const ws = mkdtempSync(path.join(tmpdir(), "replay-shapes-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\ntest = "test"\netherscan_api_key = "${V.etherscanTop}"\n\n[etherscan]\nmainnet = { key = "${V.etherscanKey}", url = "https://api.etherscan.io/api" }\n`)
      writeFileSync(path.join(ws, "src", "Chains.sol"), [
        `// built in ${V.user}/work/vault`,
        "contract Chains {",
        `  string a = "https://eth-mainnet.g.alchemy.com/v2/${V.alchemy}";`,
        `  string b = "https://mainnet.infura.io/v3/${V.infura}";`,
        `  string c = "https://rpc.ankr.com/eth/${V.ankr}";`,
        `  string d = "https://young-wild-sun.quiknode.pro/${V.quiknode}/";`,
        `  // Cookie: session=${V.cookie}`,
        `  // X-Console-Token: ${V.consoleToken}`,
        `  string apiKey = "${V.apiKey}";`,
        `  string aws_secret_access_key = "${V.awsQuoted}";`,
        "}",
        "",
      ].join("\n"))
      // The redactor masks `PRIVATE_KEY = 0x…`; it keeps a short name like `pk`.
      writeFileSync(path.join(ws, "src", "Deploy.sol"), `contract Deploy { uint256 pk = ${V.privateKey}; }\n`)
      writeFileSync(path.join(ws, "src", "Ops.sol"), `// aws ${V.awsBare}\ncontract Ops {}\n`)
      writeFileSync(path.join(ws, "src", "Words.sol"), `contract Words { string constant words = "${V.phrase}"; }\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest is Test { function testDrain() public {} }\n`)
      const replay = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      const record = JSON.stringify(replay)
      for (const [name, v] of Object.entries(V)) expect([name, record.includes(v)]).toEqual([name, false])
      expect(replay.omitted).toEqual([
        { path: "src/Deploy.sol", reason: "holds a 64-hex key the redactor cannot mask" },
        { path: "src/Ops.sol", reason: "holds an AWS secret key the redactor cannot mask" },
        { path: "src/Words.sol", reason: "holds a mnemonic the redactor cannot mask" },
      ])
      const chains = replay.files.find((f: { path: string }) => f.path === "src/Chains.sol").text
      expect(chains).toContain("// built in ~/work/vault\n")
      expect(chains).toContain('"https://eth-mainnet.g.alchemy.com/v2/${RPC_URL_KEY}"')
      expect(chains).toContain('"https://mainnet.infura.io/v3/${RPC_URL_KEY}"')
      expect(chains).toContain('"https://rpc.ankr.com/eth/${RPC_URL_KEY}"')
      expect(chains).toContain('"https://young-wild-sun.quiknode.pro/${RPC_URL_KEY}/"')
      expect(chains).toContain("// Cookie: session=[REDACTED]\n")
      expect(chains).toContain("// X-Console-Token: [REDACTED]\n")
      expect(chains).toContain('string apiKey = "[REDACTED]";')
      expect(chains).toContain('string aws_secret_access_key = "[REDACTED]";')
      const toml = replay.files.find((f: { path: string }) => f.path === "foundry.toml").text
      expect(toml).toContain('etherscan_api_key = "${ETHERSCAN_API_KEY}"')
      expect(toml).toContain('mainnet = { key = "${ETHERSCAN_API_KEY}", url = "https://api.etherscan.io/api" }')

      // A record written by an older scrubber still holds raw text. The bundle
      // redacts and checks it again, so the zip gets today's rules.
      const old = {
        ...replay,
        omitted: [],
        files: [
          ...replay.files,
          { path: "src/OldChains.sol", text: `contract OldChains { string a = "https://eth-mainnet.g.alchemy.com/v2/${V.alchemy}"; }\n` },
          { path: "src/OldDeploy.sol", text: `contract OldDeploy { uint256 pk = ${V.privateKey}; }\n` },
        ],
      }
      const zip = buildReplayBundle({
        finding: { stages: { proven: true }, title: "Reentrancy drains the vault", proofKind: "forge", proof: { kind: "forge", pass: true, test: "testDrain()" } },
        recorded: { replay: old, proof: { kind: "forge", pass: true, test: "testDrain()" } },
      })
      for (const [name, v] of Object.entries(V)) expect([name, zip.includes(v)]).toEqual([name, false])
      const dir = mkdtempSync(path.join(tmpdir(), "replay-shapes-zip-"))
      try {
        unzip(zip, dir)
        const files = readTree(dir)
        expect(files.get("src/OldChains.sol")).toContain("/v2/${RPC_URL_KEY}")
        expect(files.has("src/OldDeploy.sol")).toBe(false)
        expect(files.get("README.md")).toContain("- `src/OldDeploy.sol` — holds a 64-hex key the redactor cannot mask")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("vendored forge-std ships byte for byte, the record keeps its hash, and no file in the zip is the cap mark", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { makeWorkspace } = await import("../../spike/lib/sandbox.mjs")
    const lab = new URL("../../lab/vault-reentrancy/", import.meta.url).pathname
    const ws = makeWorkspace(lab)
    const store = mkdtempSync(path.join(tmpdir(), "replay-vendored-store-"))
    const dir = mkdtempSync(path.join(tmpdir(), "replay-vendored-zip-"))
    try {
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), readFileSync(path.join(lab, "oracle", "VaultExploit.t.sol"), "utf8"))
      const snap = snapshotForgeReplay(ws, { contract: "VaultExploitTest", test: "test_reentrancy_drains_vault()" })
      expect(vendoredLibs()).toEqual(["chimera", "forge-std"])
      expect(JSON.stringify(snap).includes("too long to check")).toBe(false)
      expect(snap.omitted).toEqual([])
      const big = ["lib/forge-std/src/Vm.sol", "lib/forge-std/src/console.sol", "lib/forge-std/src/safeconsole.sol"]
      for (const rel of big) {
        const f = snap.files.find((x: { path: string }) => x.path === rel)
        const bytes = readFileSync(path.join(lab, rel))
        expect(bytes.length > 64 * 1024).toBe(true)
        expect(f.text).toBeUndefined()
        expect(f.vendored).toEqual({ lib: "forge-std", sha256: createHash("sha256").update(bytes).digest("hex") })
      }
      // The store keeps a vendored file by hash, and its bytes once, under lib/.
      const kept = storeReplayFiles(snap, store)
      const body = readFileSync(path.join(store, `${kept.store.sha256}.json`), "utf8")
      expect(body.includes("contract Vm") || body.includes("interface Vm")).toBe(false)
      expect(kept.store.bytes < 64 * 1024).toBe(true)
      const vm = snap.files.find((x: { path: string }) => x.path === "lib/forge-std/src/Vm.sol").vendored.sha256
      expect(readFileSync(path.join(store, "lib", vm))).toEqual(readFileSync(path.join(lab, "lib/forge-std/src/Vm.sol")))
      const loaded = loadReplayFiles(kept, store)
      const proof = { kind: "forge", pass: true, test: "test_reentrancy_drains_vault()", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "1" } }
      unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "drain", proofKind: "forge", proof }, recorded: { replay: loaded, proof } }), dir)
      const files = readTree(dir)
      for (const rel of big) expect(files.get(rel)).toBe(readFileSync(path.join(lab, rel), "utf8"))
      for (const [name, text] of files) expect([name, /\[REDACTED: text of \d+ characters too long to check\]/.test(text)]).toEqual([name, false])
      const readme = files.get("README.md") || ""
      expect(readme).toContain("Vendored library files (`lib/forge-std`) are included unchanged")
      expect(readme.split("\n")[0].startsWith("PROVEN: Touchstone proved this finding by its own replay")).toBe(true)
      // The bundle carries the re-run command, marked not re-run-checked; no claim ever.
      expect(commands(readme).length).toBeGreaterThanOrEqual(1)
      expect(readme).not.toContain("RE-RUN CHECKED")
      expect(readme).toContain("not re-run-checked")
      expect(files.get("SHA256SUMS")).toContain("  lib/forge-std/src/safeconsole.sol\n")
      execFileSync("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: dir, stdio: "ignore" })
      // The store's copy is the source; with it gone the engine's copy serves.
      rmSync(path.join(store, "lib"), { recursive: true, force: true })
      expect(loadReplayFiles(kept, store).files.find((f: { path: string }) => f.path === "lib/forge-std/src/Vm.sol").text).toBe(files.get("lib/forge-std/src/Vm.sol"))
      // A vendored hash that neither the store nor the engine holds: left out, named.
      const stale = { ...loaded, files: loaded.files.map((f: { path: string; vendored?: unknown }) => (f.path === "lib/forge-std/src/Vm.sol" ? { path: f.path, vendored: { lib: "forge-std", sha256: "0".repeat(64) } } : f)) }
      const out = mkdtempSync(path.join(tmpdir(), "replay-vendored-stale-"))
      try {
        unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "drain", proofKind: "forge", proof }, recorded: { replay: stale, proof } }), out)
        const r = readTree(out)
        expect(r.has("lib/forge-std/src/Vm.sol")).toBe(false)
        expect(r.get("README.md")).toContain("- `lib/forge-std/src/Vm.sol` — a forge-std file that neither the record nor the engine holds any more")
      } finally {
        rmSync(out, { recursive: true, force: true })
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(store, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a record's vendored flag is checked against the engine's index; a forged one is redacted like any file", () => {
    // Made up. A forged record marks a secret-holding file as vendored, with its own hash.
    const secret = "Zq7Xv9KpR2mN4tW8yB3cL6Hd"
    const text = `// X-Api-Key: ${secret}\ncontract Evil {}\n`
    const sha256 = createHash("sha256").update(text).digest("hex")
    const replay = {
      version: 1, kind: "forge", contract: "PocTest", test: "testDrain",
      files: [
        { path: "foundry.toml", text: "[profile.default]\n" },
        { path: "src/Evil.sol", text, vendored: { lib: "forge-std", sha256 } },
        { path: "lib/forge-std/src/Evil.sol", text, vendored: { lib: "forge-std", sha256 } },
        { path: "test/AgentPoc.t.sol", text: "contract PocTest {}\n" },
      ],
      omitted: [],
    }
    const proof = { kind: "forge", pass: true, test: "testDrain()" }
    const zip = buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay, proof } })
    expect(zip.includes(secret)).toBe(false)
    const dir = mkdtempSync(path.join(tmpdir(), "replay-forged-"))
    try {
      unzip(zip, dir)
      const files = readTree(dir)
      expect(files.get("src/Evil.sol")).toContain("// X-Api-Key: [REDACTED]")
      expect(files.get("lib/forge-std/src/Evil.sol")).toContain("// X-Api-Key: [REDACTED]")
      expect(files.get("README.md")).not.toContain("Vendored library files")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a library file whose bytes differ from the engine's copy is not vendored, and is redacted", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { makeWorkspace } = await import("../../spike/lib/sandbox.mjs")
    const lab = new URL("../../lab/vault-reentrancy/", import.meta.url).pathname
    const ws = makeWorkspace(lab)
    try {
      // Made up.
      const bearer = "Zq7Xv9KpR2mN4tW8yB3cL6Hd"
      const f = path.join(ws, "lib/forge-std/src/StdChains.sol")
      writeFileSync(f, `// Authorization: Bearer ${bearer}\n${readFileSync(f, "utf8")}`)
      const snap = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      const chains = snap.files.find((x: { path: string }) => x.path === "lib/forge-std/src/StdChains.sol")
      expect(chains.vendored).toBeUndefined()
      expect(chains.text).toContain("// Authorization: Bearer [REDACTED]\n")
      expect(JSON.stringify(snap).includes(bearer)).toBe(false)
      // The untouched files of the same library are still vendored.
      expect(snap.files.find((x: { path: string }) => x.path === "lib/forge-std/src/Vm.sol").vendored.lib).toBe("forge-std")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("the bundle ships an allow-list of sources and config, not a data file or a secret file", () => {
    // No forge run here, so snapshot falls back to every .sol under the workspace
    // (still sources only) plus foundry.toml / remappings.txt. A data file and
    // every secret-shaped file the reviewer tried are left out, by name or body.
    const ws = mkdtempSync(path.join(tmpdir(), "replay-allow-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "src", "keys"))
      mkdirSync(path.join(ws, "src", "keystore"))
      mkdirSync(path.join(ws, "test"))
      mkdirSync(path.join(ws, "out"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", "Vault.sol"), "contract Vault {}\n")
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), "contract PocTest {}\n")
      // Not shipped: a data artifact (not a source) and the reviewer's secret files.
      writeFileSync(path.join(ws, "src", "Thing.json"), JSON.stringify({ bytecode: "0x60" }))
      writeFileSync(path.join(ws, "src", "BytecodeVault.runtime.hex"), "0x6080\n")
      writeFileSync(path.join(ws, "src", "keys", "deployer.key"), "0x" + "ab".repeat(32) + "\n")
      writeFileSync(path.join(ws, "src", "keystore", "UTC--2024-01-01--addr.json"), JSON.stringify({ crypto: { ciphertext: "deadbeef", kdfparams: {} }, mac: "x" }))
      writeFileSync(path.join(ws, "src", "password.txt"), "Tr0ub4dor-x9-FAKE\n")
      writeFileSync(path.join(ws, "src", "bare.txt"), "0x" + "cd".repeat(32) + "\n")
      writeFileSync(path.join(ws, "out", "ignore.json"), "{}\n")
      const snap = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      const shipped = snap.files.map((f: { path: string }) => f.path).sort()
      expect(shipped).toEqual(["foundry.toml", "src/Vault.sol", "test/AgentPoc.t.sol"])
      // The data files and secret files are simply not sources (not candidates),
      // so no secret-shaped value is in the record at all.
      const record = JSON.stringify(snap)
      for (const v of ["deployer.key", "ciphertext", "Tr0ub4dor", "cd".repeat(32), "6080", "ignore.json"]) expect([v, record.includes(v)]).toEqual([v, false])
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("an 83 KB JSON holding eight token shapes never ships (it is not a source) and none of its values reach the zip", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-m1-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", "Vault.sol"), "contract Vault {}\n")
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), "contract PocTest {}\n")
      const secrets = [
        "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.AbCdEfGhIjKlMnOpQrStUvWxYz012345",
        "sk_live_" + "A".repeat(24),
        "xoxb-" + "1".repeat(20),
        "glpat-" + "B".repeat(20),
        "npm_" + "c".repeat(36),
        "sk-" + "D".repeat(32),
        "tk_alice_9f1c4a2e",
        "Bearer " + "E".repeat(40),
      ]
      // One minified JSON over 64 KB with the eight values inside padding.
      const big = JSON.stringify({ pad: "q".repeat(83 * 1024), meta: { notes: secrets } })
      writeFileSync(path.join(ws, "src", "Thing.json"), big)
      const snap = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      expect(snap.files.map((f: { path: string }) => f.path)).not.toContain("src/Thing.json")
      const proof = { kind: "forge", pass: true, test: "testDrain()" }
      const zip = buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay: snap, proof } })
      for (const v of secrets) expect([v.slice(0, 10), zip.includes(v)]).toEqual([v.slice(0, 10), false])
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("a .sol candidate that is a hard link, outside the workspace, or over the per-file size cap is left out", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-guard-"))
    const outside = mkdtempSync(path.join(tmpdir(), "replay-guard-out-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", "Vault.sol"), "contract Vault {}\n")
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), "contract PocTest {}\n")
      // A hard link to a file outside the workspace: left out (nlink > 1).
      writeFileSync(path.join(outside, "secret.sol"), "// " + "0x" + "ef".repeat(32) + "\n")
      linkSync(path.join(outside, "secret.sol"), path.join(ws, "src", "Linked.sol"))
      const snap = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      expect(snap.files.map((f: { path: string }) => f.path)).not.toContain("src/Linked.sol")
      expect(snap.omitted.find((o: { path: string }) => o.path === "src/Linked.sol")?.reason).toBe("a hard link")
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("past the file-count cap the bundle is incomplete and makes no re-run claim", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-count-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), "contract PocTest {}\n")
      // 5001 tiny .sol files, over the 5000 cap. (No real read happens past the cap.)
      for (let i = 0; i < 5001; i++) writeFileSync(path.join(ws, "src", `C${i}.sol`), "// x\n")
      const snap = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      expect(snap.files.length).toBe(0)
      expect(snap.omitted.some((o: { reason: string }) => /over the 5000 cap/.test(o.reason))).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("a source file over the redactor's cap, or one left out for a secret, is dropped and named, never shipped", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-overcap-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", "Big.sol"), `contract Big {\n${"  uint256 public a;\n".repeat(4000)}}\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest is Test { function testDrain() public {} }\n`)
      const snap = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      expect(snap.omitted).toEqual([{ path: "src/Big.sol", reason: "over 64 KB, so the redactor cannot check it" }])
      const proof = { kind: "forge", pass: true, test: "testDrain()", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "1" } }
      const readmeOf = (replay: unknown) => {
        const d = mkdtempSync(path.join(tmpdir(), "replay-overcap-zip-"))
        try {
          unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay, proof } }), d)
          const files = readTree(d)
          for (const [name, text] of files) expect([name, text.includes("too long to check")]).toEqual([name, false])
          expect(files.has("src/Big.sol")).toBe(false)
          return files.get("README.md") || ""
        } finally {
          rmSync(d, { recursive: true, force: true })
        }
      }
      expect(readmeOf(snap)).toContain("- `src/Big.sol` — over 64 KB, so the redactor cannot check it")
      // An old record that holds the mark in place of code is caught at bundle time.
      const old = { ...snap, omitted: [], files: [...snap.files, { path: "src/Big.sol", text: "[REDACTED: text of 76012 characters too long to check]" }] }
      expect(readmeOf(old)).toContain("- `src/Big.sol` — over 64 KB, so the redactor cannot check it")
      // A file left out for a secret is named too.
      rmSync(path.join(ws, "src", "Big.sol"))
      writeFileSync(path.join(ws, "src", "Key.sol"), `// ${PEM}\ncontract Key {}\n`)
      const withKey = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      expect(withKey.omitted).toEqual([{ path: "src/Key.sol", reason: "a secret body" }])
      expect(readmeOf(withKey)).toContain("- `src/Key.sol` — a secret body")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }

    // An HTTP request script over the cap is left out, and there is no rerun command.
    const script = `await request("GET", "/");\n// ${"x".repeat(70 * 1024)}\n`
    const proof = { kind: "http", status: "pass", oracle: { name: "debug-route-signer-key-leak", detail: "x", passed: true }, log: [{ label: "1", request: { method: "GET", url: "http://origin:8080/" }, response: { status: 200, body: "ok" } }] }
    const d = mkdtempSync(path.join(tmpdir(), "replay-overcap-http-"))
    try {
      unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "http", script, proof }, recorded: { script, proof, pack: "web" } }), d)
      const files = readTree(d)
      expect(files.has("script.mjs")).toBe(false)
      expect(files.has("rerun.mjs")).toBe(false)
      expect((files.get("README.md") || "").split("\n")[0]).toContain("This bundle cannot be re-run from this folder: the request script is over 64 KB, so the redactor cannot check it, so it is left out.")
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  test("a Foundry bundle never claims RE-RUN CHECKED; it carries the command marked not-checked, and a forked proof gets none", () => {
    const readmeOf = (ws: string, contract: string) => {
      const snap = snapshotForgeReplay(ws, { contract, test: "t()" })
      const proof = { kind: "forge", pass: true, test: "t()", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "1" } }
      const dir = mkdtempSync(path.join(tmpdir(), "replay-cut-"))
      try {
        unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay: snap, proof } }), dir)
        return readTree(dir).get("README.md") || ""
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    // A non-forked proof: the command ships, marked "not re-run-checked", never a claim.
    const ws = mkdtempSync(path.join(tmpdir(), "replay-cut-ws-"))
    try {
      mkdirSync(path.join(ws, "src")); mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", "Vault.sol"), "contract Vault {}\n")
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), "contract PocTest {}\n")
      const r = readmeOf(ws, "PocTest")
      expect(r).not.toContain("RE-RUN CHECKED")
      expect(r).toContain("not re-run-checked")
      expect(r).toContain("an automatic re-run check does not ship yet")
      expect(commands(r).length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
    // A forked proof: an offline re-run cannot fork, so no command at all.
    const fw = mkdtempSync(path.join(tmpdir(), "replay-cut-fork-"))
    try {
      mkdirSync(path.join(fw, "src")); mkdirSync(path.join(fw, "test"))
      writeFileSync(path.join(fw, "foundry.toml"), `[profile.default]\nsrc = "src"\neth_rpc_url = "https://eth-mainnet.g.alchemy.com/v2/Kd83nWq2Lx9Pz4Rt7Ys1Mv6Bc0Hj5Fg"\n`)
      writeFileSync(path.join(fw, "src", "Vault.sol"), "contract Vault {}\n")
      writeFileSync(path.join(fw, "test", "AgentPoc.t.sol"), "contract PocTest {}\n")
      const r = readmeOf(fw, "PocTest")
      expect(commands(r)).toEqual([])
      expect(r).not.toContain("RE-RUN CHECKED")
    } finally {
      rmSync(fw, { recursive: true, force: true })
    }
  })

  test("no claim when the verifier fails or the stored verdict is a fail (non-Docker)", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { makeWorkspace } = await import("../../spike/lib/sandbox.mjs")
    // @ts-expect-error — plain .mjs module, no types
    const { verifyForgeReplay } = await import("../../spike/lib/replay-bundle.mjs")
    const lab = new URL("../../lab/vault-reentrancy/", import.meta.url).pathname
    const ws = makeWorkspace(lab)
    try {
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), readFileSync(path.join(lab, "oracle", "VaultExploit.t.sol"), "utf8"))
      const snap = snapshotForgeReplay(ws, { contract: "VaultExploitTest", test: "t()" })
      const proof = { kind: "forge", pass: true, test: "t()" }
      const line1 = (replay: unknown) => {
        const dir = mkdtempSync(path.join(tmpdir(), "replay-noclaim-"))
        try {
          unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay, proof } }), dir)
          return (readTree(dir).get("README.md") || "").split("\n")[0]
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
      // The verifier's forge did not pass: pass is false, reason set, no claim.
      const failed = await verifyForgeReplay({ replay: snap, proof }, { run: async () => ({ passed: false, failed: true }) })
      expect(failed.pass).toBe(false)
      expect(failed.reason).toBe("the proof test did not pass from the bundle folder")
      expect(line1({ ...snap, rerun: failed }).startsWith("RE-RUN CHECKED")).toBe(false)
      // Docker missing reads as "could not run", not "did not pass".
      const noDocker = await verifyForgeReplay({ replay: snap, proof }, { run: async () => ({ passed: false, failed: false, code: "ENOENT" }) })
      expect(noDocker.pass).toBe(false)
      expect(noDocker.reason).toBe("the check could not run (Docker is not available)")
      // A hand-set stored fail (pass:false) with a matching tree still makes no claim.
      const stored = { ...snap, rerun: { checked: true, pass: false, tree: failed.tree, reason: "x" } }
      expect(line1(stored).startsWith("RE-RUN CHECKED")).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("an old record's stored forge command and check-harm do not reach proof.json", () => {
    const replay = {
      version: 1, kind: "forge", contract: "PocTest", test: "testDrain",
      command: "docker run --rm --pull never --network none ghcr.io/foundry-rs/foundry@sha256:dead 'forge test --offline'",
      prepare: "docker pull ghcr.io/foundry-rs/foundry@sha256:dead",
      fork: { rpc: "${RPC_URL}", block: null, forked: false },
      files: [{ path: "foundry.toml", text: "[profile.default]\n" }, { path: "test/AgentPoc.t.sol", text: "contract PocTest {}\n" }],
      omitted: [],
    }
    const proof = { kind: "forge", pass: true, test: "testDrain()", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "1" } }
    const dir = mkdtempSync(path.join(tmpdir(), "replay-oldcmd-"))
    try {
      unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay, proof } }), dir)
      const files = readTree(dir)
      // No check-harm.mjs / harm.json, and the stale stored command/prepare do
      // not reach proof.json (the README's command is the fresh re-run one).
      expect(files.has("check-harm.mjs")).toBe(false)
      expect(files.has("harm.json")).toBe(false)
      const proofJson = JSON.parse(files.get("proof.json") || "")
      expect(proofJson.replay.command).toBeUndefined()
      expect(proofJson.replay.prepare).toBeUndefined()
      expect((files.get("proof.json") || "").includes("--pull never")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the README date uses a real time only, never the run's ms duration", () => {
    // ms is a duration (findings.mjs normalize: `ms: r.ms || null`), not a date.
    expect(provenDate({ finding: { ms: 42000 } })).toBeNull()
    expect(provenDate({ finding: { ms: 42000 }, recorded: { ms: 42000 } })).toBeNull()
    // A real start time on the finding (getFinding sends it as `at`) is the date.
    expect(provenDate({ finding: { at: Date.UTC(2026, 1, 20) } })).toBe("2026-02-20")
    // The proof's own time wins when a record holds one.
    expect(provenDate({ recorded: { proof: { at: Date.UTC(2025, 5, 1) } }, finding: { at: Date.UTC(2026, 1, 20) } })).toBe("2025-06-01")
    // Out-of-range times are dropped: a 1970 epoch (a duration misread) and a future date.
    expect(provenDate({ finding: { at: 42000 } })).toBeNull()
    expect(provenDate({ finding: { at: Date.now() + 86400000 * 30 } })).toBeNull()
    // In a README: ms alone yields no date clause; a real at yields one.
    const proof = { kind: "forge", pass: true, test: "testDrain()", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "1" } }
    const replay = { version: 1, kind: "forge", contract: "PocTest", test: "testDrain", fork: { rpc: "${RPC_URL}", block: null, forked: false }, files: [{ path: "foundry.toml", text: "[profile.default]\n" }, { path: "test/AgentPoc.t.sol", text: "contract PocTest {}\n" }], omitted: [] }
    const line1 = (finding: Record<string, unknown>) => {
      const dir = mkdtempSync(path.join(tmpdir(), "replay-date-"))
      try {
        unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof, ...finding }, recorded: { replay, proof } }), dir)
        return (readTree(dir).get("README.md") || "").split("\n")[0]
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    expect(line1({ ms: 42000 })).not.toContain(" on ")
    expect(line1({ ms: 42000 })).not.toContain("1970")
    expect(line1({ at: Date.UTC(2026, 1, 20) })).toContain("by its own replay on 2026-02-20 (harm: an ETH drain)")
  })

  test("a normalized proof's rerunCommand never reaches proof.json", () => {
    // findings.mjs can put a rerunCommand on the normalized proof. The bundle
    // falls back to it when there is no recorded proof, so it must be dropped.
    const proof = { kind: "forge", pass: true, test: "testDrain()", rerunCommand: "forge test --match-test testDrain", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "1" } }
    const replay = { version: 1, kind: "forge", contract: "PocTest", test: "testDrain", fork: { rpc: "${RPC_URL}", block: null, forked: false }, files: [{ path: "foundry.toml", text: "[profile.default]\n" }, { path: "test/AgentPoc.t.sol", text: "contract PocTest {}\n" }], omitted: [] }
    const dir = mkdtempSync(path.join(tmpdir(), "replay-rerun-"))
    try {
      // No recorded.proof: the builder uses finding.proof, which carries rerunCommand.
      unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay } }), dir)
      const files = readTree(dir)
      expect(JSON.parse(files.get("proof.json") || "").rerunCommand).toBeUndefined()
      expect((files.get("proof.json") || "").includes("--match-test testDrain")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a finding recorded before snapshots ships what it has and names no command", () => {
    const zip = buildReplayBundle({ finding: forgeFinding })
    const dir = mkdtempSync(path.join(tmpdir(), "replay-old-"))
    try {
      unzip(zip, dir)
      const files = readTree(dir)
      expect(files.get("test/AgentPoc.t.sol")).toContain("contract VaultTest")
      expect(files.has("foundry.toml")).toBe(false)
      const readme = files.get("README.md") || ""
      expect(commands(readme)).toHaveLength(0)
      expect(readme).not.toContain("forge test")
      const fork = JSON.parse(files.get("fork.json") || "")
      expect(fork.rpc).toBe("${RPC_URL}")
      expect(fork.block).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a finding that is not proven gets no bundle, and the refusal says why", () => {
    const refused = (args: Record<string, unknown>) => {
      try {
        buildReplayBundle(args)
        return null
      } catch (err) {
        return err as { refused?: boolean; message?: string }
      }
    }
    const lead = { ...forgeFinding, stages: { ...forgeFinding.stages, proven: false } }
    expect(bundleRefusal({ finding: forgeFinding })).toBeNull()
    expect(refused({ finding: forgeFinding })).toBeNull()
    expect(bundleRefusal({ finding: lead })).toBe(NOT_PROVEN_REFUSAL)
    expect(refused({ finding: lead })?.refused).toBe(true)
    expect(refused({ finding: lead })?.message).toContain("no replay bundle")
    // The app's verdict wins over a raw record that claims a pass.
    expect(bundleRefusal({ finding: lead, recorded: { pocProved: true, proof: forgeFinding.proof } })).toBe(NOT_PROVEN_REFUSAL)
    // A raw candidate with no app verdict: only pocProved === true is proven.
    const { stages: _stages, ...candidate } = forgeFinding
    expect(bundleRefusal({ finding: candidate })).toBe(NOT_PROVEN_REFUSAL)
    expect(bundleRefusal({ finding: candidate, recorded: { pocProved: false, proof: forgeFinding.proof } })).toBe(NOT_PROVEN_REFUSAL)
    expect(bundleRefusal({ finding: candidate, recorded: { pocProved: true, proof: forgeFinding.proof } })).toBeNull()
    const http = { title: "IDOR", proofKind: "http", proof: { kind: "http", status: "fail", oracle: { name: "x", passed: false } } }
    expect(bundleRefusal({ finding: { ...http, stages: { proven: false } } })).toBe(NOT_PROVEN_REFUSAL)
    expect(bundleRefusal({ finding: { ...http, stages: { proven: true } } })).toBeNull()
  })

  test("the zip drops a file name with a backslash, a colon, or a control character", () => {
    const bad = ["src/a\\..\\..\\evil1.sol", "src/C:evil2.sol", "src/evil3\n.sol", "src/evil4\u0007.sol"]
    const replay = { version: 1, kind: "forge", files: [...bad, "src/Fine.sol"].map((p) => ({ path: p, text: "contract X {}\n" })) }
    const zip = buildReplayBundle({ finding: forgeFinding, recorded: { replay, proof: forgeFinding.proof } })
    const names = execFileSync("python3", ["-I", "-c", "import sys, zipfile; print('\\0'.join(zipfile.ZipFile(sys.stdin.buffer).namelist()), end='')"], { input: zip }).toString().split("\0")
    expect(names).toContain("src/Fine.sol")
    for (const n of names) expect(n).not.toMatch(/evil/)
  })

  test("an http bundle against a live target keeps the script and says there is no rerun", () => {
    const script = `const r = await request("GET", "/api/users/2", { headers: { authorization: "Bearer ${BEARER}" } });\n`
    const proof = {
      kind: "http",
      status: "pass",
      oracle: { name: "cross-tenant-read", detail: `returned Bearer ${BEARER}`, passed: true },
      log: [{ label: "1", request: { method: "GET", url: "https://app.example.com/api/users/2", headers: { authorization: `Bearer ${BEARER}` } }, response: { status: 200, body: "ok" } }],
    }
    const zip = buildReplayBundle({
      finding: { stages: { proven: true }, title: "IDOR", proofKind: "http", script, proof },
      recorded: { script, proof, pack: "web" },
    })
    expect(zip.includes(BEARER)).toBe(false)
    const dir = mkdtempSync(path.join(tmpdir(), "replay-http-"))
    try {
      unzip(zip, dir)
      const files = readTree(dir)
      const readme = files.get("README.md") || ""
      expect(commands(readme)).toHaveLength(0)
      expect(readme).toContain("## No rerun")
      expect(readme).toContain("live target")
      for (const name of ["rerun.mjs", "rerun.json", "proof-http.mjs", "SHA256SUMS"]) expect(files.has(name)).toBe(false)
      expect(files.get("script.mjs")).toContain('authorization: "[REDACTED]"')
      expect(files.get("script.mjs")).not.toContain(BEARER)
      expect(files.get("transcript.json")).not.toContain(BEARER)
      expect(files.get("proof.json")).not.toContain(BEARER)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an http bundle against the pack lab carries a rerun command and the engine's lab code", () => {
    // Made up. The lab's debug route leaks a signer key; the transcript keeps
    // the route and the key name, not the key.
    const signerKey = "0x" + "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"
    const script = `await request("GET", "/internal/debug/config");\n`
    const proof = {
      kind: "http",
      status: "pass",
      detail: "the debug route returned the signer key",
      oracle: { name: "debug-route-signer-key-leak", detail: "the debug route returned the signer key", passed: true },
      log: [{
        label: "1. GET /internal/debug/config",
        request: { method: "GET", url: "http://origin:8080/internal/debug/config", headers: { "content-type": "application/json" }, body: null },
        response: { status: 200, headers: {}, body: { signerPrivateKey: signerKey, signerAddress: "0x" + "ab".repeat(20) } },
      }],
    }
    const zip = buildReplayBundle({ finding: { title: "debug route leaks the signer key", proofKind: "http", script, proof, stages: { proven: true } }, recorded: { script, proof, pack: "web" } })
    expect(zip.includes(signerKey.slice(2))).toBe(false)
    const dir = mkdtempSync(path.join(tmpdir(), "replay-http-lab-"))
    try {
      unzip(zip, dir)
      const files = readTree(dir)
      const readme = files.get("README.md") || ""
      expect(readme.split("\n")[0]).toMatch(/^PROVEN: /)
      expect(commands(readme)).toEqual([
        "npm run build:labs -- web && docker pull node:20-slim",
        "sha256sum -c SHA256SUMS && \\\n  node rerun.mjs <path-to-touchstone-checkout>",
      ])
      expect(section(readme, "Rerun (offline)")).toBe("sha256sum -c SHA256SUMS && \\\n  node rerun.mjs <path-to-touchstone-checkout>")
      const engine = Object.fromEntries(["spike/lib/proof-http.mjs", "spike/lib/lab-net.mjs", "spike/packs/web/pack.mjs"].map((rel) => [rel, createHash("sha256").update(readFileSync(new URL(`../../${rel}`, import.meta.url))).digest("hex")]))
      expect(JSON.parse(files.get("rerun.json") || "")).toEqual({ pack: "web", image: "touchstone/web-lab:dev", oracle: "debug-route-signer-key-leak", engine })
      expect(files.get("script.mjs")).toBe(script)
      expect(files.get("rerun.mjs")).toBe(readFileSync(new URL("../../spike/lib/replay-http-rerun.mjs", import.meta.url), "utf8"))
      // The lab code is loaded from the checkout, not copied: it imports other engine files.
      expect(files.has("proof-http.mjs")).toBe(false)
      const transcript = JSON.parse(files.get("transcript.json") || "")
      expect(transcript[0].request.url).toBe("http://origin:8080/internal/debug/config")
      expect(transcript[0].response.body.signerPrivateKey).toBe("[REDACTED]")
      const sums = files.get("SHA256SUMS") || ""
      for (const name of ["script.mjs", "rerun.json", "rerun.mjs", "transcript.json", "proof.json"]) expect(sums).toContain(`  ${name}\n`)
      execFileSync("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: dir, stdio: "ignore" })
      // With no checkout path the rerun cannot load the oracle, and says so.
      let code = 0
      let out = ""
      try {
        out = execFileSync("node", ["rerun.mjs"], { cwd: dir, encoding: "utf8" })
      } catch (err) {
        code = (err as { status?: number }).status ?? -1
        out = String((err as { stdout?: string }).stdout ?? "")
      }
      expect(code).toBe(2)
      expect(out).toContain("CANNOT CHECK")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an http bundle masks header pairs and unquoted secret keys", () => {
    // Made up.
    const sid = "sid=Xk4Pq8Lm2Rt7Vw3Zb9Nc"
    const token = "Tt6Hq2Wr9Zk4Lp1Ty7Mv3B"
    const script = `await request("GET", "/admin", { headers: { cookie: "${sid}" } });\n`
    const proof = {
      kind: "http",
      status: "pass",
      oracle: { name: "admin-without-auth", detail: "the admin page answered 200", passed: true },
      log: [{
        label: "1",
        request: { method: "GET", url: "https://app.example.com/admin", headers: [["cookie", sid], ["x-touchstone-token", token], ["accept", "text/html"]] },
        response: { status: 200, headers: [["set-cookie", sid]], body: "ok" },
      }],
    }
    const zip = buildReplayBundle({ finding: { stages: { proven: true }, title: "admin page", proofKind: "http", script, proof }, recorded: { script, proof, pack: "web" } })
    expect(zip.includes(sid)).toBe(false)
    expect(zip.includes(token)).toBe(false)
    const dir = mkdtempSync(path.join(tmpdir(), "replay-http-pairs-"))
    try {
      unzip(zip, dir)
      const files = readTree(dir)
      expect(files.get("script.mjs")).toContain('cookie: "[REDACTED]"')
      const t = JSON.parse(files.get("transcript.json") || "")
      expect(t[0].request.headers).toEqual([["cookie", "[REDACTED]"], ["x-touchstone-token", "[REDACTED]"], ["accept", "text/html"]])
      expect(t[0].response.headers).toEqual([["set-cookie", "[REDACTED]"]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a proof that holds a shape the redactor cannot mask gets no zip, and the refusal names no value", () => {
    // Made up. The redactor keeps a bare 64-hex value and a bare AWS secret.
    const hex = "9c4f1a7e3b8d2f6a0c5e9b1d7f3a8c2e6b0d4f9a1c7e3b5d8f2a6c0e4b9d1f7a"
    const aws = "Rb3Nc6Kd1Fg5Jy0Ts/Ua+Pe2Hq7Lm2Xp9Rt4Vw8Q"
    for (const [detail, shape] of [[`the route returned signer key 0x${hex}`, "a 64-hex key"], [`the route returned aws ${aws}`, "an AWS secret key"]]) {
      const proof = { kind: "http", status: "pass", oracle: { name: "debug-route-signer-key-leak", detail, passed: true }, log: [] }
      type Refusal = { refused?: boolean; name?: string; message?: string }
      let err: Refusal | null = null
      try {
        buildReplayBundle({ finding: { stages: { proven: true }, title: "leak", proofKind: "http", script: "await request(\"GET\", \"/\");\n", proof }, recorded: { proof, pack: "web" } })
      } catch (e) {
        err = e as Refusal
      }
      expect(err?.refused).toBe(true)
      expect(err?.name).toBe("BundleRefused")
      expect(err?.message).toContain(shape)
      expect(err?.message).toContain("proof.json")
      expect(err?.message).not.toContain(hex)
      expect(err?.message).not.toContain(aws)
    }
  })

  test("a bundle counts the values it cannot judge, names none, and lists them in the README", () => {
    // Made up. Two storage slots (one used twice), an AWS-shaped token with no
    // "aws" word, and a URL token on a host that is not a known provider: each
    // may be evidence. A value counts once, in however many files it is.
    const slot = "0x" + "36".repeat(16) + "08".repeat(16)
    const token = "Rb3Nc6Kd1Fg5Jy0Ts/Ua+Pe2Hq7Lm2Xp9Rt4Vw8Q"
    const urlToken = "Zx81QwErTy56UiOp34AsDf"
    const ws = mkdtempSync(path.join(tmpdir(), "replay-unjudged-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", "Proxy.sol"), `contract Proxy {\n  bytes32 internal constant SLOT = ${slot};\n  bytes32 internal constant OTHER = ${slot.slice(0, -2)}09;\n  bytes32 internal constant AGAIN = ${slot};\n  string blob = "${token}";\n}\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest is Test { function testDrain() public {} }\n`)
      const replay = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      const plan = planReplayBundle({
        finding: { stages: { proven: true }, title: "Proxy takeover", proofKind: "forge", proof: { kind: "forge", pass: true, test: "testDrain()" } },
        recorded: { replay, proof: { kind: "forge", pass: true, test: "testDrain()" } },
      })
      expect(plan.unjudged).toEqual([
        { shape: "hex64", count: 2, text: "2 values of 64 hex characters that may be keys or hashes" },
        { shape: "aws40", count: 1, text: "1 token of 40 characters that may be an AWS secret key" },
      ])
      const dir = mkdtempSync(path.join(tmpdir(), "replay-unjudged-zip-"))
      try {
        unzip(plan.zip, dir)
        const readme = readTree(dir).get("README.md") || ""
        expect(readme).toContain("## Check these before you share the bundle\n")
        expect(readme).toContain("- 2 values of 64 hex characters that may be keys or hashes\n- 1 token of 40 characters that may be an AWS secret key\n")
        expect(readme.includes(slot.slice(2))).toBe(false)
        expect(readme.includes(token)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }

    const proof = {
      kind: "http",
      status: "pass",
      oracle: { name: "cross-tenant-read", detail: "read another tenant", passed: true },
      log: [{ label: "1", request: { method: "GET", url: `https://files.example.com/share/${urlToken}` }, response: { status: 200, body: "ok" } }],
    }
    const http = planReplayBundle({ finding: { stages: { proven: true }, title: "share link", proofKind: "http", proof }, recorded: { proof, pack: "web" } })
    expect(http.unjudged).toEqual([{ shape: "urlToken", count: 1, text: "1 URL part that may be an access token" }])
    const lab = { ...proof, log: [{ label: "1", request: { method: "GET", url: `http://origin:8080/share/${urlToken}` }, response: { status: 200, body: "ok" } }] }
    expect(planReplayBundle({ finding: { stages: { proven: true }, title: "share link", proofKind: "http", proof: lab }, recorded: { proof: lab, pack: "web" } }).unjudged).toEqual([])
  })

  test("a BIP39 phrase with no keyword is named by its checksum and left out", () => {
    // Made up: a phrase built from fixed entropy at test time, and a run of
    // wordlist words that fails the checksum.
    const phrase = Mnemonic.fromEntropy("0x" + "5a".repeat(16)).phrase
    const notSeed = "orbit lemon cradle vivid tunnel amber frost gravel nephew silent wagon plume"
    expect(Mnemonic.isValidMnemonic(notSeed)).toBe(false)
    const ws = mkdtempSync(path.join(tmpdir(), "replay-bip39-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", "Note.sol"), `// ops notes: ${phrase}\ncontract Note {}\n`)
      writeFileSync(path.join(ws, "src", "Prose.sol"), `// ${notSeed}\ncontract Prose {}\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest is Test { function testDrain() public {} }\n`)
      const replay = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      expect(JSON.stringify(replay).includes(phrase)).toBe(false)
      expect(replay.omitted).toEqual([{ path: "src/Note.sol", reason: "holds a mnemonic the redactor cannot mask" }])
      expect(replay.files.map((f: { path: string }) => f.path)).toContain("src/Prose.sol")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("the run record keeps the replay's hash and paths; the files live in replay/<sha256>.json", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-store-runs-"))
    const ws = mkdtempSync(path.join(tmpdir(), "replay-store-ws-"))
    const prev = process.env.TOUCHSTONE_RESULTS_DIR
    process.env.TOUCHSTONE_RESULTS_DIR = dir
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", "Vault.sol"), `contract Vault { function withdraw() external {} }\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest is Test { function testDrain() public {} }\n`)
      const snap = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      expect(replayStoreDir()).toBe(path.join(dir, "replay"))
      const kept = storeReplayFiles(snap)
      // The record: no file text, only the hash, the counts and the paths.
      expect(kept.files).toBeUndefined()
      expect(kept.version).toBe(3)
      expect(kept.paths).toEqual(snap.files.map((f: { path: string }) => f.path))
      expect(kept.store.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(kept.store.fileCount).toBe(snap.files.length)
      expect(JSON.stringify(kept).includes("function withdraw")).toBe(false)
      expect(kept.command).toBe(snap.command)
      const file = path.join(dir, "replay", `${kept.store.sha256}.json`)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(kept.store.sha256)
      expect(kept.store.bytes).toBe(statSync(file).size)
      // The same sources give the same file, not a second one.
      expect(storeReplayFiles(snap).store.sha256).toBe(kept.store.sha256)
      expect(readdirSync(path.join(dir, "replay"))).toEqual([`${kept.store.sha256}.json`])

      // The bundle reads the files back through the record.
      writeFileSync(path.join(dir, "run-m7-1.json"), JSON.stringify({ result: { findings: [{ title: "drain", pocProved: true, proof: { kind: "forge", pass: true, test: "testDrain()", replay: kept } }] } }))
      const recorded = loadRecordedReplay("m7-1.1")
      expect(recorded.replay.files).toEqual(snap.files)
      const finding = { stages: { proven: true }, title: "drain", proofKind: "forge", proof: { kind: "forge" } }
      const out = mkdtempSync(path.join(tmpdir(), "replay-store-zip-"))
      try {
        unzip(buildReplayBundle({ finding, recorded }), out)
        const files = readTree(out)
        expect(files.get("src/Vault.sol")).toContain("function withdraw")
        expect(commands(files.get("README.md") || "").length).toBeGreaterThanOrEqual(1)
        expect(files.get("README.md")).not.toContain("RE-RUN CHECKED")
      } finally {
        rmSync(out, { recursive: true, force: true })
      }

      // A changed or missing file gives no files and says why. No command.
      writeFileSync(file, readFileSync(file, "utf8").replace("withdraw", "withdrew"))
      const changed = loadRecordedReplay("m7-1.1")
      expect(changed.replay.files).toEqual([])
      expect(changed.replay.filesLost).toBe("the replay file does not match the hash in the record")
      const readme = (() => {
        const d = mkdtempSync(path.join(tmpdir(), "replay-store-lost-"))
        try {
          unzip(buildReplayBundle({ finding, recorded: changed }), d)
          return readTree(d).get("README.md") || ""
        } finally {
          rmSync(d, { recursive: true, force: true })
        }
      })()
      expect(readme).toContain("The proof's source files of this run are gone: the replay file does not match the hash in the record.")
      expect(commands(readme)).toEqual([])
      rmSync(file)
      expect(loadRecordedReplay("m7-1.1").replay.filesLost).toBe("the replay file is no longer in the results folder")
      // A store path in a record cannot leave the folder: the name must be a hash.
      writeFileSync(path.join(dir, "run-m7-2.json"), JSON.stringify({ result: { findings: [{ title: "x", proof: { kind: "forge", replay: { ...kept, store: { sha256: "../run-m7-1" } } } }] } }))
      expect(loadRecordedReplay("m7-2.1").replay.filesLost).toBe("the record names no replay file")
    } finally {
      if (prev === undefined) delete process.env.TOUCHSTONE_RESULTS_DIR
      else process.env.TOUCHSTONE_RESULTS_DIR = prev
      rmSync(dir, { recursive: true, force: true })
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("loadRecordedReplay prefers a finding's own pack over the run's (a joined run is 'multi')", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "replay-pack-"))
    const prev = process.env.TOUCHSTONE_RESULTS_DIR
    process.env.TOUCHSTONE_RESULTS_DIR = dir
    try {
      // A joined run: the run is "multi"; the web finding keeps its own pack.
      writeFileSync(path.join(dir, "run-joined-1.json"), JSON.stringify({
        result: { pack: "multi", findings: [{ title: "web idor", pack: "web", pocProved: true, proof: { kind: "http" } }, { title: "a contracts finding", pack: "contracts", proof: { kind: "forge" } }] },
      }))
      expect(loadRecordedReplay("joined-1.1").pack).toBe("web")
      expect(loadRecordedReplay("joined-1.2").pack).toBe("contracts")
      // A single-pack run with no finding pack falls back to the run's pack.
      writeFileSync(path.join(dir, "run-solo-1.json"), JSON.stringify({ result: { pack: "web", findings: [{ title: "one", proof: { kind: "http" } }] } }))
      expect(loadRecordedReplay("solo-1.1").pack).toBe("web")
    } finally {
      if (prev === undefined) delete process.env.TOUCHSTONE_RESULTS_DIR
      else process.env.TOUCHSTONE_RESULTS_DIR = prev
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
        result: { findings: [{ title: "one", script: "await request()", pocProved: true, proof: { kind: "http", replay } }, { title: "two", pocProved: "yes", proof: { kind: "forge" } }] },
      }))
      const first = loadRecordedReplay("demo-1.1")
      expect(first.replay.command).toBe("docker run example")
      expect(first.script).toBe("await request()")
      const second = loadRecordedReplay("demo-1.2")
      expect(second.proof.kind).toBe("forge")
      expect(second.replay).toBeNull()
      expect(first.pocProved).toBe(true)
      expect(second.pocProved).toBe(false)
      expect(loadRecordedReplay("../demo-1")).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.TOUCHSTONE_RESULTS_DIR
      else process.env.TOUCHSTONE_RESULTS_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Opt in with TOUCHSTONE_DOCKER_TESTS=1. Real offline forge over a bundle
  // folder: the proof re-runs from the shipped files alone, so the bundle's
  // "re-run checked" claim is earned, not asserted. Needs the pinned Foundry
  // image and solc 0.8.38 warmed in the foundry-svm volume; never pulls.
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
  ;(forgeReady ? test : test.skip)("a Foundry bundle re-runs from its own files offline; a data-needing proof makes no claim", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { makeWorkspace, forgeTest, forgeReplayCommand } = await import("../../spike/lib/sandbox.mjs")
    // @ts-expect-error — plain .mjs module, no types
    const { verifyForgeReplay } = await import("../../spike/lib/replay-bundle.mjs")
    const volume = `touchstone-replay-test-${process.pid}`
    execFileSync("docker", ["volume", "create", volume], { stdio: "ignore" })
    execFileSync("docker", [
      "run", "--rm", "--pull", "never", "--network", "none", "-u", "0", "--entrypoint", "sh",
      "-v", "foundry-svm:/from:ro", "-v", `${volume}:/svm`,
      "ghcr.io/foundry-rs/foundry:latest", "-c", "cp -a /from/0.8.38 /svm/ && chown -R 1000:1000 /svm",
    ], { stdio: "ignore" })
    // Build the allow-list workspace for a lab (a forge run first so build-info
    // lists the compiled sources), then snapshot it.
    const snapLab = async (labRel: string, pocFile: string, contract: string) => {
      const lab = new URL(`../../${labRel}/`, import.meta.url).pathname
      const ws = makeWorkspace(lab)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), readFileSync(path.join(lab, "oracle", pocFile), "utf8"))
      await forgeTest(ws, { matchContract: contract })
      const snap = snapshotForgeReplay(ws, { contract, test: "t()" })
      return { ws, snap }
    }
    try {
      // (1) vault-reentrancy: a pure-source proof. verifyForgeReplay (the tested
      // function) confirms the offline re-run passes from the bundle files; the
      // shipped bundle makes NO automatic claim, and the README command the test
      // runs by hand reproduces the pass from the bundle folder alone.
      const { ws, snap } = await snapLab("lab/vault-reentrancy", "VaultExploit.t.sol", "VaultExploitTest")
      const proof = { kind: "forge", pass: true, test: "t()" }
      const rerun = await verifyForgeReplay({ replay: snap, proof })
      expect(rerun.pass).toBe(true)
      expect(rerun.tree).toMatch(/^[a-f0-9]{64}$/)
      const wantCmd = forgeReplayCommand({ matchContract: "VaultExploitTest", solc: snap.solc })
      const dir = mkdtempSync(path.join(tmpdir(), "replay-e2e-"))
      try {
        unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay: snap, proof } }), dir)
        const readme = readFileSync(path.join(dir, "README.md"), "utf8")
        expect(readme).not.toContain("RE-RUN CHECKED")
        expect(readme).toContain("not re-run-checked")
        expect(readme).toContain(wantCmd)
        execFileSync("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: dir, stdio: "ignore" })
        const run = wantCmd.replace("foundry-svm:", `${volume}:`)
        const out = execFileSync("bash", ["-c", run], { cwd: dir, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
        expect(out).toContain("[PASS] test_reentrancy_drains_vault")
        writeFileSync(path.join(dir, "test", "AgentPoc.t.sol"), readFileSync(path.join(dir, "test", "AgentPoc.t.sol"), "utf8") + "// edit\n")
        expect(() => execFileSync("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: dir, stdio: "ignore" })).toThrow()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      // (2) a needed source removed from the checked tree: the re-run fails.
      const missing = { ...snap, files: snap.files.filter((x: { path: string; vendored?: unknown }) => x.path !== "src/Vault.sol") }
      const bad = await verifyForgeReplay({ replay: missing, proof })
      expect(bad.pass).toBe(false)
      expect(typeof bad.reason).toBe("string")
      rmSync(ws, { recursive: true, force: true })

      // (3) a proof that reads a data file through a cheatcode: the allow-list
      // ships sources+config only, not the data file, so the offline re-run
      // fails and the bundle makes no claim — the honest scope-cut result.
      const dw = mkdtempSync(path.join(tmpdir(), "replay-data-"))
      try {
        mkdirSync(path.join(dw, "src"))
        mkdirSync(path.join(dw, "test"))
        mkdirSync(path.join(dw, "lib", "forge-std", "src"), { recursive: true })
        writeFileSync(path.join(dw, "lib", "forge-std", "src", "Vm.sol"), "// SPDX-License-Identifier: MIT\npragma solidity >=0.8.0;\ninterface Vm { function readFile(string calldata) external view returns (string memory); }\n")
        writeFileSync(path.join(dw, "foundry.toml"), `[profile.default]
src = "src"
test = "test"
fs_permissions = [{ access = "read", path = "./data" }]
`)
        mkdirSync(path.join(dw, "data"))
        writeFileSync(path.join(dw, "data", "answer.txt"), "forty-two")
        writeFileSync(path.join(dw, "test", "AgentPoc.t.sol"), `// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;
import "forge-std/Vm.sol";
contract DataReadTest {
  Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  function test_reads_data() external view {
    require(keccak256(bytes(vm.readFile("data/answer.txt"))) == keccak256("forty-two"), "data missing");
  }
}
`)
        // With the data file present the proof passes in the workspace.
        const live = await forgeTest(dw, { matchContract: "DataReadTest" })
        expect(live.passed).toBe(true)
        // The snapshot ships no data file (it is not a compiled source).
        const dsnap = snapshotForgeReplay(dw, { contract: "DataReadTest", test: "test_reads_data()" })
        expect(dsnap.files.map((f: { path: string }) => f.path)).not.toContain("data/answer.txt")
        // So the offline re-run from the bundle files alone fails: no claim.
        const dRerun = await verifyForgeReplay({ replay: dsnap, proof: { kind: "forge", pass: true } })
        expect(dRerun.pass).toBe(false)
        expect(typeof dRerun.reason).toBe("string")
      } finally {
        rmSync(dw, { recursive: true, force: true })
      }
    } finally {
      execFileSync("docker", ["volume", "rm", "-f", volume], { stdio: "ignore" })
    }
  }, 600_000)
})

describe("report: secrets stay out of every format", () => {
  // A live AI/MCP run's bearer token, quoted in the write-up and in the
  // exchanges (Authorization, Cookie, X-API-Key, a query param, a JSON body).
  const token = "tok_operator_9f3a2c1b8e7d"
  const fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  const leak = {
    id: "run-m.1",
    runId: "run-m",
    title: "Tool call used the operator credential",
    severity: "high",
    module: "AI / MCP",
    proofKind: "http",
    target: "mcp.example.com",
    stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
    explanation:
      `The agent read the brief and called the tool with Bearer ${token}.\n\n` +
      "Fix: rotate that credential and stop copying it into the prompt.",
    proof: {
      kind: "http",
      pass: true,
      oracle: { name: "forbidden tool call", detail: "the tool ran with the operator credential", passed: true },
      exchanges: [
        {
          label: "MCP tools/call",
          request: {
            method: "POST",
            url: `/mcp/tools/call?token=${token}`,
            headers: [
              { name: "Authorization", redacted: false, value: `Bearer ${token}` },
              { name: "X-API-Key", redacted: false, value: token },
              { name: "Cookie", redacted: false, value: `session=${token}` },
              { name: "Content-Type", redacted: false, value: "application/json" },
              { name: "Authorization", redacted: true, sha256: fingerprint },
            ],
            body: `{"jsonrpc":"2.0","authorization":"Bearer ${token}","email":"victim@example.com"}`,
          },
          response: {
            status: 200,
            headers: [{ name: "Set-Cookie", redacted: false, value: `sid=${token}` }],
            body: "ok",
          },
        },
      ],
      detail: "",
    },
    usage: { usd: null },
  }

  test("html, markdown and json omit the bearer token and keep the proof", () => {
    const report = buildReport(leak)
    const html = renderReportHtml(report)
    const md = renderReportMarkdown(report)
    const json = JSON.stringify(report)
    for (const rendered of [html, md, json]) {
      expect(rendered).not.toContain(token)
      expect(rendered).toContain("victim@example.com")
      expect(rendered).toContain("application/json")
      expect(rendered).toContain("/mcp/tools/call")
      expect(rendered).toContain("forbidden tool call")
      expect(rendered).toContain("rotate that credential")
    }
    expect(html).toContain("answered 200")
    expect(json).toContain(fingerprint)
    expect(report.fixStated).toBe(true)
    // The finding handed in is the recorded one. Redaction copies; it does not edit it.
    expect(leak.explanation).toContain(token)
    expect(leak.proof.exchanges[0].request.headers[0].value).toContain(token)
  })
})
