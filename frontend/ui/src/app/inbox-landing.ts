import { noInbox, type Inbox, type InboxItem, type InboxState } from "@novadeck/core/inbox"
import { createStore, type Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { viewing, type UiStore } from "./ui-store"

// The landing rule: the Inbox the app's list, bell, toasts, OS pings and app badge consume.
// Items for the terminal the person is looking at (see `viewing`: the selected terminal while
// the page has their focus, in every view) don't land while they look: the agent is right
// there, so a row would only repeat it. They land when the person looks away, if still
// unresolved. An update (a done report or a tell) is read once its terminal is looked at,
// whether it landed or not: seeing the terminal is seeing it. Anything else that landed
// stays: selecting a terminal doesn't take back a row the person must still answer. A
// feedback draft the person asked for always lands, and so does an item the person asks to
// open by its id (`reveal`), as Answer in a terminal's Messages does.
//
// The marks on a tab and window, and `watchUnreadTurns`, read the raw backend Inbox, never
// this one.

const keyOf = (item: InboxItem): string => `${item.id}@${item.at}`

const sameItems = (a: readonly InboxItem[], b: readonly InboxItem[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])

type WorkspaceSource = Pick<Store<Workspace>, "getSnapshot" | "subscribe">

// Wraps `raw`, following the workspace and the UI store for what the person is viewing.
// Returns the Inbox the app consumes and the stop. Everything but `state` is the raw Inbox's.
export const landInbox = (
  raw: Inbox,
  workspace: WorkspaceSource,
  ui: Pick<UiStore, "getSnapshot" | "subscribe">,
): {
  readonly inbox: Inbox
  readonly stop: () => void
  // Lands the raw item `id` now, even while its terminal is viewed; none that is not there.
  readonly reveal: (id: string) => void
} => {
  // The items that landed, by key, and the updates read by being seen, which never land.
  const landed = new Set<string>()
  const read = new Set<string>()
  const store = createStore<InboxState>(raw.state.getSnapshot())
  const sync = (): void => {
    const state = raw.state.getSnapshot()
    const looking = viewing(workspace.getSnapshot(), ui.getSnapshot())
    const standing = new Set(state.items.map(keyOf))
    for (const key of landed) if (!standing.has(key)) landed.delete(key)
    for (const key of read) if (!standing.has(key)) read.delete(key)
    const items: InboxItem[] = []
    const toRead: InboxItem[] = []
    for (const item of state.items) {
      const key = keyOf(item)
      const { source } = item
      const here =
        looking !== null &&
        looking.id === source.terminalId &&
        looking.context === `${source.projectId}/${source.workspaceSessionId}`
      if (read.has(key)) continue
      // Looking at its terminal reads an update, landed or not.
      if (here && item.kind === "update") {
        read.add(key)
        toRead.push(item)
        continue
      }
      if (!landed.has(key) && here && item.kind !== "feedback") continue
      landed.add(key)
      items.push(item)
    }
    store.update((current) =>
      sameItems(current.items, items) &&
      current.answering === state.answering &&
      current.failed === state.failed
        ? current
        : { ...state, items },
    )
    for (const item of toRead) raw.answer(item.id, { kind: "update", action: "read" })
  }
  const reveal = (id: string): void => {
    const item = raw.state.getSnapshot().items.find((each) => each.id === id)
    if (!item || read.has(keyOf(item))) return
    landed.add(keyOf(item))
    sync()
  }
  sync()
  const stops = [raw.state.subscribe(sync), workspace.subscribe(sync), ui.subscribe(sync)]
  return {
    inbox: { ...raw, state: { getSnapshot: store.getSnapshot, subscribe: store.subscribe } },
    stop: () => stops.forEach((stop) => stop()),
    reveal,
  }
}

// The landed Inbox of an app's raw one, made once and kept for the app's life: the list, the
// bell, the toasts and the pings all share it, so an item lands once for all of them.
const landings = new WeakMap<
  Inbox,
  { readonly inbox: Inbox; readonly reveal: (id: string) => void }
>()

export const landedInbox = (
  raw: Inbox | undefined,
  workspace: WorkspaceSource,
  ui: Pick<UiStore, "getSnapshot" | "subscribe">,
): Inbox => {
  if (!raw) return noInbox
  const known = landings.get(raw)
  if (known) return known.inbox
  const { inbox: landed, reveal } = landInbox(raw, workspace, ui)
  landings.set(raw, { inbox: landed, reveal })
  return landed
}

// Lands the raw Inbox's item `id` in its landed Inbox even while its terminal is viewed, for
// whatever opens an item by its id (Answer in a terminal's Messages). Nothing before the
// landed Inbox was made.
export const revealItem = (raw: Inbox | undefined, id: string): void => {
  if (raw) landings.get(raw)?.reveal(id)
}
