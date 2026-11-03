import { pageKey } from "./items/pages"
import type { CompanionWindowMeta, WorkspaceTarget } from "./types"

// What agents put in front of the person beside their terminals: the plans they write,
// and images, project files and preview-browser pages they show. A backend reports
// them; each terminal's companion pane presents them. The content-preview demo
// implements this with sample agents; a runner reports the same from the agents' own
// files and hooks, and from what they present through Novadeck's MCP server.

// The kinds an agent shows (with `show`) or the person attaches: each points at a file, a
// page or a change. A plan is the one kind an agent writes rather than shows.
export type ShownKind = "image" | "file" | "page" | "changes"

// What an agent showed or the person attached, as the backend keeps it: a pointer to a
// file or page, never a copy, held by exactly one terminal's bar or one undocked window.
// Its content loads when something shows it, so it shows what the file holds now.

// An item's id, as its backend names it: stable across restarts and unique in the app.
export type ItemId = string & { readonly __item: unique symbol }

export const itemIdOf = (id: string): ItemId => id as ItemId

// Who holds the item: a terminal's bar, or a window of its own.
export type ItemHolder = { readonly terminalId: string } | { readonly windowId: string }

export type ItemKind = ShownKind | "plan"

export type Item = {
  readonly id: ItemId
  readonly holder: ItemHolder
  readonly kind: ItemKind
  readonly name: string
  readonly detail: string
  // A file's or plan's path, or the page's address.
  readonly path: string | null
  readonly url: string | null
  // The lines it points at, numbered from 1.
  readonly lines: { readonly from: number; readonly to: number } | null
  // A file that may hold secrets: shown only when the person picks it.
  readonly secret: boolean
  // Shown by an agent, or attached by the person.
  readonly by: "agent" | "person"
  // The terminal it was shown from, which a window docks back into; null for a file the
  // person opened in their project window, which came from no terminal.
  readonly from: { readonly terminalId: string; readonly handle: string } | null
  // Counts its shows; a higher version is something shown again.
  readonly version: number
  // The person asked to see it: it opens rather than waits.
  readonly openAsked: boolean
  readonly shownAt: number
  // A plan's agent, by the name the person knows it by, whose plan it is, and whether
  // it's a file or text in the agent's own conversation, which `path` then names.
  readonly plan: {
    readonly agent: string
    readonly role: "root" | "subagent"
    readonly source: "file" | "text"
  } | null
}

export const isOnBar = (
  item: Item,
  terminalId: string,
): item is Item & { readonly holder: { readonly terminalId: string } } =>
  "terminalId" in item.holder && item.holder.terminalId === terminalId

// The file the person can open for it, where it has one of its own: a text plan's path
// is its agent's conversation record, which isn't the plan.
export const pathOf = (item: Pick<Item, "path" | "plan">): string | null =>
  item.plan?.source === "text" ? null : item.path

export const windowOfItem = (item: Item): string | undefined =>
  "windowId" in item.holder ? item.holder.windowId : undefined

// What each kind of item means as data, apart from how it looks. A new kind adds its line.
type KindRule = {
  // What the kind points at, so showing the same thing again finds it: a file by its path, a
  // page by the runner's own key for its address, a change by its repository's folder. A
  // plan has none here: which agent's plan slot it fills is the backend's to know.
  readonly pointer: "none" | "file" | "page" | "changes"
  // How long the pane follows its content: a plan is followed whether shown or not, anything
  // else only while something shows it.
  readonly follow: "always" | "shown"
  // What closing one does on its own terminal's bar: a plan hides until it's rewritten,
  // anything else is gone.
  readonly close: "hide" | "remove"
}

export const kindRules: Record<ItemKind, KindRule> = {
  image: { pointer: "file", follow: "shown", close: "remove" },
  file: { pointer: "file", follow: "shown", close: "remove" },
  page: { pointer: "page", follow: "shown", close: "remove" },
  changes: { pointer: "changes", follow: "shown", close: "remove" },
  plan: { pointer: "none", follow: "always", close: "hide" },
}

type Pointer = Pick<Item, "kind" | "path" | "url">

// What a file, page or change item points at, so showing the same thing again finds it: a
// page by the runner's own key for it, a change by its folder.
export const pointerOf = (item: Pointer): string | null => {
  switch (kindRules[item.kind].pointer) {
    case "none":
      return null
    case "page":
      return `page:${pageKey(item.url ?? "")}`
    case "file":
      return `file:${item.path}`
    case "changes":
      return `changes:${item.path}`
  }
}

export const samePointer = (a: Pointer, b: Pointer): boolean => {
  const pointer = pointerOf(a)
  return pointer !== null && pointer === pointerOf(b)
}

