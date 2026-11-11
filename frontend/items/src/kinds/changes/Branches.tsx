import type { ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { useMemo } from "react"

import type { ItemStore } from "../../store/item-store"
import { peekDiff } from "./diff-cache"
import { layoutFor, type Change } from "./diff-rows"
import { placeParts, type Part } from "./labels"
import { Parts } from "./Parts"
import type { TreeFile } from "./tree"
import { useFileDiff, type FileDiffState } from "./use-file-diff"

// What a file changed, as the terminal tab lists its subagents: a branch (├ └) for each change,
// what it sits in and its lines, unfolded under the file's row by the tab's own fold. Read when
// the file is first unfolded, and kept to fold away again.

const most = 8

type Branch = { readonly key: string; readonly parts: readonly Part[]; readonly counts: string }

const countsOf = (change: Change): string =>
  [
    change.added > 0 || change.removed === 0 ? `+${change.added}` : "",
    change.removed > 0 ? `−${change.removed}` : "",
  ]
    .filter(Boolean)
    .join(" ")

export const branchesOf = (
  runs: readonly { readonly changes: readonly Change[]; readonly label: string | undefined }[],
): Branch[] =>
  runs.flatMap(({ changes, label }, run) =>
    changes.map((change): Branch => {
      const place = placeParts(change.fact?.places ?? [], change.fact?.edit)
      const lines = `${change.onlyRemoves ? "was " : ""}${change.lines.from === change.lines.to ? "line" : "lines"} ${
        change.lines.from === change.lines.to
          ? change.lines.from
          : `${change.lines.from}–${change.lines.to}`
      }`
      const parts: Part[] = [
        ...(place.length > 0 ? place : [{ text: lines, kind: "plain" as const }]),
        ...(change.reindented > 0
          ? [{ text: ` · ${change.reindented} re-indented`, kind: "plain" as const }]
          : []),
        ...(label ? [{ text: ` · ${label}`, kind: "plain" as const }] : []),
      ]
      return { key: `${run}-${change.id}`, parts, counts: countsOf(change) }
    }),
  )

export const Branches = ({
  itemStore,
  target,
  itemId,
  stamp,
  file,
  open,
  layers,
  layerName,
}: {
  itemStore: ItemStore
  target: WorkspaceTarget
  itemId: ItemId
  stamp: string
  file: TreeFile
  open: boolean
  layers: readonly string[]
  layerName: (id: string) => string
}): React.JSX.Element => {
  // Read when unfolded, and kept (see ./diff-cache.ts) to fold away with what it showed.
  const read = useFileDiff(itemStore, target, itemId, stamp, open ? file.path : null, layers)
  const kept = peekDiff(itemStore, itemId, stamp, layers, file.path)
  const loaded: FileDiffState = read.state === "idle" && kept ? { state: "ready", ...kept } : read
  const diff = loaded.state === "ready" ? loaded.diff : undefined
  const facts = loaded.state === "ready" ? loaded.facts : undefined
  const branches = useMemo((): Branch[] | undefined => {
    if (!diff || !facts) return undefined
    return branchesOf(
      diff.runs.map((run, at) => ({
        changes: layoutFor(run, facts[at] ?? null).filter(
          (each): each is Change => each.kind === "change",
        ),
        label: diff.runs.length > 1 ? run.layers.map(layerName).join(" + ") : undefined,
      })),
    )
  }, [diff, facts, layerName])
  const note =
    loaded.state === "failed"
      ? "Can't read this file's changes"
      : file.secret
        ? "May hold secrets, so its changes are not read"
        : file.binary
          ? "Binary file"
          : undefined
  const rows: Branch[] = note
    ? [{ key: "note", parts: [{ text: note, kind: "plain" }], counts: "" }]
    : branches
      ? branches.length > most
        ? [
            ...branches.slice(0, most - 1),
            {
              key: "more",
              parts: [{ text: `${branches.length - most + 1} more changes`, kind: "plain" }],
              counts: "",
            },
          ]
        : branches
      : [{ key: "wait", parts: [{ text: "Reading the changes…", kind: "plain" }], counts: "" }]
  return (
    <span className="terminal-tab-branches diff-branches grid min-w-0">
      <span className="terminal-tab-branches-fold min-h-0 overflow-hidden">
        <span className="flex min-w-0 flex-col pt-0.5 pb-1.5 text-caption leading-[18px]">
          {rows.map((row, at) => (
            <span
              key={row.key}
              className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
              data-branch
            >
              <span className="terminal-tab-branch shrink-0">
                {at === rows.length - 1 ? "└" : "├"}
              </span>
              <span className="changes-change truncate">
                <Parts parts={row.parts} />
              </span>
              {row.counts && (
                <span className="terminal-tab-wait-trail diff-trail shrink-0">{row.counts}</span>
              )}
            </span>
          ))}
        </span>
      </span>
    </span>
  )
}
