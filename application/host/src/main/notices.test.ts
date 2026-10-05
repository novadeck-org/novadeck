import { EventEmitter } from "node:events"

import type { IpcMainEvent } from "electron"

import { noticeChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import {
  desktopNoticeOf,
  notificationText,
  registerNoticeIpc,
  showNotices,
  type NotificationLike,
} from "./notices"

const notice = { id: "3f2a9c1e-0000-4000-8000-000000000001", title: "t1 is done: Tests", body: "" }

describe("a notice from the page", () => {
  it("passes with a terminal id and one line each of title and body", () => {
    expect(desktopNoticeOf({ ...notice, body: "All green." })).toEqual({
      ...notice,
      body: "All green.",
    })
  })

  it("passes nothing else the page sent", () => {
    expect(desktopNoticeOf({ ...notice, icon: "/etc/passwd", silent: true })).toEqual(notice)
  })

  context("when it is not one", () => {
    it("is refused", () => {
      for (const value of [
        undefined,
        null,
        "t1 is done",
        { ...notice, id: "../../etc" },
        { ...notice, id: "" },
        { ...notice, id: "x".repeat(65) },
        { ...notice, id: 1 },
        { ...notice, title: "" },
        { ...notice, title: "  " },
        { ...notice, title: "x".repeat(257) },
        { ...notice, title: "two\nlines" },
        { ...notice, title: "\u202eevil" },
        { ...notice, body: "letter\u061cmark" },
        { ...notice, body: "x".repeat(121) },
        { ...notice, body: "bell\u0007" },
        { ...notice, body: null },
      ])
        expect(desktopNoticeOf(value)).toBeUndefined()
    })
  })
})

// The notice handler registered on a stand-in for ipcMain, for a page that is the app's
// own or not.
const registered = (own: boolean) => {
  const listeners = new Map<string, (event: IpcMainEvent, value: unknown) => void>()
  const shown: [string, unknown][] = []
  registerNoticeIpc(
    { on: (channel, listener) => void listeners.set(channel, listener) },
    {
      window: () => (own ? "window" : undefined),
      show: (window, value) => void shown.push([window, value]),
    },
  )
  const send = (value: unknown): void => listeners.get(noticeChannel)?.({} as IpcMainEvent, value)
  return { send, shown }
}

describe("taking the page's notices", () => {
  it("shows a valid notice for the window it came from", () => {
    const { send, shown } = registered(true)
    send(notice)
    expect(shown).toEqual([["window", notice]])
  })

  it("drops an invalid notice", () => {
    const { send, shown } = registered(true)
    send({ ...notice, title: "<script>\n" })
    expect(shown).toEqual([])
  })

  it("drops a notice from any other sender", () => {
    const { send, shown } = registered(false)
    send(notice)
    expect(shown).toEqual([])
  })
})

// Electron's Notification as showing uses it: what it was made with, shown, closed.
class FakeNotification extends EventEmitter implements NotificationLike {
  shown = false
  closed = false
  constructor(readonly options: { readonly title: string; readonly body: string }) {
    super()
  }
  show(): void {
    this.shown = true
  }
  close(): void {
    this.closed = true
    this.emit("close")
  }
}

const notifying = (supported = true) => {
  const made: FakeNotification[] = []
  const clicks: [string, string][] = []
  const show = showNotices<string>({
    supported,
    create: (options) => {
      const notification = new FakeNotification(options)
      made.push(notification)
      return notification
    },
    clicked: (window, id) => void clicks.push([window, id]),
  })
  return { show, made, clicks }
}

describe("showing notices as the system's notifications", () => {
  it("shows one with the notice's title and body", () => {
    const { show, made } = notifying()
    show("window", { ...notice, body: "All green." })
    expect(made.map(({ options, shown }) => ({ ...options, shown }))).toEqual([
      { title: "t1 is done: Tests", body: "All green.", shown: true },
    ])
  })

  it("replaces the one still showing for the same terminal, and leaves others", () => {
    const { show, made } = notifying()
    show("window", notice)
    show("window", { ...notice, id: "other" })
    show("window", { ...notice, body: "Again." })
    expect(made.map(({ closed }) => closed)).toEqual([true, false, false])
  })

  it("brings the window it came from to the page with the terminal's id once clicked", () => {
    const { show, made, clicks } = notifying()
    show("window", notice)
    made[0]!.emit("click")
    expect(clicks).toEqual([["window", notice.id]])
  })

  it("shows none where the system has none", () => {
    const { show, made } = notifying(false)
    show("window", notice)
    expect(made).toEqual([])
  })
})

describe("a notification's text", () => {
  const markup = {
    title: "t1 is done: <b>Spoof</b>",
    body: 'x <b>b</b> <a href="https://e.test">l</a> & y',
  }

  it("escapes the body's markup on Linux, whose notification server may read it", () => {
    expect(notificationText(markup, "linux")).toEqual({
      title: "t1 is done: <b>Spoof</b>",
      body: 'x &lt;b&gt;b&lt;/b&gt; &lt;a href="https://e.test"&gt;l&lt;/a&gt; &amp; y',
    })
  })

  it("leaves it as it is elsewhere, where it is plain text", () => {
    expect(notificationText(markup, "darwin")).toEqual(markup)
    expect(notificationText(markup, "win32")).toEqual(markup)
  })
})
