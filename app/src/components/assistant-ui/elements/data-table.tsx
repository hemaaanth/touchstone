"use client"

import { useMemo, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { card } from "./surfaces"

// A small sortable table in the style of the assistant-ui data-table element:
// a quiet bordered surface, a sticky header, and a click on a header to sort
// by that column. The first click sorts ascending, the second descending, the
// third restores the given row order.

export interface DataColumn<Row> {
  key: string
  label: string
  // The cell. Defaults to the row's value at `key` as text.
  cell?: (row: Row) => ReactNode
  // The value to sort by. Defaults to the row's value at `key`. Leave the
  // column unsortable with `sortable: false`.
  sortValue?: (row: Row) => string | number
  sortable?: boolean
  align?: "left" | "right"
  className?: string
}

type Sort = { key: string; dir: "asc" | "desc" } | null

const valueAt = <Row,>(row: Row, key: string): unknown => (row as Record<string, unknown>)[key]

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  maxHeight = "24rem",
  className,
}: {
  columns: DataColumn<Row>[]
  rows: Row[]
  rowKey: (row: Row, index: number) => string
  maxHeight?: string
  className?: string
}) {
  const [sort, setSort] = useState<Sort>(null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col) return rows
    const by = col.sortValue ?? ((r: Row) => String(valueAt(r, col.key) ?? ""))
    const sign = sort.dir === "asc" ? 1 : -1
    // Keep the given order for equal values, so a sort is stable.
    return rows
      .map((row, i) => ({ row, i, v: by(row) }))
      .sort((a, b) => {
        const d =
          typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : String(a.v).localeCompare(String(b.v))
        return d !== 0 ? d * sign : a.i - b.i
      })
      .map((x) => x.row)
  }, [rows, columns, sort])

  const toggle = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null))

  return (
    <div className={cn(card, "overflow-auto", className)} style={{ maxHeight }}>
      <table className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-background dark:bg-popover">
          <tr className="border-b border-border/60">
            {columns.map((c) => {
              const active = sort?.key === c.key
              const sortable = c.sortable !== false
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cn(
                    "px-3 py-2 font-medium whitespace-nowrap text-muted-foreground",
                    c.align === "right" && "text-right",
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      className={cn(
                        "inline-flex items-center gap-1 transition-colors hover:text-foreground",
                        active && "text-foreground",
                      )}
                    >
                      {c.label}
                      {active ? (
                        sort.dir === "asc" ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )
                      ) : null}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={rowKey(row, i)} className="border-b border-border/40 align-top last:border-b-0">
              {columns.map((c) => (
                <td key={c.key} className={cn("px-3 py-2", c.align === "right" && "text-right", c.className)}>
                  {c.cell ? c.cell(row) : String(valueAt(row, c.key) ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
