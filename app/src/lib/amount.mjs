// An on-chain amount as text, the one way the console and the shareable
// report write it. Plain JavaScript, so the server (report.mjs) and the app
// (src/lib/eth.ts) share it and never drift apart.
//
// The rule (a harm number must never read smaller or larger than the record
// without saying so):
// - Exact when the value needs at most six significant decimals:
//   "9.945 ETH", "1 ETH", "0.0000012 ETH".
// - Otherwise rounded to the nearest, never cut, at six significant decimals,
//   and marked "≈": "≈0.000002 ETH", "≈1.234568 ETH". Six significant digits
//   keep the shown value within 0.0005% of the record, far inside 0.1%.
// - Below a millionth of the unit it reads in the base unit, exact:
//   "3,980 wei", never "0 ETH".
// `exact` is the record's own value in the base unit, for the tooltip.

const SIG = 6

/**
 * @param {string} raw  the amount in base units, a decimal integer string, maybe signed
 * @param {{ decimals?: number, unit?: string, baseUnit?: string, signed?: boolean }} [opts]
 * @returns {{ text: string, exact: string, approx: boolean }}
 */
export function formatAmount(raw, { decimals = 18, unit = "ETH", baseUnit = "wei", signed = false } = {}) {
  let n
  try {
    n = BigInt(String(raw).trim())
  } catch {
    return { text: String(raw), exact: String(raw), approx: false }
  }
  const neg = n < 0n
  const abs = neg ? -n : n
  const sign = neg ? "-" : signed && abs > 0n ? "+" : ""
  const exact = `${sign}${abs.toLocaleString("en-US")} ${baseUnit}`
  if (abs === 0n) return { text: `0 ${unit}`, exact, approx: false }
  const scale = 10n ** BigInt(decimals)
  // Below a millionth of the unit: the base unit, exact.
  if (decimals > SIG && abs < scale / 10n ** BigInt(SIG)) return { text: exact, exact, approx: false }
  const whole = abs / scale
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "")
  const zeros = whole > 0n ? 0 : frac.length - frac.replace(/^0+/, "").length
  const fmt = (w, f) => `${w.toLocaleString("en-US")}${f ? `.${f}` : ""} ${unit}`
  // Exact: at most six significant decimals.
  if (frac.length - zeros <= SIG) return { text: `${sign}${fmt(whole, frac)}`, exact, approx: false }
  // Rounded to the nearest at six significant decimals, and marked.
  const keep = zeros + SIG
  const q = (abs * 10n ** BigInt(keep) + scale / 2n) / scale
  const w2 = q / 10n ** BigInt(keep)
  const f2 = (q % 10n ** BigInt(keep)).toString().padStart(keep, "0").replace(/0+$/, "")
  return { text: `≈${sign}${fmt(w2, f2)}`, exact, approx: true }
}
