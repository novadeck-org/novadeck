import { entryKey, type Inbox, type InboxEntry } from "@novadeck/core/inbox"
import type { Backend, Notice } from "@novadeck/core/port"
import { handleText } from "@novadeck/core/terminals/handle"

import { needing } from "../inbox/inbox-state"
import { fromNovadeck, labelOf, subjectOf } from "../inbox/inbox-text"
import { isDesktop } from "../shell/desktop"
import type { Ding } from "./ding"
import type { LandedInbox } from "./inbox-landing"
import { heldForToast, modalOpen } from "./selectors"
import type { UiStore } from "./ui-store"

// The Inbox these follow: the landed one, which knows what landed quietly, or any with a state.
export type NeedsInbox = Pick<Inbox, "state"> & Partial<Pick<LandedInbox, "landedQuietly">>

// How long a new entry that needs the person waits before it pings: one the person or the
// agent settles in that time never does. (A permission request has already waited its own
// 3 s before it becomes an entry.)
export const needGraceMs = 2000

// How long before this started an entry may have begun and still be new: a request becomes
// an entry only once its dialog shows, a few seconds after it was asked.
const launchSlackMs = 5000

// The most the icon's count says; the desktop app takes 0 to 999.
const maxBadge = 999

// The notifications Novadeck has shown, so that one source takes its own back and no
// other's: a terminal has one notification at a time, a newer one replacing it, and what
// cleared when an Inbox entry left must not close the finish notice that came after it.
export type NoticeBoard = {
  // Shows a notice for `owner`, replacing whatever its terminal showed. `entryId` is the Inbox
  // entry the notice is about, if it is about one.
  readonly show: (owner: string, notice: Notice, entryId?: string) => void
  // Closes the terminal's notification if `owner`'s is still the latest.
  readonly close: (owner: string, terminalId: string) => void
  // The entry the terminal's latest notification is about, for a click on it to open.
  readonly entryIdOf: (terminalId: string) => string | undefined
}

// A backend's board is the one: what rings notices and what hears their clicks share it. The
// `ding` it sounds with each notice is the first caller's (a notice's id is its terminal's).
const boards = new WeakMap<object, NoticeBoard>()

