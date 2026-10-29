import type { EventEmitter } from "node:events"

import { runnerPortMessage, type DesktopHost } from "@novadeck/protocol/bridge"
import { pageSignInChannel, pageSignInMessage } from "@novadeck/viewers/browser/sign-in"
import { pageRequestChannel, pageRequestMessage } from "@novadeck/viewers/browser/trouble"
import { afterEach, beforeEach, vi } from "vitest"

import {
  apiUrlArgumentPrefix,
  feedbackAboutChannel,
  feedbackArgumentPrefix,
  feedbackSendChannel,
  webglContextsArgumentPrefix,
  appearanceChannel,
  installAppChannel,
  badgeChannel,
  noticeChannel,
  noticeClickChannel,
  notificationsQuietChannel,
  noticeCloseChannel,
  dismissWhatsNewChannel,
  whatsNewChannel,
  openUpdatePageChannel,
  pageLookChannel,
  pagePictureChannel,
  pagePhoneChannel,
  portableChannel,
  portableStateChannel,
  quitAppChannel,
  openPortableDownloadChannel,
  showDataFolderChannel,
  updateNewsChannel,
  runnerPortChannel,
  sandboxChannel,
  saveBeforeQuitChannel,
  setUpdateChannelChannel,
  uninstallAppChannel,
  uninstallPlanChannel,
  updateChannelChannel,
  updateOfferChannel,
  updateRequestChannel,
  versionChannel,
  windowFocusChannel,
  windowFocusRequestChannel,
} from "../bridge.js"
import { context, describe, expect, it } from "../test"

// Electron as the preload sees it: what it exposes to the page, and what it sends.
const electron = vi.hoisted(() => ({
  renderer: undefined as unknown as EventEmitter,
  exposed: undefined as unknown as DesktopHost,
  sent: [] as string[],
  messages: [] as [string, ...unknown[]][],
  // What the main process answers a request with.
  answer: undefined as unknown,
}))

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  const renderer = new EventEmitter()
  electron.renderer = renderer
  return {
    contextBridge: {
      exposeInMainWorld: (_key: string, api: DesktopHost) => {
        electron.exposed = api
      },
    },
    // A file is one on this machine when it names its path; other files have none.
    webUtils: {
      getPathForFile: (file: { path?: string }) => {
        if (file.path === undefined) throw new TypeError("not a File")
        return file.path
      },
    },
    ipcRenderer: Object.assign(renderer, {
      send: (channel: string, ...values: unknown[]) => {
        electron.sent.push(channel)
        if (values.length) electron.messages.push([channel, values[0]])
      },
      invoke: async (channel: string, ...values: unknown[]) => {
        electron.sent.push(channel)
        if (values.length) electron.messages.push([channel, ...values])
        return electron.answer
      },
    }),
  }
})

const argument = `${apiUrlArgumentPrefix}http://127.0.0.1:4000/api/`

beforeEach(async () => {
  vi.resetModules()
  // Each test loads a fresh preload onto the same mocked ipcRenderer.
  electron.renderer?.removeAllListeners()
  electron.sent.length = 0
  electron.messages.length = 0
  electron.answer = undefined
  process.argv.push(argument)
  await import("./index")
})
afterEach(() => {
  process.argv.splice(process.argv.indexOf(argument), 1)
})

// The host asks the page to save before quitting, and counts the answers it got.
const askToSave = async (): Promise<number> => {
  electron.renderer.emit(saveBeforeQuitChannel)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return electron.sent.filter((channel) => channel === saveBeforeQuitChannel).length
}

