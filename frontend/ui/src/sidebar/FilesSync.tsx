import type { RepoSync, SyncLanding } from "@novadeck/core/files"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { PhaseGlyph, type GlyphPhase } from "@novadeck/toolkit/PhaseGlyph"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Check, Copy, ExternalLink, SquareTerminal } from "lucide-react"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import {
  agoOf,
  elapsedOf,
  hasNews,
  landingFoot,
  marksOf,
  moveCommand,
  lockPathIn,
  newCount,
  pullHref,
  shortSha,
  whyBehind,
  type DependencyRun,
  type SyncMark,
  type SyncTerminals,
  type RepoRun,
  type TerminalProgress,
  type UpdateRun,
} from "./files-sync"

// How each git repository stands against its origin's main, in the Files panel: the marks on a
// repository's folder row, the line over a tree that starts inside one, and the card a mark opens.

// The kind of card a mark opens: what landed, or what main left behind.
export type SyncCardKind = "new" | "behind"

// Where a mark is, for the card to hang off it: its kind and its repository's path.
export const markKey = (kind: SyncMark["kind"], path: string): string => `${kind}:${path}`

// One mark: a button that opens its card where there is one (what landed, what is behind), and
// plain words in a tooltip where there is none (what is ahead of origin).
const Mark = ({
  mark,
  path,
  open,
  inTree,
  onOpen,
}: {
  mark: SyncMark
  path: string
  open: boolean
  // It sits in a tree's row, whose own label says it and whose menu opens it: out of the tab order
  // and of what a screen reader reads. Outside the tree it is a control like any other.
  inTree: boolean
  onOpen: (kind: SyncCardKind, anchor: HTMLElement) => void
}): React.JSX.Element =>
  mark.kind === "ahead" ? (
    <Tooltip content={mark.tip}>
      <span className="files-mark" data-kind="ahead" aria-hidden="true">
        {mark.text}
      </span>
    </Tooltip>
  ) : (
    <Tooltip content={mark.tip}>
      <button
        type="button"
        className="files-mark"
        data-kind={mark.kind}
        data-open={open}
        data-sync-mark={markKey(mark.kind, path)}
        tabIndex={inTree ? -1 : 0}
        aria-hidden={inTree ? true : undefined}
        aria-label={mark.tip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => onOpen(mark.kind, event.currentTarget)}
      >
        {mark.text}
      </button>
    </Tooltip>
  )

// A repository's marks on its folder row, in its chips' place: what landed, what is behind and
// what is ahead; nothing for a repository that is up to date.
export const SyncMarks = ({
  repo,
  open,
  onOpen,
}: {
  repo: RepoSync
  // The card that hangs off this repository's mark now.
  open: SyncCardKind | undefined
  onOpen: (repo: RepoSync, kind: SyncCardKind, anchor: HTMLElement) => void
}): React.JSX.Element | null => {
  const marks = marksOf(repo)
  if (marks.length === 0) return null
  return (
    <>
      {marks.map((mark) => (
        <Mark
          key={mark.kind}
          mark={mark}
          path={repo.path}
          open={open === mark.kind}
          inTree
          onOpen={(kind, anchor) => onOpen(repo, kind, anchor)}
        />
      ))}
    </>
  )
}

// A closed folder that hides a repository with news.
export const SyncDot = (): React.JSX.Element => <span className="files-dot" aria-hidden="true" />

// The line over a tree that starts inside a repository, there while it has news: that main just
// caught up, or is behind. Its marks open the same cards a folder row's do, where what to run is.
export const SyncLine = ({
  repo,
  open,
  onOpen,
}: {
  repo: RepoSync | undefined
  open: SyncCardKind | undefined
  onOpen: (repo: RepoSync, kind: SyncCardKind, anchor: HTMLElement) => void
}): React.JSX.Element | null => {
  if (!repo || !hasNews(repo)) return null
  const marks = marksOf(repo).filter(({ kind }) => kind !== "ahead")
  const behind = repo.behind !== null
  return (
    <div
      className="files-sync-line"
      data-state={behind ? "behind" : "new"}
      data-open={open !== undefined}
    >
      <b className="files-sync-branch">{repo.branch}</b>
      <span className="files-sync-said">{behind ? "is behind" : "just caught up"}</span>
      <span className="files-sync-marks">
        {marks.map((mark) => (
          <Mark
            key={mark.kind}
            mark={mark}
            path={repo.path}
            open={open === mark.kind}
            inTree={false}
            onOpen={(kind, anchor) => onOpen(repo, kind, anchor)}
          />
        ))}
      </span>
    </div>
  )
}

