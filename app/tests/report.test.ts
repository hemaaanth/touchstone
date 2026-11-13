import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
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
import { bundleRefusal, bundleText, evidenceReplay, leakShapes, loadReplayFiles, NOT_PROVEN_REFUSAL, planReplayBundle, replayStoreDir, snapshotForgeReplay, storeReplayFiles, vendoredLibs } from "../../spike/lib/replay-bundle.mjs"
// @ts-expect-error — resolved from spike/node_modules; the app does not depend on ethers
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
  test("a forge snapshot zips the project, one replay command, and no secrets", () => {
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
      const zip = buildReplayBundle({
        finding: { stages: { proven: true }, title: "Reentrancy drains the vault", proofKind: "forge", proof: { kind: "forge", pass: true, test: "testDrain()" } },
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
        expect(files.get("foundry.toml")).toContain('"${RPC_URL}"')
        expect(files.get("foundry.toml")).not.toContain(ALCHEMY_KEY)
        expect(files.get("src/Vault.sol")).toContain("// Authorization: Bearer [REDACTED]\n")
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
        expect(cmd.startsWith("sha256sum -c SHA256SUMS && ")).toBe(true)
        expect(cmd).toContain("--json -vvvv' > replay.json && ")
        expect(cmd.endsWith("node check-harm.mjs replay.json")).toBe(true)
        for (const name of ["SHA256SUMS", "harm.json", "check-harm.mjs"]) expect(files.has(name)).toBe(true)
        const sums = files.get("SHA256SUMS") || ""
        expect(sums).toContain("  test/AgentPoc.t.sol\n")
        expect(sums).toContain("  harm.json\n")
        expect(sums).not.toContain("README.md")
        execFileSync("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: dir, stdio: "ignore" })
        writeFileSync(path.join(dir, "test", "AgentPoc.t.sol"), `contract PocTest is Test { function testDrain() public { assertTrue(true); } }\n`)
        expect(() => execFileSync("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: dir, stdio: "ignore" })).toThrow()
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

  test("line 1 of a forge README says which harm kind the folder re-checks and which it does not", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-harmkind-"))
    try {
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest {}\n`)
      const replay = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      const victim = "0x00000000000000000000000000000000000000aa"
      const cases = [
        { harm: { ok: true, kind: "funds", victim, lostWei: "1" }, line: "The harm (an ETH drain) is re-checked by `check-harm.mjs`.", exit: 1 },
        { harm: { ok: true, kind: "funds", asset: "token", victim, token: "0x00000000000000000000000000000000000000bb", lostUnits: "5" }, line: "The harm (a token drain) is NOT re-checked by this folder.", exit: 2 },
        { harm: { ok: true, kind: "control", victim, writes: 1 }, line: "The harm (a control takeover: a write to an owner, admin, or implementation slot) is NOT re-checked by this folder.", exit: 2 },
      ]
      for (const c of cases) {
        const proof = { kind: "forge", pass: true, test: "testDrain()", harm: c.harm }
        const dir = mkdtempSync(path.join(tmpdir(), "replay-harmkind-zip-"))
        try {
          unzip(buildReplayBundle({ finding: { title: "t", proofKind: "forge", proof, stages: { proven: true } }, recorded: { replay, proof } }), dir)
          const readme = readTree(dir).get("README.md") || ""
          expect(readme.split("\n")[0]).toBe(`PROVEN: the engine's proof gate passed this finding when it was recorded. ${c.line}`)
          if (c.exit === 2) expect(readme).toContain("A passing replay here shows that the test still passes, not that the harm still happens.")
          // A trace that passes but moves no ETH: an ETH drain fails, the other kinds cannot be checked.
          writeFileSync(path.join(dir, "replay.json"), JSON.stringify({ "test/AgentPoc.t.sol:PocTest": { test_results: { "testDrain()": { status: "Success", traces: [] } } } }))
          let code = 0
          try {
            execFileSync("node", ["check-harm.mjs", "replay.json"], { cwd: dir, stdio: "ignore" })
          } catch (err) {
            code = (err as { status?: number }).status ?? -1
          }
          expect(code).toBe(c.exit)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("vendored forge-std ships byte for byte, the record keeps its hash, and no file in the zip is the cap mark", async () => {
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
      expect(readme.split("\n")[0]).toBe("PROVEN: the engine's proof gate passed this finding when it was recorded. The harm (an ETH drain) is re-checked by `check-harm.mjs`.")
      expect(commands(readme)).toHaveLength(2)
      expect(files.get("SHA256SUMS")).toContain("  lib/forge-std/src/safeconsole.sol\n")
      execFileSync("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: dir, stdio: "ignore" })
      // The store's copy is the source; with it gone the engine's copy serves.
      rmSync(path.join(store, "lib"), { recursive: true, force: true })
      expect(loadReplayFiles(kept, store).files.find((f: { path: string }) => f.path === "lib/forge-std/src/Vm.sol").text).toBe(files.get("lib/forge-std/src/Vm.sol"))
      // A vendored hash that neither the store nor the engine holds: left out, no command.
      const stale = { ...loaded, files: loaded.files.map((f: { path: string; vendored?: unknown }) => (f.path === "lib/forge-std/src/Vm.sol" ? { path: f.path, vendored: { lib: "forge-std", sha256: "0".repeat(64) } } : f)) }
      const out = mkdtempSync(path.join(tmpdir(), "replay-vendored-stale-"))
      try {
        unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "drain", proofKind: "forge", proof }, recorded: { replay: stale, proof } }), out)
        const r = readTree(out).get("README.md") || ""
        expect(r).toContain("- `lib/forge-std/src/Vm.sol` — a forge-std file that neither the record nor the engine holds any more")
        expect(commands(r)).toEqual([])
        expect(r.split("\n")[0]).toContain("This bundle cannot be re-run from this folder: 1 file was left out")
      } finally {
        rmSync(out, { recursive: true, force: true })
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(store, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The vault lab with its PoC: each case below breaks one thing the build needs.
  const skipCase = async (name: string, change: (ws: string) => void) => {
    const { makeWorkspace } = await import("../../spike/lib/sandbox.mjs")
    const lab = new URL("../../lab/vault-reentrancy/", import.meta.url).pathname
    const ws = makeWorkspace(lab)
    const dir = mkdtempSync(path.join(tmpdir(), `replay-skip-${name}-`))
    try {
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), readFileSync(path.join(lab, "oracle", "VaultExploit.t.sol"), "utf8"))
      change(ws)
      const snap = snapshotForgeReplay(ws, { contract: "VaultExploitTest", test: "test_reentrancy_drains_vault()" })
      const proof = { kind: "forge", pass: true, test: "test_reentrancy_drains_vault()", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "1" } }
      unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "drain", proofKind: "forge", proof }, recorded: { replay: snap, proof } }), dir)
      const files = readTree(dir)
      const readme = files.get("README.md") || ""
      return { snap, files, readme, line1: readme.split("\n")[0], cmds: commands(readme) }
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const NO_RERUN = "PROVEN: the engine's proof gate passed this finding when it was recorded. This bundle cannot be re-run from this folder: "

  test("skip case: the plain lab keeps its command (the baseline for the cases below)", async () => {
    const r = await skipCase("base", () => {})
    expect(r.snap.omitted).toEqual([])
    expect(r.cmds).toHaveLength(2)
  })

  test("skip case: an imported file that is a symbolic link is left out, and the bundle has no command", async () => {
    const r = await skipCase("link", (ws) => {
      const f = path.join(ws, "lib/forge-std/src/StdMath.sol")
      const copy = path.join(ws, "StdMath.copy")
      renameSync(f, copy)
      symlinkSync(copy, f)
    })
    expect(r.snap.omitted.find((o: { path: string }) => o.path === "lib/forge-std/src/StdMath.sol")?.reason).toMatch(/^imported by lib\/forge-std\/src\/\w+\.sol, but a symbolic link; not followed$/)
    expect(r.files.has("lib/forge-std/src/StdMath.sol")).toBe(false)
    expect(r.cmds).toEqual([])
    expect(r.line1.startsWith(NO_RERUN)).toBe(true)
  })

  test("skip case: an import through remappings into node_modules is left out, and the bundle has no command", async () => {
    const r = await skipCase("node-modules", (ws) => {
      mkdirSync(path.join(ws, "node_modules/@acme/lib"), { recursive: true })
      writeFileSync(path.join(ws, "node_modules/@acme/lib/Acme.sol"), "library Acme {}\n")
      writeFileSync(path.join(ws, "remappings.txt"), "@acme/=node_modules/@acme/\n")
      const poc = path.join(ws, "test", "AgentPoc.t.sol")
      writeFileSync(poc, `import "@acme/lib/Acme.sol";\n${readFileSync(poc, "utf8")}`)
    })
    expect(r.snap.omitted).toContainEqual({ path: "node_modules/@acme/lib/Acme.sol", reason: "imported by test/AgentPoc.t.sol, but node_modules/ is not included" })
    expect(r.files.has("node_modules/@acme/lib/Acme.sol")).toBe(false)
    expect(r.cmds).toEqual([])
  })

  test("skip case: an import into a hidden folder is left out, and the bundle has no command", async () => {
    const r = await skipCase("hidden", (ws) => {
      mkdirSync(path.join(ws, "src/.deps"), { recursive: true })
      writeFileSync(path.join(ws, "src/.deps/Dep.sol"), "library Dep {}\n")
      const v = path.join(ws, "src", "Vault.sol")
      writeFileSync(v, readFileSync(v, "utf8").replace(/(pragma solidity[^;]*;)/, '$1\nimport "./.deps/Dep.sol";'))
    })
    expect(r.snap.omitted).toContainEqual({ path: "src/.deps/Dep.sol", reason: "imported by src/Vault.sol, but a hidden folder; not included" })
    expect(r.cmds).toEqual([])
  })

  test("skip case: an import into a library's test folder is left out, and the bundle has no command", async () => {
    const r = await skipCase("libtest", (ws) => {
      mkdirSync(path.join(ws, "lib/forge-std/test/utils"), { recursive: true })
      writeFileSync(path.join(ws, "lib/forge-std/test/utils/Helper.sol"), "library Helper {}\n")
      const poc = path.join(ws, "test", "AgentPoc.t.sol")
      writeFileSync(poc, `import "forge-std/../test/utils/Helper.sol";\n${readFileSync(poc, "utf8")}`)
    })
    expect(r.snap.omitted).toContainEqual({ path: "lib/forge-std/test/utils/Helper.sol", reason: "imported by test/AgentPoc.t.sol, but a library's test folder is not included" })
    expect(r.cmds).toEqual([])
  })

  test("skip case: an imported file that cannot be read is left out, and the bundle has no command", async () => {
    let locked = ""
    try {
      const r = await skipCase("unreadable", (ws) => {
        locked = path.join(ws, "lib/forge-std/src/StdMath.sol")
        chmodSync(locked, 0o000)
      })
      expect(r.snap.omitted).toContainEqual({ path: "lib/forge-std/src/StdMath.sol", reason: "a file that could not be read" })
      expect(r.cmds).toEqual([])
    } finally {
      if (locked) try { chmodSync(locked, 0o644) } catch {}
    }
  })

  test("skip case: an imported path that is not a regular file is left out, and the bundle has no command", async () => {
    const r = await skipCase("fifo", (ws) => {
      const f = path.join(ws, "lib/forge-std/src/StdMath.sol")
      rmSync(f)
      execFileSync("mkfifo", [f])
    })
    expect(r.snap.omitted.find((o: { path: string }) => o.path === "lib/forge-std/src/StdMath.sol")?.reason).toMatch(/^imported by lib\/forge-std\/src\/\w+\.sol, but not a regular file$/)
    expect(r.cmds).toEqual([])
  })

  test("skip case: a proof that reads a file at run time has no command", async () => {
    const r = await skipCase("readfile", (ws) => {
      const poc = path.join(ws, "test", "AgentPoc.t.sol")
      writeFileSync(poc, readFileSync(poc, "utf8").replace(/(function test_reentrancy_drains_vault\(\)[^{]*\{)/, '$1 vm.readFile("fixtures/x.json");'))
    })
    expect(r.snap.runtimeReads).toEqual(["test/AgentPoc.t.sol calls vm.readFile, and this folder holds only the .sol and config files"])
    expect(r.cmds).toEqual([])
    expect(r.line1).toBe(`${NO_RERUN}test/AgentPoc.t.sol calls vm.readFile, and this folder holds only the .sol and config files.`)
  })

  test("skip case: a skip that no source imports cannot matter, and the command stays", async () => {
    const r = await skipCase("unused", (ws) => {
      mkdirSync(path.join(ws, "node_modules/x"), { recursive: true })
      writeFileSync(path.join(ws, "node_modules/x/Unused.sol"), "library Unused {}\n")
      symlinkSync(path.join(ws, "src", "Vault.sol"), path.join(ws, "src", "VaultLink.sol"))
      writeFileSync(path.join(ws, "src", ".Hidden.sol"), "library Hidden {}\n")
    })
    expect(r.snap.omitted).toEqual([])
    expect(r.cmds).toHaveLength(2)
  })

  test("skip case: at bundle time an old record that lost an imported file gets no command", async () => {
    const { makeWorkspace } = await import("../../spike/lib/sandbox.mjs")
    const lab = new URL("../../lab/vault-reentrancy/", import.meta.url).pathname
    const ws = makeWorkspace(lab)
    const dir = mkdtempSync(path.join(tmpdir(), "replay-skip-old-"))
    try {
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), readFileSync(path.join(lab, "oracle", "VaultExploit.t.sol"), "utf8"))
      const snap = snapshotForgeReplay(ws, { contract: "VaultExploitTest", test: "test_reentrancy_drains_vault()" })
      const old = { ...snap, files: snap.files.filter((f: { path: string }) => f.path !== "src/Vault.sol") }
      const proof = { kind: "forge", pass: true, test: "test_reentrancy_drains_vault()" }
      unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "drain", proofKind: "forge", proof }, recorded: { replay: old, proof } }), dir)
      const readme = readTree(dir).get("README.md") || ""
      expect(readme).toContain("- `src/Vault.sol` — imported by test/AgentPoc.t.sol, but it is not in this folder")
      expect(commands(readme)).toEqual([])
    } finally {
      rmSync(ws, { recursive: true, force: true })
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

  test("a source file over the redactor's cap, or one left out for a secret, leaves the bundle with no command", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-overcap-"))
    try {
      mkdirSync(path.join(ws, "src"))
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", "Big.sol"), `contract Big {\n${"  uint256 public a;\n".repeat(4000)}}\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest is Test { function testDrain() public {} }\n`)
      const snap = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      expect(snap.omitted).toEqual([{ path: "src/Big.sol", reason: "over 64 KB, so the redactor cannot check it" }])
      expect(snap.command).toBeNull()
      const proof = { kind: "forge", pass: true, test: "testDrain()", harm: { ok: true, kind: "funds", victim: "0x" + "aa".repeat(20), lostWei: "1" } }
      const readmeOf = (replay: unknown) => {
        const d = mkdtempSync(path.join(tmpdir(), "replay-overcap-zip-"))
        try {
          unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay, proof } }), d)
          const files = readTree(d)
          for (const [name, text] of files) expect([name, text.includes("too long to check")]).toEqual([name, false])
          expect(files.has("src/Big.sol")).toBe(false)
          expect(files.has("check-harm.mjs")).toBe(false)
          return files.get("README.md") || ""
        } finally {
          rmSync(d, { recursive: true, force: true })
        }
      }
      const readme = readmeOf(snap)
      expect(readme.split("\n")[0]).toBe('PROVEN: the engine\'s proof gate passed this finding when it was recorded. This bundle cannot be re-run from this folder: 1 file was left out (see "Left out").')
      expect(commands(readme)).toEqual([])
      expect(readme).toContain("- `src/Big.sol` — over 64 KB, so the redactor cannot check it")
      // An old record that holds the mark in place of code is caught at bundle time.
      const old = { ...snap, omitted: [], files: [...snap.files, { path: "src/Big.sol", text: "[REDACTED: text of 76012 characters too long to check]" }] }
      expect(readmeOf(old)).toContain("- `src/Big.sol` — over 64 KB, so the redactor cannot check it")
      // A file left out for a secret also leaves no command.
      rmSync(path.join(ws, "src", "Big.sol"))
      writeFileSync(path.join(ws, "src", "Key.sol"), `// ${PEM}\ncontract Key {}\n`)
      const withKey = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      expect(withKey.omitted).toEqual([{ path: "src/Key.sol", reason: "secret file" }])
      expect(commands(readmeOf(withKey))).toEqual([])
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }

    // A request script over the cap is left out, and there is no rerun.
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

  test("the header and name checks ask the redactor: code is kept, a header value it would mask is refused", () => {
    // From the real web record that the old check refused: a variable, not a value.
    expect(leakShapes('    headers: { Authorization: "Bearer " + a.d.token }')).toEqual([])
    expect(leakShapes('fetch(u, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } })')).toEqual([])
    // The bundle redacts first; what the redactor masks there, the check never sees.
    expect(leakShapes(bundleText("x-api-key: process.env.API_KEY"))).toEqual([])
    // A value the redactor masks on a bare line is a leak when the text kept it.
    expect(leakShapes(`"note": "send Authorization: Bearer ${BEARER}"`)).toContain("a header in text")
  })

  test("a path the redactor would mask is left out and named by a placeholder, never shipped", () => {
    // Made up.
    const stripe = "sk_live_51Hq7Lm2Xp9Rt4Vw8Zb3Nc6Kd"
    const github = "ghp_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"
    const ws = mkdtempSync(path.join(tmpdir(), "replay-paths-"))
    try {
      mkdirSync(path.join(ws, "src", `${github}`), { recursive: true })
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`)
      writeFileSync(path.join(ws, "src", `key-${stripe}.sol`), "contract A {}\n")
      writeFileSync(path.join(ws, "src", github, "B.sol"), "contract B {}\n")
      writeFileSync(path.join(ws, "src", "Vault.sol"), "contract Vault {}\n")
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), "contract PocTest {}\n")
      const snap = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      const record = JSON.stringify(snap)
      expect(record.includes(stripe)).toBe(false)
      expect(record.includes(github)).toBe(false)
      expect(snap.omitted).toEqual([
        { path: "[REDACTED]", reason: "its path holds a value the redactor masks" },
        { path: "[REDACTED]", reason: "its path holds a value the redactor masks" },
      ])
      const proof = { kind: "forge", pass: true, test: "testDrain()" }
      const zip = buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay: snap, proof } })
      expect(zip.includes(stripe)).toBe(false)
      expect(zip.includes(github)).toBe(false)
      // An old record that names such a path inline gets the same rule.
      const old = { ...snap, omitted: [{ path: `src/key-${stripe}.sol`, reason: "binary" }], files: [...snap.files, { path: `src/${github}/C.sol`, text: "contract C {}\n" }] }
      const again = buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof }, recorded: { replay: old, proof } })
      expect(again.includes(stripe)).toBe(false)
      expect(again.includes(github)).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
    expect(evidenceReplay({ snapshotHash: "a".repeat(64), snapshot: { files: { [`keys/${stripe}.txt`]: "x", "README.md": "y" } } }).snapshotFiles).toEqual(["[REDACTED]", "README.md"])
  })

  test("check-harm.mjs passes only when the replay moves the recorded wei", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-harm-"))
    const dir = mkdtempSync(path.join(tmpdir(), "replay-harm-zip-"))
    try {
      mkdirSync(path.join(ws, "test"))
      writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\n`)
      writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), `contract PocTest {}\n`)
      const replay = snapshotForgeReplay(ws, { contract: "PocTest", test: "testDrain()" })
      const vault = "0x00000000000000000000000000000000000000aa"
      const proof = { kind: "forge", pass: true, test: "testDrain()", harm: { ok: true, kind: "funds", victim: vault, lostWei: "1000000000000000000" } }
      unzip(buildReplayBundle({ finding: { stages: { proven: true }, title: "drain", proofKind: "forge", proof }, recorded: { replay, proof } }), dir)
      const trace = (wei: string, status = "Success") => ({
        "test/AgentPoc.t.sol:PocTest": { test_results: { "testDrain()": { status, traces: [["Execution", { arena: [
          { parent: null, trace: { kind: "CALL", address: "0x00000000000000000000000000000000000000bb", caller: "0x00000000000000000000000000000000000000cc", success: true, value: "0x0" } },
          { parent: 0, trace: { kind: "CALL", address: "0x00000000000000000000000000000000000000dd", caller: vault, success: true, value: wei } },
        ] }]] } } },
      })
      const check = (body: unknown) => {
        writeFileSync(path.join(dir, "replay.json"), JSON.stringify(body))
        try {
          execFileSync("node", ["check-harm.mjs", "replay.json"], { cwd: dir, stdio: "ignore" })
          return 0
        } catch (err) {
          return (err as { status?: number }).status ?? -1
        }
      }
      expect(check(trace("0xde0b6b3a7640000"))).toBe(0)
      expect(check(trace("0x1"))).toBe(1)
      expect(check(trace("0xde0b6b3a7640000", "Failure"))).toBe(1)
      expect(check({})).toBe(1)
      const harm = JSON.parse(readFileSync(path.join(dir, "harm.json"), "utf8"))
      writeFileSync(path.join(dir, "harm.json"), JSON.stringify({ ...harm, harm: { ok: true, kind: "control", victim: vault } }))
      expect(check(trace("0xde0b6b3a7640000"))).toBe(2)
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
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
      let err: { refused?: boolean; name?: string; message?: string } | null = null
      try {
        buildReplayBundle({ finding: { stages: { proven: true }, title: "leak", proofKind: "http", script: "await request(\"GET\", \"/\");\n", proof }, recorded: { proof, pack: "web" } })
      } catch (e) {
        err = e as typeof err
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
        expect(section(files.get("README.md") || "", "Replay (offline)")).toContain("forge test --offline")
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
      expect(readme).toContain("The replay files of this run are gone: the replay file does not match the hash in the record.")
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
      // The record keeps the paths and the store pointer; the files come back from the store.
      expect(f.proof.replay.files).toBeUndefined()
      for (const rel of ["src/Vault.sol", "foundry.toml", "test/AgentPoc.t.sol", "lib/forge-std/src/Vm.sol"]) expect(f.proof.replay.paths).toContain(rel)
      const replay = loadReplayFiles(f.proof.replay)
      expect(replay.filesLost).toBeUndefined()
      const zip = buildReplayBundle({
        finding: { stages: { proven: true }, title: f.title, proofKind: "forge", proof: f.proof },
        recorded: { proof: f.proof, replay, pocProved: true },
      })
      unzip(zip, dir)
      // forge-std ships as the engine installs it, so the proof compiles.
      for (const rel of ["lib/forge-std/src/Vm.sol", "lib/forge-std/src/console.sol", "lib/forge-std/src/safeconsole.sol"]) {
        expect(readFileSync(path.join(dir, rel), "utf8")).toBe(readFileSync(path.join(lab, rel), "utf8"))
      }
      const readme = readFileSync(path.join(dir, "README.md"), "utf8")
      const cmd = section(readme, "Replay (offline)") || ""
      expect(cmd.startsWith("sha256sum -c SHA256SUMS && \\\n  docker run --rm --pull never --network none ")).toBe(true)
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
      expect(f.proof.harm.kind).toBe("funds")
      expect(out).toContain(`OK: test_reentrancy_drains_vault() passed and ${f.proof.harm.victim} lost ${f.proof.harm.lostWei} wei`)
      // A PoC that only asserts true still passes forge. With the sums redone
      // to hide the edit, the harm check must still refuse it.
      const poc = path.join(dir, "test", "AgentPoc.t.sol")
      const body = readFileSync(poc, "utf8")
      writeFileSync(poc, body.replace(/(function test_reentrancy_drains_vault\(\)[^{]*\{)/, "$1 assertTrue(true); return;"))
      expect(readFileSync(poc, "utf8")).not.toBe(body)
      expect(() => execFileSync("sha256sum", ["-c", "--quiet", "SHA256SUMS"], { cwd: dir, stdio: "ignore" })).toThrow()
      execFileSync("bash", ["-c", "sha256sum test/AgentPoc.t.sol > .sum && grep -v '  test/AgentPoc.t.sol$' SHA256SUMS >> .sum && mv .sum SHA256SUMS"], { cwd: dir })
      let tampered = 0
      try {
        execFileSync("bash", ["-c", run], { cwd: dir, stdio: "ignore", timeout: 300_000 })
      } catch (err) {
        tampered = (err as { status?: number }).status ?? -1
      }
      expect(tampered).toBe(1)
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
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
