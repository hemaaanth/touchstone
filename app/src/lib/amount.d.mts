export function formatAmount(
  raw: string,
  opts?: { decimals?: number; unit?: string; baseUnit?: string; signed?: boolean },
): { text: string; exact: string; approx: boolean }
