import type { Work, WorkClosing } from "@novadeck/core/works"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { SidebarItem, sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { SubjectBar, SubjectDetail, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  FilePenLine,
  GitBranch,
  GitCompare,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { panelLabels } from "./panel-labels"
import { SidebarPanel } from "./SidebarPanel"
import {
  changeRows,
  groups,
  originOf,
  ownerOpen,
  selectedRoot,
  type ChangeRow,
  type Fact,
  type FileView,
  type Group,
  type PullMark,
  type Standing,
} from "./worktree-rows"

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
    className="worktrees-file truncate"
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
  <span className="terminal-tab-branches worktrees-branches grid min-w-0">
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
              <span className="terminal-tab-wait-trail worktrees-trail">
                <Lines added={file.added} removed={file.removed} />
              </span>
            </>
          )
          return canOpen(row.work, file.path) ? (
            <button
              key={file.path}
              type="button"
              className="worktrees-file-open flex min-w-0 items-center gap-1.5 whitespace-nowrap"
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

// What the trash button says, when it is not available.
const busyTip = "Its agent is working in this worktree. Close it once the turn ends."

const closeTip = (row: ChangeRow): string =>
  row.close === "busy" ? busyTip : `Close the ${row.branch} worktree`

// The row's detail line: its owner's handle, then its branch, cut in the middle where it runs
// long so both its start and its end show.
const BranchLine = ({ row }: { row: ChangeRow }): React.JSX.Element => (
  <>
    {row.handle && <span className="worktrees-handle shrink-0">{row.handle}</span>}
    <span className="worktrees-branch min-w-0 truncate" title={row.branch}>
      {row.branch}
    </span>
  </>
)

// The row's icon: where it stands, its most telling fact. A working agent's spinner is the
// Terminals panel's own (tabs.css), turning while the row's phase says running.
const standingIcons: Readonly<Record<Exclude<Standing, "working">, LucideIcon>> = {
  conflict: TriangleAlert,
  "ci-failing": CircleX,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  ready: GitPullRequest,
  draft: GitPullRequestDraft,
  branch: GitBranch,
}

const StandingIcon = ({ standing }: { standing: Standing }): React.JSX.Element => {
  if (standing === "working")
    return <span aria-hidden className="terminal-glyph inline-block w-[1ch] text-center" />
  const Icon = standingIcons[standing]
  return <Icon size={14} strokeWidth={1.5} aria-hidden />
}

const factGlyphs: Readonly<Record<NonNullable<Fact["glyph"]>, LucideIcon>> = {
  "ci-passed": CircleCheck,
  "ci-failing": CircleX,
  "ci-running": LoaderCircle,
  unpushed: Upload,
  uncommitted: FilePenLine,
}

// What the row says under its branch: each fact in words, in its tone, the pull request's state
// followed by its number, a link to its page. The first fact's glyph is the row's icon already,
// so it goes without. It stands outside the row's select button, so the link is no control in a
// control (the button's label says it all); a click beside the link selects the row as the
// button would, for the pointer.
const Facts = ({
  row,
  onSelect,
}: {
  row: ChangeRow
  onSelect: () => void
}): React.JSX.Element | null =>
  row.facts.length === 0 ? null : (
    <div
      className="worktrees-facts"
      onClick={(event) => {
        if (!(event.target as Element).closest("a")) onSelect()
      }}
    >
      {row.facts.map((fact, index) => {
        const Glyph = index > 0 && fact.glyph ? factGlyphs[fact.glyph] : undefined
        return (
          <span key={fact.text} className="worktrees-fact" data-tone={fact.tone}>
            {Glyph && <Glyph size={11} strokeWidth={1.75} aria-hidden />}
            <span aria-hidden>{fact.text}</span>
            {fact.pull && row.pullRequest && <PullMarkLink mark={row.pullRequest} />}
          </span>
        )
      })}
    </div>
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
      <span className="worktrees-pr-text">{mark.text}</span>
    </>
  )
  return mark.url ? (
    <a
      className="worktrees-pr"
      href={mark.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={mark.label}
      data-state={mark.state}
    >
      {body}
    </a>
  ) : (
    <span className="worktrees-pr" role="img" aria-label={mark.label} data-state={mark.state}>
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
    row.handle,
    row.branch,
    files,
    linesWords(work),
    // Lowercased to run on in the label, but not an initialism ("CI failing", "PR closed").
    ...row.facts.map((fact) =>
      fact.text.replace(/^[A-Z](?![A-Z])/, (first) => first.toLowerCase()),
    ),
  ]
    .filter(Boolean)
    .join(", ")
  return (
    <SidebarItem
      role="listitem"
      className={`terminal-tab worktrees-row${selected ? " selected" : ""}`}
      name={row.title}
      icon={<StandingIcon standing={row.standing} />}
      detail={<BranchLine row={row} />}
      after={
        <>
          <Facts row={row} onSelect={() => onSelect(work)} />
          <Branches row={row} canOpen={canOpen} onOpenFile={onOpenFile} />
        </>
      }
      badge={
        work.added + work.removed > 0 ? (
          <span className="terminal-tab-kinds worktrees-size">
            <Lines added={work.added} removed={work.removed} />
          </span>
        ) : undefined
      }
      selected={selected}
      selectLabel={label}
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
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          </Tooltip>
        </div>
      }
      onSelect={() => onSelect(work)}
      data-terminal-phase={row.standing === "working" ? "running" : "idle"}
      data-worktrees-row={work.root}
      data-standing={row.standing}
      data-conflict={row.conflict || undefined}
      data-merged={row.merged || undefined}
      data-safe={row.safe || undefined}
      data-pull-request={row.pullRequest?.state}
    />
  )
}

const noHandles: ReadonlyMap<string, string> = new Map()

// Trash N safe's dialog: the safe rows it closes.
const sweepBar = (safe: readonly ChangeRow[]): React.JSX.Element => (
  <SubjectBar>
    <SubjectSide>
      <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
      <SubjectName>Done</SubjectName>
    </SubjectSide>
    <SubjectDetail end>{safe.length} safe</SubjectDetail>
  </SubjectBar>
)

const sweepDescription = (safe: readonly ChangeRow[]): string =>
  safe.length === 1
    ? "Its folder is removed. It is merged or its pull request closed, and nothing in it lives only here. Its branch stays."
    : "Their folders are removed. Each is merged or its pull request closed, and nothing in it lives only here. Their branches stay."

const sweepBody = (safe: readonly ChangeRow[]): React.JSX.Element => (
  <ul className="worktrees-kept text-control">
    {safe.map((row) => (
      <li key={row.work.root}>{`${row.title} (${row.branch})`}</li>
    ))}
  </ul>
)

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
  <ul className="worktrees-kept text-control">
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

// Where Done's fold is kept for the next time, in this browser only.
const doneFoldKey = "novadeck.worktrees.done-folded"

const readDoneFolded = (): boolean => {
  try {
    return localStorage.getItem(doneFoldKey) === "true"
  } catch {
    return false
  }
}

const keepDoneFolded = (folded: boolean): void => {
  try {
    localStorage.setItem(doneFoldKey, String(folded))
  } catch {
    // Not kept: it folds as it is told until the panel comes back.
  }
}

// The time, to the minute, so the origin line's age keeps up while nothing else changes. It may
// read a minute young, as the age is said to the minute or hour.
const useMinute = (): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

// The panel's top line: how old the remote's main is, which conflicts and merges are measured
// against, amber once an hour old, and Fetch, which fetches it now.
const OriginLine = ({
  origin,
  onFetch,
}: {
  origin: { readonly text: string; readonly stale: boolean }
  onFetch: (() => Promise<void>) | undefined
}): React.JSX.Element => {
  const [fetching, setFetching] = useState(false)
  return (
    <div className="worktrees-origin" data-stale={origin.stale || undefined}>
      <RefreshCw size={11} strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 truncate">{origin.text}</span>
      {onFetch && (
        <button
          type="button"
          className="worktrees-fetch"
          disabled={fetching}
          onClick={() => {
            setFetching(true)
            onFetch()
              .catch(() => {})
              .finally(() => setFetching(false))
          }}
        >
          {fetching ? "Fetching…" : "Fetch"}
        </button>
      )}
    </div>
  )
}

// A group's heading: its name and count; Done's folds, and holds Trash N safe.
const GroupHeading = ({
  group,
  title,
  count,
  folded,
  onFold,
  safe,
  onTrashSafe,
}: {
  group: Group
  title: string
  count: number
  folded: boolean | undefined
  onFold: (() => void) | undefined
  safe: number
  onTrashSafe: () => void
}): React.JSX.Element => {
  const id = `worktrees-group-${group}`
  const words = (
    <>
      <span>{title}</span>
      <span className="worktrees-group-count">{count}</span>
    </>
  )
  return (
    <div className="worktrees-group-heading" data-group={group}>
      <h3 id={id} className="worktrees-group-title">
        {onFold ? (
          <button
            type="button"
            className="worktrees-group-fold"
            aria-expanded={!folded}
            onClick={onFold}
          >
            {words}
            {folded ? (
              <ChevronRight size={12} strokeWidth={2} aria-hidden />
            ) : (
              <ChevronDown size={12} strokeWidth={2} aria-hidden />
            )}
          </button>
        ) : (
          words
        )}
      </h3>
      {safe > 0 && (
        <button type="button" className="worktrees-sweep" onClick={onTrashSafe}>
          <Trash2 size={12} strokeWidth={1.75} aria-hidden />
          Trash {safe} safe
        </button>
      )}
    </div>
  )
}

// The sidebar's Worktrees panel: the open project's works, each a git worktree Novadeck tracks,
// against main, drawn as the Terminals panel's tabs and named by the terminal that owns it (or
// "No owner"), grouped by what the person would do next: Needs you, In progress, In review and
// Done (groups.ts order), newest first within each. A row's icon says where it stands, and the
// line under its handle and branch says it in words: red only for what needs the person, amber
// for what lives only here, green for what is safe to trash. A click shows the work on its
// owner's bar. The trash button asks the runner to close the worktree, which says what it holds
// when the person should confirm first, and waits while its owner's agent is working in it; on a
// safe row it shows at rest, and Done's Trash N safe closes every safe one after one confirm.
export const WorktreesPanel = ({
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
  handles = noHandles,
  forges = true,
  onFetch,
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
  // Each terminal's handle as people see it ("@moth"), by id, where it has one.
  handles?: ReadonlyMap<string, string>
  // Whether pull requests are looked for (a forge is on): while none is, rows say nothing of one.
  forges?: boolean
  // Fetches origin now for the open project; absent where the backend can't.
  onFetch?: () => Promise<void>
}): React.JSX.Element => {
  const [last, setLast] = useState<{ root: string; on: string | undefined } | undefined>()
  // What the dialog asks about, and what went wrong last, as one line under a name.
  const [asking, setAsking] = useState<Asking | null>(null)
  const [refusal, setRefusal] = useState<{
    root: string
    title: string
    text: string
  } | null>(null)
  useEffect(() => (watching ? watch() : undefined), [watching, watch])
  const now = useMinute()
  const rows = useMemo(
    () => changeRows(works, titles, now, handles, forges),
    [works, titles, now, handles, forges],
  )
  const origin = originOf(works, now)
  const [doneFolded, setDoneFolded] = useState(readDoneFolded)
  // The safe rows Trash N safe would close, while its dialog asks.
  const [sweeping, setSweeping] = useState<readonly ChangeRow[] | null>(null)
  // Both go with their row: once another project is open, or the worktree closed meanwhile,
  // they would name a row the list no longer has. Settled as the works change, during render.
  const [seen, setSeen] = useState(works)
  if (seen !== works) {
    setSeen(works)
    const listed = (root: string): boolean => works.some((work) => work.root === root)
    if (refusal && !listed(refusal.root)) setRefusal(null)
    if (asking && !listed(asking.row.work.root)) setAsking(null)
    if (sweeping && !sweeping.some((row) => listed(row.work.root))) setSweeping(null)
  }
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
          root: row.work.root,
          title: named(row),
          text: `stays: ${error instanceof Error ? error.message : "Novadeck could not close it."}`,
        })
      },
    )
  }
  // Closes every safe row, unforced: the runner closes a safe worktree without asking, and one
  // that has stopped being safe since stays, saying why above the list.
  const sweep = (safe: readonly ChangeRow[]): void => {
    setRefusal(null)
    for (const row of safe)
      onCloseWork(row.work.root, false).then(
        (closing) => {
          if (!closing.closed)
            setRefusal({
              root: row.work.root,
              title: named(row),
              text: `stays: it holds ${closing.holds}.`,
            })
        },
        (error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === "NOT_FOUND") return
          setRefusal({
            root: row.work.root,
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
        root: work.root,
        title: named(row),
        text: `can't be shown: ${error instanceof Error ? error.message : "Novadeck could not show it."}`,
      }),
    )
  }
  return (
    <SidebarPanel
      id="worktrees-panel"
      title={panelLabels.worktrees}
      count={reported || works.length > 0 ? works.length : undefined}
      active={active}
      onClose={onClose}
    >
      {refusal && (
        <div className="worktrees-refusal" role="alert">
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
      {origin && rows.length > 0 && <OriginLine origin={origin} onFetch={onFetch} />}
      {rows.length === 0 ? (
        reported && (
          <div className="worktrees-empty">
            <h3 className="text-body">No worktrees</h3>
            <p className="text-control">
              When an agent opens or takes a git worktree in this project, it shows up here with its
              branch, and you can close it.
            </p>
          </div>
        )
      ) : (
        <div className={`worktrees-list ${sidebarListClasses}`}>
          {groups.map(({ key, title }) => {
            const members = rows.filter((row) => row.group === key)
            if (members.length === 0) return null
            const safe = members.filter((row) => row.safe)
            const folded = key === "done" ? doneFolded : undefined
            return (
              <section
                key={key}
                className="worktrees-group"
                aria-labelledby={`worktrees-group-${key}`}
              >
                <GroupHeading
                  group={key}
                  title={title}
                  count={members.length}
                  folded={folded}
                  onFold={
                    key === "done"
                      ? () => {
                          keepDoneFolded(!doneFolded)
                          setDoneFolded(!doneFolded)
                        }
                      : undefined
                  }
                  safe={safe.length}
                  onTrashSafe={() => setSweeping(safe)}
                />
                {!folded && (
                  <div className="worktrees-group-rows" role="list" aria-label={title}>
                    {members.map((row) => (
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
              </section>
            )
          })}
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
      <ConfirmDialog
        subject={sweeping}
        bar={sweepBar}
        title={(each) => `Trash ${each.length} ${each.length === 1 ? "worktree" : "worktrees"}?`}
        description={sweepDescription}
        body={sweepBody}
        confirmLabel="Trash them"
        cancelLabel="Keep them"
        onConfirm={() => {
          if (sweeping) sweep(sweeping)
          setSweeping(null)
        }}
        onCancel={() => setSweeping(null)}
        widthClassName="w-[min(380px,calc(100vw-32px))]"
      />
    </SidebarPanel>
  )
}