describe("saving before quit, in the page", () => {
  it("answers once the page's save has finished", async () => {
    let finish!: () => void
    electron.exposed.beforeQuit(() => new Promise<void>((resolve) => (finish = resolve)))
    expect(await askToSave()).toBe(0)
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(electron.sent).toEqual([saveBeforeQuitChannel])
  })

  it("answers even when the save fails", async () => {
    electron.exposed.beforeQuit(() => Promise.reject(new Error("runner gone")))
    expect(await askToSave()).toBe(1)
  })

  context("when the page registered nothing", () => {
    it("answers at once", async () => {
      expect(await askToSave()).toBe(1)
    })
  })

  context("when a page unregisters", () => {
    it("clears only its own save, not one registered after it", async () => {
      const saves: string[] = []
      const unregisterFirst = electron.exposed.beforeQuit(async () => void saves.push("first"))
      const unregisterSecond = electron.exposed.beforeQuit(async () => void saves.push("second"))
      unregisterFirst()
      expect(await askToSave()).toBe(1)
      expect(saves).toEqual(["second"])
      unregisterSecond()
      expect(await askToSave()).toBe(2)
      expect(saves).toEqual(["second"])
    })
  })
})

describe("a port to the runner", () => {
  it("is asked for under the page's id, and reaches the page as a window message", () => {
    const posted = vi.fn<(message: unknown, origin: string, transfer: unknown[]) => void>()
    vi.stubGlobal("window", { postMessage: posted })
    try {
      electron.exposed.requestRunner("request-1")
      expect(electron.messages).toEqual([[runnerPortChannel, "request-1"]])
      const port = {}
      electron.renderer.emit(runnerPortChannel, { ports: [port] }, "request-1")
      expect(posted).toHaveBeenCalledWith({ type: runnerPortMessage, id: "request-1" }, "*", [port])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("a page view's sign-in windows", () => {
  const told = (...args: unknown[]) => {
    const posted = vi.fn<(message: unknown, origin: string) => void>()
    vi.stubGlobal("window", { postMessage: posted })
    try {
      electron.renderer.emit(pageSignInChannel, {}, ...args)
    } finally {
      vi.unstubAllGlobals()
    }
    return posted
  }

  it("reach the page as a window message naming its view and how many are open", () => {
    expect(told(7, 1)).toHaveBeenCalledExactlyOnceWith(
      { type: pageSignInMessage, contentsId: 7, open: 1 },
      "*",
    )
  })

  it("are dropped when the word is malformed", () => {
    expect(told("7", 1)).not.toHaveBeenCalled()
    expect(told(7, -1)).not.toHaveBeenCalled()
  })
})

describe("a request a page view failed", () => {
  const told = (...args: unknown[]) => {
    const posted = vi.fn<(message: unknown, origin: string) => void>()
    vi.stubGlobal("window", { postMessage: posted })
    try {
      electron.renderer.emit(pageRequestChannel, {}, ...args)
    } finally {
      vi.unstubAllGlobals()
    }
    return posted
  }

  it("reaches the page as a window message naming its view", () => {
    const posted = told(7, { url: "http://localhost/a.js", status: 404, what: "script", extra: 1 })
    expect(posted).toHaveBeenCalledExactlyOnceWith(
      {
        type: pageRequestMessage,
        contentsId: 7,
        url: "http://localhost/a.js",
        status: 404,
        what: "script",
      },
      "*",
    )
  })

  it("is clipped to what the runner takes, not refused", () => {
    const posted = told(7, {
      url: `http://x/${"u".repeat(3000)}`,
      status: 404,
      what: "w".repeat(40),
    })
    const [message] = posted.mock.calls[0]!
    expect(message).toMatchObject({ status: 404, what: "w".repeat(32) })
    expect((message as { url: string }).url).toHaveLength(2048)
  })

  it("reaches it only if it is what the viewer reads", () => {
    const failure = { url: "http://localhost/a.js", status: 404, what: "script" }
    for (const bad of [
      told("7", failure),
      told(7, null),
      told(7, "text"),
      told(7, { ...failure, status: "404" }),
      told(7, { ...failure, status: 1000 }),
      told(7, { ...failure, status: 4.5 }),
      told(7, { url: failure.url, status: 404 }),
    ])
      expect(bad).not.toHaveBeenCalled()
  })
})

describe("the page's appearance", () => {
  it("goes to the main process as its scheme and ground only", () => {
    const appearance = {
      scheme: "dark",
      ground: "#0f1114",
      extra: "dropped",
    } as const
    electron.exposed.showAppearance(appearance)
    expect(electron.messages).toEqual([[appearanceChannel, { scheme: "dark", ground: "#0f1114" }]])
  })
})

describe("a pasted file's path", () => {
  it("is its path on this machine", () => {
    const file = { path: "/home/me/my shot.png" } as unknown as File
    expect(electron.exposed.pathForFile?.(file)).toBe("/home/me/my shot.png")
  })

  it("is empty for a file that has none", () => {
    expect(electron.exposed.pathForFile?.({ path: "" } as unknown as File)).toBe("")
  })

  it("is empty for anything Electron can't take as a file", () => {
    expect(electron.exposed.pathForFile?.({} as unknown as File)).toBe("")
  })
})

describe("a picture of a live page", () => {
  it("is asked for by the page's view id, and comes back as a JPEG address", async () => {
    electron.answer = "data:image/jpeg;base64,AAAA"
    expect(await electron.exposed.pagePicture?.(7, 800)).toBe("data:image/jpeg;base64,AAAA")
    expect(electron.messages).toEqual([[pagePictureChannel, 7, 800]])
  })

  it("is nothing for anything else the main process answers", async () => {
    const answers = [undefined, "data:text/html,<script>", "https://example.com/a.jpg", 7]
    const pictures = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.pagePicture?.(7)
    })
    expect(await Promise.all(pictures)).toEqual(answers.map(() => undefined))
  })
})

describe("a look at a page loaded afresh", () => {
  const picture = "data:image/jpeg;base64,AAAA"
  const look = {
    picture,
    url: "http://localhost:5173/",
    title: "Home",
    size: { width: 1280, height: 800 },
    troubles: [{ kind: "load", text: "ERR_CONNECTION_REFUSED" }],
  }

  it("is asked for by its address and layout only, and comes back as the main process answered", async () => {
    electron.answer = look
    expect(
      await electron.exposed.lookAtPage?.({
        url: "http://localhost:5173/",
        layout: "phone",
        extra: "dropped",
      } as never),
    ).toEqual(look)
    expect(electron.messages).toEqual([
      [pageLookChannel, { url: "http://localhost:5173/", layout: "phone" }],
    ])
  })

  it("is a reason, and no picture, for anything else the main process answers", async () => {
    const answers = [
      undefined,
      "data:image/jpeg;base64,AAAA",
      { ...look, picture: "data:text/html,<script>" },
      { ...look, size: undefined },
      { reason: "Busy." },
    ]
    const looks = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.lookAtPage?.({ url: "http://localhost:5173/", layout: "desktop" })
    })
    expect(await Promise.all(looks)).toEqual([
      { reason: "The page could not be pictured." },
      { reason: "The page could not be pictured." },
      { reason: "The page could not be pictured." },
      { reason: "The page could not be pictured." },
      { reason: "Busy." },
    ])
  })
})

describe("a live page made a phone's", () => {
  it("is asked for by the page's view id, and did only when the main process says so", async () => {
    electron.answer = true
    expect(await electron.exposed.pagePhone?.(7, true)).toBe(true)
    expect(electron.messages).toEqual([[pagePhoneChannel, 7, true]])
    const answers = [false, undefined, "true", 1]
    const phones = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.pagePhone?.(7, false)
    })
    expect(await Promise.all(phones)).toEqual(answers.map(() => false))
  })
})

