// The attack classes a contract audit must sweep.
//
// WHY THIS EXISTS. Before this file the Contracts prompt said "list every
// suspect root cause" and named no classes at all. Each run then rediscovered
// the field from scratch, so a class nobody thought of was a class nobody
// checked. The corpus says which classes actually take money: 492 DefiLlama
// incidents from 2025-01-01 have 38 distinct techniques, and 62% of the
// contract-logic ones on EVM DeFi targets belong to a class our five labs never
// exercise. A checklist makes each of those a line the agent must answer.
//
// THE RULE THAT DOES NOT BEND. This is guidance, never a verdict. A class tick
// here proves nothing; the harm gate is still the only thing that records a
// finding. So the list is a sweep the agent must close out, not a claim.
//
// WHERE EACH CLASS CAME FROM. `evidence` names the incidents that make the class
// worth a row, so a row can be argued about instead of trusted. `labs` names a
// lab that exercises it, when one ships. A class with neither is still on the
// list on purpose: it is the gap.

// One row per class the audit must answer. `id` is what submit_finding writes.
// `prompt` is the question the agent answers, in the code's own words.
export const ATTACK_CLASSES = [
  {
    id: "access-control",
    label: "Unprotected privileged function",
    prompt: "A function that moves funds, mints, changes an owner/admin/implementation, or sets a fee has no caller check. Ask for every such function: who may call it, and is that written in the code?",
    labs: ["lab/vault-multi"],
  },
  {
    id: "auth-takeover",
    label: "Ownership or role takeover",
    prompt: "Can an outsider become the owner, admin, minter or holder of a role? Look for an unguarded setter, a public initializer, an unprotected `_authorizeUpgrade`, a delegatecall to a caller-chosen address, and an owner variable packed above offset 0 in its slot.",
    labs: [],
  },
  {
    id: "reentrancy",
    label: "Reentrancy and read-only reentrancy",
    prompt: "Which external call happens before the state it depends on is written? Cover a plain reentrancy, a cross-function one, and a read-only one where a view function reports stale state to a third party mid-transaction.",
    labs: ["lab/vault-reentrancy", "lab/vault-multi"],
  },
  {
    id: "share-accounting",
    label: "Share and debt accounting",
    prompt: "Trace the share price through deposit, withdraw and redeem. Is every subtraction in the right unit (shares vs assets)? Does a rounding direction ever favour the user? Can an operation leave the vault counting assets it no longer holds?",
    labs: ["lab/vault-shares"],
  },
  {
    id: "rounding",
    label: "Rounding and truncation",
    prompt: "Where does integer division round down, and who gains from that direction? Cover a sub-unit withdrawal that burns zero shares, a fee that rounds to zero, and a division before a multiply.",
    labs: [],
  },
  {
    id: "first-depositor",
    label: "First-depositor and donation inflation",
    prompt: "With zero shares outstanding, what does the first deposit mint? Can a direct token transfer (or a donation) move the share price without minting shares, so the next depositor's shares round to zero?",
    labs: [],
  },
  {
    id: "oracle",
    label: "Oracle manipulation and staleness",
    prompt: "Where does a price come from? If it is a spot reserve, a single swap in the same transaction moves it. If it is a feed, is the round, the timestamp and the confidence checked? Is the value latched at one moment and used at another?",
    labs: [],
  },
  {
    id: "slippage",
    label: "Missing slippage and deadline checks",
    prompt: "Does every swap or liquidity action take a minimum-out and a deadline, and is the minimum derived from a value the caller cannot set to zero?",
    labs: [],
  },
  {
    id: "mint",
    label: "Unbacked or infinite mint",
    prompt: "Which function increases a supply or a balance without a matching deposit? Can a repeated call mint without limit, or mint against a price the caller just moved?",
    labs: [],
  },
  {
    id: "input-validation",
    label: "Missing input validation",
    prompt: "Which parameter, if it is zero, the caller's own address, the pool itself, or a value the caller repeats, breaks an invariant? Cover same-asset swaps, a zero address, and a self-transfer.",
    labs: [],
  },
  {
    id: "external-call",
    label: "Arbitrary external call and delegatecall",
    prompt: "Can the caller choose the target of a call or delegatecall, or name a token the contract then trusts? A delegatecall to a caller-chosen address runs that code with this contract's storage and funds.",
    labs: [],
  },
  {
    id: "signature",
    label: "Signature and permit flaws",
    prompt: "Does the signed hash name this chain, this contract and a nonce? Is the recovered address checked against zero? Is a permit's deadline and allowance bounded? Can the same signature be replayed here, on a second deployment, or on a fork?",
    labs: [],
  },
  {
    id: "proxy",
    label: "Proxy and upgrade path",
    prompt: "Is the implementation slot writable by anyone but the admin? Is the implementation left initializable? Can an upgrade run with no event, or to unverified code?",
    labs: [],
  },
  {
    id: "approval",
    label: "Approval and allowance abuse",
    prompt: "Does any path let a caller spend another user's allowance, or leave an allowance standing after it was used?",
    labs: [],
  },
  {
    id: "liquidation",
    label: "Liquidation and risk parameters",
    prompt: "Can a position be liquidated at a price the attacker just moved, or borrow against collateral the attacker inflated? Are the threshold, the bonus and the close factor each bounded?",
    labs: [],
  },
  {
    id: "fee-accounting",
    label: "Fee and reward accounting",
    prompt: "Is a fee or a reward computed from a value that changed earlier in the same call? Can an attacker open many accounts, or split a withdrawal, to collect it more than once?",
    labs: ["lab/vault-accounting"],
  },
  {
    id: "governance",
    label: "Governance and proposal execution",
    prompt: "Can voting power be borrowed for one block, or is a proposal executable before a timelock? Can a proposal change the implementation or drain a vault?",
    labs: [],
  },
  {
    id: "logic",
    label: "Protocol logic (deposit / withdraw / swap / borrow / redeem)",
    prompt: "For each of deposit, withdraw, swap, borrow and redeem: read the function twice and ask what the second call does. Cover a withdrawal that pays out twice, a swap where the input and output token are the same, and a balance that is zeroed after the transfer.",
    labs: ["lab/vault-accounting"],
  },
  {
    id: "arithmetic",
    label: "Arithmetic and casting",
    prompt: "Where is an unchecked block, a cast between signed and unsigned, a shift, or an exponent? Can a subtraction wrap into a huge positive balance?",
    labs: [],
  },
  {
    id: "accounting-invariant",
    label: "Insolvency and locked funds",
    prompt: "Which invariant must always hold (total assets >= total owed)? Can a sequence of ordinary user calls break it? Can a holder who supplied value end up unable to withdraw it, with no attacker gaining anything?",
    labs: ["lab/vault-accounting", "lab/vault-shares"],
  },
  {
    id: "other",
    label: "A class not on this list",
    prompt: "Use this only for a real root cause that none of the rows above describes, and say in the explanation which class it is and why the list missed it.",
    labs: [],
  },
];

