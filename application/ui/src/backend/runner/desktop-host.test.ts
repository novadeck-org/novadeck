import type { DesktopHost, DesktopNotice } from "@novadeck/protocol/bridge"

import { context, describe, expect, it } from "../../test"
import { desktopNotices, desktopUpdates, hostNotice, noticeText } from "./desktop-host"

// A host's notification bridge that records what the page shows, and lets a test click.
const host = () => {
  const shown: DesktopNotice[] = []
  let clicked: ((id: string) => void) | undefined
  const bridge = {
    showNotice: (notice: DesktopNotice) => void shown.push(notice),
    onNoticeClick: (listener: (id: string) => void) => {
      clicked = listener
      return () => {
        clicked = undefined
      }
    },
  } as unknown as DesktopHost
  return { bridge, shown, click: (id: unknown) => clicked?.(id as string) }
}

describe("a notice's text", () => {
  it("is one line without control characters", () => {
    expect(noticeText("t1 is done:\n\u202eCheckout\u0007", 256)).toBe("t1 is done: Checkout")
    expect(noticeText("a\u061cb", 256)).toBe("a b")
  })

  it("is cut to its length with an ellipsis, never inside a character", () => {
    expect(noticeText("abcdef", 4)).toBe("abc…")
    expect(noticeText(`ab${"😀"}cd`, 4)).toBe("ab…")
  })
})

describe("a notice for the host", () => {
  it("passes for a terminal id, bounded", () => {
    const notice = hostNotice({ id: "3f2a-01", title: "t1 is done", body: "x".repeat(500) })
    expect(notice?.body).toHaveLength(120)
  })

  it("is dropped for an id that is no terminal's, or with nothing to say", () => {
    expect(hostNotice({ id: "../evil", title: "t1 is done", body: "" })).toBeUndefined()
    expect(hostNotice({ id: "01", title: "\n", body: "Done." })).toBeUndefined()
  })
})

describe("desktop notices", () => {
  context("in a host that has them", () => {
    it("shows what passes and hears clicks that name a terminal", () => {
      const { bridge, shown, click } = host()
      const notices = desktopNotices(bridge)!
      notices.show({ id: "01", title: "t1 is done: Tests", body: "All green." })
      notices.show({ id: "bad id", title: "t1 is done", body: "" })
      expect(shown).toEqual([{ id: "01", title: "t1 is done: Tests", body: "All green." }])
      const clicks: string[] = []
      const stop = notices.onClick((id) => clicks.push(id))
      click("01")
      click({ id: "01" })
      click("../02")
      stop()
      click("01")
      expect(clicks).toEqual(["01"])
    })
  })

  context("in a browser, or a host that came before them", () => {
    it("are absent", () => {
      expect(desktopNotices(undefined)).toBeUndefined()
      expect(desktopNotices({} as DesktopHost)).toBeUndefined()
    })
  })
})

// A host's update bridge that lets a test report offers and counts what the page asks.
const updater = (channel: unknown = "stable") => {
  let report: ((offer: unknown) => void) | undefined
  let installs = 0
  let pages = 0
  const set: unknown[] = []
  const bridge = {
    onUpdate: (listener: (offer: unknown) => void) => {
      report = listener
      return () => {
        report = undefined
      }
    },
    installUpdate: () => void (installs += 1),
    openUpdatePage: () => void (pages += 1),
    updateChannel: () => Promise.resolve(channel),
    setUpdateChannel: (next: unknown) => void set.push(next),
  } as unknown as DesktopHost
  return {
    bridge,
    report: (offer: unknown) => report?.(offer),
    installs: () => installs,
    pages: () => pages,
    set,
  }
}

describe("desktop updates", () => {
  context("in a host that has them", () => {
    it("hears offers that look like a release's and no others", () => {
      const { bridge, report } = updater()
      const heard: unknown[] = []
      const stop = desktopUpdates(bridge)!.onOffer((offer) => heard.push(offer))
      report({ kind: "ready", version: "0.0.80", notes: ["One."] })
      report({ kind: "available", version: "1.2.3-beta.1", notes: [] })
      report({ kind: "later", version: "0.0.80", notes: [] })
      report({ kind: "ready", version: "latest", notes: [] })
      report({ kind: "ready", version: "0.0.80\n<b>", notes: [] })
      report("0.0.80")
      report(null)
      stop()
      report({ kind: "ready", version: "0.0.81", notes: [] })
      expect(heard).toEqual([
        { kind: "ready", version: "0.0.80", notes: ["One."] },
        { kind: "available", version: "1.2.3-beta.1", notes: [] },
      ])
    })

    it("keeps the notes to the lines and length the page shows, as plain text", () => {
      const { bridge, report } = updater()
      const heard: { notes: readonly string[] }[] = []
      desktopUpdates(bridge)!.onOffer((offer) => heard.push(offer))
      report({
        kind: "ready",
        version: "0.0.80",
        notes: [
          "Fixed\u0007 a thing.",
          7,
          "   ",
          "x".repeat(500),
          ...Array.from({ length: 20 }, (_, index) => `Note ${index}`),
        ],
      })
      const { notes } = heard[0]!
      expect(notes[0]).toBe("Fixed a thing.")
      expect(notes[1]).toHaveLength(200)
      expect(notes).toHaveLength(12)
    })

    it("hears no notes from a host that sends none", () => {
      const { bridge, report } = updater()
      const heard: { notes: readonly string[] }[] = []
      desktopUpdates(bridge)!.onOffer((offer) => heard.push(offer))
      report({ kind: "ready", version: "0.0.80" })
      expect(heard[0]!.notes).toEqual([])
    })

    it("installs and opens the release page through the host", () => {
      const { bridge, installs, pages } = updater()
      const updates = desktopUpdates(bridge)!
      updates.install()
      updates.openPage()
      expect([installs(), pages()]).toEqual([1, 1])
    })

    it("reads the channel and switches it, accepting only a channel it knows", async () => {
      const { bridge, set } = updater()
      const channel = desktopUpdates(bridge)!.channel!
      expect(await channel.get()).toBe("stable")
      channel.set("early")
      expect(set).toEqual(["early"])
      await expect(desktopUpdates(updater("nightly").bridge)!.channel!.get()).rejects.toThrow()
    })

    it("offers no channel where the host has none", () => {
      const { bridge } = updater()
      delete (bridge as { updateChannel?: unknown }).updateChannel
      expect(desktopUpdates(bridge)!.channel).toBeUndefined()
    })
  })

  context("in a browser, or a host that came before them", () => {
    it("are absent", () => {
      expect(desktopUpdates(undefined)).toBeUndefined()
      expect(desktopUpdates({} as DesktopHost)).toBeUndefined()
    })
  })
})