// The item on terminal `terminalId`'s own bar that points where `pointer` does, which an
// agent showing it again updates rather than adding another.
export const ownItemWith = (
  items: readonly Item[],
  terminalId: string,
  pointer: Pointer,
): Item | undefined => items.find((item) => isOnBar(item, terminalId) && samePointer(item, pointer))

// What terminal `terminalId`'s agent showed that points where `pointer` does, which it
// updates by showing it again: the item on its own bar, else the latest it showed that
// the person moved into a window or onto another bar.
export const shownItemWith = (
  items: readonly Item[],
  terminalId: string,
  pointer: Pointer,
): Item | undefined =>
  ownItemWith(items, terminalId, pointer) ??
  items
    .toSorted((a, b) => a.shownAt - b.shownAt)
    .findLast(
      (item) =>
        item.by === "agent" && item.from?.terminalId === terminalId && samePointer(item, pointer),
    )

// What an item holds as it loads, from the file or page it points at now.

// An image, by a URL the page can load.
export type ImageContent = { readonly kind: "image"; readonly src: string }

// A text file, with the lines it pointed at. `firstLine` numbers the first of `lines`.
export type FileContent = {
  readonly kind: "file"
  readonly path: string
  readonly firstLine: number
  readonly lines: readonly string[]
  readonly from: number
  readonly to: number
  // How many lines the file has, once it was read to its end.
  readonly total: number | null
  // The file is long, so only its start was read.
  readonly truncated: boolean
  // The lines it pointed at ran past the file's end, which they now stop at.
  readonly clamped: boolean
}

// A web page, by its http(s) address. `live` when the app can load it in the
// pane, as the desktop app does; otherwise it shows as a link to open in the browser,
// with its `snapshot` image when the backend has one. `shown` counts the agent's shows of
// it, as its item's version: each later one loads it afresh, and brings `scroll`, a CSS
// selector the show gave, into view.
export type PageContent = {
  readonly kind: "page"
  readonly url: string
  readonly shown: number
  readonly scroll?: string
  readonly live: boolean
  readonly snapshot?: string
}

// One file of a change: how it changed and its diff as hunks of lines. A `binary` file, one
// that may hold secrets (`secret`), or one past the change's bounds (`listed`) has no hunks and
// is listed by name. A hunk's line numbers count from its `oldStart` and `newStart`.
export type ChangedFile = {
  readonly path: string
  readonly oldPath: string | null
  readonly status: "added" | "modified" | "deleted" | "renamed"
  readonly added: number
  readonly removed: number
  readonly binary: boolean
  readonly secret: boolean
  readonly listed: boolean
  readonly hunks: readonly {
    readonly oldStart: number
    readonly oldCount: number
    readonly newStart: number
    readonly newCount: number
    readonly lines: readonly {
      readonly kind: "context" | "add" | "remove"
      readonly text: string
    }[]
  }[]
}

// An agent's whole change: the repository's working tree against `base`, file by file, up
// to the backend's bounds, past which files are only listed and `truncated` says so. `root`
// is the repository's folder, which the paths are from.
export type ChangesContent = {
  readonly kind: "changes"
  readonly root: string
  readonly base: string
  readonly files: readonly ChangedFile[]
  readonly truncated: boolean
}

export type ShownContent = ImageContent | FileContent | PageContent | ChangesContent

// A plan's text as it stands. `writable` when `save` can write it: a plan that lives only
// in the agent's messages, or a backend that can't write plans yet, leaves it read-only.
// `skill` when Novadeck's skill is installed for its agent, which tells the agent to
// re-read the plan before acting on it and apply the notes left in it.
export type PlanContent = {
  readonly kind: "plan"
  readonly text: string
  // The backend sent only the start of a very long plan.
  readonly truncated: boolean
  readonly writable: boolean
  readonly skill: boolean
}

// Why an item can't show: its file is gone or can't be read, is no file, is too large or
// isn't text, may hold secrets and wasn't asked for, or its plan is gone.
export type UnavailableReason =
  | "missing"
  | "unreadable"
  | "not-a-file"
  | "too-large"
  | "binary"
  | "secret"
  | "gone"

// What an item holds now. `stamp` names this exact content: it changes whenever the
// content does, and a plan's edit says which stamp it was made on. `size` is in bytes,
// where the backend knows it.
export type ItemContent =
  | {
      readonly state: "ready"
      readonly stamp: string
      readonly content: ShownContent | PlanContent
    }
  | {
      readonly state: "unavailable"
      readonly reason: UnavailableReason
      readonly size: number | null
    }

// A plan as one stamp has it.
export type PlanVersion = { readonly stamp: string; readonly plan: PlanContent }

export const planVersionOf = (content: ItemContent): PlanVersion | undefined =>
  content.state === "ready" && content.content.kind === "plan"
    ? { stamp: content.stamp, plan: content.content }
    : undefined