describe("a notice about a terminal", () => {
  it("goes to the main process as its id, title and body only", () => {
    const notice = {
      id: "01",
      title: "t1 is done: Tests",
      body: "All green.",
      icon: "x",
    }
    electron.exposed.showNotice?.(notice)
    expect(electron.messages).toEqual([
      [noticeChannel, { id: "01", title: "t1 is done: Tests", body: "All green." }],
    ])
  })

  it("comes back once clicked as the terminal's id, and only that, until the page stops", () => {
    const clicks: string[] = []
    const stop = electron.exposed.onNoticeClick!((id) => clicks.push(id))
    electron.renderer.emit(noticeClickChannel, {}, "01")
    electron.renderer.emit(noticeClickChannel, {}, { id: "02" })
    stop()
    electron.renderer.emit(noticeClickChannel, {}, "03")
    expect(clicks).toEqual(["01"])
  })
})

describe("closing a notice and the icon's badge", () => {
  it("send the terminal id, and only a valid badge", () => {
    electron.exposed.closeNotice?.("01")
    electron.exposed.setBadge?.({ count: 3, image: null, extra: 1 } as never)
    electron.exposed.setBadge?.({ count: 1000, image: null })
    expect(electron.messages).toEqual([
      [noticeCloseChannel, "01"],
      [badgeChannel, { count: 3, image: null }],
    ])
  })
})