type Merge = SyncLanding["merges"][number]

// How many merges a card lists before it says how many more there are.
const listed = 5

// A line of the card's log: it comes in after the lines above it, so the log reads in top to
// bottom as the card opens (files.css holds it still under reduced motion).
const Line = ({
  at,
  className = "",
  children,
  ref,
  ...rest
}: {
  at: number
  className?: string
  children: React.ReactNode
  ref?: React.Ref<HTMLDivElement>
} & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element => (
  <div
    {...rest}
    ref={ref}
    className={`files-line ${className}`.trimEnd()}
    style={{ "--line": at } as React.CSSProperties}
  >
    {children}
  </div>
)

// One merge: its short commit (dimmed), its pull request number, its subject and, at the end, the
// handle of the agent whose pull request it was. Where it has a pull request page, it opens it.
const MergeLine = ({
  repo,
  merge,
  at,
}: {
  repo: RepoSync
  merge: Merge
  at: number
}): React.JSX.Element => {
  const href = pullHref(repo, merge.pr)
  const body = (
    <>
      <span className="files-sha">{shortSha(merge.commit)}</span>
      {merge.pr !== null && <span className="files-pr">#{merge.pr}</span>}
      <span className="files-t">{merge.subject}</span>
      <span className="files-end">
        {merge.own && <HandleChip handle={merge.by} className="handle-plain" />}
        {href && <ExternalLink className="files-open" size={12} strokeWidth={2} aria-hidden />}
      </span>
    </>
  )
  return href ? (
    <Line at={at} className="files-merge" data-link="true">
      <button
        type="button"
        className="files-merge-button"
        aria-label={`#${merge.pr} ${merge.subject}, open the pull request`}
        onClick={() => void window.open(href, "_blank", "noopener,noreferrer")}
      >
        {body}
      </button>
    </Line>
  ) : (
    <Line at={at} className="files-merge">
      {body}
    </Line>
  )
}

// The merges, newest first: up to `listed`, then "# N more merges", which opens the rest here.
const MergeLog = ({
  repo,
  merges,
}: {
  repo: RepoSync
  merges: readonly Merge[]
}): React.JSX.Element => {
  const [all, setAll] = useState(false)
  const shown = all ? merges : merges.slice(0, listed)
  return (
    <>
      {shown.map((merge, at) => (
        <MergeLine key={merge.commit} repo={repo} merge={merge} at={at} />
      ))}
      {!all && merges.length > listed && (
        <Line at={listed} className="files-more">
          <button
            type="button"
            className="files-more-button"
            aria-expanded={false}
            onClick={() => setAll(true)}
          >
            # {merges.length - listed} more {merges.length - listed === 1 ? "merge" : "merges"}
          </button>
        </Line>
      )}
    </>
  )
}

// Puts a command on the clipboard where the app can; one it can't write goes nowhere.
const copyText = (text: string): void => {
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

// A phase glyph that says in words what it shows, for a screen reader.
const Glyph = ({
  phase,
  failed = false,
  label,
  className = "files-g",
}: {
  phase: GlyphPhase
  failed?: boolean
  label: string
  className?: string
}): React.JSX.Element => (
  <>
    <PhaseGlyph phase={phase} failed={failed} className={className} />
    <span className="sr-only">{label}</span>
  </>
)

// A `$ command` line: whatever the command, Copy and Run are on it, and nothing runs but by Run.
// `lead` stands in the prompt's place (a spinner, a mark) while it is under way or has been. Run
// leaves focus on the line (never on the page) once it has been pressed and gives way.
const CommandLine = ({
  at,
  command,
  lead,
  end,
  onRun,
  primary = false,
  running = false,
  buttons = true,
}: {
  at: number
  command: string
  lead?: React.ReactNode
  // What stands at its end instead of the buttons: "in a terminal", a time.
  end?: React.ReactNode
  onRun: () => void
  primary?: boolean
  running?: boolean
  buttons?: boolean
}): React.JSX.Element => {
  const [copied, setCopied] = useState(false)
  const line = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Line at={at} className="files-command" data-prompt="true" tabIndex={-1} ref={line}>
      {lead ?? <span className="files-p">$</span>}
      <span className="files-t">{command}</span>
      <span className="files-end">
        {end}
        {buttons && (
          <>
            <button
              type="button"
              className="files-ib"
              aria-label={copied ? `Copied ${command}` : `Copy ${command}`}
              onClick={() => {
                copyText(command)
                setCopied(true)
              }}
            >
              {copied ? (
                <Check size={12} strokeWidth={2} aria-hidden />
              ) : (
                <Copy size={12} strokeWidth={1.9} aria-hidden />
              )}
            </button>
            <button
              type="button"
              className="files-run"
              data-primary={primary || undefined}
              aria-label={`Run ${command}`}
              aria-disabled={running || undefined}
              onClick={() => {
                if (running) return
                line.current?.focus()
                onRun()
              }}
            >
              <SquareTerminal size={12} strokeWidth={2} aria-hidden /> Run
            </button>
          </>
        )}
      </span>
    </Line>
  )
}

// The card: a head strip (the phase, the repository, where main stands against its origin), a
// log on the terminal's own ground and a muted foot. `said` is what a screen reader is told, politely,
// as it changes: what the card shows of a run.
const Readout = ({
  repo,
  phase,
  failed = false,
  label,
  route,
  said,
  foot,
  children,
}: {
  repo: RepoSync
  phase: GlyphPhase
  failed?: boolean
  label: string
  route: string
  said?: string | undefined
  foot?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element => (
  <>
    <div className="files-readout-head">
      <Glyph phase={phase} failed={failed} label={label} className="" />
      <b>{repo.name}</b>
      <span className="files-route">{route}</span>
    </div>
    <div className="files-readout-log">{children}</div>
    {foot !== undefined && <div className="files-readout-foot">{foot}</div>}
    <div className="sr-only" role="status" aria-live="polite">
      {said}
    </div>
  </>
)

// What a card with no terminal followed subscribes to.
const ignore = (): (() => void) => () => undefined
const nothingFollowed = (): undefined => undefined

// Where a command runs, as the card says it: the folder from the project's root.
const placeOf = (repo: RepoSync, dir: string): string => {
  const base = repo.path === "" ? repo.name : repo.path
  return dir === "." ? base : `${base}/${dir}`
}

// The lines for the command a changed lockfile asks for: not run yet, or run in a terminal that
// is followed (`progress`) until it ends. Where the runner didn't say the lockfile's folder (a
// runner before revision 25) there is nothing to run it in, so it is said in a comment alone. A
// run that failed offers its command again.
const dependencyLines = ({
  repo,
  landing,
  at,
  progress,
  onRun,
}: {
  repo: RepoSync
  landing: SyncLanding
  at: number
  progress: TerminalProgress | undefined
  onRun: () => void
}): React.JSX.Element | null => {
  const dependencies = landing.dependencies
  if (!dependencies) return null
  const { command, dir } = dependencies
  const file = lockPathIn(repo, dependencies.file)
  if (dir === undefined)
    return (
      <Line at={at} className="files-comment" data-gap="true">
        # {file} changed: {command}
      </Line>
    )
  const comment = (
    <Line at={at} className="files-comment" data-gap="true">
      # {file} changed
    </Line>
  )
  if (progress === undefined || progress.phase === "failed")
    return (
      <>
        {comment}
        <CommandLine
          at={at + 1}
          command={command}
          onRun={onRun}
          {...(progress !== undefined && {
            lead: <Glyph phase="done" failed label="Failed" />,
            end: <span className="files-dim">{progress.ms ? elapsedOf(progress.ms) : ""}</span>,
          })}
        />
      </>
    )
  const finished = progress.phase === "finished"
  return (
    <>
      {comment}
      <CommandLine
        at={at + 1}
        command={command}
        buttons={false}
        onRun={onRun}
        lead={
          finished ? (
            <Glyph phase="unheard" label="Finished" />
          ) : (
            <Glyph phase="running" label="Running" />
          )
        }
        end={
          <span className="files-dim">
            {finished
              ? progress.ms !== undefined
                ? `finished · ${elapsedOf(progress.ms)}`
                : "finished"
              : "in a terminal"}
          </span>
        }
      />
    </>
  )
}

// What a screen reader is told of a dependency run.
const dependencySaid = (
  command: string,
  progress: TerminalProgress | undefined,
): string | undefined =>
  progress === undefined
    ? undefined
    : progress.phase === "running"
      ? `Running ${command} in a terminal`
      : progress.phase === "failed"
        ? `${command} failed`
        : `${command} finished`

// What came in: the merges, then, where a lockfile changed, the command its dependencies ask
// for. The landing is the one the card was opened on, kept as it was then.
const LandingCard = ({
  repo,
  landing,
  dependency,
  follow,
  onRunDependency,
  onShowTerminal,
}: {
  repo: RepoSync
  landing: SyncLanding
  dependency: DependencyRun | undefined
  follow: SyncTerminals["follow"] | undefined
  onRunDependency: () => void
  onShowTerminal: (id: string) => void
}): React.JSX.Element => {
  const [now] = useState(Date.now)
  const followed = useMemo(
    () => (dependency ? follow?.(dependency.id, dependency.startedAt) : undefined),
    [follow, dependency],
  )
  const progress = useSyncExternalStore(
    followed?.subscribe ?? ignore,
    followed?.get ?? nothingFollowed,
  )
  const underway = progress?.phase === "running"
  const folder =
    landing.dependencies?.dir === undefined ? "." : dirOf(landing.dependencies.file, repo)
  return (
    <Readout
      repo={repo}
      phase="done"
      label="Caught up"
      route={`${repo.branch} ‹ origin`}
      said={
        landing.dependencies ? dependencySaid(landing.dependencies.command, progress) : undefined
      }
      foot={
        <>
          <span>
            {underway
              ? `Runs in its own terminal, in ${placeOf(repo, folder)}`
              : landingFoot(landing, now)}
          </span>
          {dependency && (
            <button
              type="button"
              className="files-show"
              onClick={() => onShowTerminal(dependency.id)}
            >
              Show it
            </button>
          )}
        </>
      }
    >
      <MergeLog repo={repo} merges={landing.merges} />
      {dependencyLines({
        repo,
        landing,
        at: Math.min(landing.merges.length, listed + 1),
        progress,
        onRun: onRunDependency,
      })}
    </Readout>
  )
}

// The folder of a lockfile from its repository, "." for the top.
const dirOf = (file: string, repo: RepoSync): string => {
  const path = lockPathIn(repo, file)
  const slash = path.lastIndexOf("/")
  return slash < 0 ? "." : path.slice(0, slash)
}

// Novadeck's own words for why it didn't move: a comment, not git's.
const said = (text: string): string => {
  const plain = text.replace(/\.$/, "")
  return `# ${plain.charAt(0).toLowerCase()}${plain.slice(1)}`
}

// What main left behind: the merges waiting, why they were left, and the command that moves
// main, which Run runs here. A refusal is git's own words in red where it was git that refused,
// else Novadeck's in a comment, with where main stays. A runner that names no command (before
// revision 25) gets the facts alone.
const BehindCard = ({
  repo,
  run,
  onUpdate,
}: {
  repo: RepoSync
  run: UpdateRun | undefined
  onUpdate: () => void
}): React.JSX.Element | null => {
  const { behind } = repo
  if (!behind) return null
  const command = moveCommand(behind)
  const refused = run?.state === "refused" ? run : undefined
  const at = Math.min(behind.merges.length, listed + 1)
  const stays = behind.local ?? repo.head
  const hint = [...(refused?.git ?? []), refused?.said ?? ""].some((each) =>
    /local changes|overwritten/i.test(each),
  )
  return (
    <Readout
      repo={repo}
      phase={refused ? "done" : "waiting"}
      failed={refused !== undefined}
      label={refused ? "Refused" : "Waiting"}
      route={`${repo.branch} · ${behind.count} behind origin`}
      said={
        run?.state === "running"
          ? `Running ${command ?? "the move"}`
          : refused
            ? `${command ?? "The move"} was refused: ${refused.said}`
            : undefined
      }
      foot={refused && hint ? "Commit or set aside the edit, then run it again" : undefined}
    >
      <MergeLog repo={repo} merges={behind.merges} />
      {!refused && (
        <Line at={at} className="files-comment" data-gap="true">
          # {behind.why === null ? "main hasn't moved yet" : `left as it is: ${whyBehind(behind)}`}
        </Line>
      )}
      {command !== undefined && (
        <CommandLine
          at={at + 1}
          command={command}
          primary={!refused}
          running={run?.state === "running"}
          onRun={onUpdate}
          {...(run?.state === "running" && {
            lead: <Glyph phase="running" label="Running" />,
          })}
        />
      )}
      {refused?.git?.map((text, index) => (
        <Line
          // eslint-disable-next-line react/no-array-index-key -- Git's lines are as printed, in order.
          key={index}
          at={at + 2 + index}
          className="files-err"
        >
          {text}
        </Line>
      ))}
      {refused && refused.git === undefined && (
        <Line at={at + 2} className="files-comment">
          {said(refused.said)}
        </Line>
      )}
      {refused?.more !== undefined && (
        <Line at={at + 22} className="files-comment">
          # … {refused.more} more {refused.more === 1 ? "line" : "lines"}
        </Line>
      )}
      {refused && (
        <Line at={at + 23} className="files-comment" data-gap="true">
          #{" "}
          {stays
            ? `main stays at ${shortSha(stays)}, your files as they are`
            : "main stays as it is"}
        </Line>
      )}
    </Readout>
  )
}

// A move that went through here: what was waiting, and the command with its check, which is all
// there is to say; the card stays until it is closed, and focus is on the check.
const MovedCard = ({ repo, command }: { repo: RepoSync; command: string }): React.JSX.Element => {
  const merges = repo.behind?.merges ?? []
  const line = useRef<HTMLDivElement>(null)
  useEffect(() => line.current?.focus(), [])
  return (
    <Readout
      repo={repo}
      phase="done"
      label="Caught up"
      route={`${repo.branch} ‹ origin`}
      said={`${command} moved main`}
    >
      <MergeLog repo={repo} merges={merges} />
      <Line
        at={Math.min(merges.length, listed + 1)}
        className="files-command"
        data-gap="true"
        tabIndex={-1}
        ref={line}
      >
        <Glyph phase="done" label="Moved" />
        <span className="files-t">{command}</span>
      </Line>
    </Readout>
  )
}

// What a card holds. A landing's is the snapshot it was opened on; a behind card follows the
// repository as it stands, and after Run moved main stays as the move left it (`behind` is then
// the snapshot it was opened on).
export const SyncCard = ({
  kind,
  repo,
  run,
  onUpdate,
  dependency,
  follow,
  onRunDependency,
  onShowTerminal,
}: {
  kind: SyncCardKind
  repo: RepoSync
  run: RepoRun | undefined
  onUpdate: () => void
  dependency: DependencyRun | undefined
  // Follows the terminal the dependency command runs in.
  follow: SyncTerminals["follow"] | undefined
  onRunDependency: () => void
  onShowTerminal: (id: string) => void
}): React.JSX.Element | null => {
  if (kind === "new")
    return repo.landing ? (
      <LandingCard
        repo={repo}
        landing={repo.landing}
        dependency={dependency}
        follow={follow}
        onRunDependency={onRunDependency}
        onShowTerminal={onShowTerminal}
      />
    ) : null
  return run?.run.state === "ok" && repo.behind ? (
    <MovedCard repo={repo} command={run.command} />
  ) : (
    <BehindCard repo={repo} run={run?.run} onUpdate={onUpdate} />
  )
}

// The card's name, for assistive technology.
export const cardLabel = (kind: SyncCardKind, repo: RepoSync): string =>
  kind === "new" ? `${repo.name} caught up with origin` : `${repo.name} is behind origin`

// Keeps `agoOf` and `newCount` where the card's words are, for the notices that say the same.
export { agoOf, newCount }

// Remembers the element a mark was when its card opened (the mark itself may go once seen).
export const useAnchor = (): {
  readonly rect: () => DOMRect | null
  readonly hold: (element: HTMLElement) => void
} => {
  const held = useRef<DOMRect | null>(null)
  useEffect(() => () => void (held.current = null), [])
  return {
    rect: () => held.current,
    hold: (element) => {
      held.current = element.getBoundingClientRect()
    },
  }
}
