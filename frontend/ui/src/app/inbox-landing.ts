import { noInbox, type Inbox, type InboxItem, type InboxState } from "@novadeck/core/inbox"
import { createStore, type Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { isDesktop } from "../shell/desktop"
import { inboxShown } from "./selectors"
import { viewing, type UiStore } from "./ui-store"

// The landing rule: the Inbox the app's list, bell, toasts, OS pings and app badge consume.
// Items for the terminal the person is looking at (see `viewing`: the selected terminal while
// the page has their focus, in every view) don't land while they look: the agent is right
// there, so a row would only repeat it. They land when the person looks away, if still
// unresolved, quietly: no toast or OS ping rings for what the person already saw there. An
// update (a done report or a tell) is read once its terminal has been looked at for a moment
// (`readDwellMs`), whether it landed or not: seeing the terminal is seeing it. A read that
// fails lands the update instead. On a phone, while the Inbox list covers the screen, no
// terminal is looked at. Anything else that landed
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

// How long the person must keep looking at a terminal before an update of it counts as seen:
// a glance while passing through doesn't read a report.
export const readDwellMs = 1000

// The items that arrived while their terminal was viewed and landed later, as the person
// looked away, by the landed Inbox's state. They count on the bell, but the person has
// already seen them where they happened, so no toast or OS ping rings for them.
const quiets = new WeakMap<object, Set<string>>()

export const landedQuietly = (inbox: Pick<Inbox, "state">, item: InboxItem): boolean =>
  quiets.get(inbox.state)?.has(keyOf(item)) ?? false

// Wraps `raw`, following the workspace and the UI store for what the person is viewing.
// Returns the Inbox the app consumes and the stop. Everything but `state` is the raw Inbox's.
// `desktop` says whether the window is wide enough for the sidebar beside the terminal: on a
// phone the Inbox list covers the terminal, which then isn't viewed.
export const landInbox = (
  raw: Inbox,
  workspace: WorkspaceSource,
  ui: Pick<UiStore, "getSnapshot" | "subscribe">,
  desktop: () => boolean = isDesktop,
): {
  readonly inbox: Inbox
  readonly stop: () => void
  // Lands the raw item `id` now, even while its terminal is viewed; none that is not there.
  readonly reveal: (id: string) => void
} => {
  // The items that landed, by key; the updates read by being seen, which never land; the
  // ones kept unread while viewed, because the person asked for them or a read failed; the
  // ones that arrived held, which land quietly; and the reads under way.
  const landed = new Set<string>()
  const read = new Set<string>()
  const kept = new Set<string>()
  const quiet = new Set<string>()
  const reading = new Set<string>()
  // Per update seen in its viewed terminal, the dwell it waits out before it is read.
  const dwelling = new Map<string, ReturnType<typeof setTimeout>>()
  const ripe = new Set<string>()
  const store = createStore<InboxState>(raw.state.getSnapshot())
  const landedState: Inbox["state"] = {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
  }
  quiets.set(landedState, quiet)
  const sync = (): void => {
    const state = raw.state.getSnapshot()
    const page = ui.getSnapshot()
    const looking =
      !desktop() && inboxShown(page, desktop) ? null : viewing(workspace.getSnapshot(), page)
    const standing = new Set(state.items.map(keyOf))
    for (const set of [landed, read, kept, quiet, reading, ripe])
      for (const key of set) if (!standing.has(key)) set.delete(key)
    for (const [key, timer] of dwelling)
      if (!standing.has(key)) {
        clearTimeout(timer)
        dwelling.delete(key)
      }
    const items: InboxItem[] = []
    const toRead: InboxItem[] = []
    const stillDwelling = new Set<string>()
    for (const item of state.items) {
      const key = keyOf(item)
      const { source } = item
      const here =
        looking !== null &&
        looking.id === source.terminalId &&
        looking.context === `${source.projectId}/${source.workspaceSessionId}`
      if (!here) kept.delete(key)
      if (read.has(key)) {
        // A read that failed, or that left the item standing once it settled, mustn't hide
        // it for good: it lands, to be read by hand.
        if (
          state.failed[item.id] !== undefined ||
          (reading.has(key) && !state.answering[item.id])
        ) {
          read.delete(key)
          reading.delete(key)
          kept.add(key)
          landed.add(key)
        } else {
          if (state.answering[item.id]) reading.add(key)
          continue
        }
      }
      // Looking at its terminal for a while reads an update, landed or not.
      if (here && item.kind === "update" && !kept.has(key)) {
        if (ripe.has(key)) {
          ripe.delete(key)
          read.add(key)
          toRead.push(item)
          continue
        }
        stillDwelling.add(key)
        if (!dwelling.has(key))
          dwelling.set(
            key,
            setTimeout(() => {
              dwelling.delete(key)
              ripe.add(key)
              sync()
            }, readDwellMs),
          )
      }
      if (!landed.has(key) && here && item.kind !== "feedback") {
        quiet.add(key)
        continue
      }
      landed.add(key)
      items.push(item)
    }
    for (const [key, timer] of dwelling)
      if (!stillDwelling.has(key)) {
        clearTimeout(timer)
        dwelling.delete(key)
        ripe.delete(key)
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
    kept.add(keyOf(item))
    sync()
  }
  sync()
  const stops = [raw.state.subscribe(sync), workspace.subscribe(sync), ui.subscribe(sync)]
  return {
    inbox: { ...raw, state: landedState },
    stop: () => {
      stops.forEach((stop) => stop())
      dwelling.forEach(clearTimeout)
      dwelling.clear()
    },
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
