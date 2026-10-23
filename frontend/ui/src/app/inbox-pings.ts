import { handleText } from "@novadeck/core/handle"
import type { Inbox, InboxItem } from "@novadeck/core/inbox"
import type { Backend, Notice } from "@novadeck/core/port"

import { needing } from "../inbox/inbox-state"
import { fromNovadeck, labelOf, subjectOf } from "../inbox/inbox-text"
import type { UiStore } from "./ui-store"

// How long a new item that needs the person waits before it pings: one the person or the
// agent settles in that time never does. (A permission request has already waited its own
// 3 s before it becomes an item.)
export const needGraceMs = 2000

// The most the icon's count says; the host takes 0 to 999.
const maxBadge = 999

// The notifications Novadeck has shown, so that one source takes its own back and no
// other's: a terminal has one notification at a time, a newer one replacing it, and what
// cleared when an Inbox item left must not close the finish notice that came after it.
export type NoticeBoard = {
  // Shows a notice for `owner`, replacing whatever its terminal showed.
  readonly show: (owner: string, notice: Notice) => void
  // Closes the terminal's notification if `owner`'s is still the latest.
  readonly close: (owner: string, terminalId: string) => void
}

export const noticeBoard = (notices: Backend["notices"]): NoticeBoard | undefined => {
  if (!notices) return undefined
  const latest = new Map<string, string>()
  return {
    show: (owner, notice) => {
      latest.set(notice.id, owner)
      notices.show(notice)
    },
    close: (owner, terminalId) => {
      if (latest.get(terminalId) !== owner) return
      latest.delete(terminalId)
      notices.close?.(terminalId)
    },
  }
}

// What a desktop notification says of an item that needs the person: the Inbox row's own
// byline as the title, led by who it is from as a finish notice's is ("@moth asks you:
// Checkout"; Novadeck's own items are its own), and its subject, a command included, as the
// body.
export const needNotice = (item: InboxItem): Notice => {
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

// What a click on a terminal's notification does: the Inbox opens on that terminal's item
// when it has one standing, else the terminal shows, as a click on a finish notice has always
// done.
export const clickNotice = (
  terminalId: string,
  items: readonly InboxItem[],
  to: {
    readonly open: (id: string) => void
    readonly showInbox: () => void
    readonly reveal: (terminalId: string) => void
  },
): void => {
  const item = items.find(({ source }) => source.terminalId === terminalId)
  if (!item) return to.reveal(terminalId)
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
const keyOf = (item: InboxItem): string => `${item.id}@${item.at}`

const onWindows = (): boolean => navigator.platform.startsWith("Win")

// Follows the Inbox for the person who isn't looking at it. A new item that needs them (what
// the bell counts) pings once, after `graceMs` and only if it still stands and the page
// still hasn't their focus, where they want it (`notifyNeeds`); an item that pinged and then
// leaves the Inbox takes its notification back. Items there when this starts, or that began
// before it, are taken as seen. The app icon's `badge` follows the bell's count, drawn as an image where `image`
// says the platform takes one, and clears when this stops. Returns the stop.
export const watchInboxPings = (
  inbox: Pick<Inbox, "state">,
  ui: UiStore,
  {
    board,
    badge,
    graceMs = needGraceMs,
    image = onWindows() ? drawBadge : () => null,
  }: {
    board?: NoticeBoard | undefined
    badge?: Backend["badge"] | undefined
    graceMs?: number
    image?: (count: number) => string | null
  } = {},
): (() => void) => {
  const startedAt = Date.now()
  const seen = new Set<string>()
  // The items whose ping stands, by key, with their terminal.
  const pinged = new Map<string, string>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let counted: number | undefined
  const ping = (key: string): void => {
    const item = needing(inbox.state.getSnapshot().items).find((each) => keyOf(each) === key)
    const { pageFocused, preferences } = ui.getSnapshot()
    if (!item || pageFocused || !preferences.notifyNeeds || !board) return
    board.show(key, needNotice(item))
    pinged.set(key, item.source.terminalId)
  }
  const follow = (): void => {
    const waiting = needing(inbox.state.getSnapshot().items)
    const count = Math.min(waiting.length, maxBadge)
    const keys = new Set(waiting.map(keyOf))
    for (const [key, terminalId] of pinged)
      if (!keys.has(key)) {
        pinged.delete(key)
        board?.close(key, terminalId)
      }
    for (const item of waiting) {
      const key = keyOf(item)
      if (seen.has(key)) continue
      seen.add(key)
      // One that began before this started, as the Inbox fills in after launch, isn't new.
      if (item.at < startedAt) continue
      const timer = setTimeout(() => {
        timers.delete(timer)
        ping(key)
      }, graceMs)
      timers.add(timer)
    }
    if (badge && counted !== count) {
      counted = count
      badge({ count, image: count > 0 ? image(count) : null })
    }
  }
  for (const item of needing(inbox.state.getSnapshot().items)) seen.add(keyOf(item))
  follow()
  const stop = inbox.state.subscribe(follow)
  return () => {
    stop()
    timers.forEach(clearTimeout)
    badge?.({ count: 0, image: null })
  }
}
