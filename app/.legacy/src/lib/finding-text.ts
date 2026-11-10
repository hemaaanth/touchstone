import type { Finding, FindingLocation } from "@/data/fixtures"

/** The class from the dedup key, for example "reentrancy". */
export function findingClass(finding: Finding): string {
  return finding.fingerprint.split("|").at(-1) ?? ""
}

/** chain / address / selector (label). The label is only a name (C2). */
export function whereText(location: FindingLocation): string {
  const { chain, address, selector, label } = location
  const last = selector ? (label ? `${selector} (${label})` : selector) : label
  return [chain, address, last].filter(Boolean).join(" / ")
}

/** chain / address / selector (function) / class (C2). */
export function locationKey(finding: Finding): string {
  const kind = findingClass(finding)
  const where = whereText(finding.location)
  return kind ? `${where} / ${kind}` : where
}