// Saving an edit: the plan's new stamp, or, when the file changed since the stamp the
// edit was made on, the plan as it now stands, to merge the edit into.
export type PlanSaved =
  | { readonly saved: true; readonly stamp: string }
  | { readonly saved: false; readonly current: PlanVersion }

// Why a plan can't be written, which saving it again won't change until the plan or its
// folder does: its file is gone, Novadeck may not write in its folder or file, it lives in
// an agent's messages, it is past what Novadeck writes, or the item is no plan.
export type PlanUnwritableReason =
  | "gone"
  | "folder"
  | "transcript"
  | "too-large"
  | "not-a-plan"
  | "outside"

// What `save` rejects with when the plan can't be written for good. Any other rejection
// is a failure that may pass, which the pane tries again.
export class PlanUnwritableError extends Error {
  constructor(readonly reason: PlanUnwritableReason) {
    super(`The plan can't be written: ${reason}`)
    this.name = "PlanUnwritableError"
  }
}

// What went wrong on a live page, as the pane saw it: an error the page logged or threw,
// with the script and line it came from; a request of the page's own origin answered with an
// HTTP error `status` (0 for no answer), the page itself being `what: "page"`; or a load that
// failed outright.
export type PageTrouble =
  | {
      readonly kind: "error"
      readonly text: string
      readonly source: string
      readonly line: number
    }
  | {
      readonly kind: "request"
      readonly url: string
      readonly status: number
      readonly what: string
    }
  | { readonly kind: "load"; readonly text: string }

// How many troubles one `trouble` call carries at most.
export const pageTroublesPerCall = 20

// Where the items' content comes from. The items themselves reach the workspace store
// as the backend's seed and actions, like terminals.
export type Companions = {
  // Reports what the item holds now, then again whenever that changes, until stopped.
  // One that may hold secrets reports `secret` unless `reveal` is the path the item points at:
  // the person's yes is to a file, not to whatever the item is pointed at when it's heard.
  readonly follow: (
    target: WorkspaceTarget,
    itemId: ItemId,
    options: { readonly reveal: string | undefined },
    on: (content: ItemContent) => void,
  ) => () => void
  // Writes the person's edit to the plan, unless it changed since `basedOn`. Rejects with
  // a `PlanUnwritableError` when the plan can't be written at all.
  readonly save: (
    target: WorkspaceTarget,
    itemId: ItemId,
    text: string,
    basedOn: string,
  ) => Promise<PlanSaved>
  // Tells what went wrong on a live page, which the item's show `shown` (its `version`)
  // loaded, so the agent that showed it can hear. Best effort: it never fails, and a
  // backend that can't tell anyone does nothing. At most `pageTroublesPerCall` at a time.
  readonly trouble: (
    target: WorkspaceTarget,
    itemId: ItemId,
    shown: number,
    troubles: readonly PageTrouble[],
  ) => void
  // Opens a file in the session's project window, by a path from the project's folder or
  // absolute: the item the window holds is pointed at it, or, when the session has none,
  // the window is made under `windowId`. Resolves with the item and its window as they now
  // are; rejects when the path is no file it can open. Absent where the backend can't.
  readonly openInProject?: (
    target: WorkspaceTarget,
    path: string,
    windowId: string,
  ) => Promise<{ readonly item: Item; readonly window: CompanionWindowMeta }>
  // A picture of what a live page shows now, by its view's web contents id, no wider than
  // `width` device pixels, which the pane shows in its place while the person isn't at it;
  // undefined when there's none to take. Absent where pages don't load live, or the app
  // can't picture them: they stay live.
  readonly picture?: (
    page: number,
    width?: number,
    forLook?: boolean,
  ) => Promise<string | undefined>
  // Makes a live page's view act as a phone's, by its web contents id, or as itself again:
  // touched, with a phone's screen and browser; false when it can't. Absent where pages
  // don't load live, or the app can't: a page at a phone's size is then only as narrow.
  readonly phone?: (page: number, phone: boolean) => Promise<boolean>
}

// Items with nothing to show, for a backend whose terminals have only their messages
// in the pane.
export const emptyCompanions = (): Companions => ({
  follow: () => () => {},
  save: () => Promise.reject(new Error("There are no plans")),
  trouble: () => {},
})

// A note as Novadeck writes it into the plan: an HTML comment, invisible once rendered,
// marked for the agent's skill to find.
export const noteOpen = "<!-- novadeck: "
export const noteClose = " -->"

export const notePattern = /<!-- novadeck: (.*?) -->/g

export const notesIn = (text: string): number => [...text.matchAll(notePattern)].length

// A note's text as the comment around it allows: one line, and no `-->`, which would
// end the comment early and spill the rest of the note into the plan.
export const noteSafe = (text: string): string => {
  let safe = text.replace(/\s*\n\s*/g, " ")
  while (safe.includes("-->")) safe = safe.replaceAll("-->", "->")
  return safe
}
