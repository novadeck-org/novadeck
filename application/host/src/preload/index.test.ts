import type { EventEmitter } from "node:events"

import type { DesktopHost } from "@novadeck/protocol/bridge"
import { afterEach, beforeEach, vi } from "vitest"

import {
  apiUrlArgumentPrefix,
  appearanceChannel,
  noticeChannel,
  noticeClickChannel,
  saveBeforeQuitChannel,
} from "../bridge.js"
import { context, describe, expect, it } from "../test"

// Electron as the preload sees it: what it exposes to the page, and what it sends.
const electron = vi.hoisted(() => ({
  renderer: undefined as unknown as EventEmitter,
  exposed: undefined as unknown as DesktopHost,
  sent: [] as string[],
  messages: [] as [string, unknown][],
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
      invoke: async () => undefined,
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
    const appearance = { scheme: "dark", ground: "#0f1114", extra: "dropped" } as const
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
    const notice = { id: "01", title: "t1 is done: Tests", body: "All green.", icon: "x" }
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
