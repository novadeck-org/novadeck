import type {
  DesktopHost,
  DesktopNotice,
  InstallResult as BridgeInstall,
  PortableState as BridgePortable,
  SandboxState as BridgeState,
  UninstallPlan as BridgePlan,
  UninstallResult as BridgeUninstall,
} from "@novadeck/protocol/bridge"

import type { InstallResult, PortableState } from "../../model/portable"
import type { SandboxState } from "../../model/sandbox"
import type { UninstallPlan, UninstallResult } from "../../model/uninstall"
import { context, describe, expect, it } from "../../test"
import {
  desktopNotices,
  desktopPortable,
  desktopSandbox,
  desktopUninstall,
  desktopUpdates,
  desktopVersion,
  hostInstall,
  hostNotice,
  hostPortable,
  hostSandbox,
  hostUninstallPlan,
  hostUninstallResult,
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
    expect(noticeText("@moth is done:\n\u202eCheckout\u0007", 256)).toBe("@moth is done: Checkout")
    expect(noticeText("a\u061cb", 256)).toBe("a b")
  })

  it("is cut to its length with an ellipsis, never inside a character", () => {
    expect(noticeText("abcdef", 4)).toBe("abc…")
    expect(noticeText(`ab${"😀"}cd`, 4)).toBe("ab…")
  })
})

describe("a notice for the host", () => {
  it("passes for a terminal id, bounded", () => {
    const notice = hostNotice({ id: "3f2a-01", title: "@moth is done", body: "x".repeat(500) })
    expect(notice?.body).toHaveLength(120)
  })

  it("is dropped for an id that is no terminal's, or with nothing to say", () => {
    expect(hostNotice({ id: "../evil", title: "@moth is done", body: "" })).toBeUndefined()
    expect(hostNotice({ id: "01", title: "\n", body: "Done." })).toBeUndefined()
  })
})

