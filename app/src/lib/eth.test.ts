// K5: the proof says what was lost and how much, from the proof record, and a
// harm number never reads smaller or larger than the record without saying so.
import { test } from "node:test"
import assert from "node:assert/strict"
import { formatWei, harmText } from "./eth"
import { formatAmount } from "./amount.mjs"

// The shown number, read back: "≈1,234.567 ETH" -> 1234.567.
const shownEth = (text: string) => Number(text.replace(/^≈/, "").replace(/[+,]/g, "").replace(/ ETH$/, ""))
// An exact ETH text back to wei, with no float in between: "9.945 ETH" -> 9945…
const textToWei = (text: string) => {
  const [w, f = ""] = text.replace(/[+,]/g, "").replace(/ ETH$/, "").split(".")
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, "0"))
}
// Within 0.1% of the record's wei.
const close = (text: string, wei: string) => {
  const shown = shownEth(text) * 1e18
  const truth = Number(wei)
  return Math.abs(shown - truth) <= Math.abs(truth) * 0.001
}

test("a wei amount: exact when it fits, else rounded to the nearest and marked, never cut", () => {
  const cases: [wei: string, text: string, approx: boolean][] = [
    // The reviewer's value: 0.000001999999999999 ETH. Cut, it read 0.000001.
    ["1999999999999", "≈0.000002 ETH", true],
    ["1", "1 wei", false],
    ["999999999999999999", "≈1 ETH", true],
    ["1000000000000000000", "1 ETH", false],
    ["9945000000000000000", "9.945 ETH", false],
    // 18 significant decimals.
    ["1234567890123456789", "≈1.234568 ETH", true],
    // Very large.
    ["123456789012345678901234567890", "≈123,456,789,012.345679 ETH", true],
    // Up to six significant decimals stay exact, however small.
    ["1200000000000", "0.0000012 ETH", false],
  ]
  for (const [wei, text, approx] of cases) {
    const a = formatWei(wei)
    assert.equal(a.text, text, wei)
    assert.equal(a.approx, approx, wei)
    assert.equal(a.exact, `${BigInt(wei).toLocaleString("en-US")} wei`, wei)
    if (approx) assert.ok(close(a.text, wei), `${a.text} is within 0.1% of ${wei} wei`)
    // An exact text reads back to the record's wei, digit for digit.
    else if (!a.text.endsWith(" wei")) assert.equal(textToWei(a.text), BigInt(wei), wei)
  }
})

test("signed moves: a gain has +, dust reads in wei, never as 0 ETH", () => {
  // The FeeVault RoundingTest moves: the record has 3980 and -1990 wei.
  assert.equal(formatWei("3980", true).text, "+3,980 wei")
  assert.equal(formatWei("-1990", true).text, "-1,990 wei")
  assert.equal(formatWei("10000000000000000000", true).text, "+10 ETH")
  assert.equal(formatWei("-1999999999999999999", true).text, "≈-2 ETH")
  assert.equal(formatWei("0").text, "0 ETH")
})

test("a token amount with known decimals follows the same rule", () => {
  assert.deepEqual(formatAmount("1500000", { decimals: 6, unit: "USDC", baseUnit: "base units" }), { text: "1.5 USDC", exact: "1,500,000 base units", approx: false })
  const usdc = formatAmount("1234567891", { decimals: 6, unit: "USDC", baseUnit: "base units" })
  assert.equal(usdc.text, "1,234.567891 USDC")
  const dai = formatAmount("1999999999999999999", { decimals: 18, unit: "DAI", baseUnit: "base units" })
  assert.deepEqual([dai.text, dai.approx], ["≈2 DAI", true])
})

const target = { address: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f", name: "FeeVault" }

test("the harm reads as what was lost: an ETH drain, a token drain, a control takeover", () => {
  // Real record shapes (run …2611110619-1 and spike/lib/proof.mjs).
  const drain = harmText({ ok: true, kind: "funds", victim: target.address, lostWei: "9945000000000000000", targets: [target] })
  assert.equal(drain?.lead, "FeeVault lost ")
  assert.equal(drain?.amount?.text, "9.945 ETH")
  assert.equal(drain?.amount?.exact, "9,945,000,000,000,000,000 wei")
  assert.equal(drain?.rest, ".")
  // The reviewer's value: rounded and marked, not cut to 0.000001.
  assert.equal(harmText({ ok: true, kind: "funds", victim: target.address, lostWei: "1999999999999", targets: [target] })?.amount?.text, "≈0.000002 ETH")
  const control = harmText({ ok: true, kind: "control", victim: target.address, writes: 2, targets: [target] })
  assert.equal(control?.lead, "FeeVault was taken over: the replay wrote 2 control slots (owner, admin or implementation).")
  assert.equal(control?.amount, null)
  const raw = harmText({ ok: true, kind: "funds", asset: "token", victim: target.address, token: "0x1111111111111111111111111111111111111111", lostUnits: "5000000", targets: [target] })
  assert.equal(`${raw?.lead}${raw?.amount?.text}${raw?.rest}`, "FeeVault lost 5,000,000 raw units of token 0x1111…1111.")
  const known = harmText({ ok: true, kind: "funds", asset: "token", victim: target.address, lostUnits: "1500000", decimals: 6, symbol: "USDC", targets: [target] })
  assert.equal(`${known?.lead}${known?.amount?.text}${known?.rest}`, "FeeVault lost 1.5 USDC.")
  assert.equal(harmText({ ok: false, kind: "funds" }), null)
  assert.equal(harmText(null), null)
})
