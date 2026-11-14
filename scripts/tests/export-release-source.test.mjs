import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportReleaseSource } from "../export-release-source.mjs";

test("release input retains exact source commit but excludes history and private blobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-input-"));
  const repo = join(dir, "repo"), target = join(dir, "target"), output = join(dir, "source.pack");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
  }).toString().trim();
  try {
    mkdirSync(repo); mkdirSync(target);
    git(repo, "init", "-q");
    writeFileSync(join(repo, "old.txt"), "old private content");
    git(repo, "add", "."); git(repo, "commit", "-qm", "old");
    const parent = git(repo, "rev-parse", "HEAD"), oldBlob = git(repo, "rev-parse", "HEAD:old.txt");
    rmSync(join(repo, "old.txt"));
    mkdirSync(join(repo, "app")); mkdirSync(join(repo, "spike", "data"), { recursive: true });
    writeFileSync(join(repo, "app", "source.mjs"), "export const value = 1;\n");
    writeFileSync(join(repo, "app", ".env.local"), "API_KEY=fixture-secret\n");
    writeFileSync(join(repo, "spike", "data", "providers.json"), '{"apiKey":"private-fixture"}');
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "release");
    const revision = git(repo, "rev-parse", "HEAD");
    const secret = git(repo, "rev-parse", "HEAD:app/.env.local");
    const provider = git(repo, "rev-parse", "HEAD:spike/data/providers.json");
    const result = exportReleaseSource({ repo, revision, output });
    assert.equal(result.files, 1);
    git(target, "init", "-q");
    execFileSync("git", ["-C", target, "index-pack", "--stdin"], { input: readFileSync(output) });
    assert.equal(git(target, "rev-parse", `${revision}^{commit}`), revision);
    assert.equal(git(target, "show", `${revision}:app/source.mjs`), "export const value = 1;");
    assert.match(git(target, "ls-tree", "-r", revision), /app\/source\.mjs/);
    for (const object of [parent, oldBlob, secret, provider]) {
      assert.notEqual(spawnSync("git", ["-C", target, "cat-file", "-e", object]).status, 0);
    }
    assert.throws(() => exportReleaseSource({ repo, revision, output }), /EEXIST/);
    chmodSync(dir, 0o777);
    assert.throws(() => exportReleaseSource({ repo, revision, output: join(dir, "another.pack") }), /private/);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
