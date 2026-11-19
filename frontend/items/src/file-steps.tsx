import type { Item, ItemContent } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { ChevronLeft, ChevronRight, FolderOpen } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { useItemCommands } from "./item-commands"
import { listedFolder, useFolderView } from "./kinds/folder/hooks"
import { absoluteOf } from "./kinds/folder/model"
import {
  arrowKinds,
  fileNameOf,
  homeOf,
  neighboursOf,
  sessionOf,
  stepsOf,
  type Home,
} from "./kinds/folder/stepping"
import { PaneTools, type PaneTool } from "./pane-row"
import { registrationOf } from "./registry"
import type { ItemStore } from "./store/item-store"

// What a file shown in a pane or a window offers when it is in a folder the session has open
// (see ./kinds/folder/stepping.ts for which): ‹ and › to show the file before or after it in
// the folder, which point the same item at it, so no tab comes or goes, and "Show in", which goes
// back to the folder with the file selected. These are the tools of every kind of file, at the
// end of the row; none of a viewer's own.

// The folder a listing is of, as the folder item at a path under its top names it.
const nameOf = ({ folder, within }: Home): string =>
  within === "" ? folder.name : (within.split("/").at(-1) ?? folder.name)

// The listing of the folder `home` says the file is in, followed while the file is shown: a
// follow of its own, which leaves the folder item's own view where it is.
const useListing = (
  itemStore: ItemStore,
  target: WorkspaceTarget,
  { folder, within }: Home,
): ItemContent | undefined => {
  const [kept, setKept] = useState<{ readonly key: string; readonly content: ItemContent }>()
  const { projectId, workspaceSessionId } = target
  const key = `${folder.id}\n${within}`
  useEffect(
    () =>
      itemStore.siblings({ projectId, workspaceSessionId }, folder.id, within, (content) =>
        setKept({ key, content }),
      ),
    [itemStore, projectId, workspaceSessionId, folder.id, within, key],
  )
  return kept?.key === key ? kept.content : undefined
}

// Where a key is not the pane's to take: a field, and the pane's own tab row, which steps along
// its tabs by the same keys.
const isOthers = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('input, textarea, select, [contenteditable], [role="tablist"]') !== null

const Steps = ({
  item,
  itemStore,
  target,
  home,
}: {
  item: Item
  itemStore: ItemStore
  target: WorkspaceTarget
  home: Home
}): React.JSX.Element => {
  const { folder, within } = home
  const commands = useItemCommands()
  const { sort } = useFolderView(itemStore, folder.id)
  const listed = listedFolder(useListing(itemStore, target, home))
  const kind = registrationOf(item).names.one
  const name = nameOf(home)
  const named = fileNameOf(item.path ?? "")
  const near = useMemo(
    () => listed && neighboursOf(stepsOf(listed.entries, item.kind, sort), named),
    [listed, item.kind, sort, named],
  )
  // The file asked for and not shown yet, so a key held down doesn't ask for it again.
  const asked = useRef<string>(undefined)
  // What went wrong with the last step, in words, until the next one or another file.
  const [problem, setProblem] = useState<{ readonly path: string | null; readonly text: string }>()
  const { repoint } = itemStore
  const itemId = item.id
  const itemPath = item.path
  const step = useCallback(
    (to: string): void => {
      if (!repoint || !listed || asked.current === to) return
      asked.current = to
      const path = absoluteOf(listed.path, to)
      const was = itemPath
      repoint(target, itemId, path)
        .catch((error: unknown) => {
          const why = error instanceof Error && error.message !== "" ? `: ${error.message}` : "."
          setProblem({ path: was, text: `Couldn't open ${to}${why}` })
        })
        .finally(() => {
          asked.current = undefined
        })
    },
    [repoint, listed, target, itemId, itemPath],
  )
  const before = near?.before
  const after = near?.after
  // Only a kind whose viewer leaves the arrow keys alone steps by them (see `arrowKinds`).
  const arrows = arrowKinds.has(item.kind)
  // The keys are heard on the pane or window around the body, which stays as the viewer is
  // drawn again for another file (as it is, whenever the item is pointed elsewhere) and holds
  // the tools and tabs too: a key pressed with focus anywhere in it steps.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const pane = anchor?.closest<HTMLElement>("[data-workspace-companion], .artifact-window")
  // Whether the last step was by key, so focus lost with the viewer it was in comes back.
  const keyed = useRef(false)
  useEffect(() => {
    if (!pane || !arrows) return
    const press = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if (isOthers(event.target)) return
      const to = event.key === "ArrowLeft" ? before : after
      if (!to) return
      event.preventDefault()
      keyed.current = true
      step(to.name)
    }
    pane.addEventListener("keydown", press)
    return () => pane.removeEventListener("keydown", press)
  }, [pane, arrows, before, after, step])
  // The viewer of the file before is gone with the focus it held: the pane takes it, so the next
  // key reaches it too.
  const path = item.path
  const shownPath = useRef(path)
  useEffect(() => {
    if (shownPath.current === path) return
    shownPath.current = path
    if (!keyed.current) return
    keyed.current = false
    const focused = document.activeElement
    if (pane && (!focused || focused === document.body)) pane.focus({ preventScroll: true })
  })
  // Where the place can't bring another item forward, as a window can't, there is no way back.
  const showIn =
    commands &&
    ((): void => {
      itemStore.folder(folder.id, { within, selected: named })
      if ("terminalId" in folder.holder) commands.openBarTab(folder.holder.terminalId, folder.id)
      // A window comes forward, where it is.
      else commands.undock(folder.id)
    })
  // The ends of the folder's files take no click but keep their tooltip and focus, as the
  // folder's own Up does at its top.
  const tools: PaneTool[] = [
    ...(repoint && near
      ? ([
          {
            key: "previous",
            icon: ChevronLeft,
            label: `Previous ${kind} in ${name}`,
            tip: before
              ? `Previous ${kind} in ${name}: ${before.name}${arrows ? " · ←" : ""}`
              : `This is the first ${kind} in ${name}`,
            ...(arrows && { keys: "ArrowLeft" }),
            pending: !before,
            onClick: () => {
              if (before) step(before.name)
            },
          },
          {
            key: "next",
            icon: ChevronRight,
            label: `Next ${kind} in ${name}`,
            tip: after
              ? `Next ${kind} in ${name}: ${after.name}${arrows ? " · →" : ""}`
              : `This is the last ${kind} in ${name}`,
            ...(arrows && { keys: "ArrowRight" }),
            pending: !after,
            onClick: () => {
              if (after) step(after.name)
            },
          },
        ] satisfies PaneTool[])
      : []),
    ...(showIn
      ? [{ key: "show-in", icon: FolderOpen, label: `Show in ${name}`, onClick: showIn }]
      : []),
  ]
  return (
    <>
      <PaneTools tools={tools} after />
      <span ref={setAnchor} hidden />
      {problem?.path === item.path && (
        <div className="pane-notice" data-tone="danger" role="alert">
          <p>{problem.text}</p>
        </div>
      )}
    </>
  )
}

// The steps of a file: its folder among the session's items, and then the tools. Nothing where
// the file is in none.
export const FileSteps = ({
  item,
  itemStore,
  target,
}: {
  item: Item
  itemStore: ItemStore
  target: WorkspaceTarget
}): React.JSX.Element | null => {
  const { workspace } = itemStore
  const items = useSyncExternalStore(workspace.subscribe, () =>
    sessionOf(workspace.getSnapshot(), item.id),
  )
  const home = useMemo(() => homeOf(item, items), [item, items])
  return home ? <Steps item={item} itemStore={itemStore} target={target} home={home} /> : null
}
