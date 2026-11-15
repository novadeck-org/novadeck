import type { Work, WorkClosing } from "@novadeck/core/works"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { SidebarItem, sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { SubjectBar, SubjectDetail, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import {
  GitCompare,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  X,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useMemo, useState, type CSSProperties } from "react"

import {
  changeRows,
  ownerOpen,
  selectedRoot,
  type ChangeRow,
  type FileView,
  type PullMark,
} from "./changes-rows"
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

// The files under the row, a branch each, as a tab's subagents unfold under it (tabs.css). A file
// opens in the project window, as a preview of what the works merge to.
const Branches = ({
  row,
  canOpen,
  onOpenFile,
}: {
  row: ChangeRow
  canOpen: (work: Work, path: string) => boolean
  onOpenFile: (work: Work, path: string) => void
}): React.JSX.Element => (
  <span className="terminal-tab-branches changes-branches grid min-w-0">
    <span className="terminal-tab-branches-fold min-h-0 overflow-hidden">
      <span className="flex min-w-0 flex-col pt-1 pr-2.5 pb-2 pl-8 text-caption leading-[18px]">
        {row.branches.map((branch, index) => {
          const glyph = (
            <span aria-hidden className="terminal-tab-branch shrink-0">
              {index === row.branches.length - 1 ? "└" : "├"}
            </span>
          )
          if (branch.kind === "more")
            return (
              <span
                key="more"
                aria-hidden
                className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
              >
                {glyph}
                <span className="truncate">{branch.text}</span>
              </span>
            )
          const { file } = branch
          const body = (
            <>
              {glyph}
              <FileName file={file} title />
              <span className="terminal-tab-wait-trail changes-trail">
                <Lines added={file.added} removed={file.removed} />
              </span>
            </>
          )
          return canOpen(row.work, file.path) ? (
            <button
              key={file.path}
              type="button"
              className="changes-file-open flex min-w-0 items-center gap-1.5 whitespace-nowrap"
              aria-label={`Preview ${file.path} with every agent's work merged`}
              onClick={() => onOpenFile(row.work, file.path)}
            >
              {body}
            </button>
          ) : (
            <span
              key={file.path}
              aria-hidden
              className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
            >
              {body}
            </span>
          )
        })}
      </span>
    </span>
  </span>
)

// The work's total lines in words, for the row's accessible label: "85 lines added, 18 removed".
const linesWords = (work: Work): string | undefined => {
  const parts = [
    work.added > 0 && `${work.added} ${work.added === 1 ? "line" : "lines"} added`,
    work.removed > 0 && `${work.removed} removed`,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : undefined
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

// The glyph of a pull request's state, as the forges draw them.
const pullGlyphs: Readonly<Record<PullMark["state"], LucideIcon>> = {
  draft: GitPullRequestDraft,
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
}

// The work's pull request, "#812" after its state's glyph: a link to its page at the end of the
// row's detail line, among the row's actions rather than in its select button (a link inside it
// would be a control in a control), so it is reached by Tab and a click does not select the row.
const PullMarkLink = ({ mark }: { mark: PullMark }): React.JSX.Element => {
  const Glyph = pullGlyphs[mark.state]
  const body = (
    <>
      <Glyph size={12} strokeWidth={1.5} aria-hidden />
      <span className="changes-pr-text">{mark.text}</span>
    </>
  )
  return mark.url ? (
    <a
      className="changes-pr"
      href={mark.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={mark.label}
      data-state={mark.state}
    >
      {body}
    </a>
  ) : (
    <span className="changes-pr" role="img" aria-label={mark.label} data-state={mark.state}>
      {body}
    </span>
  )
}

const ChangeItem = ({
  row,
  selected,
  onSelect,
  canOpen,
  onOpenFile,
  onClose,
}: {
  row: ChangeRow
  selected: boolean
  onSelect: (work: Work) => void
  canOpen: (work: Work, path: string) => boolean
  onOpenFile: (work: Work, path: string) => void
  onClose: (row: ChangeRow) => void
}): React.JSX.Element => {
  const { work } = row
  const count = work.files.length
  const files = `${count}${work.truncated ? "+" : ""} ${count === 1 && !work.truncated ? "file" : "files"} changed`
  const label = [
    row.title,
    row.branch,
    files,
    linesWords(work),
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
      after={<Branches row={row} canOpen={canOpen} onOpenFile={onOpenFile} />}
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
          {row.pullRequest && <PullMarkLink mark={row.pullRequest} />}
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
      data-pull-request={row.pullRequest?.state}
      // The detail line keeps room for the mark beside the ×: its glyph and gaps, and its text.
      style={
        row.pullRequest
          ? ({
              "--_sidebar-actions-space": `calc(${row.pullRequest.text.length}ch + 46px)`,
            } as CSSProperties)
          : undefined
      }
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

// The sidebar's Changes panel: the open project's works, each a git worktree Novadeck tracks,
// against main, drawn as the Terminals panel's tabs and named by the terminal that owns it (or
// "No owner"). First come, first served. A merged
// work (its changes already in main) has a green merge icon, which wins over a conflict; a
// conflicting one a red icon. A click
// shows the work on its owner's bar. The × asks the runner to close the worktree, which says what it holds when the
// person should confirm first, and waits while its owner's agent is working in it.
export const ChangesPanel = ({
  works,
  reported,
  watch,
  titles,
  selectedId,
  active,
  watching,
  onClose,
  onSelect,
  canOpenFile,
  onOpenFile,
  onCloseWork,
}: {
  // The open project's works.
  works: readonly Work[]
  // The backend has reported every work at least once. Until then the panel lists what it has
  // and says neither how many nor that there are none: an empty list may only be unread.
  reported: boolean
  // Follows the works until the returned release is called.
  watch: () => () => void
  // Each terminal's title, by id, in every project.
  titles: ReadonlyMap<string, string>
  // The selected terminal, where a work with no owner is shown.
  selectedId: string | undefined
  active: boolean
  // The panel is the one shown: the works are followed only then.
  watching: boolean
  onClose: () => void
  // Shows a work on the bar of the terminal named (its owner, or where it has none, or its
  // owner is closed, the selected one); rejects with why it can't.
  onSelect: (work: Work, on: string | undefined) => Promise<void>
  // Whether a file of a work can be opened so: main has it.
  canOpenFile: (work: Work, path: string) => boolean
  // Opens a file of a work in the project window, as a preview of what the works merge to.
  onOpenFile: (work: Work, path: string) => void
  // Closes a work's worktree; rejects with the backend's reason when it refuses, and with code
  // NOT_FOUND once it is closed already.
  onCloseWork: (root: string, force: boolean) => Promise<WorkClosing>
}): React.JSX.Element => {
  const [last, setLast] = useState<{ root: string; on: string | undefined } | undefined>()
  // What the dialog asks about, and what went wrong last, as one line under a name.
  const [asking, setAsking] = useState<Asking | null>(null)
  const [refusal, setRefusal] = useState<{ title: string; text: string } | null>(null)
  useEffect(() => (watching ? watch() : undefined), [watching, watch])
  const rows = useMemo(() => changeRows(works, titles), [works, titles])
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
      count={reported || works.length > 0 ? works.length : undefined}
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
        reported && (
          <div className="changes-empty">
            <h3 className="text-body">No worktrees</h3>
            <p className="text-control">
              When an agent opens or takes a git worktree in this project, it shows up here with its
              branch, and you can close it.
            </p>
          </div>
        )
      ) : (
        <div className={`changes-list ${sidebarListClasses}`} role="list" aria-label="Changes">
          {rows.map((row) => (
            <ChangeItem
              key={row.work.root}
              row={row}
              selected={row.work.root === selected}
              onSelect={(work) => show(work, row)}
              canOpen={canOpenFile}
              onOpenFile={onOpenFile}
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
