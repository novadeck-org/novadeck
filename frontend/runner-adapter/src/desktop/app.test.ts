import type { PortableState } from "@novadeck/core/desktop/portable"
import type { SandboxState } from "@novadeck/core/desktop/sandbox"
import type { UninstallPlan, UninstallResult } from "@novadeck/core/desktop/uninstall"
import type { UpdateOffer, WhatsNew } from "@novadeck/core/desktop/update"
import type {
  DesktopApp,
  DesktopNotice,
  UpdateOffer as BridgeOffer,
  WhatsNew as BridgeWhatsNew,
  PortableState as BridgePortable,
  SandboxState as BridgeState,
  UninstallPlan as BridgePlan,
  UninstallResult as BridgeUninstall,
} from "@novadeck/protocol/bridge"

import { context, describe, expect, it } from "../test"
import {
  desktopBadge,
  desktopFeedback,
  desktopNotices,
  desktopOptions,
  desktopPortable,
  desktopSandbox,
  desktopUninstall,
  desktopUpdates,
  desktopVersion,
  desktopWhatsNew,
  desktopWindowFocus,
  desktopNoticeOf,
  sandboxStateOf,
  uninstallPlanOf,
  uninstallResultOf,
  noticeText,
} from "./app"

// An app's notification bridge that records what the page shows, and lets a test click.
const app = () => {
  const shown: DesktopNotice[] = []
  const closed: string[] = []
  const badges: unknown[] = []
  let clicked: ((id: string) => void) | undefined
  const bridge = {
    showNotice: (notice: DesktopNotice) => void shown.push(notice),
    closeNotice: (id: string) => void closed.push(id),
    setBadge: (badge: unknown) => void badges.push(badge),
    onNoticeClick: (listener: (id: string) => void) => {
      clicked = listener
      return () => {
        clicked = undefined
      }
    },
  } as unknown as DesktopApp
  return { bridge, shown, closed, badges, click: (id: unknown) => clicked?.(id as string) }
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

describe("a notice for the app", () => {
  it("passes for a terminal id, bounded", () => {
    const notice = desktopNoticeOf({ id: "3f2a-01", title: "@moth is done", body: "x".repeat(500) })
    expect(notice?.body).toHaveLength(120)
  })

  it("is dropped for an id that is no terminal's, or with nothing to say", () => {
    expect(desktopNoticeOf({ id: "../evil", title: "@moth is done", body: "" })).toBeUndefined()
    expect(desktopNoticeOf({ id: "01", title: "\n", body: "Done." })).toBeUndefined()
  })
})

describe("desktop notices", () => {
  context("in an app that has them", () => {
    it("shows what passes and hears clicks that name a terminal", () => {
      const { bridge, shown, click } = app()
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

  context("when the app's notifications play the sound", () => {
    it("says so, and passes the person's silent choice", () => {
      const { bridge, shown } = app()
      const notices = desktopNotices({ ...bridge, notificationsSound: true } as DesktopApp)!
      expect(notices.sounds).toBe(true)
      notices.show({ id: "01", title: "@moth is done", body: "", silent: true })
      notices.show({ id: "02", title: "@moth is done", body: "", silent: "no" as never })
      expect(shown).toEqual([
        { id: "01", title: "@moth is done", body: "", silent: true },
        { id: "02", title: "@moth is done", body: "" },
      ])
    })

    it("passes the theme's sound, and drops a name the app does not have", () => {
      const { bridge, shown } = app()
      const notices = desktopNotices({ ...bridge, notificationsSound: true } as DesktopApp)!
      notices.show({ id: "01", title: "@moth is done", body: "", sound: "afterglow" })
      notices.show({ id: "02", title: "@moth is done", body: "", sound: "../x" as never })
      expect(shown).toEqual([
        { id: "01", title: "@moth is done", body: "", sound: "afterglow" },
        { id: "02", title: "@moth is done", body: "" },
      ])
    })

    it("claims no sound in an app that lacks it", () => {
      expect(desktopNotices(app().bridge)!.sounds).toBeUndefined()
    })
  })

  context("when the app can tell whether notifications are held back", () => {
    it("passes a boolean answer, and a failure or anything else is false", async () => {
      const { bridge } = app()
      const ask = (answer: () => Promise<unknown>) =>
        desktopNotices({ ...bridge, notificationsQuiet: answer } as unknown as DesktopApp)!.quiet!()
      expect(await ask(async () => true)).toBe(true)
      expect(await ask(async () => "yes")).toBe(false)
      expect(await ask(() => Promise.reject(new Error("gone")))).toBe(false)
    })

    it("has no quiet in an app that lacks it", () => {
      expect(desktopNotices(app().bridge)!.quiet).toBeUndefined()
    })
  })

  context("when the app can take one away", () => {
    it("closes by a terminal id and drops anything else", () => {
      const { bridge, closed } = app()
      const notices = desktopNotices(bridge)!
      notices.close!("01")
      notices.close!("../02")
      notices.close!({ id: "03" } as unknown as string)
      expect(closed).toEqual(["01"])
    })

    it("has no close in an app that lacks it", () => {
      const { bridge } = app()
      const old = { ...bridge, closeNotice: undefined } as unknown as DesktopApp
      expect(desktopNotices(old)!.close).toBeUndefined()
    })
  })

  context("in a browser, or an app that came before them", () => {
    it("are absent", () => {
      expect(desktopNotices(undefined)).toBeUndefined()
      expect(desktopNotices({} as DesktopApp)).toBeUndefined()
    })
  })
})

describe("the desktop badge", () => {
  const png = "data:image/png;base64,iVBORw0KGgo="

  it("passes valid badges to the app", () => {
    const { bridge, badges } = app()
    const badge = desktopBadge(bridge)!
    badge({ count: 3, image: png })
    badge({ count: 0, image: null })
    expect(badges).toEqual([
      { count: 3, image: png },
      { count: 0, image: null },
    ])
  })

  it("drops what the contract does not allow", () => {
    const { bridge, badges } = app()
    const badge = desktopBadge(bridge)!
    for (const value of [
      { count: -1, image: null },
      { count: 1000, image: null },
      { count: 1.5, image: null },
      { count: 2, image: "https://example.com/a.png" },
      { count: 2, image: "data:image/svg+xml;base64,PHN2Zz4=" },
      { count: 2, image: `data:image/png;base64,${"A".repeat(16384)}` },
      { count: "2", image: null },
      null,
    ])
      badge(value as never)
    expect(badges).toEqual([])
  })

  it("is absent in a browser, or an app that came before it", () => {
    expect(desktopBadge(undefined)).toBeUndefined()
    expect(desktopBadge({} as DesktopApp)).toBeUndefined()
  })
})

describe("the desktop window's focus", () => {
  it("passes the app's booleans to the page until it stops", () => {
    let report: ((focused: unknown) => void) | undefined
    const bridge = {
      onWindowFocus: (listener: (focused: unknown) => void) => {
        report = listener
        return () => {
          report = undefined
        }
      },
    } as unknown as DesktopApp
    const states: boolean[] = []
    const stop = desktopWindowFocus(bridge)!((focused) => states.push(focused))
    report?.(true)
    report?.("yes")
    report?.(null)
    report?.(false)
    stop()
    expect(states).toEqual([true, false])
    expect(report).toBeUndefined()
  })

  it("is absent in a browser, or an app that came before it", () => {
    expect(desktopWindowFocus(undefined)).toBeUndefined()
    expect(desktopWindowFocus({} as DesktopApp)).toBeUndefined()
  })
})

// An app's update bridge that lets a test report offers and counts what the page asks.
const updater = (channel: unknown = "stable") => {
  let report: ((offer: unknown) => void) | undefined
  let pages = 0
  let allowed = 0
  const set: unknown[] = []
  const bridge = {
    onUpdate: (listener: (offer: unknown) => void) => {
      report = listener
      return () => {
        report = undefined
      }
    },
    openUpdatePage: () => void (pages += 1),
    allowUpdates: () => void (allowed += 1),
    updateChannel: () => Promise.resolve(channel),
    setUpdateChannel: (next: unknown) => void set.push(next),
  } as unknown as DesktopApp
  return {
    bridge,
    report: (offer: unknown) => report?.(offer),
    pages: () => pages,
    allowed: () => allowed,
    set,
  }
}

const asking = (answer: unknown) =>
  ({ version: () => Promise.resolve(answer) }) as unknown as DesktopApp

describe("desktop version", () => {
  it("is absent in an app that does not say", () => {
    expect(desktopVersion(undefined)).toBeUndefined()
    expect(desktopVersion({} as DesktopApp)).toBeUndefined()
  })

  it("is what the app answers, when it looks like a release's", async () => {
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
  context("in an app that has them", () => {
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

    it("opens the release page through the app", () => {
      const { bridge, pages } = updater()
      const updates = desktopUpdates(bridge)!
      updates.openPage()
      expect(pages()).toBe(1)
    })

    it("keeps allow only when it is exactly true on an available offer", () => {
      const { bridge, report } = updater()
      const heard: unknown[] = []
      desktopUpdates(bridge)!.onOffer((offer) => heard.push(offer))
      report({ kind: "available", version: "0.0.80", allow: true })
      report({ kind: "available", version: "0.0.81", allow: "yes" })
      report({ kind: "available", version: "0.0.82", allow: false })
      report({ kind: "ready", version: "0.0.83", allow: true })
      expect(heard).toEqual([
        { kind: "available", version: "0.0.80", allow: true },
        { kind: "available", version: "0.0.81" },
        { kind: "available", version: "0.0.82" },
        { kind: "ready", version: "0.0.83" },
      ])
    })

    it("asks the app to allow updates, where it can", () => {
      const { bridge, allowed } = updater()
      desktopUpdates(bridge)!.allow!()
      expect(allowed()).toBe(1)
      delete (bridge as { allowUpdates?: unknown }).allowUpdates
      expect(desktopUpdates(bridge)!.allow).toBeUndefined()
    })

    it("reads the channel and switches it, accepting only a channel it knows", async () => {
      const { bridge, set } = updater()
      const channel = desktopUpdates(bridge)!.channel!
      expect(await channel.get()).toBe("stable")
      channel.set("experimental")
      expect(set).toEqual(["experimental"])
      await expect(desktopUpdates(updater("nightly").bridge)!.channel!.get()).rejects.toThrow()
    })

    it("offers no channel where the app has none", () => {
      const { bridge } = updater()
      delete (bridge as { updateChannel?: unknown }).updateChannel
      expect(desktopUpdates(bridge)!.channel).toBeUndefined()
    })
  })

  context("in a browser, or an app that came before them", () => {
    it("are absent", () => {
      expect(desktopUpdates(undefined)).toBeUndefined()
      expect(desktopUpdates({} as DesktopApp)).toBeUndefined()
    })
  })
})

describe("desktop what's new", () => {
  const highlight = { title: "Word handles", line: "Talk to @moth." }
  const whatsNewApp = (answer: unknown) => {
    const calls = { dismissed: 0 }
    const bridge = {
      whatsNew: () => Promise.resolve(answer),
      dismissWhatsNew: () => void (calls.dismissed += 1),
    } as unknown as DesktopApp
    return { bridge, calls }
  }

  it("fits the protocol's, which the page's own copy must keep to", () => {
    const ours: WhatsNew = { version: "0.2.0", highlights: [highlight] }
    const theirs: BridgeWhatsNew = ours
    const back: WhatsNew = theirs
    expect(back).toEqual(ours)
  })

  it("is absent in a browser, an app that came before it, or one with only some of its calls", () => {
    expect(desktopWhatsNew(undefined)).toBeUndefined()
    expect(desktopWhatsNew({} as DesktopApp)).toBeUndefined()
    const { bridge } = whatsNewApp(undefined)
    delete (bridge as { dismissWhatsNew?: unknown }).dismissWhatsNew
    expect(desktopWhatsNew(bridge)).toBeUndefined()
  })

  it("gives the highlights the contract allows, as plain lines", async () => {
    const { bridge } = whatsNewApp({
      version: "0.2.0",
      highlights: [{ title: "  A\n<b>b</b> ", line: "x" }, { title: "", line: "no title" }, 3],
    })
    expect(await desktopWhatsNew(bridge)!.get()).toEqual({
      version: "0.2.0",
      highlights: [{ title: "A <b>b</b>", line: "x" }],
    })
  })

  it("keeps an icon named as Lucide names them, and drops another without dropping the highlight", async () => {
    const { bridge } = whatsNewApp({
      version: "0.2.0",
      highlights: [
        { title: "A", line: "a", icon: "gauge" },
        { title: "B", line: "b", icon: "folder-git-2" },
        { title: "C", line: "c", icon: 7 },
        { title: "D", line: "d", icon: "-gauge" },
      ],
    })
    expect(await desktopWhatsNew(bridge)!.get()).toEqual({
      version: "0.2.0",
      highlights: [
        { title: "A", line: "a", icon: "gauge" },
        { title: "B", line: "b", icon: "folder-git-2" },
        { title: "C", line: "c" },
        { title: "D", line: "d" },
      ],
    })
  })

  it("has nothing to give when the app has none, or its answer breaks the contract", async () => {
    const answers = [
      undefined,
      null,
      "0.2.0",
      { version: "latest", highlights: [highlight] },
      { version: "0.2.0", highlights: [] },
    ]
    const heard = await Promise.all(
      answers.map((answer) => desktopWhatsNew(whatsNewApp(answer).bridge)!.get()),
    )
    expect(heard).toEqual(answers.map(() => undefined))
  })

  it("dismisses through the app, once per call", () => {
    const { bridge, calls } = whatsNewApp(undefined)
    desktopWhatsNew(bridge)!.dismiss()
    expect(calls).toEqual({ dismissed: 1 })
  })
})

describe("the app's sandbox", () => {
  it("fits the protocol's, which the page's own copy must keep to", () => {
    const ours: SandboxState = { sandboxed: false, fix: "x" }
    const theirs: BridgeState = ours
    const back: SandboxState = theirs
    expect(back).toEqual(ours)
  })

  it("is sandboxed, or not with the command that fixes it", () => {
    expect(sandboxStateOf({ sandboxed: true })).toEqual({ sandboxed: true })
    expect(sandboxStateOf({ sandboxed: false, fix: " sudo ln -s a b \n" })).toEqual({
      sandboxed: false,
      fix: "sudo ln -s a b",
    })
  })

  it("keeps no command that is not one plain line of reasonable length", () => {
    const unfixed = { sandboxed: false, fix: "" }
    expect(sandboxStateOf({ sandboxed: false, fix: "a\nsudo b" })).toEqual(unfixed)
    expect(sandboxStateOf({ sandboxed: false, fix: "a\u202eb" })).toEqual(unfixed)
    expect(sandboxStateOf({ sandboxed: false, fix: "a".repeat(301) })).toEqual(unfixed)
    expect(sandboxStateOf({ sandboxed: false, fix: 7 })).toEqual(unfixed)
    expect(sandboxStateOf({ sandboxed: false })).toEqual(unfixed)
  })

  it("is refused when it is neither", () => {
    expect(() => sandboxStateOf(null)).toThrow()
    expect(() => sandboxStateOf({ sandboxed: "no" })).toThrow()
  })

  it("is asked of the app, where it has one", async () => {
    const bridge = { sandbox: () => Promise.resolve({ sandboxed: true }) } as unknown as DesktopApp
    expect(await desktopSandbox(bridge)!()).toEqual({ sandboxed: true })
  })

  it("is absent in a browser, or an app that came before it", () => {
    expect(desktopSandbox(undefined)).toBeUndefined()
    expect(desktopSandbox({} as DesktopApp)).toBeUndefined()
  })
})

// An app's portable bridge that lets a test push states and counts the installs asked for.
const portableApp = (first: unknown) => {
  let push: ((state: unknown) => void) | undefined
  let installs = 0
  const bridge = {
    portable: () => Promise.resolve(first),
    installApp: () => void (installs += 1),
    onPortableState: (listener: (state: unknown) => void) => {
      push = listener
      return () => {
        push = undefined
      }
    },
  } as unknown as DesktopApp
  return { bridge, push: (state: unknown) => push?.(state), installs: () => installs }
}

const idleState = () => ({
  portable: true,
  version: "0.0.70",
  run: "0a1b-2c3d",
  install: { phase: "idle" },
})

describe("the app's portable copy", () => {
  it("fits the protocol's, which the page's own copy must keep to", () => {
    const states: PortableState[] = [
      { portable: false },
      ...(
        [
          { phase: "idle" },
          { phase: "downloading", percent: 40 },
          { phase: "installing" },
          { phase: "installed" },
          { phase: "newer", version: "0.0.80" },
          { phase: "failed", reason: "x" },
        ] as const
      ).map((install) => ({
        portable: true as const,
        version: "0.0.70",
        run: "0a1b-2c3d",
        install,
      })),
      {
        portable: true as const,
        version: "0.0.70",
        run: "0a1b-2c3d",
        install: { phase: "idle" as const },
        dataFolder: "/home/me/.config/novadeck",
      },
    ]
    const theirs: BridgePortable[] = states
    const back: PortableState[] = theirs
    const offers: UpdateOffer[] = [
      { kind: "downloading", version: "0.0.80", percent: 4 },
      { kind: "ready", version: "0.0.80" },
    ]
    const bridged: BridgeOffer[] = offers
    const home: UpdateOffer[] = bridged
    expect([back, home]).toEqual([states, offers])
  })

  it("is portable with its version and install, or not", async () => {
    const idle = idleState()
    expect(await desktopPortable(portableApp({ portable: false }).bridge)!.state()).toEqual({
      portable: false,
    })
    expect(await desktopPortable(portableApp(idle).bridge)!.state()).toEqual(idle)
  })

  it("keeps a plain data folder, and leaves out one that is no path", async () => {
    const folder = { ...idleState(), dataFolder: "/home/me/.config/novadeck" }
    expect(await desktopPortable(portableApp(folder).bridge)!.state()).toEqual(folder)
    const odd = { ...idleState(), dataFolder: "/home/me/\nx" }
    expect(await desktopPortable(portableApp(odd).bridge)!.state()).toEqual(idleState())
  })

  it("carries the calls the app has, and reads the news as the contract allows", async () => {
    const calls: string[] = []
    const bridge = {
      portable: () => Promise.resolve({ portable: false }),
      installApp: () => {},
      onPortableState: () => () => {},
      openPortableDownload: () => void calls.push("download"),
      showDataFolder: () => void calls.push("folder"),
      updateNews: () =>
        Promise.resolve({
          version: "0.0.80",
          from: "0.0.70",
          highlights: [{ title: "A", line: "B" }, { nope: 1 }],
        }),
    } as unknown as DesktopApp
    const portable = desktopPortable(bridge)!
    portable.openDownload?.()
    portable.showDataFolder?.()
    expect(calls).toEqual(["download", "folder"])
    expect(await portable.news?.()).toEqual({
      version: "0.0.80",
      from: "0.0.70",
      highlights: [{ title: "A", line: "B" }],
    })
    const bare = desktopPortable(portableApp({ portable: false }).bridge)!
    expect([bare.openDownload, bare.showDataFolder, bare.news]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it("is not taken from an answer that is none of the contract's", async () => {
    const state = (answer: unknown) => desktopPortable(portableApp(answer).bridge)!.state()
    const run = { version: "0.0.70", run: "0a1b" }
    await expect(state(null)).rejects.toThrow()
    await expect(state({ portable: true })).rejects.toThrow()
    await expect(state({ portable: true, ...run })).rejects.toThrow()
    await expect(state({ portable: true, ...run, install: { phase: "done" } })).rejects.toThrow()
    await expect(
      state({ portable: true, ...run, install: { phase: "downloading", percent: 140 } }),
    ).rejects.toThrow()
    await expect(
      state({ portable: true, ...run, run: "a b", install: { phase: "idle" } }),
    ).rejects.toThrow()
    await expect(
      state({ portable: true, ...run, version: "latest", install: { phase: "idle" } }),
    ).rejects.toThrow()
    await expect(state({ portable: "yes", ...run, install: { phase: "idle" } })).rejects.toThrow()
  })

  it("asks the app to install, and hears each step it can read", () => {
    const { bridge, push, installs } = portableApp({ portable: false })
    const portable = desktopPortable(bridge)!
    portable.install()
    expect(installs()).toBe(1)
    const heard: unknown[] = []
    const stop = portable.onState((state) => heard.push(state))
    const run = { portable: true, version: "0.0.70", run: "0a1b-2c3d" }
    push({ ...run, install: { phase: "downloading", percent: 40 } })
    push({ ...run, install: { phase: "downloading", percent: 140 } })
    push({ ...run, install: { phase: "installing" } })
    push({ ...run, install: { phase: "done" } })
    push({ ...run, install: { phase: "failed", reason: "Disk\nfull" } })
    stop()
    push({ ...run, install: { phase: "installed" } })
    expect(heard).toEqual([
      { ...run, install: { phase: "downloading", percent: 40 } },
      { ...run, install: { phase: "installing" } },
      { ...run, install: { phase: "failed", reason: "Disk full" } },
    ])
  })

  it("is absent in a browser, or an app that came before it", () => {
    expect(desktopPortable(undefined)).toBeUndefined()
    expect(desktopPortable({} as DesktopApp)).toBeUndefined()
    expect(desktopPortable({ portable: () => {}, installApp: () => {} } as never)).toBeUndefined()
  })
})

describe("the app's uninstall", () => {
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
    expect(uninstallPlanOf({ kind: "unavailable" })).toEqual({ kind: "unavailable" })
    expect(uninstallPlanOf({ kind: "manual", command: "brew uninstall --cask novadeck" })).toEqual({
      kind: "manual",
      command: "brew uninstall --cask novadeck",
    })
    expect(uninstallPlanOf(ready)).toEqual(ready)
  })

  it("takes a data folder path as long as the app's preload does", () => {
    const path = `/${"a".repeat(999)}`
    expect(uninstallPlanOf({ ...ready, dataFolders: [path] })).toEqual({
      ...ready,
      dataFolders: [path],
    })
    expect(() => uninstallPlanOf({ ...ready, dataFolders: [`${path}a`] })).toThrow()
  })

  it("takes no plan from an answer that is none of them, or whose text is not plain", () => {
    expect(() => uninstallPlanOf(null)).toThrow()
    expect(() => uninstallPlanOf({ kind: "later" })).toThrow()
    expect(() => uninstallPlanOf({ kind: "manual" })).toThrow()
    expect(() => uninstallPlanOf({ kind: "manual", command: "a\nb" })).toThrow()
    expect(() => uninstallPlanOf({ kind: "ready", dataFolders: [], handoff: "me" })).toThrow()
    expect(() => uninstallPlanOf({ ...ready, dataFolders: ["/ok", 7] })).toThrow()
    expect(() => uninstallPlanOf({ ...ready, dataFolders: ["/a\u202eb"] })).toThrow()
  })

  it("takes a result of the three kinds, dropping a leftover that is not one plain line", () => {
    expect(uninstallResultOf({ kind: "uninstalling" })).toEqual({ kind: "uninstalling" })
    expect(uninstallResultOf({ kind: "removed" })).toEqual({ kind: "removed" })
    expect(uninstallResultOf({ kind: "removed", leftover: "sudo rm x" })).toEqual({
      kind: "removed",
      leftover: "sudo rm x",
    })
    expect(uninstallResultOf({ kind: "removed", leftover: "a\nb" })).toEqual({ kind: "removed" })
    expect(uninstallResultOf({ kind: "failed", reason: " Disk\nbusy " })).toEqual({
      kind: "failed",
      reason: "Disk busy",
    })
  })

  it("keeps a reason of the length the app's preload takes, with the advice it ends in", () => {
    const advice = " Novadeck has stopped your terminals; quit it and open it again."
    const reason = `${"a".repeat(266 - advice.length)}${advice}`
    expect(reason).toHaveLength(266)
    expect(uninstallResultOf({ kind: "failed", reason })).toEqual({ kind: "failed", reason })
    const longest = "b".repeat(300)
    expect(uninstallResultOf({ kind: "failed", reason: longest })).toEqual({
      kind: "failed",
      reason: longest,
    })
    expect(uninstallResultOf({ kind: "failed", reason: "b".repeat(301) })).toEqual({
      kind: "failed",
      reason: "Something went wrong.",
    })
  })

  it("takes any other answer for a failure the person can read", () => {
    const unknown = { kind: "failed", reason: "Something went wrong." }
    expect(uninstallResultOf(undefined)).toEqual(unknown)
    expect(uninstallResultOf({ kind: "done" })).toEqual(unknown)
    expect(uninstallResultOf({ kind: "failed", reason: "  " })).toEqual(unknown)
  })

  it("asks, uninstalls and quits through the app", async () => {
    let quit = 0
    const asked: boolean[] = []
    const bridge = {
      uninstallPlan: () => Promise.resolve(ready),
      uninstallApp: ({ keepData }: { keepData: boolean }) => {
        asked.push(keepData)
        return Promise.resolve({ kind: "removed" })
      },
      quitApp: () => void (quit += 1),
    } as unknown as DesktopApp
    const uninstall = desktopUninstall(bridge)!
    expect(await uninstall.plan()).toEqual(ready)
    expect(await uninstall.run({ keepData: false })).toEqual({ kind: "removed" })
    expect(asked).toEqual([false])
    uninstall.quit()
    expect(quit).toBe(1)
  })

  it("fails an uninstall the app throws on", async () => {
    const bridge = {
      uninstallPlan: () => Promise.resolve(ready),
      uninstallApp: () => Promise.reject(new Error("gone")),
      quitApp: () => {},
    } as unknown as DesktopApp
    expect((await desktopUninstall(bridge)!.run({ keepData: true })).kind).toBe("failed")
  })

  it("is absent in a browser, or an app that has only some of it", () => {
    expect(desktopUninstall(undefined)).toBeUndefined()
    expect(desktopUninstall({} as DesktopApp)).toBeUndefined()
    expect(
      desktopUninstall({ uninstallPlan: () => Promise.resolve(ready) } as unknown as DesktopApp),
    ).toBeUndefined()
  })
})

describe("desktop feedback", () => {
  const sent: unknown[] = []
  const feedbackApp = (overrides: Record<string, unknown> = {}) =>
    ({
      feedback: true,
      feedbackAbout: () => Promise.resolve({ version: "0.0.219", os: "macos", arch: "arm64" }),
      sendFeedback: (note: unknown) => {
        sent.push(note)
        return Promise.resolve()
      },
      ...overrides,
    }) as unknown as DesktopApp

  it("is absent unless the app says it sends notes", () => {
    expect(desktopFeedback(undefined)).toBeUndefined()
    expect(desktopFeedback({} as DesktopApp)).toBeUndefined()
    expect(desktopFeedback(feedbackApp({ feedback: undefined }))).toBeUndefined()
    expect(desktopFeedback(feedbackApp({ sendFeedback: undefined }))).toBeUndefined()
  })

  it("has no way to ask an agent yet", () => {
    expect(desktopFeedback(feedbackApp())).not.toHaveProperty("ask")
  })

  it("shows the version and the OS as the demo does", async () => {
    expect(await desktopFeedback(feedbackApp())!.about()).toEqual({
      version: "0.0.219",
      os: "macOS arm64",
    })
    const windows = feedbackApp({
      feedbackAbout: () => Promise.resolve({ version: "1.0.0", os: "windows", arch: "x64" }),
    })
    expect((await desktopFeedback(windows)!.about()).os).toBe("Windows x64")
    const linux = feedbackApp({
      feedbackAbout: () => Promise.resolve({ version: "1.0.0", os: "linux", arch: "x64" }),
    })
    expect((await desktopFeedback(linux)!.about()).os).toBe("Linux x64")
  })

  it.each([
    undefined,
    { version: "x", os: "linux", arch: "x64" },
    { version: "1.0.0", os: "beos", arch: "x64" },
    { version: "1.0.0", os: "linux", arch: "x 64!" },
  ])("refuses details like %j", async (answer) => {
    const odd = feedbackApp({ feedbackAbout: () => Promise.resolve(answer) })
    await expect(desktopFeedback(odd)!.about()).rejects.toThrow()
  })

  it("hands the app a note's kind and text, and rejects when it fails", async () => {
    await desktopFeedback(feedbackApp())!.send({ kind: "idea", text: "Hi" })
    expect(sent).toEqual([{ kind: "idea", text: "Hi" }])
    const failing = feedbackApp({ sendFeedback: () => Promise.reject(new Error("503")) })
    await expect(desktopFeedback(failing)!.send({ kind: null, text: "x" })).rejects.toThrow("503")
  })
})

describe("what the desktop app gives the backend", () => {
  it("is nothing in a browser but the pane's pages as pictures, not live", () => {
    expect(desktopOptions(undefined)).toEqual({ livePages: false })
  })

  it("passes the app's own calls through, each with what the page hands it", async () => {
    const calls: unknown[][] = []
    const note =
      (name: string, answer?: unknown) =>
      (...input: unknown[]) => {
        calls.push([name, ...input])
        return answer
      }
    const options = desktopOptions({
      livePages: true,
      pickDirectory: note("pick", Promise.resolve("/work")),
      beforeQuit: note("before quit", () => {}),
      showAppearance: note("appearance"),
      openLogs: note("logs"),
      pagePicture: note("picture"),
      lookAtPage: note("look"),
      pagePhone: note("phone"),
    } as unknown as DesktopApp)
    expect(options.livePages).toBe(true)
    expect(await options.pickDirectory!()).toBe("/work")
    const save = async () => {}
    options.beforeQuit!(save)
    options.showAppearance!({ dark: true } as never)
    options.openLogs!()
    options.pagePicture!("page" as never, 640)
    options.pageLook!({ url: "https://example.com", layout: "phone", before: 1 })
    options.pagePhone!("page" as never, true as never)
    expect(calls).toEqual([
      ["pick"],
      ["before quit", save],
      ["appearance", { dark: true }],
      ["logs"],
      ["picture", "page", 640],
      ["look", { url: "https://example.com", layout: "phone", before: 1 }],
      ["phone", "page", true],
    ])
    // The parts the app lacks are left off, not set to undefined.
    expect(Object.keys(options)).not.toContain("notices")
  })
})
