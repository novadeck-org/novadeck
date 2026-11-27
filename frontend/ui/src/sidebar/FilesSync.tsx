import type { RepoSync, SyncLanding } from "@novadeck/core/files"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { GitMerge, Package } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import {
  agoOf,
  baseName,
  hasNews,
  landingSub,
  marksOf,
  newCount,
  whyBehind,
  type SyncMark,
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
// caught up, or is behind and can be updated. Its marks open the same cards a folder row's do.
export const SyncLine = ({
  repo,
  open,
  updating,
  refused,
  onOpen,
  onUpdate,
}: {
  repo: RepoSync | undefined
  open: SyncCardKind | undefined
  updating: boolean
  // Why the last update was refused, in git's words.
  refused: string | undefined
  onOpen: (repo: RepoSync, kind: SyncCardKind, anchor: HTMLElement) => void
  onUpdate: (repo: RepoSync) => void
}): React.JSX.Element | null => {
  if (!repo || !hasNews(repo)) return null
  const marks = marksOf(repo).filter(({ kind }) => kind !== "ahead")
  const behind = repo.behind !== null
  return (
    <div
      className="files-sync-line"
      data-state={behind ? "behind" : "new"}
      data-open={open !== undefined}
      data-refused={refused !== undefined || undefined}
    >
      <b className="files-sync-branch">{repo.branch}</b>
      <span className="files-sync-said" title={refused}>
        {refused !== undefined
          ? `Can't update: ${refused}`
          : behind
            ? "is behind"
            : "just caught up"}
      </span>
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
      {behind && (
        <button
          type="button"
          className="files-update"
          disabled={updating}
          onClick={() => onUpdate(repo)}
        >
          {updating ? "Updating…" : refused !== undefined ? "Retry" : "Update"}
        </button>
      )}
    </div>
  )
}

// How many merges a card lists before it says how many more there are.
const listed = 8

const MergeList = ({
  merges,
}: {
  merges: readonly SyncLanding["merges"][number][]
}): React.JSX.Element => (
  <ul className="files-card-list">
    {merges.slice(0, listed).map((merge) => (
      <li key={merge.commit}>
        <GitMerge size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className="files-card-subject">{merge.subject}</span>
        <span className="files-card-number">
          {merge.pr === null ? merge.commit.slice(0, 7) : `#${merge.pr}`}
        </span>
      </li>
    ))}
    {merges.length > listed && (
      <li className="files-card-more">and {merges.length - listed} more</li>
    )}
  </ul>
)

// What came in: the merges, the dependency hint where a lockfile changed, and how many files
// pulse in the tree. The landing is the one the card was opened on, kept as it was then.
const LandingCard = ({
  repo,
  landing,
}: {
  repo: RepoSync
  landing: SyncLanding
}): React.JSX.Element => {
  const [now] = useState(Date.now)
  return (
    <>
      <div>
        <h4 className="files-card-title">{repo.name} caught up with origin</h4>
        <div className="files-card-sub">{landingSub(repo, landing, now)}</div>
      </div>
      {landing.merges.length > 0 && <MergeList merges={landing.merges} />}
      {landing.dependencies && (
        <div className="files-card-hint">
          <Package size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>
            New dependencies: <code>{baseName(landing.dependencies.file)}</code> changed. Run{" "}
            <code>{landing.dependencies.command}</code> before you start the app.
          </span>
        </div>
      )}
      <div className="files-card-foot">
        <span>
          {landing.filesTotal === 0 ? "No files changed" : "Changed files pulse in the tree"}
        </span>
      </div>
    </>
  )
}

// What main left behind: why it was left, the merges waiting, and Update.
const BehindCard = ({
  repo,
  updating,
  refused,
  onUpdate,
}: {
  repo: RepoSync
  updating: boolean
  refused: string | undefined
  onUpdate: () => void
}): React.JSX.Element | null => {
  const { behind } = repo
  if (!behind) return null
  const why = whyBehind(behind)
  return (
    <>
      <div>
        <h4 className="files-card-title">
          {repo.name} is {behind.count} behind origin
        </h4>
        <div className="files-card-sub">{behind.why === null ? why : `Left as it is: ${why}.`}</div>
      </div>
      {behind.merges.length > 0 && <MergeList merges={behind.merges} />}
      <div className="files-card-foot" data-refused={refused !== undefined || undefined}>
        <span>
          {refused !== undefined
            ? `Can't update: ${refused}`
            : behind.why !== null && /edits/i.test(behind.why)
              ? "Update keeps your edits where git can"
              : "Update moves main forward"}
        </span>
        <button type="button" className="files-update" disabled={updating} onClick={onUpdate}>
          {updating ? "Updating…" : refused !== undefined ? "Retry" : "Update"}
        </button>
      </div>
    </>
  )
}

// What a card holds. A landing's is the snapshot it was opened on; a behind card follows the
// repository as it stands, and goes (`null`) once it is no longer behind.
export const SyncCard = ({
  kind,
  repo,
  updating,
  refused,
  onUpdate,
}: {
  kind: SyncCardKind
  repo: RepoSync
  updating: boolean
  refused: string | undefined
  onUpdate: () => void
}): React.JSX.Element | null =>
  kind === "new" ? (
    repo.landing && <LandingCard repo={repo} landing={repo.landing} />
  ) : (
    <BehindCard repo={repo} updating={updating} refused={refused} onUpdate={onUpdate} />
  )

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
