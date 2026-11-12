import type { Work, WorkClosing } from "@novadeck/core/works"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { SidebarItem, sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { SubjectBar, SubjectDetail, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { GitCompare, GitMerge, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { changeRows, ownerOpen, selectedRoot, type ChangeRow, type FileView } from "./changes-rows"
import { SidebarPanel } from "./SidebarPanel"

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
                <span className="terminal-tab-wait-trail changes-trail">
                  <Lines added={branch.file.added} removed={branch.file.removed} />
                </span>
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

// What the × says, when it is not available.
const busyTip = "Its agent is working in this worktree. Close it once the turn ends."

const closeTip = (row: ChangeRow): string =>
  row.close === "busy" ? busyTip : `Close the ${row.branch} worktree`

// The row's project (where the panel lists more than one) and branch, on its detail line.
const BranchLine = ({ row }: { row: ChangeRow }): React.JSX.Element => (
  <>
    <span aria-hidden className="terminal-glyph inline-block w-[1ch] shrink-0 text-center" />
    {row.project !== undefined && (
      <>
        <span className="changes-project min-w-0 max-w-[45%] shrink-0 truncate" title={row.project}>
          {row.project}
        </span>
        {/* Outside the name, so a cut name keeps it. */}
        <span className="changes-sep shrink-0">·</span>
      </>
    )}
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
    row.project === undefined ? undefined : `in ${row.project}`,
    files,
    row.conflictWords?.replace(/^C/, "c"),
    row.merged ? "merged" : undefined,
  ]
    .filter(Boolean)
    .join(", ")
  const tooltip = [row.conflictWords ?? (row.merged ? "Merged" : undefined), row.mainWords]
    .filter(Boolean)
    .join(" · ")
  return (
    <SidebarItem
      role="listitem"
      className={`terminal-tab changes-row${selected ? " selected" : ""}`}
      name={row.title}
      icon={
        row.merged ? (
          <GitMerge size={14} strokeWidth={1.5} />
        ) : (
          <GitCompare size={14} strokeWidth={1.5} />
        )
      }
      detail={<BranchLine row={row} />}
      below={<Branches row={row} />}
      badge={
        work.added + work.removed > 0 ? (
          <span className="terminal-tab-kinds changes-size">
            <Lines added={work.added} removed={work.removed} />
          </span>
        ) : undefined
      }
      selected={selected}
      selectLabel={label}
      {...(tooltip ? { tooltip } : {})}
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
      data-changes-row={work.root}
      data-conflict={row.conflict || undefined}
      data-merged={row.merged || undefined}
    />
  )
}

// What the dialog asks about: a worktree the runner said holds something, and what.
type Asking = { readonly row: ChangeRow; readonly holds: string }

// What the dialog says is kept. A detached worktree has no branch to keep commits on.
const keptNotes = ({ row }: Asking): readonly string[] => [
  ...(row.work.branch === null ? [] : [`Committed work stays on the branch ${row.branch}.`]),
  "Uncommitted work, and commits only a detached HEAD reaches, are kept on a ref under refs/novadeck/kept/ in the repository.",
  "Ignored files, such as .env, are not kept.",
]

// A row by its owner and branch, as a notice names it.
const named = (row: ChangeRow): string => `${row.title} (${row.branch})`

const closeDescription = ({ holds }: Asking): string =>
  `It holds ${holds}. Closing removes its folder.`

const closeBody = (asking: Asking): React.JSX.Element => (
  <ul className="changes-kept text-control">
    {keptNotes(asking).map((note) => (
      <li key={note}>{note}</li>
    ))}
  </ul>
)

const closeBar = ({ row }: Asking): React.JSX.Element => (
  <SubjectBar>
    <SubjectSide>
      <GitCompare size={14} strokeWidth={1.5} aria-hidden="true" />
      <SubjectName>{row.title}</SubjectName>
    </SubjectSide>
    <SubjectDetail end>{row.branch}</SubjectDetail>
  </SubjectBar>
)

// The sidebar's Changes panel: every project's works, each a git worktree Novadeck tracks,
// against main, drawn as the Terminals panel's tabs and named by the terminal that owns it (or
// "No owner"), with its project where there are several. First come, first served. A merged
// work (its changes already in main) has a merge icon, a conflicting one a red icon. A click
// shows the work on its owner's bar. The × asks the runner to close the worktree, which says what it holds when the
// person should confirm first, and waits while its owner's agent is working in it.
export const ChangesPanel = ({
  works,
  watch,
  titles,
  projects,
  selectedId,
  agentWorktrees,
  active,
  watching,
  onClose,
  onSelect,
  onCloseWork,
}: {
  works: readonly Work[]
  // Follows the works until the returned release is called.
  watch: () => () => void
  // Each terminal's title, by id, in every project.
  titles: ReadonlyMap<string, string>
  // Each project's name, by id.
  projects: ReadonlyMap<string, string>
  // The selected terminal, where a work with no owner is shown.
  selectedId: string | undefined
  // Whether agents may open worktrees: "off" points the empty list to Preferences. Absent
  // where the backend has no such setting.
  agentWorktrees: "on" | "off" | "absent"
  active: boolean
  // The panel is the one shown: the works are followed only then.
  watching: boolean
  onClose: () => void
  // Shows a work on the bar of the terminal named (its owner, or where it has none, or its
  // owner is closed, the selected one); rejects with why it can't.
  onSelect: (work: Work, on: string | undefined) => Promise<void>
  // Closes a work's worktree; rejects with the backend's reason when it refuses, and with code
  // NOT_FOUND once it is closed already.
  onCloseWork: (root: string, force: boolean) => Promise<WorkClosing>
}): React.JSX.Element => {
  const [last, setLast] = useState<{ root: string; on: string | undefined } | undefined>()
  // What the dialog asks about, and what went wrong last, as one line under a name.
  const [asking, setAsking] = useState<Asking | null>(null)
  const [refusal, setRefusal] = useState<{ title: string; text: string } | null>(null)
  useEffect(() => (watching ? watch() : undefined), [watching, watch])
  const rows = useMemo(() => changeRows(works, titles, projects), [works, titles, projects])
  const selected = selectedRoot(works, selectedId, last)
  // Asks the runner to close the worktree. Unforced, it may answer with what the worktree holds,
  // which the person confirms before it is asked again with force: nothing is forced unasked.
  const close = (row: ChangeRow, force: boolean): void => {
    setRefusal(null)
    onCloseWork(row.work.root, force).then(
      (closing) => {
        if (!closing.closed) setAsking({ row, holds: closing.holds })
      },
      (error: unknown) => {
        // Closed already (by an agent, meanwhile): nothing is left to close.
        if ((error as { code?: unknown } | null)?.code === "NOT_FOUND") return
        setRefusal({
          title: named(row),
          text: `stays: ${error instanceof Error ? error.message : "Novadeck could not close it."}`,
        })
      },
    )
  }
  const show = (work: Work, row: ChangeRow): void => {
    // The owner's bar, but a closed owner (in History) has none: the selected terminal's.
    const on = ownerOpen(work.terminalId, titles) ? work.terminalId! : selectedId
    setLast({ root: work.root, on })
    onSelect(work, on).catch((error: unknown) =>
      setRefusal({
        title: named(row),
        text: `can't be shown: ${error instanceof Error ? error.message : "Novadeck could not show it."}`,
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
            <strong>{refusal.title}</strong> {refusal.text}
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
              onSelect={(work) => show(work, row)}
              onClose={(each) => close(each, false)}
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
          if (asking) close(asking.row, true)
          setAsking(null)
        }}
        onCancel={() => setAsking(null)}
        widthClassName="w-[min(380px,calc(100vw-32px))]"
      />
    </SidebarPanel>
  )
}
