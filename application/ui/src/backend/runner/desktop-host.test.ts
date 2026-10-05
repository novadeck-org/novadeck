import type { DesktopHost, DesktopNotice } from "@novadeck/protocol/bridge"

import { context, describe, expect, it } from "../../test"
import { desktopNotices, hostNotice, noticeText } from "./desktop-host"

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
