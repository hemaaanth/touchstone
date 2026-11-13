// K5: the proof shows what was lost and how much, from the proof record.
import { test } from "node:test"
import assert from "node:assert/strict"
import { formatWei, harmText } from "./eth"

test("a wei amount reads in ETH, and a dust amount in wei, never as 0 ETH", () => {
  assert.equal(formatWei("9945000000000000000"), "9.945 ETH")
  assert.equal(formatWei("10000000000000000000", true), "+10 ETH")
  assert.equal(formatWei("-10000000000000000000", true), "-10 ETH")
  // The FeeVault RoundingTest moves: the record has 3980 and -1990 wei.
  assert.equal(formatWei("3980", true), "+3,980 wei")
  assert.equal(formatWei("-1990", true), "-1,990 wei")
  assert.equal(formatWei("0"), "0 ETH")
  assert.equal(formatWei("1234567890123456789012"), "1,234.56789 ETH")
})

const target = { address: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f", name: "FeeVault" }

test("the harm reads as what was lost: an ETH drain, a token drain, a control takeover", () => {
  // Real record shapes (run …2611110619-1 and spike/lib/proof.mjs).
  assert.deepEqual(harmText({ ok: true, kind: "funds", victim: target.address, lostWei: "9945000000000000000", targets: [target] }), {
    text: "FeeVault lost 9.945 ETH.",
    exact: "9945000000000000000 wei",
  })
  assert.deepEqual(harmText({ ok: true, kind: "control", victim: target.address, writes: 2, targets: [target] }), {
    text: "FeeVault was taken over: the replay wrote 2 control slots (owner, admin or implementation).",
    exact: null,
  })
  const token = harmText({ ok: true, kind: "funds", asset: "token", victim: target.address, token: "0x1111111111111111111111111111111111111111", lostUnits: "5000000", targets: [target] })
  assert.equal(token?.text, "FeeVault lost 5,000,000 raw units of token 0x1111…1111.")
  // A refused harm or none: nothing.
  assert.equal(harmText({ ok: false, kind: "funds" }), null)
  assert.equal(harmText(null), null)
})
