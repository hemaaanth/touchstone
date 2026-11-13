// A live scope saved with no permission (an old or hand-edited scope file) is
// refused by the reach gate. It never borrows another scope's covering grant.
//
//   node --test spike/test/reach-permission.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const { addLiveScope } = await import("../lib/scopes-store.mjs");
const { getTarget } = await import("../lib/targets.mjs");
const { enforceReach } = await import("../lib/reach.mjs");
const SCOPES = process.env.TOUCHSTONE_SCOPES_FILE;

test("a saved live scope with no permission is refused, though another scope's grant covers its host", () => {
  // Another scope's tick: a grant that covers app.example.com.
  addLiveScope({ title: "other", hosts: ["app.example.com"], pack: "web", permission: true });
  // A second scope for the same host, then its permission is removed by hand.
  const mine = addLiveScope({ title: "mine", hosts: ["app.example.com"], pack: "web", permission: true });
  const all = JSON.parse(readFileSync(SCOPES, "utf8"));
  delete all.find((s) => s.id === mine.id).permission;
  writeFileSync(SCOPES, JSON.stringify(all));

  const target = getTarget(mine.id);
  assert.equal(target.permission, undefined);
  assert.throws(() => enforceReach(target), /^Error: Refused: this live scope has no saved permission, so no grant counts for it\. Add the scope again and tick the permission box\.$/);
});

test("a direct call with a host list (no saved scope) keeps the old rule: any covering grant", () => {
  const gate = enforceReach({ id: "direct-call", kind: "live", hosts: ["app.example.com"] });
  assert.deepEqual(gate.hosts, ["app.example.com"]);
  assert.ok(gate.grants.length >= 1);
});

test("a resumed run keeps only its own saved grants, with or without the scope's permission", () => {
  const s = addLiveScope({ title: "resumed", hosts: ["shop.example.com"], pack: "web", permission: true });
  const grantId = s.permission.grantId;
  const all = JSON.parse(readFileSync(SCOPES, "utf8"));
  delete all.find((x) => x.id === s.id).permission;
  writeFileSync(SCOPES, JSON.stringify(all));
  assert.deepEqual(enforceReach(getTarget(s.id), { grantIds: [grantId] }).grants.map((g) => g.id), [grantId]);
});