describe("notifications that play the sound", () => {
  it("is only macOS, the platform the test runs on", () => {
    expect(electron.exposed.notificationsSound).toBe(process.platform === "darwin")
  })

  it("sends the person's silent choice with a notice", () => {
    electron.exposed.showNotice?.({ id: "01", title: "t", body: "", silent: true })
    expect(electron.messages.at(-1)).toEqual([
      noticeChannel,
      { id: "01", title: "t", body: "", silent: true },
    ])
  })
})

describe("the sound a notice names", () => {
  it("is sent with the notice for the main process to check", () => {
    electron.exposed.showNotice?.({ id: "01", title: "t", body: "", sound: "afterglow" })
    expect(electron.messages.at(-1)).toEqual([
      noticeChannel,
      { id: "01", title: "t", body: "", silent: undefined, sound: "afterglow" },
    ])
  })
})

describe("asking whether notifications are held back", () => {
  it("passes a boolean answer, and anything else is false", async () => {
    electron.answer = true
    expect(await electron.exposed.notificationsQuiet?.()).toBe(true)
    electron.answer = "yes"
    expect(await electron.exposed.notificationsQuiet?.()).toBe(false)
    expect(electron.sent.filter((channel) => channel === notificationsQuietChannel)).toHaveLength(2)
  })
})

describe("the window's focus", () => {
  it("is asked for once the page listens", () => {
    electron.exposed.onWindowFocus!(() => {})
    expect(electron.sent).toEqual([windowFocusRequestChannel])
  })

  it("comes back as a boolean, and only that, until the page stops", () => {
    const states: boolean[] = []
    const stop = electron.exposed.onWindowFocus!((focused) => states.push(focused))
    electron.renderer.emit(windowFocusChannel, {}, true)
    electron.renderer.emit(windowFocusChannel, {}, "yes")
    electron.renderer.emit(windowFocusChannel, {}, false)
    stop()
    electron.renderer.emit(windowFocusChannel, {}, true)
    expect(states).toEqual([true, false])
  })
})

const ready = { kind: "ready", version: "1.2.3" }

