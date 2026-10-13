import type {
  DesktopHost,
  DesktopNotice,
  InstallResult as BridgeInstall,
  PortableState as BridgePortable,
  SandboxState as BridgeState,
} from "@novadeck/protocol/bridge"

import type { InstallResult, PortableState } from "../../model/portable"
import type { SandboxState } from "../../model/sandbox"
import { context, describe, expect, it } from "../../test"
import {
  desktopNotices,
  desktopPortable,
  desktopSandbox,
  desktopUpdates,
  desktopVersion,
  hostInstall,
  hostNotice,
  hostPortable,
  hostSandbox,
  noticeText,
} from "./desktop-host"

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

const asking = (answer: unknown) =>
  ({ version: () => Promise.resolve(answer) }) as unknown as DesktopHost

describe("desktop version", () => {
  it("is absent in a host that does not say", () => {
    expect(desktopVersion(undefined)).toBeUndefined()
    expect(desktopVersion({} as DesktopHost)).toBeUndefined()
  })

  it("is what the host answers, when it looks like a release's", async () => {
    expect(await desktopVersion(asking("0.4.2"))!()).toBe("0.4.2")
    expect(await desktopVersion(asking("1.2.3-beta.1"))!()).toBe("1.2.3-beta.1")
  })

  it("refuses anything else", async () => {
    const answers = ["latest", "0.4.2\n<b>", "", null, 3]
    await Promise.all(
      answers.map((answer) =>
        expect(desktopVersion(asking(answer))!()).rejects.toThrow("Unknown version"),
      ),
    )
  })
})

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

    it("hears a download only with a whole percent from 0 to 100, which no other offer carries", () => {
      const { bridge, report } = updater()
      const heard: unknown[] = []
      desktopUpdates(bridge)!.onOffer((offer) => heard.push(offer))
      report({ kind: "downloading", version: "0.0.80", notes: [], percent: 0 })
      report({ kind: "downloading", version: "0.0.80", notes: [], percent: 100 })
      report({ kind: "downloading", version: "0.0.80", notes: [] })
      report({ kind: "downloading", version: "0.0.80", notes: [], percent: 42.5 })
      report({ kind: "downloading", version: "0.0.80", notes: [], percent: 101 })
      report({ kind: "downloading", version: "0.0.80", notes: [], percent: "40" })
      report({ kind: "ready", version: "0.0.80", notes: [], percent: 40 })
      expect(heard).toEqual([
        { kind: "downloading", version: "0.0.80", notes: [], percent: 0 },
        { kind: "downloading", version: "0.0.80", notes: [], percent: 100 },
        { kind: "ready", version: "0.0.80", notes: [] },
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

describe("a host's sandbox", () => {
  it("fits the protocol's, which the page's own copy must keep to", () => {
    const ours: SandboxState = { sandboxed: false, fix: "x" }
    const theirs: BridgeState = ours
    const back: SandboxState = theirs
    expect(back).toEqual(ours)
  })

  it("is sandboxed, or not with the command that fixes it", () => {
    expect(hostSandbox({ sandboxed: true })).toEqual({ sandboxed: true })
    expect(hostSandbox({ sandboxed: false, fix: " sudo ln -s a b \n" })).toEqual({
      sandboxed: false,
      fix: "sudo ln -s a b",
    })
  })

  it("keeps no command that is not one plain line of reasonable length", () => {
    const unfixed = { sandboxed: false, fix: "" }
    expect(hostSandbox({ sandboxed: false, fix: "a\nsudo b" })).toEqual(unfixed)
    expect(hostSandbox({ sandboxed: false, fix: "a\u202eb" })).toEqual(unfixed)
    expect(hostSandbox({ sandboxed: false, fix: "a".repeat(301) })).toEqual(unfixed)
    expect(hostSandbox({ sandboxed: false, fix: 7 })).toEqual(unfixed)
    expect(hostSandbox({ sandboxed: false })).toEqual(unfixed)
  })

  it("is refused when it is neither", () => {
    expect(() => hostSandbox(null)).toThrow()
    expect(() => hostSandbox({ sandboxed: "no" })).toThrow()
  })

  it("is asked of the host, where it has one", async () => {
    const bridge = { sandbox: () => Promise.resolve({ sandboxed: true }) } as unknown as DesktopHost
    expect(await desktopSandbox(bridge)!()).toEqual({ sandboxed: true })
  })

  it("is absent in a browser, or a host that came before it", () => {
    expect(desktopSandbox(undefined)).toBeUndefined()
    expect(desktopSandbox({} as DesktopHost)).toBeUndefined()
  })
})

describe("a host's portable copy", () => {
  it("fits the protocol's, which the page's own copy must keep to", () => {
    const state: PortableState = { portable: true, version: "0.0.70" }
    const theirs: BridgePortable = state
    const back: PortableState = theirs
    const results: InstallResult[] = [
      { kind: "installing" },
      { kind: "newer", version: "0.0.80" },
      { kind: "failed", reason: "x" },
    ]
    const bridged: BridgeInstall[] = results
    const home: InstallResult[] = bridged
    expect([back, home]).toEqual([state, results])
  })

  it("is portable with its version, or not", () => {
    expect(hostPortable({ portable: false })).toEqual({ portable: false })
    expect(hostPortable({ portable: true, version: "0.0.70" })).toEqual({
      portable: true,
      version: "0.0.70",
    })
  })

  it("is not taken from an answer that is neither", () => {
    expect(() => hostPortable(null)).toThrow()
    expect(() => hostPortable({ portable: true })).toThrow()
    expect(() => hostPortable({ portable: true, version: "latest" })).toThrow()
    expect(() => hostPortable({ portable: "yes", version: "0.0.70" })).toThrow()
  })

  it("takes an install's answer when it is one of the three", () => {
    expect(hostInstall({ kind: "installing" })).toEqual({ kind: "installing" })
    expect(hostInstall({ kind: "newer", version: "0.0.80" })).toEqual({
      kind: "newer",
      version: "0.0.80",
    })
    expect(hostInstall({ kind: "failed", reason: " Disk\nfull " })).toEqual({
      kind: "failed",
      reason: "Disk full",
    })
  })

  it("takes any other answer for a failure the person can read", () => {
    const unknown = {
      kind: "failed",
      reason: "Something went wrong.",
    }
    expect(hostInstall(undefined)).toEqual(unknown)
    expect(hostInstall({ kind: "newer", version: "soon" })).toEqual(unknown)
    expect(hostInstall({ kind: "failed", reason: 7 })).toEqual(unknown)
    expect(hostInstall({ kind: "failed", reason: "  " })).toEqual(unknown)
    expect(hostInstall({ kind: "done" })).toEqual(unknown)
  })

  it("installs and opens the installed copy through the host", async () => {
    let opened = 0
    const bridge = {
      portable: () => Promise.resolve({ portable: true, version: "0.0.70" }),
      installApp: () => Promise.resolve({ kind: "newer", version: "0.0.80" }),
      openInstalled: () => void (opened += 1),
    } as unknown as DesktopHost
    const portable = desktopPortable(bridge)!
    expect(await portable.state()).toEqual({
      portable: true,
      version: "0.0.70",
    })
    expect(await portable.install()).toEqual({
      kind: "newer",
      version: "0.0.80",
    })
    portable.openInstalled()
    expect(opened).toBe(1)
  })

  it("fails an install the host throws on", async () => {
    const bridge = {
      portable: () => Promise.resolve({ portable: true, version: "0.0.70" }),
      installApp: () => Promise.reject(new Error("gone")),
      openInstalled: () => {},
    } as unknown as DesktopHost
    expect((await desktopPortable(bridge)!.install()).kind).toBe("failed")
  })

  it("is absent in a browser, or a host that came before it", () => {
    expect(desktopPortable(undefined)).toBeUndefined()
    expect(desktopPortable({} as DesktopHost)).toBeUndefined()
  })
})

// The outdated-since date of the offer a host reports with this `outdatedSince`, as the page hears it.
const heardDate = (outdatedSince: unknown) => {
  let offer: { outdatedSince?: string } | undefined
  desktopUpdates({
    onUpdate: (listener: (offer: unknown) => void) => {
      listener({
        kind: "available",
        version: "0.0.80",
        notes: [],
        outdatedSince,
      })
      return () => {}
    },
    installUpdate: () => {},
    openUpdatePage: () => {},
  } as unknown as DesktopHost)!.onOffer((each) => (offer = each))
  return offer?.outdatedSince
}

describe("an offer's outdated-since date", () => {
  it("is kept when it reads as a date, and dropped otherwise", () => {
    expect(heardDate("2026-10-01T10:00:00Z")).toBe("2026-10-01T10:00:00Z")
    expect(heardDate("last week")).toBeUndefined()
    expect(heardDate(7)).toBeUndefined()
    expect(heardDate("2026-10-01T10:00:00Z".padEnd(80, " "))).toBeUndefined()
  })
})
