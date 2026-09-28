import type { EventEmitter } from "node:events"

import type { DesktopHost } from "@novadeck/protocol/bridge"
import { afterEach, beforeEach, vi } from "vitest"

import { apiUrlArgumentPrefix, saveBeforeQuitChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"

// Electron as the preload sees it: what it exposes to the page, and what it sends.
const electron = vi.hoisted(() => ({
  renderer: undefined as unknown as EventEmitter,
  exposed: undefined as unknown as DesktopHost,
  sent: [] as string[],
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
    ipcRenderer: Object.assign(renderer, {
      send: (channel: string) => void electron.sent.push(channel),
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