export const noticeBoard = (notices: Backend["notices"], ding: Ding): NoticeBoard | undefined => {
  if (!notices) return undefined
  const known = boards.get(notices)
  if (known) return known
  const latest = new Map<string, { owner: string; entryId: string | undefined }>()
  const board: NoticeBoard = {
    show: (owner, notice, entryId) => {
      latest.set(notice.id, { owner, entryId })
      if (notices.sounds) {
        // The desktop app's own notification plays the sound, so only a notice the ding lets
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
    entryIdOf: (terminalId) => latest.get(terminalId)?.entryId,
  }
  boards.set(notices, board)
  return board
}

// What a desktop notification says of an entry that needs the person: the Inbox entry's own
// byline as the title, led by who it is from as a finish notice's is ("@moth asks you:
// Checkout"; Novadeck's own entries are its own), and its subject, a command included, as the
// body.
export const needNotice = (entry: InboxEntry): Notice => {
  const { handle, title, terminalId } = entry.source
  const label = labelOf(entry)
  const what = label.charAt(0).toLowerCase() + label.slice(1)
  return {
    id: terminalId,
    title: fromNovadeck(entry)
      ? `${label}: ${title}`
      : handle
        ? `${handleText(handle)} ${what}: ${title}`
        : `${title} ${what}`,
    body: subjectOf(entry).replaceAll("`", ""),
  }
}

// The entry a notification about a terminal stands for: the one it names (`entryId`) if it still
// stands; without one, or once it has gone, the terminal's done report, else its first entry.
export const entryOfNotice = (
  terminalId: string,
  entries: readonly InboxEntry[],
  entryId?: string,
): InboxEntry | undefined => {
  const onTerminal = entries.filter(
    ({ source, settled }) => source.terminalId === terminalId && !settled,
  )
  return (
    onTerminal.find(({ id }) => id === entryId) ??
    (entryId === undefined
      ? onTerminal.find((each) => each.kind === "update" && each.update.type === "done")
      : undefined) ??
    onTerminal[0]
  )
}

// What a click on a terminal's notification does: the Inbox opens on the entry the notice was
// about (`entryId`) if it still stands (a notice names its entry); without one, or once it
// has gone, the terminal's done report, else its first entry, and the terminal itself when it
// has none. `entries` are the backend's own, as the Inbox may hold the entry back.
export const clickNotice = (
  terminalId: string,
  entries: readonly InboxEntry[],
  to: {
    // Opens the entry's sheet for that entry alone (see the Inbox's `OpenOptions`).
    readonly open: (id: string, after: (() => void) | undefined) => void
    // Shows the Inbox for the entry; returns what puts the sidebar back, unless it showed already.
    readonly peekInbox: () => (() => void) | undefined
    readonly reveal: (terminalId: string) => void
  },
  entryId?: string,
): void => {
  const entry = entryOfNotice(terminalId, entries, entryId)
  if (!entry) return to.reveal(terminalId)
  to.open(entry.id, to.peekInbox())
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

const onWindows = (): boolean => navigator.platform.startsWith("Win")

// Follows the Inbox for what rings the person: each new entry that needs them (what the bell
// counts) is handed to `ring` once, after `graceMs` and only if it still stands, and `ring`
// says whether it rang. A ringing entry that then leaves the Inbox for `graceMs` is handed to
// `leave`: one that drops out of a recompute and comes back keeps its own ring. Entries there
// when this starts, or that began well before it, are taken as seen, and one that leaves
// before it rings is new again if it comes back. `change` hears the entries that wait on the
// person (the bell's) after every Inbox change. A doorbell (the OS ping, the toast) is a `ring` that
// takes an entry only while its own case holds, which is how one entry never rings two.
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
    ring: (entry: InboxEntry) => boolean
    leave: (entry: InboxEntry) => void
    change?: (waiting: readonly InboxEntry[]) => void
  },
): (() => void) => {
  const startedAt = Date.now()
  const seen = new Set<string>()
  // The entries whose ring stands, by key.
  const rung = new Map<string, InboxEntry>()
  // The rung entries gone from the Inbox, which leave once they've stayed gone for `graceMs`.
  const leaving = new Map<string, ReturnType<typeof setTimeout>>()
  // The grace each new entry waits out, by key.
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const waitingKeys = (): Set<string> =>
    new Set(needing(inbox.state.getSnapshot().items).map(entryKey))
  // What the person snoozed is no longer rung, but stays seen: brought back, it is no news.
  const snoozedKeys = (): Set<string> =>
    new Set(
      inbox.state
        .getSnapshot()
        .items.filter((entry) => entry.snoozed)
        .map(entryKey),
    )
  const sound = (key: string): void => {
    const entry = needing(inbox.state.getSnapshot().items).find((each) => entryKey(each) === key)
    if (!entry || rung.has(key)) return
    if (ring(entry)) rung.set(key, entry)
  }
  const follow = (): void => {
    const waiting = needing(inbox.state.getSnapshot().items)
    const keys = new Set(waiting.map(entryKey))
    for (const [key, entry] of rung) {
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
            if (!snoozedKeys().has(key)) seen.delete(key)
            leave(entry)
          }, graceMs),
        )
    }
    // One that left before it rang is new again if it comes back, its grace begun anew;
    // one snoozed is still seen.
    const sleeping = snoozedKeys()
    for (const key of seen)
      if (!keys.has(key) && !rung.has(key) && !sleeping.has(key)) {
        seen.delete(key)
        clearTimeout(timers.get(key))
        timers.delete(key)
      }
    for (const entry of waiting) {
      const key = entryKey(entry)
      if (seen.has(key)) continue
      seen.add(key)
      // One that began well before this started, as the Inbox fills in after launch, isn't
      // new; a request asked just before, whose dialog it waited on, is.
      if (entry.at < startedAt - launchSlackMs) continue
      // One that landed while the person looked at its terminal they have already seen there.
      if (inbox.landedQuietly?.(entry)) continue
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          sound(key)
        }, graceMs),
      )
    }
    // The count is the bell's.
    change?.(needing(inbox.state.getSnapshot().items))
  }
  for (const entry of needing(inbox.state.getSnapshot().items)) seen.add(entryKey(entry))
  follow()
  const stop = inbox.state.subscribe(follow)
  return () => {
    stop()
    timers.forEach(clearTimeout)
    leaving.forEach(clearTimeout)
  }
}

// Counts each new entry that needs the person in `ui`'s `bellRings`, after the grace the toast
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

// Follows the Inbox for the person who isn't looking at it. A new entry that needs them
// pings once (see `followNeeds`), only if the page still hasn't their focus and the person
// wants them (`notifyNeeds`); an entry that pinged and then leaves the Inbox takes its
// notification back. While the page has their focus a toast rings instead, in
// inbox-toasts.ts. An entry whose toast waits behind a modal dialog there goes to whichever
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
  // The entries that rang while the page was focused but a modal dialog covered it, so the toast
  // holds them: if the person leaves the app before the dialog closes they ping instead; if
  // the dialog closes with them there, the toast has them and these are forgotten.
  const deferred = new Map<string, InboxEntry>()
  const ping = (entry: InboxEntry): void =>
    board?.show(entryKey(entry), needNotice(entry), entry.id)
  const handOver = (): void => {
    const state = ui.getSnapshot()
    if (deferred.size === 0 || (state.pageFocused && modalOpen(state))) return
    const standing = new Set(needing(inbox.state.getSnapshot().items).map(entryKey))
    const entries = [...deferred.values()]
    deferred.clear()
    if (state.pageFocused || !state.preferences.notifyNeeds) return
    for (const entry of entries) if (standing.has(entryKey(entry))) ping(entry)
  }
  const stopHanding = ui.subscribe(handOver)
  const stop = followNeeds(inbox, {
    graceMs,
    ring: (entry) => {
      const state = ui.getSnapshot()
      if (!state.preferences.notifyNeeds || !board) return false
      if (state.pageFocused) {
        if (!heldForToast(state, desktop)) return false
        deferred.set(entryKey(entry), entry)
        return true
      }
      ping(entry)
      return true
    },
    leave: (entry) => {
      deferred.delete(entryKey(entry))
      board?.close(entryKey(entry), entry.source.terminalId)
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
