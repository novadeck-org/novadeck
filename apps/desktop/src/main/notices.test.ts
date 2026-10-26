import { EventEmitter } from "node:events"

import type { IpcMainEvent } from "electron"

import { noticeChannel, noticeCloseChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import {
  desktopNoticeOf,
  noticeSoundFile,
  notificationOptions,
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
    expect(desktopNoticeOf({ ...notice, icon: "/etc/passwd", sound: "x" })).toEqual(notice)
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
        { ...notice, silent: "yes" },
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
  const closed: string[] = []
  registerNoticeIpc(
    { on: (channel, listener) => void listeners.set(channel, listener) },
    {
      window: () => (own ? "window" : undefined),
      show: (window, value) => void shown.push([window, value]),
      close: (id) => void closed.push(id),
    },
  )
  const send = (value: unknown): void => listeners.get(noticeChannel)?.({} as IpcMainEvent, value)
  const close = (value: unknown): void =>
    listeners.get(noticeCloseChannel)?.({} as IpcMainEvent, value)
  return { send, close, shown, closed }
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

describe("taking the page's requests to close a notice", () => {
  it("closes by a valid terminal id", () => {
    const { close, closed } = registered(true)
    close("t1")
    expect(closed).toEqual(["t1"])
  })

  it("drops anything but a terminal id", () => {
    const { close, closed } = registered(true)
    for (const value of [undefined, 1, { id: "t1" }, "", "../x", "x".repeat(65)]) close(value)
    expect(closed).toEqual([])
  })

  it("drops a request from any other sender", () => {
    const { close, closed } = registered(false)
    close("t1")
    expect(closed).toEqual([])
  })
})

// Electron's Notification as showing uses it: what it was made with, shown, closed.
class FakeNotification extends EventEmitter implements NotificationLike {
  shown = false
  closed = false
  constructor(
    readonly options: {
      readonly title: string
      readonly body: string
      readonly silent: boolean
      readonly sound?: string | undefined
    },
  ) {
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
  const { show, close, closeAll } = showNotices<string>({
    supported,
    create: (options) => {
      const notification = new FakeNotification(options)
      made.push(notification)
      return notification
    },
    clicked: (window, id) => void clicks.push([window, id]),
  })
  return { show, close, closeAll, made, clicks }
}

describe("showing notices as the system's notifications", () => {
  it("shows one with the notice's title and body", () => {
    const { show, made } = notifying()
    show("window", { ...notice, body: "All green." })
    expect(made.map(({ options, shown }) => ({ ...options, shown }))).toEqual([
      { title: "t1 is done: Tests", body: "All green.", silent: false, shown: true },
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

  it("closes the one showing for a terminal by its id, and forgets it", () => {
    const { show, close, made } = notifying()
    show("window", notice)
    show("window", { ...notice, id: "other" })
    close(notice.id)
    close(notice.id)
    close("unknown")
    expect(made.map(({ closed }) => closed)).toEqual([true, false])
    show("window", notice)
    expect(made.map(({ closed }) => closed)).toEqual([true, false, false])
  })

  it("keeps one whose toast timed out, so it can still be taken away", () => {
    const { show, close, made } = notifying()
    show("window", notice)
    made[0]!.emit("close", { reason: "timedOut" })
    close(notice.id)
    expect(made[0]!.closed).toBe(true)
  })

  it("forgets one the person dismissed", () => {
    const { show, close, made } = notifying()
    show("window", notice)
    made[0]!.emit("close", { reason: "userCanceled" })
    made[0]!.closed = false
    close(notice.id)
    expect(made[0]!.closed).toBe(false)
  })

  it("closes every one still showing, as when the page that showed them goes", () => {
    const { show, closeAll, made } = notifying()
    show("window", notice)
    show("window", { ...notice, id: "other" })
    made[1]!.emit("click")
    closeAll()
    expect(made.map(({ closed }) => closed)).toEqual([true, false])
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

describe("a notice's sound", () => {
  it("passes when it names a sound the app has", () => {
    expect(desktopNoticeOf({ ...notice, sound: "afterglow" })).toEqual({
      ...notice,
      sound: "afterglow",
    })
    expect(desktopNoticeOf({ ...notice, silent: true, sound: "felt" })).toEqual({
      ...notice,
      silent: true,
      sound: "felt",
    })
  })

  it("is dropped, the notice staying, when it names anything else", () => {
    for (const sound of ["ding", "../afterglow", "AFTERGLOW", "graphite", "toString", 1, null, {}])
      expect(desktopNoticeOf({ ...notice, sound })).toEqual(notice)
  })

  it("reaches the notification", () => {
    const made: unknown[] = []
    const { show } = showNotices<string>({
      supported: true,
      create: (options) => {
        made.push(options)
        return new FakeNotification(options)
      },
      clicked: () => {},
    })
    show("window", { ...notice, sound: "afterglow" })
    expect(made).toEqual([{ title: notice.title, body: "", silent: false, sound: "afterglow" }])
  })
})

describe("a notice's silent flag", () => {
  it("passes when it is a boolean", () => {
    expect(desktopNoticeOf({ ...notice, silent: true })).toEqual({ ...notice, silent: true })
    expect(desktopNoticeOf({ ...notice, silent: false })).toEqual({ ...notice, silent: false })
  })

  it("reaches the notification the person turned the sound off for", () => {
    const made: unknown[] = []
    const { show } = showNotices<string>({
      supported: true,
      create: (options) => {
        made.push(options)
        return new FakeNotification(options)
      },
      clicked: () => {},
    })
    show("window", { ...notice, silent: true })
    expect(made).toEqual([{ title: notice.title, body: "", silent: true }])
  })
})

describe("a notice as Electron's notification", () => {
  const text = { title: "t1 is done", body: "All green.", silent: false }

  it("is silent where the app plays its own sound", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(notificationOptions(text, platform)).toEqual({
        title: "t1 is done",
        body: "All green.",
        silent: true,
      })
    }
  })

  it("plays the bundled sound on macOS, so Focus mutes it", () => {
    expect(notificationOptions(text, "darwin")).toEqual({
      title: "t1 is done",
      body: "All green.",
      sound: "felt.wav",
    })
  })

  it("plays the sound the notice names on macOS, the default's for none or one it lacks", () => {
    const sound = (named?: unknown) =>
      notificationOptions(
        { ...text, ...(named === undefined ? {} : { sound: named as never }) },
        "darwin",
      ).sound
    for (const id of ["felt", "afterglow", "settle", "beam"]) expect(sound(id)).toBe(`${id}.wav`)
    expect(sound()).toBe("felt.wav")
    expect(sound("../../etc/passwd")).toBe("felt.wav")
    expect(sound("toString")).toBe("felt.wav")
    expect(noticeSoundFile(undefined)).toBe("felt.wav")
  })

  it("stays silent on macOS when the person turned the sound off", () => {
    expect(notificationOptions({ ...text, silent: true }, "darwin")).toEqual({
      title: "t1 is done",
      body: "All green.",
      silent: true,
    })
  })
})
