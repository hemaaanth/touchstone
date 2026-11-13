// Which scope members a run read, from its source-fetch events. Pure, offline.
//
//   node --test spike/test/source-coverage.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceCoverage, coverageFailure } from "../lib/source-coverage.mjs";

const A = "https://github.com/cosmos/cosmos-sdk";
const B = "https://github.com/cosmos/cosmos-sdk/tree/main/x/bank";
const ok = (url, where, files) => ({ ev: "source-fetch", url, ok: true, where, files });
const no = (url, error) => ({ ev: "source-fetch", url, ok: false, error });

test("no GitHub members means no coverage to check", () => {
  assert.equal(sourceCoverage([], []), null);
  assert.equal(sourceCoverage(["https://example.com/docs", "not a url"], []), null);
  assert.equal(coverageFailure(null), null);
});

test("each member is fetched, refused or not fetched; a member counts as read once any attempt landed", () => {
  const cov = sourceCoverage([A + "/", A + ".git", B], [
    no(A, "cosmos/cosmos-sdk would bring this scope to 3053 source files (the cap is 200)"),
    ok(B, "vendor/cosmos__cosmos-sdk@main/x/bank", 40),
    { ev: "source-fetch", url: "https://github.com/other/repo", ok: true, where: "vendor/x", files: 1 },
  ]);
  assert.deepEqual(cov.members.map((m) => [m.url, m.status]), [[A, "refused"], [B, "fetched"]]);
  assert.deepEqual([cov.fetched, cov.total, cov.complete], [1, 2, false]);
  const later = sourceCoverage([A], [no(A, "clone timed out"), ok(A, "vendor/cosmos__cosmos-sdk", 120)]);
  assert.equal(later.complete, true);
  assert.deepEqual(sourceCoverage([A], []).members[0].status, "not-fetched");
  // A failed refetch keeps the earlier copy on disk (lib/fetch.mjs), so it does not undo a good fetch.
  const refetch = sourceCoverage([A], [ok(A, "vendor/cosmos__cosmos-sdk", 120), no(A, "clone timed out"), no(A, "would bring this scope to 260 source files (the cap is 200)")]);
  assert.deepEqual([refetch.members[0].status, refetch.members[0].where, refetch.members[0].files, refetch.complete], ["fetched", "vendor/cosmos__cosmos-sdk", 120, true]);
});

test("a gap becomes a coverage error that lists what was read and what was not", () => {
  const cov = sourceCoverage([A, B], [no(A, "3053 source files (the cap is 200)"), ok(B, "vendor/cosmos__cosmos-sdk@main/x/bank", 40)]);
  const info = coverageFailure(cov, { spentUsd: 0.25 });
  assert.equal(info.kind, "coverage");
  assert.equal(info.retryable, false);
  assert.equal(info.spentUsd, 0.25);
  assert.equal(info.title, "Part of the scope was not read");
  assert.match(info.detail, /Read:\n- .*x\/bank → vendor\/cosmos__cosmos-sdk@main\/x\/bank \(40 files\)/);
  assert.match(info.detail, /Not read:\n- https:\/\/github\.com\/cosmos\/cosmos-sdk: 3053 source files/);
  assert.match(info.message, /1 of 2 scope members were not read/);
  assert.match(info.hint, /tree\/<branch>\/<folder>/);
  assert.equal(coverageFailure(sourceCoverage([A], [])).title, "The scope was not read");
  assert.equal(coverageFailure(sourceCoverage([B], [ok(B, "v", 1)])), null);
});

test("links past the 20-member limit count as not read, so the brief never ends clean", () => {
  const links = Array.from({ length: 22 }, (_, i) => `https://github.com/o/r${i}`);
  const cov = sourceCoverage(links, links.slice(0, 20).map((u, i) => ok(u, `vendor/o__r${i}`, 1)));
  assert.deepEqual([cov.fetched, cov.total, cov.complete], [20, 22, false]);
  assert.deepEqual(cov.members.slice(20).map((m) => [m.url, m.status, m.reason]), [
    ["https://github.com/o/r20", "not-fetched", "over the 20-member limit"],
    ["https://github.com/o/r21", "not-fetched", "over the 20-member limit"],
  ]);
  assert.match(coverageFailure(cov).message, /2 of 22 scope members were not read/);
});
