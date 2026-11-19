import "../../folder.css"
import type { FolderContent, FolderEntry, Item, UnavailableReason } from "@novadeck/core/items"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ArrowUp, ArrowUpDown, FolderOpen, LayoutGrid, LayoutList, Lock } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { useItemCommands } from "../../item-commands"
import { PaneTools, usePaneNote, type PaneTool } from "../../pane-row"
import type { ViewProps } from "../../registration"
import { Row, Tile, type Reader } from "./Entries"
import { listedFolder, useArrivals, useFolderView, useListing, useWriting } from "./hooks"
import {
  absoluteOf,
  countText,
  crumbsOf,
  intoFolder,
  nextSort,
  parentOf,
  sortNames,
  sorted,
  type FolderSort,
} from "./model"
import { PathField } from "./PathField"

// The terminal a folder's files open on: its own, or where it was shown from.
const terminalOf = (item: Item): string | undefined =>
  "terminalId" in item.holder ? item.holder.terminalId : item.from?.terminalId

// What the folder the view is in is called: the item's name at the top, else its own.
const folderName = (item: Item, within: string): string =>
  within === "" ? item.name : (within.split("/").at(-1) ?? item.name)

// Why a folder can't be listed, as a sentence.
const troubleText = (reason: UnavailableReason, name: string): string => {
  switch (reason) {
    case "secret":
      return `${name} may hold secrets, so Novadeck won't list what is in it.`
    case "missing":
      return `${name} isn't there any more.`
    case "gone":
      return `${name} is gone: it was moved or deleted.`
    default:
      return `Novadeck can't read ${name}.`
  }
}

// Whether the platform's shortcuts use Command, as a Mac's do.
const mac = /Mac|iPhone|iPad/.test(navigator.platform)

const sortLabel = (sort: FolderSort): string => `Sorted by ${sortNames[sort]}`

// The columns of the list that name a sort when clicked.
const headings: readonly {
  readonly label: string
  readonly sort: FolderSort | null
  readonly className: string
}[] = [
  { label: "Name", sort: "name", className: "folder-col-name" },
  { label: "Modified", sort: "newest", className: "folder-col-modified" },
  { label: "Size", sort: "size", className: "folder-col-size" },
  { label: "Kind", sort: null, className: "folder-col-kind" },
]