describe("an update offer", () => {
  it("asks the host for the last one once the page listens", () => {
    electron.exposed.onUpdate!(() => {})
    expect(electron.sent).toEqual([updateRequestChannel])
  })

  it("comes back as an offer until the page stops", () => {
    const offers: unknown[] = []
    const stop = electron.exposed.onUpdate!((offer) => offers.push(offer))
    electron.renderer.emit(updateOfferChannel, {}, ready)
    electron.renderer.emit(updateOfferChannel, {}, { ...ready, kind: "available" })
    stop()
    electron.renderer.emit(updateOfferChannel, {}, ready)
    expect(offers).toEqual([ready, { ...ready, kind: "available" }])
  })

  it("carries a download's percent, and only a download's", () => {
    const offers: unknown[] = []
    electron.exposed.onUpdate!((offer) => offers.push(offer))
    const downloading = { ...ready, kind: "downloading" }
    electron.renderer.emit(updateOfferChannel, {}, { ...downloading, percent: 42 })
    electron.renderer.emit(updateOfferChannel, {}, { ...ready, percent: 42 })
    expect(offers).toEqual([{ ...downloading, percent: 42 }, ready])
  })

  it("drops a download whose percent is not a whole number from 0 to 100", () => {
    const offers: unknown[] = []
    electron.exposed.onUpdate!((offer) => offers.push(offer))
    for (const percent of [undefined, -1, 101, 4.5, NaN, "42", null])
      electron.renderer.emit(updateOfferChannel, {}, { ...ready, kind: "downloading", percent })
    expect(offers).toEqual([])
  })

  it("is dropped unless its kind and version are valid", () => {
    const offers: unknown[] = []
    electron.exposed.onUpdate!((offer) => offers.push(offer))
    for (const value of [
      undefined,
      "1.2.3",
      null,
      { ...ready, kind: "install" },
      { ...ready, kind: undefined },
      { ...ready, version: "1.2.3 <b>" },
      { ...ready, version: "v1.2.3" },
      { ...ready, version: 123 },
      { kind: "ready", notes: [] },
    ])
      electron.renderer.emit(updateOfferChannel, {}, value)
    expect(offers).toEqual([])
  })

  it("passes on every kind of offer, and drops what the host sent beyond the contract", () => {
    const offers: unknown[] = []
    electron.exposed.onUpdate!((offer) => offers.push(offer))
    for (const kind of ["ready", "retrying", "available"])
      electron.renderer.emit(updateOfferChannel, {}, { ...ready, kind, notes: ["Gone."] })
    expect(offers).toEqual(
      ["ready", "retrying", "available"].map((kind) => ({ kind, version: "1.2.3" })),
    )
  })

  it("has its release page opened by asking the host, naming nothing", () => {
    electron.exposed.openUpdatePage!()
    expect(electron.sent).toEqual([openUpdatePageChannel])
    expect(electron.messages).toEqual([])
  })
})

describe("the update channel", () => {
  it("is what the host answers, when it is a channel", async () => {
    electron.answer = "experimental"
    expect(await electron.exposed.updateChannel!()).toBe("experimental")
    expect(electron.sent).toEqual([updateChannelChannel])
  })

  it("is stable when the host answers anything else", async () => {
    const answers = [undefined, "nightly", { channel: "experimental" }, 3]
    const channels = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.updateChannel!()
    })
    expect(await Promise.all(channels)).toEqual(answers.map(() => "stable"))
  })

  it("is switched by telling the host a known channel", () => {
    electron.exposed.setUpdateChannel!("experimental")
    expect(electron.messages).toEqual([[setUpdateChannelChannel, "experimental"]])
  })

  it("sends nothing for anything else", () => {
    for (const value of ["nightly", undefined, {}, 3, "Early"])
      electron.exposed.setUpdateChannel!(value as never)
    expect(electron.sent).toEqual([])
  })
})

describe("what is new", () => {
  it("is what the host answers, when the contract allows it", async () => {
    electron.answer = {
      version: "0.5.0",
      highlights: [{ title: "Faster", line: "Grid is quick." }],
    }
    expect(await electron.exposed.whatsNew!()).toEqual(electron.answer)
    expect(electron.sent).toEqual([whatsNewChannel])
  })

  it("is nothing when the host answers anything else, dropping the highlights that break it", async () => {
    const answers = [
      undefined,
      "0.5.0",
      { version: "latest", highlights: [{ title: "T", line: "L" }] },
      { version: "0.5.0", highlights: [] },
      { version: "0.5.0", highlights: [{ title: "", line: "L" }, { title: "T" }] },
    ]
    const results = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.whatsNew!()
    })
    expect(await Promise.all(results)).toEqual(answers.map(() => undefined))
    electron.answer = {
      version: "0.5.0",
      highlights: [
        { title: "", line: "L" },
        { title: "Kept", line: "Line", prs: [1] },
      ],
    }
    expect(await electron.exposed.whatsNew!()).toEqual({
      version: "0.5.0",
      highlights: [{ title: "Kept", line: "Line" }],
    })
  })

  it("tells the host of a dismissal, naming nothing", () => {
    electron.exposed.dismissWhatsNew!()
    expect(electron.sent).toEqual([dismissWhatsNewChannel])
    expect(electron.messages).toEqual([])
  })
})

