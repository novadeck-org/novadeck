import { describe, expect, it } from "../test.js"
import { keptPreferences } from "./preferences.js"
import { WorkspaceStore } from "./store.js"

describe("the person's preferences", () => {
  it("tells a stream every preference as it is read, missing none changed before it was", async () => {
    const store = new WorkspaceStore()
    const preferences = keptPreferences(store.settings)
    const controller = new AbortController()
    const stream = preferences.watch(controller.signal)
    // Changed after the stream was asked for, before it was first read.
    preferences.set({ key: "appearance", value: '"dusk"', writer: "a" })
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { values: { appearance: '"dusk"' }, revision: 1, writer: null },
    })
    const next = stream.next()
    preferences.set({ key: "chat-view", value: "true", writer: "b" })
    await expect(next).resolves.toEqual({
      done: false,
      value: { values: { "chat-view": "true" }, revision: 2, writer: "b" },
    })
    controller.abort()
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    store.close()
  })

  it("folds changes a slow reader missed, key by key, naming a writer only where one's alone", async () => {
    const store = new WorkspaceStore()
    const preferences = keptPreferences(store.settings)
    const controller = new AbortController()
    const stream = preferences.watch(controller.signal)
    await stream.next()
    preferences.set({ key: "appearance", value: '"dusk"', writer: "a" })
    preferences.set({ key: "appearance", value: '"noon"', writer: "b" })
    preferences.set({ key: "chat-view", value: "true", writer: "b" })
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { values: { appearance: '"noon"', "chat-view": "true" }, revision: 3, writer: null },
    })
    controller.abort()
    store.close()
  })
})
