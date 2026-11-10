import type { Work } from "@novadeck/core/works"
import { SidebarItem, sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { GitCompare } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { arrivals, changeRows, unreadStates, type ChangeRow, type FileView } from "./changes-rows"
import { SidebarPanel } from "./SidebarPanel"

// How long a work that has just gained unread lines stays washed, as the Inbox's arrived rows.
const arrivedMs = 1700

// A count of lines, as a diff says it: what was added, what was removed; a side with none
// says nothing.
const Lines = ({ added, removed }: { added: number; removed: number }): React.JSX.Element => (
  <>
    {added > 0 && <span className="diff-added">+{added}</span>}
    {removed > 0 && <span className="diff-removed">−{removed}</span>}
  </>
)

const FileName = ({ file, title }: { file: FileView; title?: boolean }): React.JSX.Element => (
  <span
    className="changes-file truncate"
    data-read={!file.unread}
    data-conflict={file.conflict || undefined}
    {...(title ? { title: file.path } : {})}
  >
    {file.name}
  </span>
)

// The files on the row's second line, as the names in a row, which fold away while the
// selected row unfolds them under it (tabs.css, as a tab's subagents).
const FileLine = ({ files }: { files: readonly FileView[] }): React.JSX.Element => (
  <>
    <span aria-hidden className="terminal-glyph inline-block w-[1ch] shrink-0 text-center" />
    <span aria-hidden className="terminal-tab-subagents changes-line grid min-w-0">
      <span className="flex min-w-0 items-center overflow-hidden">
        <span className="min-w-0 truncate">
          {files.map((file, index) => (
            <span key={file.path}>
              {index > 0 && <span className="changes-comma">, </span>}
              <span
                className="changes-file"
                data-read={!file.unread}
                data-conflict={file.conflict || undefined}
              >
                {file.name}
              </span>
            </span>
          ))}
        </span>
      </span>
    </span>
  </>
)

// The files under the row, a branch each, as a tab's subagents unfold under it (tabs.css).
const Branches = ({ row }: { row: ChangeRow }): React.JSX.Element => (
  <span aria-hidden className="terminal-tab-branches changes-branches -mt-1 grid min-w-0">
    <span className="terminal-tab-branches-fold min-h-0 overflow-hidden">
      <span className="flex min-w-0 flex-col pt-1 text-caption leading-[18px]">
        {row.branches.map((branch, index) => (
          <span
            key={branch.kind === "file" ? branch.file.path : "more"}
            className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
          >
            <span className="terminal-tab-branch shrink-0">
              {index === row.branches.length - 1 ? "└" : "├"}
            </span>
            {branch.kind === "file" ? (
              <>
                <FileName file={branch.file} title />
                {branch.file.unread && (
                  <span className="terminal-tab-wait-trail changes-trail">
                    <Lines added={branch.file.added} removed={branch.file.removed} />
                  </span>
                )}
              </>
            ) : (
              <span className="truncate">{branch.text}</span>
            )}
          </span>
        ))}
      </span>
    </span>
  </span>
)

// The unread lines in words, for the row's accessible label: "142 lines added, 38 removed unread".
const unreadWords = (work: Work): string => {
  const parts = [
    work.unreadAdded > 0 &&
      `${work.unreadAdded} ${work.unreadAdded === 1 ? "line" : "lines"} added`,
    work.unreadRemoved > 0 && `${work.unreadRemoved} removed`,
  ].filter(Boolean)
  return `${parts.join(", ")} unread`
}

const ChangeItem = ({
  row,
  selected,
  onSelect,
}: {
  row: ChangeRow
  selected: boolean
  onSelect: (terminalId: string) => void
}): React.JSX.Element => {
  const { work } = row
  const count = work.files.length
  const files = `${count}${work.truncated ? "+" : ""} ${count === 1 && !work.truncated ? "file" : "files"} changed`
  const label = [
    row.title,
    files,
    row.unread ? unreadWords(work) : undefined,
    row.conflictWords?.replace(/^C/, "c"),
  ]
    .filter(Boolean)
    .join(", ")
  return (
    <SidebarItem
      role="listitem"
      className={`terminal-tab changes-row${selected ? " selected" : ""}`}
      name={row.title}
      icon={<GitCompare size={14} strokeWidth={1.5} />}
      detail={<FileLine files={row.files} />}
      below={<Branches row={row} />}
      badge={
        row.unread ? (
          <span className="terminal-tab-kinds changes-size">
            <Lines added={work.unreadAdded} removed={work.unreadRemoved} />
          </span>
        ) : undefined
      }
      selected={selected}
      selectLabel={label}
      {...(row.conflictWords ? { tooltip: row.conflictWords } : {})}
      onSelect={() => onSelect(work.terminalId)}
      data-terminal-phase="idle"
      data-terminal-unread={row.unread || undefined}
      data-changes-row={work.terminalId}
      data-read={!row.unread}
      data-conflict={row.conflict || undefined}
      data-read-start={row.readStart || undefined}
      data-arrived={row.arrived || undefined}
    />
  )
}

// The sidebar's Changes panel: the project's works, each a terminal's work that differs from
// main, drawn as the Terminals panel's tabs. First come, first served, the unread ones above a
// line and the read below; a read work that gains unread lines moves up with a brief wash. A
// click selects its terminal and shows the work there.
export const ChangesPanel = ({
  works,
  synced,
  watch,
  titles,
  selectedId,
  active,
  watching,
  onClose,
  onSelect,
}: {
  works: readonly Work[]
  // The backend has reported every work since it began following.
  synced: boolean
  // Follows the works until the returned release is called.
  watch: () => () => void
  // Each terminal's title, by id.
  titles: ReadonlyMap<string, string>
  selectedId: string | undefined
  active: boolean
  // The panel is the one shown: the works are followed only then.
  watching: boolean
  onClose: () => void
  onSelect: (terminalId: string) => void
}): React.JSX.Element => {
  const known = useRef<ReadonlyMap<string, boolean> | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const [arrived, setArrived] = useState<readonly string[]>([])
  useEffect(() => (watching ? watch() : undefined), [watching, watch])
  useEffect(() => {
    // Nothing arrives until the works are synced: opening the panel or starting up lists
    // every row once, which isn't news.
    const fresh = synced ? arrivals(known.current, works) : []
    known.current = unreadStates(works, synced)
    if (fresh.length === 0) return
    setArrived((now) => [...new Set([...now, ...fresh])])
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setArrived([]), arrivedMs)
  }, [works, synced])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const rows = useMemo(() => changeRows(works, titles, arrived), [works, titles, arrived])
  return (
    <SidebarPanel
      id="changes-panel"
      title="Changes"
      count={works.length}
      active={active}
      onClose={onClose}
    >
      {rows.length === 0 ? (
        <div className="changes-empty">
          <h3 className="text-body">Nothing unmerged</h3>
          <p className="text-control">
            When an agent here changes files, its work shows up in this list.
          </p>
        </div>
      ) : (
        <div className={`changes-list ${sidebarListClasses}`} role="list" aria-label="Changes">
          {rows.map((row) => (
            <ChangeItem
              key={row.work.terminalId}
              row={row}
              selected={row.work.terminalId === selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </SidebarPanel>
  )
}
