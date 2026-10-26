import { handleText } from "@novadeck/core/handle"
import type { Inbox, InboxRow } from "@novadeck/core/inbox"
import type { Backend, Notice } from "@novadeck/core/port"

import { needing, ringing } from "../inbox/inbox-state"
import { fromNovadeck, labelOf, subjectOf } from "../inbox/inbox-text"
import { isDesktop } from "../shell/desktop"
import type { Ding } from "./ding"
import type { LandedInbox } from "./inbox-landing"
import { heldForToast, modalOpen } from "./selectors"
import type { UiStore } from "./ui-store"

// The Inbox these follow: the landed one, which knows what landed quietly, or any with a state.
export type NeedsInbox = Pick<Inbox, "state"> & Partial<Pick<LandedInbox, "landedQuietly">>

// How long a new item that needs the person waits before it pings: one the person or the
// agent settles in that time never does. (A permission request has already waited its own
// 3 s before it becomes an item.)
export const needGraceMs = 2000

// How long before this started an item may have begun and still be new: a request becomes
// an item only once its dialog shows, a few seconds after it was asked.
const launchSlackMs = 5000

// The most the icon's count says; the host takes 0 to 999.
const maxBadge = 999

// The notifications Novadeck has shown, so that one source takes its own back and no
// other's: a terminal has one notification at a time, a newer one replacing it, and what
// cleared when an Inbox item left must not close the finish notice that came after it.
export type NoticeBoard = {
  // Shows a notice for `owner`, replacing whatever its terminal showed. `item` is the Inbox
  // item the notice is about, if it is about one.
  readonly show: (owner: string, notice: Notice, item?: string) => void
  // Closes the terminal's notification if `owner`'s is still the latest.
  readonly close: (owner: string, terminalId: string) => void
  // The item the terminal's latest notification is about, for a click on it to open.
  readonly itemOf: (terminalId: string) => string | undefined
}

// A backend's board is the one: what rings notices and what hears their clicks share it. The
// `ding` it sounds with each notice is the first caller's (a notice's id is its terminal's).
const boards = new WeakMap<object, NoticeBoard>()

export const noticeBoard = (notices: Backend["notices"], ding: Ding): NoticeBoard | undefined => {
  if (!notices) return undefined
  const known = boards.get(notices)
  if (known) return known
  const latest = new Map<string, { owner: string; item: string | undefined }>()
  const board: NoticeBoard = {
    show: (owner, notice, item) => {
      latest.set(notice.id, { owner, item })
      if (notices.sounds) {
        // The host's own notification plays the sound, so only a notice the ding lets
        // through carries it: one of a burst, or a terminal's second, is silent.
        notices.show({ ...notice, silent: !ding.take(notice.id), sound: ding.sound() })
      } else {
        notices.show({ ...notice, silent: !ding.on() })
        ding.ring(notice.id)
      }
    },
    close: (owner, terminalId) => {
      if (latest.get(terminalId)?.owner !== owner) return
      latest.delete(terminalId)
      notices.close?.(terminalId)
    },
    itemOf: (terminalId) => latest.get(terminalId)?.item,
  }
  boards.set(notices, board)
  return board
}

// What a desktop notification says of an item that needs the person: the Inbox row's own
// byline as the title, led by who it is from as a finish notice's is ("@moth asks you:
// Checkout"; Novadeck's own items are its own), and its subject, a command included, as the
// body.
export const needNotice = (item: InboxRow): Notice => {
  const { handle, title, terminalId } = item.source
  const label = labelOf(item)
  const what = label.charAt(0).toLowerCase() + label.slice(1)
  return {
    id: terminalId,
    title: fromNovadeck(item)
      ? `${label}: ${title}`
      : handle
        ? `${handleText(handle)} ${what}: ${title}`
        : `${title} ${what}`,
    body: subjectOf(item).replaceAll("`", ""),
  }
}

