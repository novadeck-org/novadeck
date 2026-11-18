import type { FileContent } from "@novadeck/core/items"
import { createKept } from "@novadeck/viewers"
import { ArrowDown, ArrowUp } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState } from "react"

import { usePaneNote } from "../../../../pane-row"
import type { PreviewProps } from ".."
import { nextSort, partText, sortRows, tableOf, type Sort } from "./table"

// Where each table was left, by the item showing it, and in which file: scrolled, and
// sorted, so it opens again as it was when its pane is built again (a view switch, a tab
// brought back). A place in one file means nothing in another.
type Left = { readonly path: string; readonly top: number; readonly left: number; readonly sort: Sort | null }
const left = createKept<Left>(24)

// A delimited file (CSV, TSV) as a table: its header held on top as it scrolls, each column
// sortable from its header, numbers to the right, and each row's line in the file at its
// start. What the runner read of a long file is only part of it, and it says so under the
// table.
export const TableView = ({ id, name, content }: PreviewProps): React.JSX.Element => {
  const table = useMemo(
    () => tableOf(content.path, content.lines, content.firstLine),
    [content.path, content.lines, content.firstLine],
  )
  const saved = left.get(id)
  const kept = saved?.path === content.path ? saved : undefined
  const [sort, setSort] = useState<Sort | null>(kept?.sort ?? null)
  const rows = useMemo(() => sortRows(table, sort), [table, sort])
  const scroller = useRef<HTMLDivElement>(null)
  const keep = (next: Partial<Left>): void => {
    const element = scroller.current
    left.keep(id, {
      path: content.path,
      top: element?.scrollTop ?? 0,
      left: element?.scrollLeft ?? 0,
      sort,
      ...next,
    })
  }
  // Opens where it was left in this file; a new file, at its start.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    element.scrollTop = kept?.top ?? 0
    element.scrollLeft = kept?.left ?? 0
    // Only as it opens, or another file comes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.path])
  // A file the item is re-pointed at starts in its own order.
  const [shownPath, setShownPath] = useState(content.path)
  if (shownPath !== content.path) {
    setShownPath(content.path)
    setSort(kept?.sort ?? null)
  }
  usePaneNote([
    `${table.rows.length.toLocaleString("en-US")} ${table.rows.length === 1 ? "row" : "rows"} · ${table.header.length} ${table.header.length === 1 ? "column" : "columns"}`,
  ])
  const part = partText({
    firstLine: content.firstLine,
    count: content.lines.length,
    total: content.total,
    truncated: content.truncated,
    named: table.named,
  })
  return (
    <div className="artifact-table">
      <div
        ref={scroller}
        className="artifact-table-scroll"
        role="region"
        aria-label={name}
        // Focusable, so it scrolls by keyboard.
        tabIndex={0}
        onScroll={() => keep({})}
      >
        <table>
          <thead>
            <tr>
              <th scope="col" className="artifact-table-line">
                Line
              </th>
              {table.header.map((cell, column) => {
                const sorted = sort?.column === column ? sort.direction : undefined
                const Arrow = sorted === "descending" ? ArrowDown : ArrowUp
                return (
                  <th
                    // Columns stay where they are; only their names change with the file.
                    // eslint-disable-next-line react/no-array-index-key
                    key={column}
                    scope="col"
                    aria-sort={sorted ?? "none"}
                    data-numeric={table.numeric[column] || undefined}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        const next = nextSort(sort, column)
                        setSort(next)
                        keep({ sort: next })
                      }}
                    >
                      <span>{cell}</span>
                      <Arrow
                        size={12}
                        strokeWidth={1.75}
                        aria-hidden
                        data-shown={sorted !== undefined || undefined}
                      />
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.line}>
                <th scope="row" className="artifact-table-line">
                  {row.line}
                </th>
                {row.cells.map((cell, column) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <td key={column} data-numeric={table.numeric[column] || undefined}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length === 0 && <p className="artifact-table-empty">No rows.</p>}
      </div>
      {part && <p className="artifact-cut">{part}</p>}
    </div>
  )
}

// A table in miniature: the first rows of its first columns.
export const TableThumb = ({ content }: { content: FileContent }): React.JSX.Element => {
  const table = tableOf(content.path, content.lines.slice(0, 8), content.firstLine)
  const columns = table.header.slice(0, 4)
  return (
    <span className="peek-table">
      <span className="peek-table-row" data-head>
        {columns.map((cell, column) => (
          // eslint-disable-next-line react/no-array-index-key
          <span key={column}>{cell}</span>
        ))}
      </span>
      {table.rows.slice(0, 5).map((row) => (
        <span key={row.line} className="peek-table-row">
          {row.cells.slice(0, 4).map((cell, column) => (
            // eslint-disable-next-line react/no-array-index-key
            <span key={column} data-numeric={table.numeric[column] || undefined}>
              {cell}
            </span>
          ))}
        </span>
      ))}
    </span>
  )
}