// A folder in the pane: where it is on the first line (from the folder that was opened, never
// above it), then its files as thumbnails or a list, live as they are written. A folder inside is
// entered in place; a file opens as an item of its own kind on the terminal's bar.
export const FolderView = ({ item, itemStore, target }: ViewProps): React.JSX.Element => {
  const view = useFolderView(itemStore, item.id)
  const { within, layout, sort } = view
  const { top, here } = useListing(itemStore, target, item, within)
  const listed = listedFolder(here)
  // The last listing of this folder, kept to show faded when it goes.
  const [last, setLast] = useState<{ within: string; content: FolderContent }>()
  if (listed && (last?.within !== within || last.content !== listed))
    setLast({ within, content: listed })
  const trouble = here?.state === "unavailable" ? here.reason : undefined
  const gone = top?.state === "unavailable" && top.reason === "gone"
  const shown = listed ?? (trouble && last?.within === within ? last.content : undefined)
  const commands = useItemCommands()
  // A top that may hold secrets is refused whole, the tab wearing a lock.
  const refused = top?.state === "unavailable" && top.reason === "secret"
  usePaneNote(listed ? [countText(listed.total)] : [], gone, undefined, refused ? Lock : undefined)

  const root = useRef<HTMLDivElement>(null)
  const [inside, setInside] = useState(false)
  const arrivals = useArrivals(listed?.entries, inside, within)
  const writing = useWriting(listed?.entries, within)
  const entries = useMemo(() => sorted(arrivals.visible, sort), [arrivals.visible, sort])
  const [selected, setSelected] = useState<string>()
  const [problem, setProblem] = useState<string>()
  // The person is typing a path where the crumbs are (Ctrl+L, or a click on the path).
  const [typing, setTyping] = useState(false)
  // The list says how long ago; it moves on with the clock.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const terminal = terminalOf(item)
  const { part } = itemStore
  const reader = useMemo<Reader | undefined>(
    () =>
      part &&
      ((path, stamp, offset) => part(target, item.id, { stamp, offset, reveal: undefined, path })),
    [part, target, item.id],
  )
  const name = folderName(item, within)
  const { above, crumbs } = crumbsOf(item.path ?? "", within)
  const parent = parentOf(within)
  const goTo = (to: string): void => {
    // Moving between folders leaves focus on the body, so its keys keep working.
    root.current?.focus({ preventScroll: true })
    setSelected(undefined)
    setProblem(undefined)
    itemStore.folder(item.id, { within: to })
  }
  const up = (): void => {
    if (parent !== null) goTo(parent)
  }
  const open = (entry: FolderEntry): void => {
    if (entry.secret || entry.link) return
    if (entry.kind === "folder") return goTo(intoFolder(within, entry.name))
    if (!terminal || !listed) return setProblem(`${entry.name} can't be opened from here.`)
    setProblem(undefined)
    itemStore.attach(target, terminal, absoluteOf(listed.path, entry.name)).catch(() => {
      setProblem(`${entry.name} couldn't be opened.`)
    })
  }

  const closeField = (refocus: boolean): void => {
    setTyping(false)
    if (refocus) root.current?.focus({ preventScroll: true })
  }

  const tools: PaneTool[] = [
    {
      key: "layout",
      icon: layout === "grid" ? LayoutList : LayoutGrid,
      label: layout === "grid" ? "Show as a list" : "Show as a grid",
      onClick: () => itemStore.folder(item.id, { layout: layout === "grid" ? "list" : "grid" }),
    },
    {
      key: "sort",
      icon: ArrowUpDown,
      label: "Sort",
      tip: `${sortLabel(sort)}. Click for ${sortNames[nextSort(sort)]}.`,
      onClick: () => itemStore.folder(item.id, { sort: nextSort(sort) }),
    },
  ]

  const props = (entry: FolderEntry) => ({
    entry,
    itemId: item.id,
    within,
    reader,
    selected: selected === entry.name,
    writing: writing.get(entry.name),
    fresh: arrivals.fresh.has(entry.name),
    now,
    onSelect: () => setSelected(entry.name),
    onOpen: () => open(entry),
  })

  if (refused)
    return (
      <div className="artifact-viewer folder-viewer" data-refused="">
        <div className="folder-refused" role="status">
          <Lock size={30} strokeWidth={1.25} aria-hidden />
          <b>{item.path ?? item.name} isn't shown</b>
          <span>It may hold secrets, so Novadeck doesn't open it or list what's in it.</span>
        </div>
      </div>
    )

  return (
    <div
      ref={root}
      className="artifact-viewer folder-viewer"
      tabIndex={-1}
      data-layout={layout}
      onKeyDown={(event) => {
        // What is typed in the path field is its own: Backspace there is no way up.
        if ((event.target as HTMLElement).closest(".folder-field")) return
        if (event.key.toLowerCase() === "l" && (mac ? event.metaKey : event.ctrlKey)) {
          if (event.altKey || event.shiftKey) return
          event.preventDefault()
          setTyping(true)
        } else if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) {
          event.preventDefault()
          up()
        }
      }}
    >
      <PaneTools tools={tools} />
      <div className="folder-crumbs">
        <Tooltip
          content={
            parent === null
              ? `${crumbs[0]!.name} is the top of this folder · ${mac ? "⌘L" : "Ctrl+L"} opens another`
              : "Up"
          }
        >
          <button
            type="button"
            className="icon-button folder-up"
            aria-label="Up"
            aria-disabled={parent === null || undefined}
            onClick={up}
          >
            <ArrowUp size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </Tooltip>
        {typing ? (
          <PathField
            itemStore={itemStore}
            target={target}
            terminal={terminal}
            initial={listed?.path ?? item.path ?? ""}
            now={now}
            close={closeField}
          />
        ) : (
          <nav
            className="folder-path"
            aria-label="Folder path"
            onClick={(event) => {
              // A crumb goes to its folder; the rest of the path, which is text, is typed over.
              if (!(event.target as HTMLElement).closest("button")) setTyping(true)
            }}
          >
            {above !== "" && (
              <span className="folder-above" aria-hidden="true">
                {above}
              </span>
            )}
            {crumbs.map((crumb, index) => (
              <span key={crumb.within} className="folder-crumb-part">
                {index > 0 && (
                  <span className="folder-sep" aria-hidden="true">
                    /
                  </span>
                )}
                <button
                  type="button"
                  className="folder-crumb"
                  aria-current={index === crumbs.length - 1 ? "location" : undefined}
                  onClick={() => goTo(crumb.within)}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>
        )}
        {listed && !typing && <span className="folder-count">{countText(listed.total)}</span>}
      </div>
      {gone && (
        <div className="pane-notice" data-tone="warning" role="status">
          <p>{troubleText("gone", item.name)}</p>
          {commands && (
            <div className="pane-notice-actions">
              <button
                type="button"
                className="artifact-open"
                onClick={() => commands.closeItem(item.id)}
              >
                Close {item.name}
              </button>
            </div>
          )}
        </div>
      )}
      {trouble && !gone && (
        <div className="pane-notice" data-tone="warning" role="status">
          <p>{troubleText(trouble, name)}</p>
        </div>
      )}
      {problem && (
        <div className="pane-notice" data-tone="danger" role="alert">
          <p>{problem}</p>
        </div>
      )}
      <div
        className="folder-scroll"
        data-faded={(trouble !== undefined && shown !== undefined) || undefined}
        onPointerEnter={() => setInside(true)}
        onPointerLeave={() => setInside(false)}
      >
        {arrivals.waiting > 0 && (
          <button type="button" className="folder-arrivals" onClick={arrivals.release}>
            {arrivals.waiting} new {arrivals.waiting === 1 ? "file" : "files"}
          </button>
        )}
        {!shown && !trouble && <div className="artifact-status" aria-busy="true" />}
        {shown && listed && listed.total === 0 && (
          <div className="folder-empty">
            <FolderOpen size={28} strokeWidth={1.25} aria-hidden />
            <b>Nothing in {name} yet</b>
            <span>Files show here as they're written.</span>
          </div>
        )}
        {shown && (listed ? entries : shown.entries).length > 0 && layout === "grid" && (
          <div className="folder-grid" role="group" aria-label={name}>
            {(listed ? entries : sorted(shown.entries, sort)).map((entry) => (
              <Tile key={entry.name} {...props(entry)} />
            ))}
          </div>
        )}
        {shown && (listed ? entries : shown.entries).length > 0 && layout === "list" && (
          <table className="folder-list" aria-label={name}>
            <thead>
              <tr>
                {headings.map((heading) => (
                  <th
                    key={heading.label}
                    className={heading.className}
                    aria-sort={heading.sort === sort ? "descending" : undefined}
                  >
                    {heading.sort ? (
                      <button
                        type="button"
                        onClick={() => itemStore.folder(item.id, { sort: heading.sort! })}
                      >
                        {heading.label}
                      </button>
                    ) : (
                      heading.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(listed ? entries : sorted(shown.entries, sort)).map((entry) => (
                <Row key={entry.name} {...props(entry)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {listed?.truncated && (
        <p className="artifact-cut">
          {name} holds {listed.total.toLocaleString("en-US")} items, which is more than Novadeck
          lists whole: the first {listed.entries.length.toLocaleString("en-US")} are shown.
        </p>
      )}
    </div>
  )
}
