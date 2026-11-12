import type { Work, WorkClosed } from "@novadeck/core/works"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { SidebarItem, sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { SubjectBar, SubjectDetail, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { GitCompare, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  arrivals,
  changeRows,
  selectedRoot,
  unreadStates,
  type ChangeRow,
  type FileView,
} from "./changes-rows"
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

// What the × says, when it is not available.
const busyTip = "Its agent is working in this worktree. Close it once the turn ends."

const closeTip = (row: ChangeRow): string =>
  row.close === "busy" ? busyTip : `Close the ${row.branch} worktree`

// The row's branch, on its detail line.
const BranchLine = ({ row }: { row: ChangeRow }): React.JSX.Element => (
  <>
    <span aria-hidden className="terminal-glyph inline-block w-[1ch] shrink-0 text-center" />
    <span className="changes-branch min-w-0 truncate" title={row.branch}>
      {row.branch}
    </span>
  </>
)

const ChangeItem = ({
  row,
  selected,
  onSelect,
  onClose,
}: {
  row: ChangeRow
  selected: boolean
  onSelect: (work: Work) => void
  onClose: (row: ChangeRow) => void
}): React.JSX.Element => {
  const { work } = row
  const count = work.files.length
  const files = `${count}${work.truncated ? "+" : ""} ${count === 1 && !work.truncated ? "file" : "files"} changed`
  const label = [
    row.title,
    row.branch,
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
      detail={<BranchLine row={row} />}
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
      actions={
        <div className="terminal-tab-actions flex items-center">
          <Tooltip content={closeTip(row)}>
            <button
              className="terminal-tab-action icon-button small dim quiet terminal-tab-revealed"
              aria-label={`Close the ${row.branch} worktree of ${row.title}`}
              // Kept focusable so its tooltip says why it waits.
              aria-disabled={row.close === "busy" || undefined}
              onClick={() => {
                if (row.close !== "busy") onClose(row)
              }}
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          </Tooltip>
        </div>
      }
      onSelect={() => onSelect(work)}
      data-terminal-phase="idle"
      data-terminal-unread={row.unread || undefined}
      data-changes-row={work.root}
      data-read={!row.unread}
      data-conflict={row.conflict || undefined}
      data-read-start={row.readStart || undefined}
      data-arrived={row.arrived || undefined}
    />
  )
}

// What the dialog asks about, and what it says is kept.
const keptNotes = (row: ChangeRow): readonly string[] => [
  `Committed work stays on the branch ${row.branch}.`,
  "Uncommitted work, and commits only a detached HEAD reaches, are kept on a ref under refs/novadeck/kept/ in the repository.",
  "Ignored files, such as .env, are not kept.",
]

const closeDescription = (row: ChangeRow): string => {
  const { files, truncated } = row.work
  const count = `${files.length}${truncated ? "+" : ""} ${files.length === 1 && !truncated ? "file" : "files"}`
  return `It has changes against main: ${count}. Closing removes its folder.`
}

const closeBody = (row: ChangeRow): React.JSX.Element => (
  <ul className="changes-kept text-control">
    {keptNotes(row).map((note) => (
      <li key={note}>{note}</li>
    ))}
  </ul>
)

const closeBar = (row: ChangeRow): React.JSX.Element => (
  <SubjectBar>
    <SubjectSide>
      <GitCompare size={14} strokeWidth={1.5} aria-hidden="true" />
      <SubjectName>{row.title}</SubjectName>
    </SubjectSide>
    <SubjectDetail end>{row.branch}</SubjectDetail>
  </SubjectBar>
)

// The sidebar's Changes panel: the project's works, each a git worktree Novadeck tracks,
// against main, drawn as the Terminals panel's tabs and named by the terminal that owns it (or
// "No owner"). First come, first served, the unread ones above a line and the read below; a
// read work that gains unread lines moves up with a brief wash. A click shows the work on its
// owner's bar. The × closes the worktree, asking first while it differs from main, and waits
// while its owner's agent is working in it.
export const ChangesPanel = ({
  works,
  synced,
  watch,
  titles,
  selectedId,
  agentWorktrees,
  active,
  watching,
  onClose,
  onSelect,
  onCloseWork,
}: {
  works: readonly Work[]
  // The backend has reported every work since it began following.
  synced: boolean
  // Follows the works until the returned release is called.
  watch: () => () => void
  // Each terminal's title, by id.
  titles: ReadonlyMap<string, string>
  // The selected terminal, where a work with no owner is shown.
  selectedId: string | undefined
  // Whether agents may open worktrees: "off" points the empty list to Preferences. Absent
  // where the backend has no such setting.
  agentWorktrees: "on" | "off" | "absent"
  active: boolean
  // The panel is the one shown: the works are followed only then.
  watching: boolean
  onClose: () => void
  onSelect: (work: Work) => void
  // Closes a work's worktree; rejects with the backend's reason when it refuses.
  onCloseWork: (root: string, force: boolean) => Promise<WorkClosed>
}): React.JSX.Element => {
  const known = useRef<ReadonlyMap<string, boolean> | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const [arrived, setArrived] = useState<readonly string[]>([])
  const [last, setLast] = useState<{ root: string; on: string | undefined } | undefined>()
  // The row the dialog asks about, and why the last close was refused.
  const [asking, setAsking] = useState<ChangeRow | null>(null)
  const [refusal, setRefusal] = useState<{ title: string; reason: string } | null>(null)
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
  const selected = selectedRoot(works, selectedId, last)
  const close = (row: ChangeRow, force: boolean): void => {
    setRefusal(null)
    onCloseWork(row.work.root, force).catch((error: unknown) =>
      setRefusal({
        title: `${row.title} (${row.branch})`,
        reason: error instanceof Error ? error.message : "Novadeck could not close it.",
      }),
    )
  }
  return (
    <SidebarPanel
      id="changes-panel"
      title="Changes"
      count={works.length}
      active={active}
      onClose={onClose}
    >
      {refusal && (
        <div className="changes-refusal" role="alert">
          <p className="text-control">
            <strong>{refusal.title}</strong> stays: {refusal.reason}
          </p>
          <button
            className="icon-button small dim quiet"
            aria-label="Dismiss"
            onClick={() => setRefusal(null)}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="changes-empty">
          <h3 className="text-body">No worktrees</h3>
          <p className="text-control">
            When an agent opens or takes a git worktree, it shows up here with its branch, and you
            can close it.
          </p>
          {agentWorktrees === "off" && (
            <p className="text-control">
              Agents aren't asked to use worktrees. Turn on Agent worktrees in Preferences →
              Experimental.
            </p>
          )}
        </div>
      ) : (
        <div className={`changes-list ${sidebarListClasses}`} role="list" aria-label="Changes">
          {rows.map((row) => (
            <ChangeItem
              key={row.work.root}
              row={row}
              selected={row.work.root === selected}
              onSelect={(work) => {
                setLast({ root: work.root, on: work.terminalId ?? selectedId })
                onSelect(work)
              }}
              onClose={(each) => (each.close === "confirm" ? setAsking(each) : close(each, false))}
            />
          ))}
        </div>
      )}
      <ConfirmDialog
        subject={asking}
        bar={closeBar}
        title={() => "Close this worktree?"}
        description={closeDescription}
        body={closeBody}
        confirmLabel="Close worktree"
        cancelLabel="Keep it"
        onConfirm={() => {
          if (asking) close(asking, true)
          setAsking(null)
        }}
        onCancel={() => setAsking(null)}
        widthClassName="w-[min(380px,calc(100vw-32px))]"
      />
    </SidebarPanel>
  )
}