// What a click on a terminal's notification does: the Inbox opens on the item the notice was
// about (`itemId`) if it still stands (a notice names its row); without one, or once it
// has gone, the terminal's done report, else its first item, and the terminal itself when it
// has none. `items` are the backend's own, as the Inbox may hold the item back.
export const clickNotice = (
  terminalId: string,
  items: readonly InboxRow[],
  to: {
    readonly open: (id: string) => void
    readonly showInbox: () => void
    readonly reveal: (terminalId: string) => void
    // Lands the item in the Inbox before it opens, where the terminal being viewed held it.
    readonly land?: (id: string) => void
  },
  itemId?: string,
): void => {
  const its = items.filter(({ source }) => source.terminalId === terminalId)
  const item =
    its.find(({ id }) => id === itemId) ??
    (itemId === undefined
      ? its.find((each) => each.kind === "update" && each.update.type === "done")
      : undefined) ??
    its[0]
  if (!item) return to.reveal(terminalId)
  to.land?.(item.id)
  to.showInbox()
  to.open(item.id)
}

// What the app icon's count wears on Windows, where the taskbar takes an image: a filled
// circle with the count, "9+" past nine, on a canvas of 32 px. Null where the page can't
// draw one.
export const drawBadge = (count: number): string | null => {
  try {
    const canvas = document.createElement("canvas")
    canvas.width = 32
    canvas.height = 32
    const context = canvas.getContext("2d")
    if (!context) return null
    context.fillStyle = "#e5484d"
    context.beginPath()
    context.arc(16, 16, 15, 0, Math.PI * 2)
    context.fill()
    context.strokeStyle = "#ffffff"
    context.lineWidth = 2
    context.stroke()
    context.fillStyle = "#ffffff"
    context.textAlign = "center"
    context.textBaseline = "middle"
    const text = count > 9 ? "9+" : String(count)
    context.font = `700 ${text.length > 1 ? 17 : 21}px sans-serif`
    context.fillText(text, 16, 17)
    return canvas.toDataURL("image/png")
  } catch {
    return null
  }
}

// An item by its id and when it began: a newer one under the same id is another.
export const keyOf = (item: InboxRow): string => `${item.id}@${item.at}`

const onWindows = (): boolean => navigator.platform.startsWith("Win")

// Follows the Inbox for what rings the person: each new item that needs them (what the bell
// counts) is handed to `ring` once, after `graceMs` and only if it still stands, and `ring`
// says whether it rang. A ringing item that then leaves the Inbox for `graceMs` is handed to
// `leave`: one that drops out of a recompute and comes back keeps its own ring. Items there
// when this starts, or that began well before it, are taken as seen, and one that leaves
// before it rings is new again if it comes back. `change` hears the items that wait on the
// person (the bell's, feedback drafts too) after every Inbox change. A doorbell (the OS ping, the toast) is a `ring` that
// takes an item only while its own case holds, which is how one item never rings two.
// Returns the stop.
export const followNeeds = (
  inbox: NeedsInbox,
  {
    graceMs,
    ring,
    leave,
    change,
  }: {
    graceMs: number
    ring: (item: InboxRow) => boolean
    leave: (item: InboxRow) => void
    change?: (waiting: readonly InboxRow[]) => void
  },
): (() => void) => {
  const startedAt = Date.now()
  const seen = new Set<string>()
  // The items whose ring stands, by key.
  const rung = new Map<string, InboxRow>()
  // The rung items gone from the Inbox, which leave once they've stayed gone for `graceMs`.
  const leaving = new Map<string, ReturnType<typeof setTimeout>>()
  // The grace each new item waits out, by key.
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const waitingKeys = (): Set<string> =>
    new Set(ringing(inbox.state.getSnapshot().items).map(keyOf))
  const sound = (key: string): void => {
    const item = ringing(inbox.state.getSnapshot().items).find((each) => keyOf(each) === key)
    if (!item || rung.has(key)) return
    if (ring(item)) rung.set(key, item)
  }
  const follow = (): void => {
    const waiting = ringing(inbox.state.getSnapshot().items)
    const keys = new Set(waiting.map(keyOf))
    for (const [key, item] of rung) {
      const timer = leaving.get(key)
      if (keys.has(key)) {
        if (timer !== undefined) clearTimeout(timer)
        leaving.delete(key)
      } else if (timer === undefined)
        leaving.set(
          key,
          setTimeout(() => {
            leaving.delete(key)
            if (waitingKeys().has(key)) return
            rung.delete(key)
            seen.delete(key)
            leave(item)
          }, graceMs),
        )
    }
    // One that left before it rang is new again if it comes back, its grace begun anew.
    for (const key of seen)
      if (!keys.has(key) && !rung.has(key)) {
        seen.delete(key)
        clearTimeout(timers.get(key))
        timers.delete(key)
      }
    for (const item of waiting) {
      const key = keyOf(item)
      if (seen.has(key)) continue
      seen.add(key)
      // One that began well before this started, as the Inbox fills in after launch, isn't
      // new; a request asked just before, whose dialog it waited on, is.
      if (item.at < startedAt - launchSlackMs) continue
      // One that arrived while the person looked at its terminal, and landed as they looked
      // away, they have already seen there.
      if (inbox.landedQuietly?.(item)) continue
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          sound(key)
        }, graceMs),
      )
    }
    // The count is the bell's: it holds a feedback draft, which rings nothing.
    change?.(needing(inbox.state.getSnapshot().items))
  }
  for (const item of ringing(inbox.state.getSnapshot().items)) seen.add(keyOf(item))
  follow()
  const stop = inbox.state.subscribe(follow)
  return () => {
    stop()
    timers.forEach(clearTimeout)
    leaving.forEach(clearTimeout)
  }
}

