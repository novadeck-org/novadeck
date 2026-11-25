import type { LitTeams, Team } from "@novadeck/core/derivations"
import type { Work, WorkClosing } from "@novadeck/core/works"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { NeedMark } from "@novadeck/toolkit/NeedMark"
import { PhaseGlyph } from "@novadeck/toolkit/PhaseGlyph"
import { SidebarItem, SidebarItemHandle, sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { SubjectBar, SubjectDetail, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { isFolded, rowFold, type RowFold } from "@novadeck/toolkit/team-fold"
import {
  listedFoldRows,
  teamFoldRowClasses,
  TeamFoldMore,
  TeamFoldRow,
  TeamFoldRows,
} from "@novadeck/toolkit/TeamFoldRows"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import {
  ChevronLeft,
  ExternalLink,
  GitBranch,
  GitCompare,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useState, memo, type ReactNode } from "react"

import { panelLabels } from "./panel-labels"
import { SidebarPanel } from "./SidebarPanel"
import {
  chainOf,
  descendantsOf,
  litOf,
  originOf,
  roleOf,
  worktreeTeams,
  ownerOpen,
  selectedRoot,
  stateGlyphs,
  worktreeRows,
  type ChecksBar,
  type PullMark,
  type WorktreeRow,
  type WorktreeTeams,
} from "./worktree-rows"

// What the trash button says, when it waits.
const busyTip = "Its agent is working in this worktree. Close it once the turn ends."

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

// What the trash button says: a safe worktree goes at once; any other asks first, saying what it
// holds as far as the row knows.
const closeTip = (row: WorktreeRow): string => {
  if (row.close === "busy") return busyTip
  if (row.safe) return "Trash it: nothing in it lives only here"
  const { uncommitted = 0, unpushed = 0, pullRequest } = row.work
  const holds = [
    uncommitted > 0 && `${plural(uncommitted, "file", "files")} not committed`,
    unpushed > 0 && `${plural(unpushed, "commit", "commits")} not pushed`,
    (pullRequest?.state === "open" || pullRequest?.state === "draft") && "an open pull request",
  ].filter(Boolean)
  return `Close it, after a confirm: it holds ${holds.length > 0 ? holds.join(", ") : `work ${row.target} lacks`}`
}

// The pull request's number, tinted by its state, with its checks and review as a bar under it,
// as wide as the number. Inside the row's select button, so no control: its page opens from the
// row's actions.
const PullNumber = ({
  mark,
  bar,
}: {
  mark: PullMark
  bar: ChecksBar | undefined
}): React.JSX.Element => (
  <Tooltip content={bar ? `${mark.label}: ${bar.words}` : mark.label}>
    <span className="worktrees-pr" data-state={mark.state} aria-hidden>
      {mark.text}
      {bar && (
        <span className="worktrees-checks">
          {bar.segments.map((segment) => (
            <i key={segment.key} data-check={segment.state} style={{ flexGrow: segment.weight }} />
          ))}
          {bar.review && <b data-review={bar.review} />}
        </span>
      )}
    </span>
  </Tooltip>
)

// The row's detail line, a tab's: the worktree's glyph, where its work goes ("main ‹ branch", the
// branch giving way first), its need mark, and at the end, where a tab holds its @handle, its
// owner's handle, which the actions fade in over.
const RouteLine = ({ row }: { row: WorktreeRow }): React.JSX.Element => {
  const glyph = stateGlyphs[row.state]
  return (
    <>
      <PhaseGlyph phase={glyph.phase} failed={glyph.failed ?? false} wait={glyph.wait} />
      <span className="worktrees-target truncate">{row.target}</span>
      <ChevronLeft
        className="worktrees-route-mark shrink-0"
        size={11}
        strokeWidth={1.75}
        aria-hidden
      />
      <span className="worktrees-branch truncate" data-unread={row.unread || undefined}>
        {row.branch}
      </span>
      {row.need && (
        <Tooltip content={row.need.why}>
          <span className="worktrees-need inline-flex shrink-0">
            <NeedMark need={row.need.need} hidden />
          </span>
        </Tooltip>
      )}
      {row.handle ? (
        <SidebarItemHandle handle={row.handle} />
      ) : (
        <span className="handle-chip handle-plain sidebar-item-handle sidebar-item-end">
          no agent
        </span>
      )}
    </>
  )
}

const WorktreeItem = ({
  row,
  selected,
  team,
  fold,
  foldedRows,
  foldedCount,
  onSelect,
  onClose,
}: {
  row: WorktreeRow
  selected: boolean
  // Its place in the selected worktree's tree of teams, and how it stands in its leads' folds
  // (the toolkit's team-rows.css, as a terminal's tab).
  team: "lead" | "worker" | undefined
  fold: RowFold | undefined
  // A folded lead's members, under its line, and how many fold away into it, which its label says.
  foldedRows: ReactNode
  foldedCount: number
  onSelect: (work: Work) => void
  onClose: (row: WorktreeRow) => void
}): React.JSX.Element => {
  const { work } = row
  const url = row.pullRequest?.url
  const level = row.above.length
  return (
    <SidebarItem
      role="listitem"
      className={`terminal-tab worktrees-row ${teamFoldRowClasses}${selected ? " selected" : ""}`}
      name={row.name}
      icon={<GitBranch size={13} strokeWidth={1.5} aria-hidden />}
      detail={<RouteLine row={row} />}
      {...(foldedRows ? { below: foldedRows } : {})}
      {...(row.pullRequest ? { badge: <PullNumber mark={row.pullRequest} bar={row.bar} /> } : {})}
      selected={selected}
      selectLabel={
        foldedCount > 0
          ? `${row.label}, ${foldedCount} ${foldedCount === 1 ? "worktree" : "worktrees"} folded under it`
          : row.label
      }
      actions={
        <div className="worktrees-slot sidebar-item-slot flex items-center">
          {url && (
            <Tooltip content={`Open ${row.pullRequest!.text}`}>
              <a
                className="worktrees-action icon-button small dim quiet"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${row.pullRequest!.text} in the browser`}
              >
                <ExternalLink size={14} strokeWidth={1.5} />
              </a>
            </Tooltip>
          )}
          <Tooltip content={closeTip(row)}>
            <button
              className="worktrees-action worktrees-trash icon-button small dim quiet"
              aria-label={`Close the ${row.branch} worktree, ${row.name}`}
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
      data-worktrees-row={work.root}
      data-state={row.state}
      {...(row.state === "over" ? { "data-ended": true } : {})}
      {...(row.untitled ? { "data-untitled": true } : {})}
      {...(row.need ? { "data-need": row.need.need } : {})}
      data-safe={row.safe || undefined}
      data-pull-request={row.pullRequest?.state}
      {...(team ? { "data-team": team } : {})}
      {...(fold ? { "data-team-fold": fold } : {})}
      {...(level ? { "data-team-level": Math.min(level, 3) } : {})}
      // Room for its actions: one button, or two with its pull request's page.
      style={{ "--_sidebar-actions-space": url ? "52px" : "26px" } as React.CSSProperties}
    />
  )
}

// A folded lead's members, under its line (the toolkit's TeamFoldRows, as a folded lead's tab
// draws its teammates): each one's glyph, title and need, the worktrees it folds away with it,
// and past four, a last row counting the rest with what any of them needs. A click shows the
// member as its own row's would; the last row unfolds the team.
const FoldedWorktrees = ({
  lead,
  teams,
  rows,
  selected,
  entering,
  onOpen,
  onUnfold,
}: {
  lead: string
  teams: WorktreeTeams
  rows: ReadonlyMap<string, WorktreeRow>
  selected: string | undefined
  entering: boolean
  onOpen: (row: WorktreeRow) => void
  onUnfold: () => void
}): React.JSX.Element | null => {
  const members = teams.teams.find((team) => team.lead === lead)?.workers ?? []
  if (!members.length) return null
  const listed = members.length > listedFoldRows ? members.slice(0, listedFoldRows - 1) : members
  const rest = members.length - listed.length
  const need = (root: string) => {
    const mark = rows.get(root)?.need
    return mark ? <NeedMark key={root} need={mark.need} /> : null
  }
  const shownBelow = new Set(listed.flatMap((root) => descendantsOf(teams, root)))
  return (
    <TeamFoldRows entering={entering}>
      {listed.map((root, index) => {
        const row = rows.get(root)
        if (!row) return null
        const glyph = stateGlyphs[row.state]
        const below = descendantsOf(teams, root)
        return (
          <TeamFoldRow
            key={root}
            id={root}
            index={index}
            last={!rest && index === listed.length - 1}
            phase={glyph.phase}
            failed={glyph.failed ?? false}
            name={row.name}
            sleeping={row.state === "dormant"}
            selected={root === selected}
            below={below.length}
            needs={
              <>
                {need(root)}
                {below.map(need)}
              </>
            }
            onOpen={() => onOpen(row)}
          />
        )
      })}
      {rest > 0 && (
        <TeamFoldMore
          count={rest}
          needs={descendantsOf(teams, lead)
            .filter((root) => !listed.includes(root) && !shownBelow.has(root))
            .map(need)}
          onUnfold={onUnfold}
        />
      )}
    </TeamFoldRows>
  )
}

// What the team wire on the rail's border needs of the list (app's WorktreesWire): the list's
// element, its teams of worktrees (by root) with each one's level and the leads above it, what
// lights for the selected worktree, and that one.
export type WorktreesWire = {
  readonly list: HTMLElement | null
  readonly teams: readonly Team[]
  readonly levels: readonly number[]
  readonly chains: readonly string[]
  readonly lit: LitTeams
  readonly above: readonly string[]
  readonly selected: string
}

// The context its folds are kept by: one per panel, as the leads are worktrees' roots.
const foldContext = "worktrees"

const noHandles: ReadonlyMap<string, string> = new Map()
const noLeads: readonly string[] = []

// Trash N safe's dialog: the safe rows it closes.
const sweepBar = (safe: readonly WorktreeRow[]): React.JSX.Element => (
  <SubjectBar>
    <SubjectSide>
      <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
      <SubjectName>Safe to trash</SubjectName>
    </SubjectSide>
    <SubjectDetail end>{safe.length} safe</SubjectDetail>
  </SubjectBar>
)

const sweepDescription = (safe: readonly WorktreeRow[]): string =>
  safe.length === 1
    ? "Its folder is removed. It landed or its pull request closed, and nothing in it lives only here. Its branch stays."
    : "Their folders are removed. Each landed or its pull request closed, and nothing in it lives only here. Their branches stay."

// A row by its name and branch, as a notice names it.
const named = (row: WorktreeRow): string =>
  row.untitled ? row.branch : `${row.name} (${row.branch})`

const sweepBody = (safe: readonly WorktreeRow[]): React.JSX.Element => (
  <ul className="worktrees-kept text-control">
    {safe.map((row) => (
      <li key={row.work.root}>{named(row)}</li>
    ))}
  </ul>
)

// What the dialog asks about: a worktree the runner said holds something, and what.
type Asking = { readonly row: WorktreeRow; readonly holds: string }

// What the dialog says is kept. A detached worktree has no branch to keep commits on.
const keptNotes = ({ row }: Asking): readonly string[] => [
  ...(row.work.branch === null ? [] : [`Committed work stays on the branch ${row.branch}.`]),
  "Uncommitted work, and commits only a detached HEAD reaches, are kept on a ref under refs/novadeck/kept/ in the repository.",
  "Ignored files, such as .env, are not kept.",
]

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
      <SubjectName>{row.name}</SubjectName>
    </SubjectSide>
    <SubjectDetail end>{row.branch}</SubjectDetail>
  </SubjectBar>
)

// The time, to the minute, so the origin line's age and a row's dormancy keep up while nothing
// else changes. It may read a minute young, as the age is said to the minute or hour.
const useMinute = (): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

// The panel's top line: how old the remote's main is, which conflicts and landing are measured
// against, amber once an hour old, and Fetch, which fetches it now.
const OriginLine = ({
  origin,
  onFetch,
}: {
  origin: { readonly text: string; readonly stale: boolean }
  onFetch: (() => Promise<void>) | undefined
}): React.JSX.Element => {
  const [fetching, setFetching] = useState(false)
  // Why the last fetch failed, until the next one: the age stays as it was.
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <div className="worktrees-origin" data-stale={origin.stale || undefined}>
      <RefreshCw size={11} strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 truncate" {...(failed ? { title: failed } : {})}>
        {origin.text}
        {failed && " · fetch failed"}
      </span>
      {onFetch && (
        <button
          type="button"
          className="worktrees-fetch"
          disabled={fetching}
          onClick={() => {
            setFetching(true)
            setFailed(null)
            onFetch()
              .catch((error: unknown) =>
                setFailed(error instanceof Error ? error.message : "Novadeck could not fetch."),
              )
              .finally(() => setFetching(false))
          }}
        >
          {fetching ? "Fetching…" : failed ? "Retry" : "Fetch"}
        </button>
      )}
    </div>
  )
}

// The sidebar's Worktrees panel: the open project's works, each a git worktree Novadeck tracks,
// in one flat list, newest first, each drawn as a terminal's tab: its title (its branch where it
// has none) and its pull request's number over its checks and review; then what the worktree
// does, in the tab's glyphs, where its work goes ("main ‹ branch"), `!` or `?` where it needs the
// person, and its owner's handle. A click shows the work on its owner's bar. Under the pointer the
// handle gives way to its pull request's page and its trash, full strength where nothing in it
// lives only here; any other asks the runner, which says what it holds for the person to confirm,
// and it waits while its owner's agent is working in it. The header's Trash N trashes every safe
// one after one confirm.
const WorktreesPanelView = ({
  works,
  reported,
  watch,
  titles,
  selectedId,
  active,
  watching,
  onClose,
  onSelect,
  onCloseWork,
  handles = noHandles,
  onFetch,
  folded = noLeads,
  preview,
  unfolding,
  folding,
  onFold,
  onWire,
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
  // Closes a work's worktree; rejects with the backend's reason when it refuses, and with code
  // NOT_FOUND once it is closed already.
  onCloseWork: (root: string, force: boolean) => Promise<WorkClosing>
  // Each terminal's handle, bare ("moth"), by id, where it has one.
  handles?: ReadonlyMap<string, string>
  // Fetches origin now for the open project; absent where the backend can't.
  onFetch?: () => Promise<void>
  // The leads (worktrees' roots) whose teams the person folded into them, the one whose gutter
  // they point at, and the one they just unfolded or folded, as the Terminals list's are kept.
  folded?: readonly string[]
  preview?: string | undefined
  unfolding?: string | undefined
  folding?: string | undefined
  // Folds a lead's team or shows it again; without it, no team folds.
  onFold?: (lead: string) => void
  // Takes what the team wire draws on the rail, as it changes.
  onWire?: (wire: WorktreesWire | null) => void
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
  const teams = useMemo(() => worktreeTeams(works), [works])
  const rows = useMemo(
    () => worktreeRows(works, titles, now, handles, teams),
    [works, titles, now, handles, teams],
  )
  const byRoot = useMemo(() => new Map(rows.map((row) => [row.work.root, row])), [rows])
  const [list, setList] = useState<HTMLElement | null>(null)
  const origin = originOf(works, now)
  // The safe rows Trash N safe would close, while its dialog asks.
  const [sweeping, setSweeping] = useState<readonly WorktreeRow[] | null>(null)
  // The rows Trash N safe is closing now.
  const [sweepingRoots, setSweepingRoots] = useState<ReadonlySet<string>>(() => new Set())
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
  // The wire on the rail joins each lead to its members, lit for the selected worktree's teams.
  const wire = useMemo((): WorktreesWire => {
    const chains = teams.teams.map(({ lead }) => chainOf(teams, lead))
    return {
      list,
      teams: teams.teams,
      levels: chains.map((chain) => chain.length),
      chains: chains.map((chain) => chain.join(" ")),
      lit: litOf(teams, selected),
      above: selected === undefined ? noLeads : chainOf(teams, selected),
      selected: selected ?? "",
    }
  }, [list, teams, selected])
  useLayoutEffect(() => {
    onWire?.(wire)
  }, [onWire, wire])
  useEffect(
    () => () => {
      onWire?.(null)
    },
    [onWire],
  )
  // How each row stands in its leads' folds (the toolkit's rowFold), as a terminal's tab does.
  const foldOf = (row: WorktreeRow): RowFold | undefined => {
    const root = row.work.root
    const selectedChain = selected === undefined ? noLeads : chainOf(teams, selected)
    const at = selected === undefined ? -1 : row.above.indexOf(selected)
    return rowFold({
      folded: { [foldContext]: folded },
      context: foldContext,
      above: row.above,
      kept: selected === root || selectedChain.includes(root),
      underSelected: at < 0 ? noLeads : row.above.slice(0, at + 1),
      selectedAbove: at < 0 ? noLeads : selectedChain,
      preview: preview === undefined ? null : { context: foldContext, lead: preview },
      unfolding: unfolding === undefined ? null : { context: foldContext, lead: unfolding },
    })
  }
  const foldsIn = (lead: string) =>
    onFold !== undefined && isFolded({ [foldContext]: folded }, foldContext, lead)
  // A row whose agent is working waits, as its own trash button does.
  const safe = rows.filter(
    (row) => row.safe && row.close !== "busy" && !sweepingRoots.has(row.work.root),
  )
  // Asks the runner to close the worktree. Unforced, it may answer with what the worktree holds,
  // which the person confirms before it is asked again with force: nothing is forced unasked.
  const close = (row: WorktreeRow, force: boolean): void => {
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
  // Closes every safe row, unforced: the runner closes a safe worktree without asking. While they
  // close they leave Trash N, so a second click doesn't close them again. Any that stopped being
  // safe since stay, named together above the list with the first one's reason.
  const sweep = (each: readonly WorktreeRow[]): void => {
    setRefusal(null)
    const roots = each.map((row) => row.work.root)
    setSweepingRoots((was) => new Set([...was, ...roots]))
    void Promise.all(
      each.map((row) =>
        onCloseWork(row.work.root, false).then(
          (closing): { row: WorktreeRow; why: string } | undefined =>
            closing.closed ? undefined : { row, why: `it holds ${closing.holds}` },
          (error: unknown): { row: WorktreeRow; why: string } | undefined =>
            (error as { code?: unknown } | null)?.code === "NOT_FOUND"
              ? undefined
              : {
                  row,
                  why: error instanceof Error ? error.message : "Novadeck could not close it",
                },
        ),
      ),
    ).then((answers) => {
      setSweepingRoots((was) => new Set([...was].filter((root) => !roots.includes(root))))
      const stayed = answers.filter((answer) => answer !== undefined)
      if (stayed.length === 0) return
      setRefusal({
        root: stayed[0]!.row.work.root,
        title: stayed.map(({ row }) => named(row)).join(", "),
        text: `${stayed.length === 1 ? "stays" : "stay"}: ${stayed[0]!.why}.`,
      })
    })
  }
  const show = (work: Work, row: WorktreeRow): void => {
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
      actions={
        safe.length > 0 && (
          <Tooltip content="Trash the worktrees safe to trash">
            <button
              type="button"
              className="worktrees-sweep"
              aria-label={`Trash ${safe.length} safe ${safe.length === 1 ? "worktree" : "worktrees"}`}
              onClick={() => setSweeping(safe)}
            >
              <Trash2 size={13} strokeWidth={1.5} aria-hidden />
              {safe.length}
            </button>
          </Tooltip>
        )
      }
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
        <div
          ref={setList}
          className={`worktrees-list ${sidebarListClasses}`}
          role="list"
          aria-label={panelLabels.worktrees}
        >
          {rows.map((row) => (
            <WorktreeItem
              key={row.work.root}
              row={row}
              selected={row.work.root === selected}
              team={roleOf(teams, row.work.root, selected)}
              fold={foldOf(row)}
              foldedRows={
                foldsIn(row.work.root) && (
                  <FoldedWorktrees
                    lead={row.work.root}
                    teams={teams}
                    rows={byRoot}
                    selected={selected}
                    entering={folding === row.work.root}
                    onOpen={(each) => show(each.work, each)}
                    onUnfold={() => onFold?.(row.work.root)}
                  />
                )
              }
              foldedCount={foldsIn(row.work.root) ? descendantsOf(teams, row.work.root).length : 0}
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
      <ConfirmDialog
        subject={sweeping}
        bar={sweepBar}
        title={(each) => `Trash ${each.length} ${each.length === 1 ? "worktree" : "worktrees"}?`}
        description={sweepDescription}
        body={sweepBody}
        confirmLabel={sweeping?.length === 1 ? "Trash it" : "Trash them"}
        cancelLabel={sweeping?.length === 1 ? "Keep it" : "Keep them"}
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

// Drawn again only as its own props change: the sidebar keeps every panel mounted.
export const WorktreesPanel = memo(WorktreesPanelView)
