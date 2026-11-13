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
      writeFileSync(path.join(ws, "src", "Deploy.sol"), `contract Deploy { uint256 constant PRIVATE_KEY = ${V.privateKey}; }\n`)
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
      expect(chains).toContain("// Cookie: [REDACTED]\n")
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
          { path: "src/OldDeploy.sol", text: `contract OldDeploy { uint256 constant PRIVATE_KEY = ${V.privateKey}; }\n` },
        ],
      }
      const zip = buildReplayBundle({
        finding: { title: "Reentrancy drains the vault", proofKind: "forge", proof: { kind: "forge", pass: true, test: "testDrain()" } },
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
      unzip(buildReplayBundle({ finding: { title: "drain", proofKind: "forge", proof }, recorded: { replay, proof } }), dir)
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

  test("the README's first line says PROVEN only for a proven finding", () => {
    const firstLine = (zip: Buffer) => {
      const dir = mkdtempSync(path.join(tmpdir(), "replay-verdict-"))
      try {
        unzip(zip, dir)
        return (readTree(dir).get("README.md") || "").split("\n")[0]
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    const lead = { ...forgeFinding, stages: { ...forgeFinding.stages, proven: false } }
    expect(firstLine(buildReplayBundle({ finding: forgeFinding }))).toMatch(/^PROVEN: /)
    expect(firstLine(buildReplayBundle({ finding: lead }))).toMatch(/^NOT PROVEN: /)
    // The app's verdict wins over a raw record that claims a pass.
    expect(firstLine(buildReplayBundle({ finding: lead, recorded: { pocProved: true, proof: forgeFinding.proof } }))).toMatch(/^NOT PROVEN: /)
    // A raw candidate with no app verdict: only pocProved === true is proven.
    const { stages: _stages, ...candidate } = forgeFinding
    expect(firstLine(buildReplayBundle({ finding: candidate }))).toMatch(/^NOT PROVEN: /)
    expect(firstLine(buildReplayBundle({ finding: candidate, recorded: { pocProved: false, proof: forgeFinding.proof } }))).toMatch(/^NOT PROVEN: /)
    expect(firstLine(buildReplayBundle({ finding: candidate, recorded: { pocProved: true, proof: forgeFinding.proof } }))).toMatch(/^PROVEN: /)
    const http = { title: "IDOR", proofKind: "http", proof: { kind: "http", status: "pass" } }
    expect(firstLine(buildReplayBundle({ finding: { ...http, stages: { proven: false } } }))).toMatch(/^NOT PROVEN: /)
    expect(firstLine(buildReplayBundle({ finding: { ...http, stages: { proven: true } } }))).toMatch(/^PROVEN: /)
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
      finding: { title: "IDOR", proofKind: "http", script, proof },
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
      expect(JSON.parse(files.get("rerun.json") || "")).toEqual({ pack: "web", image: "touchstone/web-lab:dev", oracle: "debug-route-signer-key-leak" })
      expect(files.get("script.mjs")).toBe(script)
      expect(files.get("rerun.mjs")).toBe(readFileSync(new URL("../../spike/lib/replay-http-rerun.mjs", import.meta.url), "utf8"))
      expect(files.get("proof-http.mjs")).toBe(readFileSync(new URL("../../spike/lib/proof-http.mjs", import.meta.url), "utf8"))
      const transcript = JSON.parse(files.get("transcript.json") || "")
      expect(transcript[0].request.url).toBe("http://origin:8080/internal/debug/config")
      expect(transcript[0].response.body.signerPrivateKey).toBe("[REDACTED]")
      const sums = files.get("SHA256SUMS") || ""
      for (const name of ["script.mjs", "rerun.json", "rerun.mjs", "proof-http.mjs", "transcript.json", "proof.json"]) expect(sums).toContain(`  ${name}\n`)
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
    const zip = buildReplayBundle({ finding: { title: "admin page", proofKind: "http", script, proof }, recorded: { script, proof, pack: "web" } })
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
        buildReplayBundle({ finding: { title: "leak", proofKind: "http", script: "await request(\"GET\", \"/\");\n", proof }, recorded: { proof, pack: "web" } })
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