describe("the version", () => {
  it("is what the host answers, when it looks like a release's", async () => {
    electron.answer = "0.4.2"
    expect(await electron.exposed.version!()).toBe("0.4.2")
    expect(electron.sent).toEqual([versionChannel])
  })

  it("is refused when the host answers anything else", async () => {
    const answers = [undefined, "", "latest", "0.4.2\n<b>", { version: "0.4.2" }, 3]
    const asked = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.version!()
    })
    await Promise.all(asked.map((each) => expect(each).rejects.toThrow("Unknown version")))
  })
})

describe("the sandbox", () => {
  it("is what the host answers, asked for without naming anything", async () => {
    electron.answer = { sandboxed: false, fix: "curl -fsSL x | sh" }
    expect(await electron.exposed.sandbox!()).toEqual({
      sandboxed: false,
      fix: "curl -fsSL x | sh",
    })
    expect(electron.sent).toEqual([sandboxChannel])
  })

  it("is on when the host answers anything else", async () => {
    const answers = [undefined, "off", 3, { sandboxed: "no" }, { fix: "x" }]
    const states = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.sandbox!()
    })
    expect(await Promise.all(states)).toEqual(answers.map(() => ({ sandboxed: true })))
  })

  it("is off without a command when the command is not one line of reasonable length", async () => {
    const fixes = [undefined, 3, "a\nb", "a".repeat(301)]
    const states = fixes.map((fix) => {
      electron.answer = { sandboxed: false, fix }
      return electron.exposed.sandbox!()
    })
    expect(await Promise.all(states)).toEqual(fixes.map(() => ({ sandboxed: false, fix: "" })))
  })
})

const portableState = (install: unknown) => ({
  portable: true,
  version: "1.2.3",
  run: "0a1b-2c3d",
  install,
})

describe("whether this copy is portable", () => {
  it("is what the host answers when it is a portable copy of a release version", async () => {
    electron.answer = { ...portableState({ phase: "installing" }), extra: "dropped" }
    expect(await electron.exposed.portable!()).toEqual(portableState({ phase: "installing" }))
    expect(electron.sent).toEqual([portableChannel])
  })

  it("carries each phase of the install the contract allows", async () => {
    const installs = [
      { phase: "idle" },
      { phase: "downloading", percent: 42 },
      { phase: "installing" },
      { phase: "installed" },
      { phase: "newer", version: "1.2.4" },
      { phase: "failed", reason: "There is no space left on the disk." },
    ]
    const states = installs.map((install) => {
      electron.answer = portableState({ ...install, extra: 1 })
      return electron.exposed.portable!()
    })
    expect(await Promise.all(states)).toEqual(installs.map(portableState))
  })

  it("carries where the workspace is, leaving out a data folder that is no path", async () => {
    electron.answer = { ...portableState({ phase: "idle" }), dataFolder: "~/.config/novadeck" }
    expect(await electron.exposed.portable!()).toEqual(electron.answer)
    electron.answer = { ...portableState({ phase: "idle" }), dataFolder: "bell\u0007" }
    expect(await electron.exposed.portable!()).toEqual(portableState({ phase: "idle" }))
  })

  it("cleans a failure's reason into one short plain line, or shows an unknown one", async () => {
    const reasons = [undefined, "", "  \n ", "bell\u0007 ring\nagain", "x".repeat(400)]
    const states = reasons.map((reason) => {
      electron.answer = portableState({ phase: "failed", reason })
      return electron.exposed.portable!()
    })
    const reasonsSeen = (await Promise.all(states)).map((state) =>
      state.portable && state.install.phase === "failed" ? state.install.reason : undefined,
    )
    expect(reasonsSeen).toEqual([
      "Something went wrong.",
      "Something went wrong.",
      "Something went wrong.",
      "bell ring again",
      `${"x".repeat(299)}…`,
    ])
  })

  it("is not portable when the host answers anything else", async () => {
    const answers = [
      undefined,
      "portable",
      { portable: true },
      { portable: true, version: "1.2.3", install: { phase: "idle" } },
      { ...portableState({ phase: "idle" }), run: "not a run!" },
      { ...portableState({ phase: "idle" }), version: "v1" },
      { ...portableState({ phase: "idle" }), portable: "true" },
      { ...portableState({ phase: "idle" }), install: undefined },
      portableState({ phase: "done" }),
      portableState({ phase: "downloading" }),
      portableState({ phase: "downloading", percent: 40.5 }),
      portableState({ phase: "downloading", percent: 101 }),
      portableState({ phase: "newer", version: "latest" }),
    ]
    const states = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.portable!()
    })
    expect(await Promise.all(states)).toEqual(answers.map(() => ({ portable: false })))
  })
})

