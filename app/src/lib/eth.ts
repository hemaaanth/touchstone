// Amounts as the proof record holds them (wei, token units) in plain words.
// Pure, so a test can load it as is.

import { formatAmount, validDecimals } from "./amount.mjs"

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
  // "locked" is value that is stuck rather than transferred: the holder keeps their
  // claim and cannot turn it into assets (spike/lib/oracle-locked.mjs).
  kind: "funds" | "control" | "locked"
  asset?: "token" | "eth"
  victim?: string
  lostWei?: string
  token?: string
  lostUnits?: string
  // A token's symbol and decimals, when the record gives them.
  symbol?: string
  decimals?: number
  writes?: number
  // A locked finding: the claim left behind, and the withdrawal that reverted.
  stillOwed?: string
  via?: string
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
  // The record is data: read each field as a string, so nothing here throws.
  const victimAddr = typeof harm.victim === "string" ? harm.victim : ""
  const named = Array.isArray(harm.targets) ? harm.targets.find((t) => String(t?.address ?? "").toLowerCase() === victimAddr.toLowerCase()) : undefined
  const victim = victimAddr ? (named?.name ? String(named.name) : short(victimAddr)) : "The target"
  if (harm.kind === "funds" && harm.asset === "token" && harm.lostUnits) {
    const token = typeof harm.token === "string" && harm.token ? ` of token ${short(harm.token)}` : ""
    // Symbol and decimals a token can have: scaled. Else the raw units, as
    // when the record has none (bad decimals included).
    const known = validDecimals(harm.decimals) && typeof harm.symbol === "string" && harm.symbol !== ""
    const amount = known
      ? formatAmount(String(harm.lostUnits), { decimals: harm.decimals, unit: harm.symbol, baseUnit: "base units" })
      : formatAmount(String(harm.lostUnits), { decimals: 0, unit: "raw units", baseUnit: "raw units" })
    return { lead: `${victim} lost `, amount, rest: known ? "." : `${token}.` }
  }
  if (harm.kind === "funds" && harm.lostWei) return { lead: `${victim} lost `, amount: formatWei(String(harm.lostWei)), rest: "." }
  if (harm.kind === "locked") {
    // The number is the claim left behind, in the target's own units, and the function
    // that should have paid it. "Could not withdraw" is the harm; nothing moved, which
    // is exactly why the transfer channels cannot see it.
    const owed = typeof harm.stillOwed === "string" && harm.stillOwed ? formatAmount(harm.stillOwed, { decimals: 0, unit: "raw units", baseUnit: "raw units" }) : null
    const via = typeof harm.via === "string" && harm.via ? `\`${harm.via}\`` : "a withdrawal"
    return {
      lead: `${victim} is locked out: ${via} reverted while they still held `,
      amount: owed,
      rest: owed ? " they cannot turn into assets." : "a claim they cannot turn into assets.",
    }
  }
  if (harm.kind === "control") {
    const n = harm.writes ?? 0
    return { lead: `${victim} was taken over: the replay wrote ${n} control ${n === 1 ? "slot" : "slots"} (owner, admin or implementation).`, amount: null, rest: "" }
  }
  return null
}
