import type { WorkspaceTarget } from "./types"

// What agents put in front of the user beside their terminals: the plans they write,
// and images, project files and preview-browser pages they show. A backend reports
// them; each terminal's companion pane presents them. The content-preview demo
// implements this with sample agents; a runner reports the same from the agents' own
// files and hooks, and from what they present through Novadeck's MCP server.

// A terminal, as the backend port knows it: terminal IDs repeat across sessions.
export type CompanionKey = WorkspaceTarget & { readonly terminalId: string }

export const companionKeyId = ({
  projectId,
  workspaceSessionId,
  terminalId,
}: CompanionKey): string => `${projectId}/${workspaceSessionId}/${terminalId}`

// The terminal a `companionKeyId` names. Its ids hold no slashes.
export const companionKeyOf = (id: string): CompanionKey => {
  const [projectId = "", workspaceSessionId = "", terminalId = ""] = id.split("/")
  return { projectId, workspaceSessionId, terminalId }
}

export type ArtifactKind = "image" | "file" | "page"

// What an agent showed or the person attached, as the backend keeps it: a pointer to a
// file or page, never a copy, held by exactly one terminal's bar or one undocked window.
// Its content loads when something shows it, so it shows what the file holds now.

// An item's id, as its backend names it: stable across restarts and unique in the app.
export type ItemId = string & { readonly __item: unique symbol }

export const itemIdOf = (id: string): ItemId => id as ItemId

// Who holds the item: a terminal's bar, or a window of its own.
export type ItemHolder = { readonly terminalId: string } | { readonly windowId: string }

export type ItemKind = ArtifactKind | "plan"

export type CompanionItem = {
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
  readonly held: boolean
  // Shown by an agent, or attached by the person.
  readonly by: "agent" | "person"
  // The terminal it was shown from, which a window docks back into.
  readonly from: { readonly terminalId: string; readonly handle: string }
  // Counts its shows; a higher version is something shown again.
  readonly version: number
  // The person asked to see it: it opens rather than waits.
  readonly asked: boolean
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
  item: CompanionItem,
  terminalId: string,
): item is CompanionItem & { readonly holder: { readonly terminalId: string } } =>
  "terminalId" in item.holder && item.holder.terminalId === terminalId

// The file the person can open for it, where it has one of its own: a text plan's path
// is its agent's conversation record, which isn't the plan.
export const pathOf = (item: Pick<CompanionItem, "path" | "plan">): string | null =>
  item.plan?.source === "text" ? null : item.path

export const windowOfItem = (item: CompanionItem): string | undefined =>
  "windowId" in item.holder ? item.holder.windowId : undefined

type Pointer = Pick<CompanionItem, "kind" | "path" | "url">

// What a file or page item points at, so showing the same thing again finds it. A plan
// has none here: which agent's plan slot it fills is the backend's to know.
const pointerOf = (item: Pointer): string | null =>
  item.kind === "plan" ? null : item.kind === "page" ? `page:${item.url}` : `file:${item.path}`

export const samePointer = (a: Pointer, b: Pointer): boolean => {
  const pointer = pointerOf(a)
  return pointer !== null && pointer === pointerOf(b)
}

// The item on terminal `terminalId`'s own bar that points where `pointer` does, which an
// agent showing it again updates rather than adding another.
export const ownItemWith = (
  items: readonly CompanionItem[],
  terminalId: string,
  pointer: Pointer,
): CompanionItem | undefined =>
  items.find((item) => isOnBar(item, terminalId) && samePointer(item, pointer))

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

// A web page, by its http(s) address. `live` when the backend's host can load it in the
// pane, as the desktop app does; otherwise it shows as a link to open in the browser,
// with its `snapshot` image when the backend has one.
export type PageContent = {
  readonly kind: "page"
  readonly url: string
  readonly live: boolean
  readonly snapshot?: string
}

export type ShownContent = ImageContent | FileContent | PageContent

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
  | "held"
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

// Where the items' content comes from. The items themselves reach the workspace store
// as the backend's seed and actions, like terminals.
export type Companions = {
  // Reports what the item holds now, then again whenever that changes, until stopped.
  // One that may hold secrets reports `held` unless `reveal`.
  readonly follow: (
    target: WorkspaceTarget,
    itemId: ItemId,
    options: { readonly reveal: boolean },
    on: (content: ItemContent) => void,
  ) => () => void
  // Writes the person's edit to the plan, unless it changed since `basedOn`.
  readonly save: (
    target: WorkspaceTarget,
    itemId: ItemId,
    text: string,
    basedOn: string,
  ) => Promise<PlanSaved>
  // Puts a file on the terminal's bar, as the person attached it. Absent where the
  // backend can't.
  readonly attach?: (key: CompanionKey, path: string) => Promise<void>
}

// Companions with nothing to show, for a backend whose terminals have only their messages
// in the pane.
export const emptyCompanions = (): Companions => ({
  follow: () => () => {},
  save: () => Promise.reject(new Error("There are no plans")),
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
