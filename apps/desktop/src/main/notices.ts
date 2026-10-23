import {
  noticeBodyLength,
  noticeIdPattern,
  noticeTitleLength,
  type DesktopNotice,
} from "@novadeck/protocol/bridge"
import type { IpcMainEvent } from "electron"

import { noticeChannel, noticeCloseChannel } from "../bridge.js"

// What a notice may not hold: control characters, and the bidirectional overrides and
// isolates that could make it read as something else.
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
const unsafe = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

const line = (value: unknown, length: number): value is string =>
  typeof value === "string" && value.length <= length && !unsafe.test(value)

/**
 * The page's notice when it is one, or undefined. The page is not trusted with more: a
 * terminal id, and a title and body each one line of plain text within its length, the
 * title not empty; nothing else of the value passes.
 */
export const desktopNoticeOf = (value: unknown): DesktopNotice | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { id, title, body } = value as Record<string, unknown>
  if (typeof id !== "string" || !noticeIdPattern.test(id)) return undefined
  if (!line(title, noticeTitleLength) || !title.trim()) return undefined
  if (!line(body, noticeBodyLength)) return undefined
  return { id, title, body }
}

type NoticeIpc = {
  on(channel: string, listener: (event: IpcMainEvent, value: unknown) => void): unknown
}

/**
 * Shows the page's notices, and takes one away by its terminal's id. `window` names the
 * window of a request from the app's own page, or undefined for any other sender, whose
 * requests are dropped, as are notices and ids that are not valid.
 */
export const registerNoticeIpc = <Window>(
  ipc: NoticeIpc,
  {
    window,
    show,
    close,
  }: {
    readonly window: (event: IpcMainEvent) => Window | undefined
    readonly show: (window: Window, notice: DesktopNotice) => void
    readonly close: (id: string) => void
  },
): void => {
  ipc.on(noticeChannel, (event, value) => {
    const target = window(event)
    const notice = desktopNoticeOf(value)
    if (target === undefined || !notice) return
    show(target, notice)
  })
  ipc.on(noticeCloseChannel, (event, value) => {
    if (window(event) === undefined) return
    if (typeof value === "string" && noticeIdPattern.test(value)) close(value)
  })
}

/**
 * A notice as the system's notification takes it. On Linux Electron hands the body to the
 * desktop's notification server as it is, and the server may read it as markup
 * (`body-markup`, `body-hyperlinks`), so `&`, `<` and `>` there are escaped and it shows
 * the text it was given; the title, the summary, is plain text everywhere, as the body is
 * on macOS and Windows.
 */
export const notificationText = (
  { title, body }: { readonly title: string; readonly body: string },
  platform: NodeJS.Platform,
): { readonly title: string; readonly body: string } => ({
  title,
  body:
    platform === "linux"
      ? body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      : body,
})

/** What showing a notification takes of Electron's `Notification`. */
export type NotificationLike = {
  on(event: "click" | "close", listener: () => void): unknown
  show(): void
  close(): void
}

/**
 * Shows notices as the system's notifications: one per terminal at a time, a newer one
 * replacing the one still showing. Each is kept until it is clicked or closed, as some
 * systems drop a notification's clicks once nothing holds it. A click calls `clicked`
 * with the window it came from and the terminal's id. Returns `show`, a no-op where the
 * system shows none. `close` of a terminal's id takes away the one still showing for it,
 * and does nothing when none shows.
 */
export const showNotices = <Window>({
  supported,
  create,
  clicked,
}: {
  readonly supported: boolean
  readonly create: (notice: { readonly title: string; readonly body: string }) => NotificationLike
  readonly clicked: (window: Window, id: string) => void
}): {
  readonly show: (window: Window, notice: DesktopNotice) => void
  readonly close: (id: string) => void
} => {
  const showing = new Map<string, NotificationLike>()
  const show = (window: Window, { id, title, body }: DesktopNotice): void => {
    if (!supported) return
    showing.get(id)?.close()
    const notification = create({ title, body })
    const forget = (): void => {
      if (showing.get(id) === notification) showing.delete(id)
    }
    notification.on("click", () => {
      forget()
      clicked(window, id)
    })
    notification.on("close", forget)
    showing.set(id, notification)
    notification.show()
  }
  const close = (id: string): void => {
    const notification = showing.get(id)
    showing.delete(id)
    notification?.close()
  }
  return { show, close }
}