// Counts each new item that needs the person in `ui`'s `bellRings`, after the grace the toast
// and the OS ping wait (see `followNeeds`), so the Inbox's dot rings for it. Unlike them it
// rings whatever the person's focus, view or notification settings: it is the app's own quiet
// mark, there while they look. Returns the stop.
export const watchBellRings = (
  inbox: NeedsInbox,
  ui: UiStore,
  { graceMs = needGraceMs }: { graceMs?: number } = {},
): (() => void) =>
  followNeeds(inbox, {
    graceMs,
    ring: () => {
      ui.update((state) => ({ ...state, bellRings: state.bellRings + 1 }))
      return true
    },
    leave: () => {},
  })

// Follows the Inbox for the person who isn't looking at it. A new item that needs them
// pings once (see `followNeeds`), only if the page still hasn't their focus and the person
// wants them (`notifyNeeds`); an item that pinged and then leaves the Inbox takes its
// notification back. While the page has their focus a toast rings instead, in
// inbox-toasts.ts. An item whose toast waits behind a modal dialog there goes to whichever
// comes first: this ping if the person leaves the app with the dialog open, else the toast
// once it closes. The app icon's `badge` follows the bell's count, drawn as an image where
// `image` says the platform takes one, and clears when this stops. Returns the stop.
export const watchInboxPings = (
  inbox: NeedsInbox,
  ui: UiStore,
  {
    board,
    badge,
    graceMs = needGraceMs,
    image = onWindows() ? drawBadge : () => null,
    desktop = isDesktop,
  }: {
    board?: NoticeBoard | undefined
    badge?: Backend["badge"] | undefined
    graceMs?: number
    image?: (count: number) => string | null
    // Whether the window is wide enough for the resizable sidebar, as the shell asks.
    desktop?: () => boolean
  } = {},
): (() => void) => {
  let counted: number | undefined
  // The items that rang while the page was focused but a modal dialog covered it, so the toast
  // holds them: if the person leaves the app before the dialog closes they ping instead; if
  // the dialog closes with them there, the toast has them and these are forgotten.
  const deferred = new Map<string, InboxRow>()
  const ping = (item: InboxRow): void => board?.show(keyOf(item), needNotice(item), item.id)
  const handOver = (): void => {
    const state = ui.getSnapshot()
    if (deferred.size === 0 || (state.pageFocused && modalOpen(state))) return
    const standing = new Set(ringing(inbox.state.getSnapshot().items).map(keyOf))
    const items = [...deferred.values()]
    deferred.clear()
    if (state.pageFocused || !state.preferences.notifyNeeds) return
    for (const item of items) if (standing.has(keyOf(item))) ping(item)
  }
  const stopHanding = ui.subscribe(handOver)
  const stop = followNeeds(inbox, {
    graceMs,
    ring: (item) => {
      const state = ui.getSnapshot()
      if (!state.preferences.notifyNeeds || !board) return false
      if (state.pageFocused) {
        if (!heldForToast(state, desktop)) return false
        deferred.set(keyOf(item), item)
        return true
      }
      ping(item)
      return true
    },
    leave: (item) => {
      deferred.delete(keyOf(item))
      board?.close(keyOf(item), item.source.terminalId)
    },
    change: (waiting) => {
      const count = Math.min(waiting.length, maxBadge)
      if (!badge || counted === count) return
      counted = count
      badge({ count, image: count > 0 ? image(count) : null })
    },
  })
  return () => {
    stop()
    stopHanding()
    badge?.({ count: 0, image: null })
  }
}
