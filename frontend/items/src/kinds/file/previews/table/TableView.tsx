import type { FileContent } from "@novadeck/core/items"
import { createKept } from "@novadeck/viewers"
import { ArrowDown, ArrowUp } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState } from "react"

import type { PreviewProps } from ".."
import { usePaneNote } from "../../../../pane-row"
import { columnWidths, rowOffsets, rowsWindow } from "./rows-window"
import { nextSort, partText, sortRows, tableOf, type Sort } from "./table"

// Where each table was left, by the item showing it, and in which file and lines pointed at:
// scrolled, sorted, and its rows' heights as measured, so it opens again as it was when its
// pane is built again (a view switch, a tab brought back). A place in one file means nothing
// in another, and the agent pointing at other lines of it opens it at them.
type Left = {
  readonly path: string
  readonly pointed: string
  readonly top: number
  readonly left: number
  readonly sort: Sort | null
  readonly heights: ReadonlyMap<number, number>
}
const left = createKept<Left>(24)

// Past this many rows a table draws only those in view (./rows-window.ts), its columns held to
// widths from all its rows' text so they don't move as rows come and go.
const windowFrom = 200
// A row's height until it's drawn and measured, and how many rows past the view each side.
const estimate = 27
const spare = 12

// A delimited file (CSV, TSV) as a table: its header held on top as it scrolls, each column
// sortable from its header, numbers to the right, each row's line in the file at its start,
// and the rows the agent pointed at marked. A long one draws the rows in view. What the runner
// read of a long file is only part of it, and lines it cut short lose their ends: it says so
// under the table.
export const TableView = ({ id, name, content }: PreviewProps): React.JSX.Element => {
  const lastLine = content.firstLine + content.lines.length - 1
  const whole =
    content.firstLine === 1 &&
    !content.truncated &&
    content.total !== null &&
    lastLine >= content.total
  const table = useMemo(
    () => tableOf(content.path, content.lines, content.firstLine, { whole }),
    [content.path, content.lines, content.firstLine, whole],
  )
  const pointedKey = `${content.from}-${content.to}`
  const saved = left.get(id)
  const kept = saved?.path === content.path ? saved : undefined
  const [sort, setSort] = useState<Sort | null>(kept?.sort ?? null)
  const rows = useMemo(() => sortRows(table, sort), [table, sort])
  const scroller = useRef<HTMLDivElement>(null)
  const keep = (next: Partial<Left>): void => {
    const element = scroller.current
    const before = left.get(id)
    left.keep(id, {
      path: content.path,
      pointed: pointedKey,
      top: element?.scrollTop ?? 0,
      left: element?.scrollLeft ?? 0,
      sort,
      heights: before?.path === content.path ? before.heights : new Map(),
      ...next,
    })
  }
  // The lines the agent pointed at, where it pointed at some of what's shown rather than all,
  // and the rows they fall in: a row spans lines where its fields hold line breaks.
  const pointed =
    content.from > content.firstLine || content.to < lastLine
      ? { from: content.from, to: content.to }
      : undefined
  const isPointed = (row: { readonly line: number; readonly last: number }): boolean =>
    pointed !== undefined && row.line <= pointed.to && row.last >= pointed.from

  // A long table's rows, drawn as they come into view: the heights measured, by line, so a
  // sort keeps them, and where the view is.
  const windowed = rows.length > windowFrom
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(
    () => kept?.heights ?? new Map(),
  )
  const head = useRef<HTMLTableSectionElement>(null)
  const [view, setView] = useState({ top: 0, height: 800 })
  const offsets = useMemo(
    () =>
      windowed
        ? rowOffsets(rows.length, (index) => heights.get(rows[index]!.line) ?? estimate)
        : undefined,
    [windowed, rows, heights],
  )
  const shown = offsets
    ? rowsWindow(offsets, { top: view.top, height: view.height, spare })
    : { start: 0, end: rows.length, before: 0, after: 0 }
  const widths = useMemo(
    () => (windowed ? columnWidths(table.header, table.rows) : undefined),
    [windowed, table],
  )
  const look = (): void => {
    const element = scroller.current
    if (!element) return
    const below = head.current?.offsetHeight ?? 0
    setView({
      top: Math.max(0, element.scrollTop),
      height: Math.max(element.clientHeight - below, 0) || 800,
    })
  }
  // Each row drawn, measured; a change draws the window again from the new heights.
  useLayoutEffect(() => {
    if (!windowed) return
    const drawn = scroller.current?.querySelectorAll<HTMLElement>("tbody tr[data-line]") ?? []
    const changes = [...drawn].flatMap((row): [number, number][] => {
      const line = Number(row.dataset.line)
      const height = row.offsetHeight
      const known = heights.get(line) ?? estimate
      return height > 0 && Math.abs(known - height) > 0.5 ? [[line, height]] : []
    })
    if (changes.length === 0) return
    const next = new Map([...heights, ...changes])
    setHeights(next)
    const place = left.get(id)
    if (place?.path === content.path) left.keep(id, { ...place, heights: next })
    // The rows drawn, and how wide: what changes their heights.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- See above.
  }, [windowed, heights, shown.start, shown.end, rows, widths, scroller, id, content.path])

  // Opens where it was left in this file; a new file, or the agent pointing at other lines of
  // it, at the rows pointed at, if it pointed at some, else at its start.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const place = left.get(id)
    const at = place?.path === content.path && place.pointed === pointedKey ? place : undefined
    const first = !at && pointed ? rows.findIndex((row) => isPointed(row)) : -1
    if (first >= 0) {
      element.scrollTop = offsets
        ? offsets[first]!
        : (element.querySelector<HTMLElement>("tbody tr[data-pointed]")?.offsetTop ?? 0) -
          (head.current?.offsetHeight ?? 0)
      element.scrollLeft = 0
    } else {
      element.scrollTop = at?.top ?? 0
      element.scrollLeft = at?.left ?? 0
    }
    look()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react-hooks/exhaustive-deps -- Only as it opens, or another file or lines come.
  }, [id, content.path, pointedKey, scroller])
  // A file the item is re-pointed at starts in its own order.
  const [shownPath, setShownPath] = useState(content.path)
  if (shownPath !== content.path) {
    setShownPath(content.path)
    setSort(kept?.sort ?? null)
    setHeights(new Map())
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
    cut: table.cut,
    clamped: content.clamped ? content.to : undefined,
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
        onScroll={() => {
          keep({})
          if (windowed) look()
        }}
      >
        <table
          data-windowed={windowed || undefined}
          aria-rowcount={windowed ? rows.length + 1 : undefined}
          style={
            widths && {
              width: `calc(${widths.reduce((sum, each) => sum + each, 0) + String(lastLine).length + 1}ch + ${(widths.length + 1) * 24}px)`,
            }
          }
        >
          {widths && (
            <colgroup>
              <col style={{ width: `calc(${String(lastLine).length + 1}ch + 22px)` }} />
              {widths.map((width, column) => (
                // oxlint-disable-next-line react/no-array-index-key -- A column is its place.
                <col key={column} style={{ width: `calc(${width}ch + 24px)` }} />
              ))}
            </colgroup>
          )}
          <thead ref={head}>
            <tr>
              <th scope="col" className="artifact-table-line">
                Line
              </th>
              {table.header.map((cell, column) => {
                const sorted = sort?.column === column ? sort.direction : undefined
                const Arrow = sorted === "descending" ? ArrowDown : ArrowUp
                return (
                  <th
                    // oxlint-disable-next-line react/no-array-index-key -- A column is its place.
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
            {shown.before > 0 && (
              <tr className="artifact-table-spacer" aria-hidden style={{ height: shown.before }}>
                <td colSpan={table.header.length + 1} />
              </tr>
            )}
            {rows.slice(shown.start, shown.end).map((row, at) => (
              <tr
                key={row.line}
                data-line={row.line}
                data-pointed={isPointed(row) || undefined}
                aria-rowindex={windowed ? shown.start + at + 2 : undefined}
              >
                <th scope="row" className="artifact-table-line">
                  {row.line}
                </th>
                {row.cells.map((cell, column) => (
                  // oxlint-disable-next-line react/no-array-index-key -- A column is its place.
                  <td key={column} data-numeric={table.numeric[column] || undefined}>
                    <span>{cell}</span>
                  </td>
                ))}
              </tr>
            ))}
            {shown.after > 0 && (
              <tr className="artifact-table-spacer" aria-hidden style={{ height: shown.after }}>
                <td colSpan={table.header.length + 1} />
              </tr>
            )}
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
          // oxlint-disable-next-line react/no-array-index-key -- A column is its place.
          <span key={column}>{cell}</span>
        ))}
      </span>
      {table.rows.slice(0, 5).map((row) => (
        <span key={row.line} className="peek-table-row">
          {row.cells.slice(0, 4).map((cell, column) => (
            // oxlint-disable-next-line react/no-array-index-key -- A column is its place.
            <span key={column} data-numeric={table.numeric[column] || undefined}>
              {cell}
            </span>
          ))}
        </span>
      ))}
    </span>
  )
}
