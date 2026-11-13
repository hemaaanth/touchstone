// Amounts as the proof record holds them (wei, token units) in plain words.
// Pure, so a test can load it as is.

const WEI_PER_ETH = 10n ** 18n
// Below this an ETH figure would round to 0: show wei instead.
const DUST = 10n ** 12n

// A wei amount (a decimal string, maybe signed) as ETH, up to six decimals,
// or as wei when it is too small to read in ETH. `signed` adds "+" to a gain.
// The exact wei value goes in a tooltip beside it.
export function formatWei(wei: string, signed = false): string {
  let n: bigint
  try {
    n = BigInt(wei)
  } catch {
    return wei
  }
  const neg = n < 0n
  const abs = neg ? -n : n
  const sign = neg ? "-" : signed && abs > 0n ? "+" : ""
  if (abs === 0n) return "0 ETH"
  if (abs < DUST) return `${sign}${abs.toLocaleString("en-US")} wei`
  const whole = abs / WEI_PER_ETH
  const frac = (abs % WEI_PER_ETH).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "")
  return `${sign}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} ETH`
}

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
  writes?: number
  targets?: { address: string; name: string }[]
}

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

// One sentence for the harm, and the exact figure for its tooltip.
export function harmText(harm: Harm | null | undefined): { text: string; exact: string | null } | null {
  if (!harm || harm.ok === false) return null
  const victim = harm.victim ? (harm.targets?.find((t) => t.address.toLowerCase() === harm.victim!.toLowerCase())?.name ?? short(harm.victim)) : "The target"
  if (harm.kind === "funds" && harm.asset === "token" && harm.lostUnits) {
    // The record holds the raw token units and the token's address only: no
    // symbol and no decimals, so the figure stays in raw units.
    const token = harm.token ? ` of token ${short(harm.token)}` : ""
    return { text: `${victim} lost ${BigInt(harm.lostUnits).toLocaleString("en-US")} raw units${token}.`, exact: harm.token ?? null }
  }
  if (harm.kind === "funds" && harm.lostWei) return { text: `${victim} lost ${formatWei(harm.lostWei)}.`, exact: `${harm.lostWei} wei` }
  if (harm.kind === "control") {
    const n = harm.writes ?? 0
    return { text: `${victim} was taken over: the replay wrote ${n} control ${n === 1 ? "slot" : "slots"} (owner, admin or implementation).`, exact: null }
  }
  return null
}
