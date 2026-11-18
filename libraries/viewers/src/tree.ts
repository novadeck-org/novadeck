import { createHold } from "./hold.js"
import type { Mount, ViewerState } from "./index.js"
import {
  countText,
  copyText,
  defaultOpening,
  pathText,
  previewText,
  rowsOf,
  scalarText,
  type Opening,
  type Row,
} from "./tree/model.js"
import type { DataRoot } from "./tree/parse.js"

export {
  dataFormatOf,
  jsonErrorAt,
  parseData,
  type DataError,
  type DataFormat,
  type DataRoot,
  type ParseOptions,
  type Parsed,
} from "./tree/parse.js"
export { pathText, type Opening } from "./tree/model.js"

// Data as a tree: JSON's value, a JSONL file's records or a YAML file's documents, each
// object and array opening and closing, a closed one showing its first entries and how many
// it holds. Only the rows in sight are drawn, so a tree of thousands of nodes stays quick.
// What's open, the row the person is at and the scroll are kept in its state. Its looks
// are tree.css's.

export type TreeContent = {
  readonly roots: readonly DataRoot[]
  /** The file's name: a state from another file opens nothing here. */
  readonly path?: string
  /** Which nodes open before the person opens or closes any. */
  readonly opening?: Partial<Opening>
}

export type TreeOptions = {
  /** Puts a copied value or path on the clipboard; the window's clipboard by default. */
  readonly copy?: (text: string) => void | Promise<void>
}

type TreeState = {
  readonly tree: {
    readonly top: number
    readonly open: readonly (readonly [string, boolean])[]
    readonly active: string | null
    readonly path?: string
  }
}

const isTreeState = (state: unknown): state is TreeState => {
  const tree = (state as Partial<TreeState> | null)?.tree
  return typeof tree?.top === "number" && Array.isArray(tree.open)
}

// Rows drawn beyond the ones in sight, each way, so a quick scroll doesn't show a gap.
const overscan = 12
// The row's height until it can be measured, as out of sight.
const fallbackHeight = 22
// How long a button says it copied.
const copiedFor = 1200

let viewers = 0

// What copying a row puts on the clipboard: its value, or its path.
const copyOf = (row: Row, what: "value" | "path"): string =>
  what === "path" ? pathText(row.path) : copyText(row.value)

