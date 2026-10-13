import type { EventEmitter } from "node:events"

import { updateNoteLength, updateNotesLength, type DesktopHost } from "@novadeck/protocol/bridge"
import { afterEach, beforeEach, vi } from "vitest"

import {
  apiUrlArgumentPrefix,
  appearanceChannel,
  installAppChannel,
  installUpdateChannel,
  noticeChannel,
  noticeClickChannel,
  openInstalledChannel,
  openUpdatePageChannel,
  portableChannel,
  sandboxChannel,
  saveBeforeQuitChannel,
  setUpdateChannelChannel,
  updateChannelChannel,
  updateOfferChannel,
  updateRequestChannel,
  versionChannel,
} from "../bridge.js"
import { context, describe, expect, it } from "../test"

// Electron as the preload sees it: what it exposes to the page, and what it sends.
const electron = vi.hoisted(() => ({
  renderer: undefined as unknown as EventEmitter,
  exposed: undefined as unknown as DesktopHost,
  sent: [] as string[],
  messages: [] as [string, unknown][],
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
      invoke: async (channel: string) => {
        electron.sent.push(channel)
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

const ready = { kind: "ready", version: "1.2.3", notes: ["Faster.", "Fixes."] }

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

  it("carries the date the copy fell behind when it is an ISO date-time, and drops any other", () => {
    const offers: unknown[] = []
    electron.exposed.onUpdate!((offer) => offers.push(offer))
    const outdatedSince = "2026-10-01T09:30:00.000Z"
    for (const value of [outdatedSince, "yesterday", "2026-10-01", 20261001, undefined])
      electron.renderer.emit(updateOfferChannel, {}, { ...ready, outdatedSince: value })
    expect(offers).toEqual([{ ...ready, outdatedSince }, ready, ready, ready, ready])
  })

  it("carries only the notes the contract allows", () => {
    const offers: (readonly string[])[] = []
    electron.exposed.onUpdate!((offer) => offers.push(offer.notes))
    const notes = [
      "Fine.",
      3,
      null,
      "",
      "line\nbreak",
      "bell\u0007",
      "\u202eflipped",
      "x".repeat(updateNoteLength + 1),
      "x".repeat(updateNoteLength),
      ...Array.from({ length: 30 }, (_, index) => `Note ${index}`),
    ]
    electron.renderer.emit(updateOfferChannel, {}, { ...ready, notes })
    electron.renderer.emit(updateOfferChannel, {}, { ...ready, notes: "not a list" })
    expect(offers[0]!).toHaveLength(updateNotesLength)
    expect(offers[0]!.slice(0, 2)).toEqual(["Fine.", "x".repeat(updateNoteLength)])
    expect(offers[1]!).toEqual([])
  })

  it("is installed by asking the host", () => {
    electron.exposed.installUpdate!()
    expect(electron.sent).toEqual([installUpdateChannel])
  })

  it("has its release page opened by asking the host, naming nothing", () => {
    electron.exposed.openUpdatePage!()
    expect(electron.sent).toEqual([openUpdatePageChannel])
    expect(electron.messages).toEqual([])
  })
})

describe("the update channel", () => {
  it("is what the host answers, when it is a channel", async () => {
    electron.answer = "early"
    expect(await electron.exposed.updateChannel!()).toBe("early")
    expect(electron.sent).toEqual([updateChannelChannel])
  })

  it("is stable when the host answers anything else", async () => {
    const answers = [undefined, "nightly", { channel: "early" }, 3]
    const channels = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.updateChannel!()
    })
    expect(await Promise.all(channels)).toEqual(answers.map(() => "stable"))
  })

  it("is switched by telling the host a known channel", () => {
    electron.exposed.setUpdateChannel!("early")
    expect(electron.messages).toEqual([[setUpdateChannelChannel, "early"]])
  })

  it("sends nothing for anything else", () => {
    for (const value of ["nightly", undefined, {}, 3, "Early"])
      electron.exposed.setUpdateChannel!(value as never)
    expect(electron.sent).toEqual([])
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

describe("whether this copy is portable", () => {
  it("is what the host answers when it is a portable copy of a release version", async () => {
    electron.answer = { portable: true, version: "1.2.3", run: "0a1b-2c3d", extra: "dropped" }
    expect(await electron.exposed.portable!()).toEqual({
      portable: true,
      version: "1.2.3",
      run: "0a1b-2c3d",
    })
    expect(electron.sent).toEqual([portableChannel])
  })

  it("is not portable when the host answers anything else", async () => {
    const answers = [
      undefined,
      "portable",
      { portable: false, version: "1.2.3", run: "0a1b-2c3d" },
      { portable: true },
      { portable: true, version: "1.2.3" },
      { portable: true, version: "1.2.3", run: "not a run!" },
      { portable: true, version: "v1", run: "0a1b-2c3d" },
      { portable: "true", version: "1.2.3", run: "0a1b-2c3d" },
    ]
    const states = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.portable!()
    })
    expect(await Promise.all(states)).toEqual(answers.map(() => ({ portable: false })))
  })
})

describe("installing the app from a portable copy", () => {
  it("asks the host, naming nothing, and passes on what the contract allows", async () => {
    const answers = [
      { kind: "installing" },
      { kind: "newer", version: "1.2.4" },
      { kind: "failed", reason: "There is no space left on the disk." },
    ]
    const results = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.installApp!()
    })
    expect(await Promise.all(results)).toEqual(answers)
    expect(electron.sent).toEqual([installAppChannel, installAppChannel, installAppChannel])
  })

  it("is a failure when the host answers anything else", async () => {
    const failed = { kind: "failed", reason: "Something went wrong." }
    const answers = [
      undefined,
      "installing",
      { kind: "done" },
      { kind: "newer", version: "latest" },
      { kind: "failed" },
      { kind: "failed", reason: "bell\u0007" },
      { kind: "failed", reason: "x".repeat(301) },
    ]
    const results = answers.map((answer) => {
      electron.answer = answer
      return electron.exposed.installApp!()
    })
    expect(await Promise.all(results)).toEqual(answers.map(() => failed))
  })

  it("opens the installed copy by asking the host, naming nothing", () => {
    electron.exposed.openInstalled!()
    expect(electron.sent).toEqual([openInstalledChannel])
    expect(electron.messages).toEqual([])
  })
})