describe("desktop notices", () => {
  context("in a host that has them", () => {
    it("shows what passes and hears clicks that name a terminal", () => {
      const { bridge, shown, click } = host()
      const notices = desktopNotices(bridge)!
      notices.show({ id: "01", title: "@moth is done: Tests", body: "All green." })
      notices.show({ id: "bad id", title: "@moth is done", body: "" })
      expect(shown).toEqual([{ id: "01", title: "@moth is done: Tests", body: "All green." }])
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
  let pages = 0
  const set: unknown[] = []
  const bridge = {
    onUpdate: (listener: (offer: unknown) => void) => {
      report = listener
      return () => {
        report = undefined
      }
    },
    openUpdatePage: () => void (pages += 1),
    updateChannel: () => Promise.resolve(channel),
    setUpdateChannel: (next: unknown) => void set.push(next),
  } as unknown as DesktopHost
  return {
    bridge,
    report: (offer: unknown) => report?.(offer),
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
    it("hears offers that look like a release's, and a download to retry, and no others", () => {
      const { bridge, report } = updater()
      const heard: unknown[] = []
      const stop = desktopUpdates(bridge)!.onOffer((offer) => heard.push(offer))
      report({ kind: "ready", version: "0.0.80" })
      report({ kind: "available", version: "1.2.3-beta.1" })
      report({ kind: "later", version: "0.0.80" })
      report({ kind: "retrying", version: "0.0.82" })
      report({ kind: "ready", version: "latest" })
      report({ kind: "ready", version: "0.0.80\n<b>" })
      report("0.0.80")
      report(null)
      stop()
      report({ kind: "ready", version: "0.0.81" })
      expect(heard).toEqual([
        { kind: "ready", version: "0.0.80" },
        { kind: "available", version: "1.2.3-beta.1" },
        { kind: "retrying", version: "0.0.82" },
      ])
    })

    it("hears a download only with a whole percent from 0 to 100, which no other offer carries", () => {
      const { bridge, report } = updater()
      const heard: unknown[] = []
      desktopUpdates(bridge)!.onOffer((offer) => heard.push(offer))
      report({ kind: "downloading", version: "0.0.80", percent: 0 })
      report({ kind: "downloading", version: "0.0.80", percent: 100 })
      report({ kind: "downloading", version: "0.0.80" })
      report({ kind: "downloading", version: "0.0.80", percent: 42.5 })
      report({ kind: "downloading", version: "0.0.80", percent: 101 })
      report({ kind: "downloading", version: "0.0.80", percent: "40" })
      report({ kind: "ready", version: "0.0.80", percent: 40 })
      expect(heard).toEqual([
        { kind: "downloading", version: "0.0.80", percent: 0 },
        { kind: "downloading", version: "0.0.80", percent: 100 },
        { kind: "ready", version: "0.0.80" },
      ])
    })

    it("opens the release page through the host", () => {
      const { bridge, pages } = updater()
      const updates = desktopUpdates(bridge)!
      updates.openPage()
      expect(pages()).toBe(1)
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
    const state: PortableState = {
      portable: true,
      version: "0.0.70",
      run: "0a1b-2c3d",
      installed: false,
    }
    const theirs: BridgePortable = state
    const back: PortableState = theirs
    const results: InstallResult[] = [
      { kind: "installed" },
      { kind: "newer", version: "0.0.80" },
      { kind: "failed", reason: "x" },
    ]
    const bridged: BridgeInstall[] = results
    const home: InstallResult[] = bridged
    expect([back, home]).toEqual([state, results])
  })

  it("is portable with its version, or not", () => {
    expect(hostPortable({ portable: false })).toEqual({ portable: false })
    expect(
      hostPortable({ portable: true, version: "0.0.70", run: "0a1b-2c3d", installed: true }),
    ).toEqual({ portable: true, version: "0.0.70", run: "0a1b-2c3d", installed: true })
  })

  it("is not taken from an answer that is neither", () => {
    expect(() => hostPortable(null)).toThrow()
    expect(() => hostPortable({ portable: true })).toThrow()
    expect(() => hostPortable({ portable: true, version: "0.0.70" })).toThrow()
    expect(() => hostPortable({ portable: true, version: "0.0.70", run: "0a1b" })).toThrow()
    expect(() =>
      hostPortable({ portable: true, version: "0.0.70", run: "a b", installed: false }),
    ).toThrow()
    expect(() => hostPortable({ portable: true, version: "latest", run: "0a1b" })).toThrow()
    expect(() => hostPortable({ portable: "yes", version: "0.0.70", run: "0a1b" })).toThrow()
  })

  it("takes an install's answer when it is one of the three", () => {
    expect(hostInstall({ kind: "installed" })).toEqual({ kind: "installed" })
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

  it("installs through the host and passes on the progress it can read", async () => {
    let tell: (progress: unknown) => void = () => {}
    const bridge = {
      portable: () =>
        Promise.resolve({ portable: true, version: "0.0.70", run: "0a1b-2c3d", installed: false }),
      installApp: () => Promise.resolve({ kind: "newer", version: "0.0.80" }),
      onInstallProgress: (listener: (progress: unknown) => void) => {
        tell = listener
        return () => {}
      },
    } as unknown as DesktopHost
    const portable = desktopPortable(bridge)!
    expect(await portable.state()).toEqual({
      portable: true,
      version: "0.0.70",
      run: "0a1b-2c3d",
      installed: false,
    })
    expect(await portable.install()).toEqual({ kind: "newer", version: "0.0.80" })
    const heard: unknown[] = []
    portable.onProgress!((progress) => heard.push(progress))
    tell({ phase: "downloading", percent: 40 })
    tell({ phase: "downloading", percent: 140 })
    tell({ phase: "installing" })
    tell({ phase: "done" })
    expect(heard).toEqual([{ phase: "downloading", percent: 40 }, { phase: "installing" }])
  })

  it("fails an install the host throws on", async () => {
    const bridge = {
      portable: () =>
        Promise.resolve({ portable: true, version: "0.0.70", run: "0a1b-2c3d", installed: false }),
      installApp: () => Promise.reject(new Error("gone")),
    } as unknown as DesktopHost
    expect((await desktopPortable(bridge)!.install()).kind).toBe("failed")
  })

  it("is absent in a browser, or a host that came before it", () => {
    expect(desktopPortable(undefined)).toBeUndefined()
    expect(desktopPortable({} as DesktopHost)).toBeUndefined()
  })
})

describe("a host's uninstall", () => {
  const ready: UninstallPlan = {
    kind: "ready",
    dataFolders: ["/home/me/.config/novadeck"],
    handoff: "uninstaller",
  }

  it("fits the protocol's, which the page's own copy must keep to", () => {
    const plans: UninstallPlan[] = [
      { kind: "unavailable" },
      { kind: "manual", command: "brew uninstall --cask novadeck" },
      ready,
    ]
    const results: UninstallResult[] = [
      { kind: "uninstalling" },
      { kind: "removed", leftover: "sudo rm /etc/apparmor.d/novadeck" },
      { kind: "failed", reason: "x" },
    ]
    const theirPlans: BridgePlan[] = plans
    const theirResults: BridgeUninstall[] = results
    const homePlans: UninstallPlan[] = theirPlans
    const homeResults: UninstallResult[] = theirResults
    expect([homePlans, homeResults]).toEqual([plans, results])
  })

  it("takes a plan of the three kinds", () => {
    expect(hostUninstallPlan({ kind: "unavailable" })).toEqual({ kind: "unavailable" })
    expect(
      hostUninstallPlan({ kind: "manual", command: "brew uninstall --cask novadeck" }),
    ).toEqual({ kind: "manual", command: "brew uninstall --cask novadeck" })
    expect(hostUninstallPlan(ready)).toEqual(ready)
  })

  it("takes a data folder path as long as the host's preload does", () => {
    const path = `/${"a".repeat(999)}`
    expect(hostUninstallPlan({ ...ready, dataFolders: [path] })).toEqual({
      ...ready,
      dataFolders: [path],
    })
    expect(() => hostUninstallPlan({ ...ready, dataFolders: [`${path}a`] })).toThrow()
  })

  it("takes no plan from an answer that is none of them, or whose text is not plain", () => {
    expect(() => hostUninstallPlan(null)).toThrow()
    expect(() => hostUninstallPlan({ kind: "later" })).toThrow()
    expect(() => hostUninstallPlan({ kind: "manual" })).toThrow()
    expect(() => hostUninstallPlan({ kind: "manual", command: "a\nb" })).toThrow()
    expect(() => hostUninstallPlan({ kind: "ready", dataFolders: [], handoff: "me" })).toThrow()
    expect(() => hostUninstallPlan({ ...ready, dataFolders: ["/ok", 7] })).toThrow()
    expect(() => hostUninstallPlan({ ...ready, dataFolders: ["/a\u202eb"] })).toThrow()
  })

  it("takes a result of the three kinds, dropping a leftover that is not one plain line", () => {
    expect(hostUninstallResult({ kind: "uninstalling" })).toEqual({ kind: "uninstalling" })
    expect(hostUninstallResult({ kind: "removed" })).toEqual({ kind: "removed" })
    expect(hostUninstallResult({ kind: "removed", leftover: "sudo rm x" })).toEqual({
      kind: "removed",
      leftover: "sudo rm x",
    })
    expect(hostUninstallResult({ kind: "removed", leftover: "a\nb" })).toEqual({ kind: "removed" })
    expect(hostUninstallResult({ kind: "failed", reason: " Disk\nbusy " })).toEqual({
      kind: "failed",
      reason: "Disk busy",
    })
  })

  it("keeps a reason of the length the host's preload takes, with the advice it ends in", () => {
    const advice = " Novadeck has stopped your terminals; quit it and open it again."
    const reason = `${"a".repeat(266 - advice.length)}${advice}`
    expect(reason).toHaveLength(266)
    expect(hostUninstallResult({ kind: "failed", reason })).toEqual({ kind: "failed", reason })
    const longest = "b".repeat(300)
    expect(hostUninstallResult({ kind: "failed", reason: longest })).toEqual({
      kind: "failed",
      reason: longest,
    })
    expect(hostUninstallResult({ kind: "failed", reason: "b".repeat(301) })).toEqual({
      kind: "failed",
      reason: "Something went wrong.",
    })
  })

  it("takes any other answer for a failure the person can read", () => {
    const unknown = { kind: "failed", reason: "Something went wrong." }
    expect(hostUninstallResult(undefined)).toEqual(unknown)
    expect(hostUninstallResult({ kind: "done" })).toEqual(unknown)
    expect(hostUninstallResult({ kind: "failed", reason: "  " })).toEqual(unknown)
  })

  it("asks, uninstalls and quits through the host", async () => {
    let quit = 0
    const asked: boolean[] = []
    const bridge = {
      uninstallPlan: () => Promise.resolve(ready),
      uninstallApp: ({ keepData }: { keepData: boolean }) => {
        asked.push(keepData)
        return Promise.resolve({ kind: "removed" })
      },
      quitApp: () => void (quit += 1),
    } as unknown as DesktopHost
    const uninstall = desktopUninstall(bridge)!
    expect(await uninstall.plan()).toEqual(ready)
    expect(await uninstall.run({ keepData: false })).toEqual({ kind: "removed" })
    expect(asked).toEqual([false])
    uninstall.quit()
    expect(quit).toBe(1)
  })

  it("fails an uninstall the host throws on", async () => {
    const bridge = {
      uninstallPlan: () => Promise.resolve(ready),
      uninstallApp: () => Promise.reject(new Error("gone")),
      quitApp: () => {},
    } as unknown as DesktopHost
    expect((await desktopUninstall(bridge)!.run({ keepData: true })).kind).toBe("failed")
  })

  it("is absent in a browser, or a host that has only some of it", () => {
    expect(desktopUninstall(undefined)).toBeUndefined()
    expect(desktopUninstall({} as DesktopHost)).toBeUndefined()
    expect(
      desktopUninstall({ uninstallPlan: () => Promise.resolve(ready) } as unknown as DesktopHost),
    ).toBeUndefined()
  })
})
