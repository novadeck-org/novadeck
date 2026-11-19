import "../../folder.css"
import type { FolderContent, FolderEntry, Item, UnavailableReason } from "@novadeck/core/items"
import { ContextMenu, type ContextMenuItem } from "@novadeck/toolkit/ContextMenu"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ArrowUp, ArrowUpDown, Copy, FolderOpen, LayoutGrid, LayoutList, Lock } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { useItemCommands } from "../../item-commands"
import { PaneTools, usePaneNote, type PaneTool } from "../../pane-row"
import type { ViewProps } from "../../registration"
import { openOnSource } from "../file/view-choice"
import { Row, Tile, type Reader } from "./Entries"
import { listedFolder, useArrivals, useFolderView, useListing, useWriting } from "./hooks"
import { canLook, entryMenu, hasSource } from "./menu"
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
import { QuickLook } from "./QuickLook"

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

// Copies a path: the folder's own, or a file's of it. A page that may not write the clipboard
// simply doesn't copy.
const copyPath = (directory: string | undefined, file?: string): void => {
  if (directory === undefined) return
  const text = file === undefined ? directory : absoluteOf(directory, file)
  navigator.clipboard?.writeText(text).catch(() => {})
}

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

  // The body, as state: what the menu and the quick look do with it is not read while drawing.
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  // A file opened from the folder takes the folder's place in the pane, whenever the pane gets
  // to it: as the folder goes, focus it held goes to the pane (or the window), so the file's
  // keys, as an image's ← →, work at once rather than falling to the page.
  useLayoutEffect(() => {
    const own = body
    // Read as it goes, while it is still in the page: the pane it is in then, which a folder
    // moved into a window of its own has changed.
    return () => {
      const pane = own?.parentElement?.closest<HTMLElement>(
        "[data-workspace-companion], .artifact-window",
      )
      if (!own || !pane || !own.contains(document.activeElement)) return
      queueMicrotask(() => {
        const focused = document.activeElement
        if (pane.isConnected && (!focused || focused === document.body || !focused.isConnected))
          pane.focus({ preventScroll: true })
      })
    }
  }, [body])
  const [inside, setInside] = useState(false)
  const arrivals = useArrivals(listed?.entries, inside, within)
  const writing = useWriting(listed?.entries, within)
  const entries = useMemo(() => sorted(arrivals.visible, sort), [arrivals.visible, sort])
  const [selected, setSelected] = useState<string>()
  const [problem, setProblem] = useState<string>()
  // The entry the open menu was asked for, as it was then (so the menu doesn't change under the
  // pointer if the file goes), and the one being looked at, by name and the folder it is in.
  const [menuFor, setMenuFor] = useState<{
    readonly entry: FolderEntry
    readonly within: string
    readonly path: string
  }>()
  const [looking, setLooking] = useState<{ readonly name: string; readonly within: string }>()
  // A file asked to be selected from outside (a file's "Show in") is taken as the selection, and
  // let go of in the store, so coming back to the folder later doesn't select it again; it is
  // scrolled into view once it is drawn, which is as the folder's listing comes.
  const wanted = view.selected
  if (wanted !== undefined && wanted !== selected) setSelected(wanted)
  const scrollTo = useRef(false)
  useEffect(() => {
    if (wanted === undefined) return
    scrollTo.current = true
    itemStore.folder(item.id, { selected: undefined })
  }, [wanted, itemStore, item.id])
  // After every render, until the selected file is drawn: its listing may come after the ask.
  useEffect(() => {
    if (!scrollTo.current) return
    const element = body?.querySelector("[data-selected]")
    if (!element) return
    scrollTo.current = false
    element.scrollIntoView?.({ block: "nearest" })
  })
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
    body?.focus({ preventScroll: true })
    setSelected(undefined)
    setProblem(undefined)
    itemStore.folder(item.id, { within: to })
  }
  const up = (): void => {
    if (parent !== null) goTo(parent)
  }
  // Opens an entry: a folder in place, a file as an item of its kind, on its source when asked to
  // and its type has one.
  // `from` is the folder it is in: the one drawn, or, for a menu asked a while ago, the one it
  // was asked in.
  const open = (
    entry: FolderEntry,
    asText = false,
    from: { readonly within: string; readonly path: string | undefined } = {
      within,
      path: listed?.path,
    },
  ): void => {
    if (entry.secret || entry.link) return
    if (entry.kind === "folder") return goTo(intoFolder(from.within, entry.name))
    if (!terminal || from.path === undefined)
      return setProblem(`${entry.name} can't be opened from here.`)
    setProblem(undefined)
    itemStore
      .attach(target, terminal, absoluteOf(from.path, entry.name))
      .then((opened) => {
        if (asText && hasSource(entry)) openOnSource(opened.id)
      })
      .catch(() => {
        setProblem(`${entry.name} couldn't be opened.`)
      })
  }
  const drawn = shown ? (listed ? entries : sorted(shown.entries, sort)) : []
  const looked =
    looking?.within === within ? drawn.find((each) => each.name === looking.name) : undefined
  // The look is of a file in the folder drawn, and ends with it: when the person goes to another
  // folder, or the file goes, it closes (focus is given back as it unmounts) and is not reopened.
  if (looking && !looked) setLooking(undefined)
  const closeLook = (): void => {
    setLooking(undefined)
    // The look held focus: it goes back to the body, so its keys keep working.
    body?.focus({ preventScroll: true })
  }
  const lookAt = (entry: FolderEntry): void => {
    if (!canLook(entry)) return
    setSelected(entry.name)
    setLooking({ name: entry.name, within })
  }
  // Moves the look, and the selection with it, to the file before or after it in the order the
  // folder is drawn in, skipping folders.
  const stepLook = (by: -1 | 1): void => {
    const files = drawn.filter(canLook)
    const next = files[files.findIndex((each) => each.name === looking?.name) + by]
    if (!next) return
    setSelected(next.name)
    setLooking({ name: next.name, within })
  }
  const menuEntry = menuFor?.entry
  // What the menu offers: the entry it was asked on's, acting in the folder it was asked in (the
  // entry may have gone since, which a look ignores and an open reports); or, off every entry,
  // the folder's own path.
  const menuItems = (asked: NonNullable<typeof menuFor>): ContextMenuItem[] =>
    entryMenu(asked.entry, {
      open: () => open(asked.entry, false, asked),
      openAsText: () => open(asked.entry, true, asked),
      look: () => {
        if (asked.within === within && drawn.some((each) => each.name === asked.entry.name))
          lookAt(asked.entry)
      },
      copyPath: () => copyPath(asked.path, asked.entry.name),
    })
  const menu: ContextMenuItem[] = menuFor
    ? menuItems(menuFor)
    : [
        {
          value: "copy-path",
          label: "Copy path",
          icon: <Copy size={14} strokeWidth={1.75} aria-hidden />,
          onSelect: () => copyPath(shown?.path),
        },
      ]

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
    onOpen: (asText: boolean) => open(entry, asText),
    onMenu: () => {
      setSelected(entry.name)
      setMenuFor({ entry, within, path: shown?.path ?? "" })
    },
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
      ref={setBody}
      className="artifact-viewer folder-viewer"
      tabIndex={-1}
      data-layout={layout}
      // A pane over its terminal leaves the folder its Space, the quick look; any other character
      // is still a reply to the terminal, and Escape still hides the pane (a look takes its own).
      data-pane-keys="space"
      onKeyDown={(event) => {
        // A key in the menu, which bubbles here through the portal, is the menu's own: it must not
        // go up, or Escape would hide the pane as it closes the menu.
        if (
          event.target instanceof Element &&
          event.target.closest('[data-scope="menu"][data-part="content"]')
        ) {
          if (event.key === "Escape") event.stopPropagation()
          return
        }
        // Going up is not done under a look, which holds the keys while it is up.
        if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) {
          event.preventDefault()
          if (!looked) up()
          return
        }
        // Space is the quick look: at the entry that has focus, else at the selected one. A key
        // held down looks once; a button of the crumbs keeps its own Space.
        if (event.key !== " ") return
        const onEntry = event.target instanceof Element ? event.target.closest("[data-name]") : null
        if (!onEntry && event.target !== event.currentTarget) return
        const named = onEntry?.getAttribute("data-name") ?? selected
        const entry = drawn.find((each) => each.name === named)
        // With nothing to look at (a folder, nothing selected) Space is left to its button.
        if (!entry || !canLook(entry)) return
        event.preventDefault()
        if (!event.repeat) lookAt(entry)
      }}
      // The menu key and Shift+F10 on the body itself are asked of the selected entry (or, with
      // none, the folder), as they are of a focused one, which the menu's trigger hears itself.
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        const at =
          event.currentTarget.querySelector<HTMLElement>("[data-selected]") ??
          event.currentTarget.querySelector<HTMLElement>(".folder-scroll")
        // Where it is drawn, so the menu opens beside it and not off the pane.
        at?.scrollIntoView?.({ block: "nearest" })
        const box = at?.getBoundingClientRect()
        at?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: box ? box.left + Math.min(box.width / 2, 24) : 0,
            clientY: box ? box.top + Math.min(box.height / 2, 24) : 0,
          }),
        )
      }}
    >
      <PaneTools tools={tools} />
      <div className="folder-crumbs">
        <Tooltip content={parent === null ? `${crumbs[0]!.name} is the top of this folder` : "Up"}>
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
        <nav className="folder-path" aria-label="Folder path">
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
        {listed && <span className="folder-count">{countText(listed.total)}</span>}
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
      <ContextMenu
        label={menuEntry ? `${menuEntry.name} actions` : `${name} actions`}
        trigger={
          <div
            className="folder-scroll"
            data-faded={(trouble !== undefined && shown !== undefined) || undefined}
            // A menu asked for off every entry is the folder's own.
            onContextMenuCapture={() => setMenuFor(undefined)}
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
        }
        items={menu}
      />
      {listed?.truncated && (
        <p className="artifact-cut">
          {name} holds {listed.total.toLocaleString("en-US")} items, which is more than Novadeck
          lists whole: the first {listed.entries.length.toLocaleString("en-US")} are shown.
        </p>
      )}
      {looked && (
        <>
          <div className="folder-look-backdrop" onClick={closeLook} />
          <QuickLook
            entry={looked}
            returnTo={body}
            path={intoFolder(within, looked.name)}
            itemId={item.id}
            reader={reader}
            now={now}
            onStep={stepLook}
            onOpen={() => {
              closeLook()
              open(looked)
            }}
            onClose={closeLook}
            onDismiss={() => setLooking(undefined)}
          />
        </>
      )}
    </div>
  )
}
