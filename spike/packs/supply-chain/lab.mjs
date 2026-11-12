import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Wallet } from "ethers";

export async function makeLabWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "touchstone-supply-"));
  cpSync(new URL("./lab/", import.meta.url), ws, { recursive: true });
  // Touchstone's own .gitignore ignores node_modules/, so the plant is stored in lab/plant.
  // The lab workspace is a separate Git repo with no .gitignore. node_modules is committed there, so the scan reads it.
  mkdirSync(join(ws, "node_modules"));
  renameSync(join(ws, "plant/ethres"), join(ws, "node_modules/ethres"));
  rmSync(join(ws, "plant"), { recursive: true });
  const wallet = Wallet.createRandom();
  const deployer = Wallet.createRandom();
  writeFileSync(join(ws, "wallet.env"), `# Throwaway lab wallet. Never fund it.\nPRIVATE_KEY=${wallet.privateKey}\nMNEMONIC="${wallet.mnemonic.phrase}"\n`, { mode: 0o600 });
  writeFileSync(join(ws, "hardhat.config.js"), `// Throwaway lab config. Never deploy it.\nmodule.exports = { networks: { lab: {\n  url: "https://eth-mainnet.g.alchemy.com/v2/LabOnly_f63N8bcQ4mwJzP2hR7sV9xKa",\n  accounts: ["${deployer.privateKey}"]\n} } };\n`, { mode: 0o600 });
  writeFileSync(join(ws, "keystore.json"), await Wallet.createRandom().encrypt("throwaway-lab-password"), { mode: 0o600 });
  const git = (args) => execFileSync("git", ["-C", ws, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["-c", "user.name=Touchstone lab", "-c", "user.email=lab@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Pin throwaway supply-chain lab"]);
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ pack: "supply-chain", kind: "lab" }));
  return ws;
}
