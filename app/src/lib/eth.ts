// Amounts as the proof record holds them (wei, token units) in plain words.
// Pure, so a test can load it as is.

import { formatAmount } from "./amount.mjs"

// A wei amount (a decimal string, maybe signed) as ETH, by the shared rule in
// amount.mjs: exact when it fits, else rounded to the nearest and marked "≈",
// and in wei below a millionth of an ETH. `exact` is the record's wei, for the
// tooltip. `signed` adds "+" to a gain.
export function formatWei(wei: string, signed = false): Amount {
  return formatAmount(wei, { signed })
}
export type Amount = { text: string; exact: string; approx: boolean }

// The harm the proof gate recorded (spike/lib/proof.mjs harmFrom): what was
// lost, and how much. Null when the record has none.
export interface Harm {
  ok?: boolean
  kind: "funds" | "control"
  asset?: "token"
  victim?: string
  lostWei?: string
  token?: string
  lostUnits?: string
  // A token's symbol and decimals, when the record gives them.
  symbol?: string
  decimals?: number
  writes?: number
  targets?: { address: string; name: string }[]
}

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

// The harm as one sentence in three parts, so the amount can carry its own
// tooltip with the record's exact value: `lead`, then `amount` (or none), then
// `rest`. A token amount reads in the token's symbol when the record gives its
// decimals and symbol, else in the record's raw units.
export function harmText(
  harm: Harm | null | undefined,
): { lead: string; amount: Amount | null; rest: string } | null {
  if (!harm || harm.ok === false) return null
  const victim = harm.victim ? (harm.targets?.find((t) => t.address.toLowerCase() === harm.victim!.toLowerCase())?.name ?? short(harm.victim)) : "The target"
  if (harm.kind === "funds" && harm.asset === "token" && harm.lostUnits) {
    const token = harm.token ? ` of token ${short(harm.token)}` : ""
    const amount =
      harm.decimals != null && harm.symbol
        ? formatAmount(harm.lostUnits, { decimals: harm.decimals, unit: harm.symbol, baseUnit: "base units" })
        : formatAmount(harm.lostUnits, { decimals: 0, unit: "raw units", baseUnit: "raw units" })
    return { lead: `${victim} lost `, amount, rest: harm.decimals != null && harm.symbol ? "." : `${token}.` }
  }
  if (harm.kind === "funds" && harm.lostWei) return { lead: `${victim} lost `, amount: formatWei(harm.lostWei), rest: "." }
  if (harm.kind === "control") {
    const n = harm.writes ?? 0
    return { lead: `${victim} was taken over: the replay wrote ${n} control ${n === 1 ? "slot" : "slots"} (owner, admin or implementation).`, amount: null, rest: "" }
  }
  return null
}