describe("installing the app from a portable copy", () => {
  it("tells the host, naming nothing, and expects no answer", () => {
    expect(electron.exposed.installApp!()).toBeUndefined()
    expect(electron.sent).toEqual([installAppChannel])
    expect(electron.messages).toEqual([])
  })
})

describe("the portable copy's links", () => {
  it("tells the host, naming nothing, for each of its requests, and expects no answer", () => {
    expect(electron.exposed.openPortableDownload!()).toBeUndefined()
    expect(electron.exposed.showDataFolder!()).toBeUndefined()
    expect(electron.sent).toEqual([openPortableDownloadChannel, showDataFolderChannel])
    expect(electron.messages).toEqual([])
  })
})

describe("what is new in the offered version", () => {
  it("is what the host answers, when the contract allows it", async () => {
    electron.answer = {
      version: "0.6.0",
      from: "0.5.0",
      highlights: [{ title: "Faster", line: "Grid is quick." }],
    }
    expect(await electron.exposed.updateNews!()).toEqual(electron.answer)
    expect(electron.sent).toEqual([updateNewsChannel])
  })

  it("is nothing when the host answers anything else", async () => {
    const answers = [
      undefined,
      "0.6.0",
      { version: "latest", highlights: [] },
      { version: "0.6.0" },
    ]
    const results = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.updateNews!()
    })
    expect(await Promise.all(results)).toEqual(answers.map(() => undefined))
  })
})

describe("the portable state, pushed", () => {
  it("passes on a valid state until the page stops, and drops a broken one", () => {
    const seen: unknown[] = []
    const stop = electron.exposed.onPortableState!((state) => seen.push(state))
    const downloading = portableState({ phase: "downloading", percent: 40 })
    const installed = portableState({ phase: "installed" })
    electron.renderer.emit(portableStateChannel, {}, { ...downloading, extra: 1 })
    electron.renderer.emit(portableStateChannel, {}, installed)
    electron.renderer.emit(portableStateChannel, {}, { portable: true, version: "v1" })
    electron.renderer.emit(portableStateChannel, {}, portableState({ phase: "downloading" }))
    stop()
    electron.renderer.emit(portableStateChannel, {}, installed)
    expect(seen).toEqual([downloading, installed])
  })
})