export const mountTree: Mount<TreeContent, TreeOptions> = (
  element,
  { content, label, saved, copy },
) => {
  const document = element.ownerDocument
  const view = document.defaultView
  const prefix = `tree-${++viewers}`
  const root = document.createElement("div")
  root.className = "tree-viewer"
  root.setAttribute("role", "tree")
  root.setAttribute("aria-label", label)
  root.tabIndex = 0
  const space = document.createElement("div")
  space.className = "tree-space"
  root.append(space)
  element.append(root)

  let shown = content
  let open = new Map<string, boolean>()
  let rows: Row[] = []
  let active: string | null = null
  let height = 0
  let drawn = { from: 0, to: 0 }

  const opening = (): Opening => ({ ...defaultOpening, ...shown.opening })
  const indexOf = (key: string | null): number =>
    key === null ? -1 : rows.findIndex((row) => row.key === key)

  const put = async (text: string): Promise<void> => {
    if (copy) return copy(text)
    await view?.navigator.clipboard.writeText(text)
  }

  // A row's height, from one drawn: none while out of sight.
  const measure = (): boolean => {
    const probe = document.createElement("div")
    probe.className = "tree-row"
    probe.textContent = "x"
    space.append(probe)
    const measured = probe.offsetHeight
    probe.remove()
    if (!measured || measured === height) return false
    height = measured
    return true
  }

  const rowHeight = (): number => height || fallbackHeight

  const part = (className: string, text: string): HTMLElement => {
    const span = document.createElement("span")
    span.className = className
    span.textContent = text
    return span
  }

  const button = (action: "value" | "path", text: string, name: string): HTMLElement => {
    const made = document.createElement("button")
    made.type = "button"
    made.tabIndex = -1
    made.dataset["action"] = action
    made.textContent = text
    made.setAttribute("aria-label", name)
    return made
  }

  const draw = (row: Row, index: number): HTMLElement => {
    const line = document.createElement("div")
    line.className = "tree-row"
    line.id = `${prefix}-${index}`
    line.setAttribute("role", "treeitem")
    line.setAttribute("aria-level", String(row.depth + 1))
    line.setAttribute("aria-setsize", String(row.siblings))
    line.setAttribute("aria-posinset", String(row.position))
    line.setAttribute("aria-selected", String(row.key === active))
    line.dataset["index"] = String(index)
    line.style.top = `${index * rowHeight()}px`
    line.style.setProperty("--depth", String(row.depth))
    // An empty object or array has nothing to expand.
    if (row.count) line.setAttribute("aria-expanded", String(row.open))
    const twisty = part("tree-twisty", "")
    if (row.count !== undefined && row.count > 0) twisty.dataset["open"] = String(row.open)
    line.append(twisty)
    if (row.name !== null) {
      const top = row.depth === 0 && row.path.length === 0
      const name = part(
        top ? "tree-label" : typeof row.name === "number" ? "tree-index" : "tree-key",
        String(row.name),
      )
      line.append(name, part("tree-colon", top ? " " : ": "))
    }
    if (row.broken !== undefined) {
      line.dataset["broken"] = ""
      line.append(part("tree-broken", row.broken), part("tree-raw", scalarText(row.value, 200)))
    } else if (row.count !== undefined && (row.type === "object" || row.type === "array")) {
      // An empty one shows as what it is: {} or [].
      if (!row.open || row.count === 0) line.append(part("tree-preview", previewText(row.value)))
      line.append(part("tree-count", countText(row.type, row.count)))
    } else {
      const value = part("tree-value", scalarText(row.value))
      value.dataset["type"] = row.type
      if (typeof row.value === "string" && row.value.length > 60)
        value.title = row.value.slice(0, 2000)
      line.append(value)
    }
    const actions = document.createElement("span")
    actions.className = "tree-actions"
    actions.append(button("value", "Copy", "Copy value"), button("path", "Copy path", "Copy path"))
    line.append(actions)
    return line
  }

  // The rows in sight, and a few more, drawn where they sit in the whole.
  const render = (): void => {
    const each = rowHeight()
    space.style.height = `${rows.length * each}px`
    const visible = root.clientHeight || 30 * each
    const from = Math.max(0, Math.floor(root.scrollTop / each) - overscan)
    const to = Math.min(rows.length, Math.ceil((root.scrollTop + visible) / each) + overscan)
    drawn = { from, to }
    const lines: HTMLElement[] = []
    for (let index = from; index < to; index += 1) lines.push(draw(rows[index]!, index))
    space.replaceChildren(...lines)
    mark()
  }

  // The active row, as the drawn rows and the tree say it, leaving the rows as they are.
  const mark = (): void => {
    const at = indexOf(active)
    for (const line of space.children)
      line.setAttribute(
        "aria-selected",
        String((line as HTMLElement).dataset["index"] === String(at)),
      )
    if (at >= drawn.from && at < drawn.to)
      root.setAttribute("aria-activedescendant", `${prefix}-${at}`)
    else root.removeAttribute("aria-activedescendant")
  }

  const layout = (): void => {
    rows = rowsOf(shown.roots, open, opening())
    if (active !== null && indexOf(active) < 0) active = null
    render()
  }

  // Scrolls just enough to show the row at `index`.
  const reveal = (index: number): void => {
    const each = rowHeight()
    // The rows start below the tree's padding.
    const top = space.offsetTop + index * each
    if (top < root.scrollTop) root.scrollTop = index * each
    else if (top + each > root.scrollTop + root.clientHeight)
      root.scrollTop = top + each - root.clientHeight
  }

  const activate = (index: number): void => {
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)]
    if (!row) return
    active = row.key
    reveal(indexOf(active))
    render()
  }

  const toggle = (row: Row, to = !row.open): void => {
    if (row.count === undefined || row.count === 0 || row.open === to) return
    open = new Map(open).set(row.key, to)
    layout()
  }

  const copied = (target: HTMLElement): void => {
    const was = target.textContent
    target.textContent = "Copied"
    target.dataset["copied"] = ""
    view?.setTimeout(() => {
      target.textContent = was
      delete target.dataset["copied"]
    }, copiedFor)
  }

  const rowAt = (target: EventTarget | null): Row | undefined => {
    const line = (target as Element | null)?.closest?.(".tree-row") as HTMLElement | null
    const index = Number(line?.dataset["index"])
    return Number.isInteger(index) ? rows[index] : undefined
  }

  const onClick = (event: MouseEvent): void => {
    const row = rowAt(event.target)
    if (!row) return
    const action = (event.target as Element).closest?.("button[data-action]") as HTMLElement | null
    if (action) {
      const what = action.dataset["action"] === "path" ? "path" : "value"
      void put(copyOf(row, what)).then(() => copied(action))
      return
    }
    active = row.key
    // A drag that picked out text isn't a click to open.
    const selection = view?.getSelection()
    // Drawing the rows again would drop the text picked out.
    if (selection && !selection.isCollapsed && root.contains(selection.anchorNode)) return mark()
    if (row.count !== undefined && row.count > 0) toggle(row)
    else render()
  }

  // The node holding the row at `index`, if it's drawn.
  const parentOf = (index: number): number => {
    const row = rows[index]
    if (!row) return -1
    for (let at = index - 1; at >= 0; at -= 1) if (rows[at]!.depth < row.depth) return at
    return -1
  }

  const onKey = (event: KeyboardEvent): void => {
    const at = indexOf(active)
    const row = rows[at]
    const page = Math.max(1, Math.floor(root.clientHeight / rowHeight()) - 1)
    const command = event.metaKey || event.ctrlKey
    if (command && event.key.toLowerCase() === "c") {
      const selection = view?.getSelection()
      // Text the person picked out in the tree copies as text.
      const picked = selection && !selection.isCollapsed && root.contains(selection.anchorNode)
      if (!row || picked) return
      event.preventDefault()
      void put(copyOf(row, event.shiftKey ? "path" : "value"))
      return
    }
    if (command || event.altKey) return
    const moves: Record<string, () => void> = {
      ArrowDown: () => activate(at + 1),
      ArrowUp: () => activate(at < 0 ? 0 : at - 1),
      Home: () => activate(0),
      End: () => activate(rows.length - 1),
      PageDown: () => activate(at < 0 ? 0 : at + page),
      PageUp: () => activate(at < 0 ? 0 : at - page),
      ArrowRight: () => {
        if (!row) return activate(0)
        if (row.count && !row.open) return toggle(row, true)
        if (row.count && row.open) activate(at + 1)
      },
      ArrowLeft: () => {
        if (!row) return activate(0)
        if (row.count && row.open) return toggle(row, false)
        const parent = parentOf(at)
        if (parent >= 0) activate(parent)
      },
      Enter: () => row && toggle(row),
      " ": () => row && toggle(row),
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    move()
  }

  const { hold, release } = createHold(root, () => [space])

  // A state from this file.
  const isPlace = (state: ViewerState | undefined): state is TreeState & ViewerState =>
    isTreeState(state) && state.tree.path === shown.path

  const restore = (state: ViewerState): void => {
    if (!isPlace(state)) return
    open = new Map(state.tree.open)
    active = state.tree.active
    layout()
    const { top } = state.tree
    hold(() => {
      root.scrollTop = top
    })
  }

  // Draws again as it scrolls, as it's sized, and once a row can be measured.
  const onScroll = (): void => {
    const each = rowHeight()
    const from = Math.floor(root.scrollTop / each)
    const to = Math.ceil((root.scrollTop + root.clientHeight) / each)
    if (from < drawn.from || to > drawn.to) render()
  }
  const Observer = view?.ResizeObserver
  const sized = Observer
    ? new Observer(() => {
        measure()
        render()
      })
    : undefined
  sized?.observe(root)
  root.addEventListener("scroll", onScroll, { passive: true })
  root.addEventListener("click", onClick)
  root.addEventListener("keydown", onKey)

  measure()
  layout()
  if (isPlace(saved)) restore(saved)

  return {
    update: (next) => {
      const samePath = next.path === shown.path
      shown = next
      // Another file opens as its own defaults say.
      if (!samePath) {
        open = new Map()
        active = null
        root.scrollTop = 0
      }
      layout()
    },
    state: () =>
      ({
        tree: {
          top: root.scrollTop,
          open: [...open],
          active,
          ...(shown.path === undefined ? {} : { path: shown.path }),
        },
      }) satisfies TreeState as unknown as ViewerState,
    restore,
    // To the row that starts at that line or nearest before it: a JSONL record or a YAML
    // document, by its line.
    jumpTo: (target) => {
      if (!("line" in target)) return
      let found = -1
      shown.roots.forEach((each, index) => {
        if (each.line <= target.line) found = index
      })
      const at = rows.findIndex((row) => row.root === found && row.path.length === 0)
      if (at >= 0) hold(() => activate(at))
    },
    focus: () => root.focus({ preventScroll: true }),
    destroy: () => {
      release()
      sized?.disconnect()
      root.removeEventListener("scroll", onScroll)
      root.removeEventListener("click", onClick)
      root.removeEventListener("keydown", onKey)
      root.remove()
    },
  }
}