export const CLASS_IDS = ATTACK_CLASSES.map((c) => c.id);
const BY_ID = new Map(ATTACK_CLASSES.map((c) => [c.id, c]));

// Accept the id, and also the label, so a model that writes the human name still
// lands on a row. Returns the canonical id, or null.
export function normalizeClass(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;
  if (BY_ID.has(text)) return text;
  const byLabel = ATTACK_CLASSES.find((c) => c.label.toLowerCase() === text);
  if (byLabel) return byLabel.id;
  // A model may write "Share accounting" or "share_accounting".
  const folded = text.replace(/[\s_]+/g, "-");
  if (BY_ID.has(folded)) return folded;
  return null;
}

export function classLabel(id) {
  return BY_ID.get(String(id ?? ""))?.id ? BY_ID.get(String(id)).label : null;
}

// The sweep, as the prompt shows it. One line per class, so the model can answer
// each one by id and the coverage line can be checked against the same list.
export function classChecklist() {
  return ATTACK_CLASSES.filter((c) => c.id !== "other")
    .map((c) => `- \`${c.id}\` (${c.label}): ${c.prompt}`)
    .join("\n");
}

// The same sweep for a prompt that must stay short (a fleet child, a follow-up).
export function classIds() {
  return ATTACK_CLASSES.map((c) => c.id).join(", ");
}