describe("uninstalling the app", () => {
  it("passes on the plan the contract allows", async () => {
    const answers = [
      { kind: "unavailable" },
      { kind: "manual", command: "brew uninstall --cask novadeck" },
      { kind: "ready", dataFolders: ["/home/me/.config/novadeck"], handoff: "app" },
      { kind: "ready", dataFolders: [], handoff: "uninstaller" },
    ]
    const plans = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.uninstallPlan!()
    })
    expect(await Promise.all(plans)).toEqual(answers)
    expect(electron.sent).toEqual(answers.map(() => uninstallPlanChannel))
  })

  it("counts any other plan as unavailable", async () => {
    const answers = [
      undefined,
      "ready",
      { kind: "manual" },
      { kind: "manual", command: "rm -rf /\u0007" },
      { kind: "ready", dataFolders: ["/a"], handoff: "root" },
      { kind: "ready", dataFolders: "/a", handoff: "app" },
      { kind: "ready", dataFolders: [1], handoff: "app" },
      { kind: "ready", dataFolders: ["bell\u0007"], handoff: "app" },
      { kind: "ready", dataFolders: Array.from({ length: 9 }, () => "/a"), handoff: "app" },
    ]
    const plans = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.uninstallPlan!()
    })
    expect(await Promise.all(plans)).toEqual(answers.map(() => ({ kind: "unavailable" })))
  })

  it("asks the host to keep the data unless the page says exactly not to", async () => {
    electron.answer = { kind: "removed" }
    await electron.exposed.uninstallApp!({ keepData: false })
    await electron.exposed.uninstallApp!({ keepData: true })
    await electron.exposed.uninstallApp!({} as { keepData: boolean })
    expect(electron.messages).toEqual([
      [uninstallAppChannel, { keepData: false }],
      [uninstallAppChannel, { keepData: true }],
      [uninstallAppChannel, { keepData: true }],
    ])
  })

  it("passes on the result the contract allows, less a leftover that is not a line", async () => {
    const answers = [
      { kind: "uninstalling" },
      { kind: "removed" },
      { kind: "removed", leftover: "sudo rm -f /etc/apparmor.d/novadeck-appimage-1000" },
      { kind: "failed", reason: "The folder is read-only." },
    ]
    const results = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.uninstallApp!({ keepData: true })
    })
    expect(await Promise.all(results)).toEqual(answers)
    electron.answer = { kind: "removed", leftover: "a\nb" }
    expect(await electron.exposed.uninstallApp!({ keepData: true })).toEqual({ kind: "removed" })
  })

  it("is a failure when the host answers anything else", async () => {
    const failed = { kind: "failed", reason: "Something went wrong." }
    const answers = [
      undefined,
      "removed",
      { kind: "gone" },
      { kind: "failed" },
      { kind: "failed", reason: "x".repeat(301) },
    ]
    const results = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.uninstallApp!({ keepData: true })
    })
    expect(await Promise.all(results)).toEqual(answers.map(() => failed))
  })

  it("quits by asking the host, naming nothing", () => {
    electron.exposed.quitApp!()
    expect(electron.sent).toEqual([quitAppChannel])
    expect(electron.messages).toEqual([])
  })
})

describe("the WebGL context limit", () => {
  const loadWith = async (value: string | undefined): Promise<DesktopHost> => {
    const given = value === undefined ? [] : [`${webglContextsArgumentPrefix}${value}`]
    process.argv.push(...given)
    vi.resetModules()
    await import("./index")
    process.argv.splice(process.argv.length - given.length, given.length)
    return electron.exposed
  }

  it("is told to the page when the host gives a valid one", async () => {
    expect((await loadWith("64")).webglContexts).toBe(64)
  })

  it.each([undefined, "", "2", "9999", "64.5", "lots"])("is left out for %j", async (value) => {
    expect(await loadWith(value)).not.toHaveProperty("webglContexts")
  })
})

describe("feedback", () => {
  const loadWith = async (given: string[]): Promise<DesktopHost> => {
    process.argv.push(...given)
    vi.resetModules()
    await import("./index")
    process.argv.splice(process.argv.length - given.length, given.length)
    return electron.exposed
  }

  it("is offered only when the host says it sends notes", async () => {
    expect((await loadWith([`${feedbackArgumentPrefix}1`])).feedback).toBe(true)
    expect(await loadWith([])).not.toHaveProperty("feedback")
    expect(await loadWith([`${feedbackArgumentPrefix}0`])).not.toHaveProperty("feedback")
  })

  it("hands a note to the host as its kind and text alone", async () => {
    electron.messages.length = 0
    await electron.exposed.sendFeedback!({ kind: "bug", text: "x", extra: 1 } as never)
    expect(electron.sent).toEqual([feedbackSendChannel])
    expect(electron.messages).toEqual([[feedbackSendChannel, { kind: "bug", text: "x" }]])
  })

  it("asks the host what goes along with a note", async () => {
    const about = { version: "1.0.0", os: "linux", arch: "x64" }
    electron.answer = about
    expect(await electron.exposed.feedbackAbout!()).toEqual(about)
    expect(electron.sent).toEqual([feedbackAboutChannel])
  })
})
