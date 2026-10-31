import {
  noticeBodyLength,
  noticeIdPattern,
  noticeTitleLength,
  type DesktopNotice,
} from "@novadeck/protocol/bridge"
import { defaultNoticeSound, noticeSoundOf, type NoticeSound } from "@novadeck/protocol/sounds"
import type { IpcMainEvent } from "electron"

import { noticeChannel, noticeCloseChannel } from "../../bridge.js"

// What a notice may not hold: control characters, and the bidirectional overrides and
// isolates that could make it read as something else.
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
const unsafe = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

const line = (value: unknown, length: number): value is string =>
  typeof value === "string" && value.length <= length && !unsafe.test(value)

/**
 * The page's notice when it is one, or undefined. The page is not trusted with more: a
 * terminal id, and a title and body each one line of plain text within its length, the
 * title not empty, `silent`, when there, a boolean, and `sound`, when it is the id of one of
 * `noticeSounds`; nothing else of the value passes. A sound that is not one is dropped, not
 * the notice, which then plays the default.
 */
export const desktopNoticeOf = (value: unknown): DesktopNotice | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { id, title, body, silent, sound } = value as Record<string, unknown>
  if (typeof id !== "string" || !noticeIdPattern.test(id)) return undefined
  if (!line(title, noticeTitleLength) || !title.trim()) return undefined
  if (!line(body, noticeBodyLength)) return undefined
  if (silent !== undefined && typeof silent !== "boolean") return undefined
  const named = noticeSoundOf(sound)
  return {
    id,
    title,
    body,
    ...(silent === undefined ? {} : { silent }),
    ...(named === undefined ? {} : { sound: named }),
  }
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

/** What Electron's `Notification` takes to show a notice. */
type NotificationOptions = {
  readonly title: string
  readonly body: string
  readonly silent?: true
  readonly sound?: string
}

/**
 * The bundled file macOS plays for a notice's sound, by name in the app's resources:
 * `<id>.wav` of an id in `noticeSounds`, never built from the page's string.
 * electron-builder.yml copies the files in.
 */
export const noticeSoundFile = (sound: unknown): string =>
  `${noticeSoundOf(sound) ?? defaultNoticeSound}.wav`

/**
 * A notice as Electron's `Notification` takes it. The app plays its own sound where it can,
 * so the notification is silent, but on macOS the page cannot tell whether Focus holds
 * notifications back and the system can: there the notification plays the bundled sound,
 * which Focus mutes, unless the person turned the sound off (`silent`). The sound is the
 * one the notice names, the person's choice or else the theme's.
 */
export const notificationOptions = (
  notice: {
    readonly title: string
    readonly body: string
    readonly silent: boolean
    readonly sound?: NoticeSound | undefined
  },
  platform: NodeJS.Platform,
): NotificationOptions => {
  const text = notificationText(notice, platform)
  return platform === "darwin" && !notice.silent
    ? { ...text, sound: noticeSoundFile(notice.sound) }
    : { ...text, silent: true }
}

/** What showing a notification takes of Electron's `Notification`. */
export type NotificationLike = {
  on(event: "click", listener: () => void): unknown
  on(event: "close", listener: (details?: { readonly reason?: string }) => void): unknown
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
  readonly create: (notice: {
    readonly title: string
    readonly body: string
    readonly silent: boolean
    readonly sound?: NoticeSound | undefined
  }) => NotificationLike
  readonly clicked: (window: Window, id: string) => void
}): {
  readonly show: (window: Window, notice: DesktopNotice) => void
  readonly close: (id: string) => void
  readonly closeAll: () => void
} => {
  const showing = new Map<string, NotificationLike>()
  const show = (window: Window, { id, title, body, silent, sound }: DesktopNotice): void => {
    if (!supported) return
    showing.get(id)?.close()
    const notification = create({ title, body, silent: silent === true, sound })
    const forget = (): void => {
      if (showing.get(id) === notification) showing.delete(id)
    }
    notification.on("click", () => {
      forget()
      clicked(window, id)
    })
    // A notification whose toast timed out, on Windows, waits on in the Action Center,
    // where only its object can still take it away: it is kept.
    notification.on("close", (details) => {
      if (details?.reason !== "timedOut") forget()
    })
    showing.set(id, notification)
    notification.show()
  }
  const close = (id: string): void => {
    const notification = showing.get(id)
    showing.delete(id)
    notification?.close()
  }
  // What a page that went away showed: no page is left to take it back.
  const closeAll = (): void => {
    for (const id of showing.keys()) close(id)
  }
  return { show, close, closeAll }
}
