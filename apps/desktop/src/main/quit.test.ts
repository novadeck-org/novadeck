import { EventEmitter } from "node:events"

import type { IpcMainEvent } from "electron"
import { afterEach, beforeEach, vi } from "vitest"

import { saveBeforeQuitChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import {
  beforeQuit,
  quitOnShutdown,
  saveBeforeClose,
  saveOnSessionEnd,
  savePages,
  shutDownInOrder,
} from "./quit"
import { notQuitting, type Quitting } from "./quitting"
import type { RunnerEnd } from "./runner"

// A page's WebContents as saving sees it: the requests it gets and its lifecycle events.
class FakePage extends EventEmitter {
  asked = 0
  send(channel: string): void {
    if (channel === saveBeforeQuitChannel) this.asked += 1
  }
  // Listeners saving left behind.
  listening(): number {
    return this.listenerCount("destroyed") + this.listenerCount("render-process-gone")
  }
}

// Pages answering over a stand-in for ipcMain.
const quitting = (count: number) => {
  const ipc = new EventEmitter()
  const pages = Array.from({ length: count }, () => new FakePage())
  let done = false
  const saved = savePages(ipc, pages, {
    sender: (event) => (event as unknown as { page?: FakePage }).page,
    timeoutMs: 1_500,
  }).then(() => {
    done = true
  })
  const answer = (page: FakePage | undefined) =>
    ipc.emit(saveBeforeQuitChannel, { page } as unknown as IpcMainEvent)
  return {
    pages,
    saved,
    answer,
    done: () => done,
    listening: () =>
      ipc.listenerCount(saveBeforeQuitChannel) +
      pages.reduce((sum, page) => sum + page.listening(), 0),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("saving before quit", () => {
  it("asks every page and goes on once each has answered", async () => {
    const app = quitting(2)
    expect(app.pages.map((page) => page.asked)).toEqual([1, 1])
    app.answer(app.pages[0])
    await vi.advanceTimersByTimeAsync(0)
    expect(app.done()).toBe(false)
    app.answer(app.pages[1])
    await app.saved
    expect(app.listening()).toBe(0)
  })

  it("ignores answers from anything but the app's own pages", async () => {
    const app = quitting(1)
    app.answer(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(app.done()).toBe(false)
  })

  context("when a page goes away before answering", () => {
    it.each(["destroyed", "render-process-gone"])("stops waiting for it once %s", async (gone) => {
      const app = quitting(2)
      app.answer(app.pages[0])
      app.pages[1]!.emit(gone)
      await app.saved
      expect(app.listening()).toBe(0)
    })
  })

  context("when a page does not answer", () => {
    it("goes on after the wait, so quitting cannot hang", async () => {
      const app = quitting(1)
      await vi.advanceTimersByTimeAsync(1_499)
      expect(app.done()).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(app.done()).toBe(true)
      expect(app.listening()).toBe(0)
    })
  })

  context("with no page open", () => {
    it("goes on at once", async () => {
      const app = quitting(0)
      await app.saved
      expect(app.done()).toBe(true)
    })
  })
})

// A window whose `close()` emits `close` as Electron does, closing unless prevented.
class FakeWindow extends EventEmitter {
  closed = 0
  destroyed = false
  close(): void {
    let prevented = false
    this.emit("close", { preventDefault: () => (prevented = true) })
    if (!prevented) this.closed += 1
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

// A window guarded by `saveBeforeClose`, whose saves finish when the test says.
const guarded = (quits = false) => {
  const window = new FakeWindow()
  const saves: (() => void)[] = []
  saveBeforeClose(
    window,
    () => new Promise<void>((resolve) => saves.push(resolve)),
    () => quits,
  )
  return { window, saves }
}

describe("saving before a window closes", () => {
  it("closes once its page saved", async () => {
    const { window, saves } = guarded()
    window.close()
    expect([window.closed, saves.length]).toEqual([0, 1])
    saves[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(window.closed).toBe(1)
  })

  it("waits with the first save when asked to close again meanwhile", async () => {
    const { window, saves } = guarded()
    window.close()
    window.close()
    expect([window.closed, saves.length]).toEqual([0, 1])
    saves[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect([window.closed, saves.length]).toEqual([1, 1])
  })

  it("does not close a window that went away while its page saved", async () => {
    const { window, saves } = guarded()
    window.close()
    window.destroyed = true
    saves[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(window.closed).toBe(0)
  })

  context("while the app quits", () => {
    it("closes at once, as quitting already saved every page", () => {
      const { window, saves } = guarded(true)
      window.close()
      expect([window.closed, saves.length]).toEqual([1, 0])
    })
  })
})

describe("the operating system ending the session", () => {
  context("on Linux and macOS", () => {
    it("holds the shutdown back and quits, which saves on the way out", () => {
      const power = new EventEmitter()
      const quit = vi.fn<() => void>()
      quitOnShutdown(power, quit)
      const preventDefault = vi.fn<() => void>()
      power.emit("shutdown", { preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(quit).toHaveBeenCalledOnce()
    })
  })

  context("on Windows", () => {
    it("saves while the shells still run once the session may end, and quits when it does", () => {
      const window = new EventEmitter()
      const calls: string[] = []
      saveOnSessionEnd(window, { save: () => calls.push("save"), quit: () => calls.push("quit") })
      window.emit("query-session-end", {})
      expect(calls).toEqual(["save"])
      window.emit("session-end", {})
      expect(calls).toEqual(["save", "quit"])
    })
  })
})

// A quit whose steps write down what ran, in order, over the real shutdown; a step named in
// `fails` rejects as it runs.
const quit = ({
  held = false,
  hosting = true,
  platform = "linux",
  state = notQuitting(),
  fails = [],
  closeRunner,
  closeServer,
  ended = "closed",
}: {
  readonly held?: boolean
  readonly hosting?: boolean
  readonly platform?: NodeJS.Platform
  readonly state?: Quitting
  readonly fails?: readonly string[]
  readonly closeRunner?: () => Promise<RunnerEnd> | undefined
  readonly closeServer?: () => Promise<void> | undefined
  readonly ended?: RunnerEnd
} = {}) => {
  const calls: string[] = []
  const step = (name: string) => (): void => {
    calls.push(name)
  }
  const waited = (name: string) => async (): Promise<void> => {
    calls.push(name)
    if (fails.includes(name)) throw new Error(`${name} failed`)
  }
  const run = () =>
    beforeQuit(
      { preventDefault: step("hold") },
      {
        quitting: state,
        held: () => held,
        announce: step("announce"),
        // Named apart once the app is marked as stopping: on Linux this is what swaps the
        // AppImage, which it does only before that.
        begin: () => {
          calls.push(state.stopping ? "begin again" : "begin")
        },
        hosting: () => hosting,
        shutDown: () =>
          shutDownInOrder({
            platform,
            persist: () => {
              calls.push("persist")
              if (fails.includes("persist")) throw new Error("persist failed")
            },
            // Named apart if the app isn't marked as stopping yet, which a shutdown must see.
            save: async () => {
              calls.push(state.stopping ? "save" : "save before stopping")
              if (fails.includes("save")) throw new Error("save failed")
            },
            closeRunner:
              closeRunner ??
              (async () => {
                await waited("close runner")()
                return ended
              }),
            closeServer: closeServer ?? waited("close server"),
          }),
        installMacUpdate: waited("install"),
        reopenAppImage: waited("reopen"),
        reopenCurrent: waited("reopen current"),
        keepUpdate: () => {
          calls.push("keep update")
          if (fails.includes("keep update")) throw new Error("keep update failed")
        },
        quit: step("quit"),
      },
    )
  return { calls, state, run }
}

describe("the app's quit", () => {
  it("saves, closes the runner and the server, installs, reopens and quits, in that order", async () => {
    const { calls, run } = quit()
    await run()
    expect(calls).toEqual([
      "announce",
      "begin",
      "hold",
      "save",
      "close runner",
      "close server",
      "install",
      "reopen",
      "reopen current",
      "quit",
    ])
  })

  it("marks the app as stopping", async () => {
    const { state, run } = quit()
    await run()
    expect(state.stopping).toBe(true)
  })

  it("closes nothing until the pages have saved", async () => {
    const calls: string[] = []
    let saved = (): void => {}
    const shutDown = shutDownInOrder({
      platform: "linux",
      persist: () => {},
      save: () => new Promise((resolve) => (saved = resolve)),
      closeRunner: async () => {
        calls.push("runner")
        return "closed" as const
      },
      closeServer: async () => {
        calls.push("server")
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([])
    saved()
    await shutDown
    expect(calls).toEqual(["runner", "server"])
  })

  it("waits for the runner to end before the update", async () => {
    let closed = (_end: RunnerEnd): void => {}
    const { calls, run } = quit({
      closeRunner: () => new Promise((resolve) => (closed = resolve)),
    })
    const finished = run()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).not.toContain("install")
    closed("closed")
    await finished
    expect(calls).toContain("install")
  })

  it("waits for the server to end before the update", async () => {
    let closed = (): void => {}
    const { calls, run } = quit({
      closeServer: () => new Promise((resolve) => (closed = resolve)),
    })
    const finished = run()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).not.toContain("install")
    closed()
    await finished
    expect(calls).toContain("install")
  })

  it("closes the server while the runner is still closing", async () => {
    let closed = (_end: RunnerEnd): void => {}
    const { calls, run } = quit({
      closeRunner: () => new Promise((resolve) => (closed = resolve)),
    })
    const finished = run()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toContain("close server")
    closed("closed")
    await finished
  })

  context("with a server but no runner", () => {
    it("closes the server and goes on to the update", async () => {
      const { calls, run } = quit({ closeRunner: () => undefined })
      await run()
      expect(calls.slice(-5)).toEqual([
        "close server",
        "install",
        "reopen",
        "reopen current",
        "quit",
      ])
    })
  })

  context("on Windows", () => {
    it("tells the runner the app is going before the pages save", async () => {
      const { calls, run } = quit({ platform: "win32" })
      await run()
      expect(calls.indexOf("persist")).toBeGreaterThan(-1)
      expect(calls.indexOf("persist")).toBeLessThan(calls.indexOf("save"))
    })
  })

  context("elsewhere", () => {
    it.each(["linux", "darwin"] as const)("tells the runner nothing early on %s", async (os) => {
      const { calls, run } = quit({ platform: os })
      await run()
      expect(calls).not.toContain("persist")
    })
  })

  context("while an update goes into place", () => {
    // The app is stopping by then: a second quit, as a logout's, is what this holds back. Not
    // stopping, this keeps the check ahead of the others.
    it.each([true, false])("holds the quit and does nothing else (stopping: %s)", (stopping) => {
      const { calls, run } = quit({ held: true, state: { ...notQuitting(), stopping } })
      expect(run()).toBeUndefined()
      expect(calls).toEqual(["hold"])
    })
  })

  context("with no runner and no server", () => {
    it("begins the quit and lets it go on", () => {
      const { calls, state, run } = quit({ hosting: false })
      expect(run()).toBeUndefined()
      expect(calls).toEqual(["announce", "begin"])
      expect(state.stopping).toBe(false)
    })
  })

  context("with a runner that was killed and then exited", () => {
    it("installs and reopens as usual", async () => {
      const { calls, run } = quit({ ended: "killed" })
      await run()
      expect(calls.slice(-4)).toEqual(["install", "reopen", "reopen current", "quit"])
      expect(calls).not.toContain("keep update")
    })
  })

  context("with a runner that did not exit even when killed", () => {
    it("keeps the update, opens nothing and quits", async () => {
      const { calls, run } = quit({ ended: "abandoned" })
      await run()
      expect(calls.slice(-4)).toEqual(["close runner", "close server", "keep update", "quit"])
      expect(calls).not.toContain("install")
      expect(calls).not.toContain("reopen")
      expect(calls).not.toContain("reopen current")
    })

    it("lets the app end when the quit comes back", async () => {
      const { calls, run } = quit({ ended: "abandoned" })
      await run()
      calls.length = 0
      expect(run()).toBeUndefined()
      expect(calls).toEqual(["begin again"])
    })

    it("still quits if keeping the update fails", async () => {
      const { calls, run } = quit({ ended: "abandoned", fails: ["keep update"] })
      await expect(run()).rejects.toThrow("keep update failed")
      expect(calls.at(-1)).toBe("quit")
    })
  })

  context("when the quit comes back once it finished", () => {
    it("begins again but lets the app end", async () => {
      const { calls, run } = quit()
      await run()
      calls.length = 0
      expect(run()).toBeUndefined()
      expect(calls).toEqual(["begin again"])
    })
  })

  context("when the uninstall already stopped the app", () => {
    it("begins but neither says so again nor shuts down twice", () => {
      const { calls, run } = quit({ state: { ...notQuitting(), stopping: true } })
      expect(run()).toBeUndefined()
      expect(calls).toEqual(["begin again"])
    })
  })

  context("when a step fails", () => {
    it.each([
      ["save", ["save", "quit"]],
      ["install", ["save", "close runner", "close server", "install", "quit"]],
      ["reopen", ["save", "close runner", "close server", "install", "reopen", "quit"]],
      [
        "reopen current",
        ["save", "close runner", "close server", "install", "reopen", "reopen current", "quit"],
      ],
    ])("still quits after %s fails", async (name, ran) => {
      const { calls, run } = quit({ fails: [name] })
      await expect(run()).rejects.toThrow(`${name} failed`)
      expect(calls.slice(3)).toEqual(ran)
    })

    it("still quits when telling the runner throws on Windows", async () => {
      const { calls, run } = quit({ platform: "win32", fails: ["persist"] })
      await expect(run()).rejects.toThrow("persist failed")
      expect(calls.at(-1)).toBe("quit")
    })

    it("goes on to the update after the server's close fails, with the runner closed too", async () => {
      const { calls, run } = quit({ fails: ["close server"] })
      await run()
      expect(calls).toContain("close runner")
      expect(calls.slice(-4)).toEqual(["install", "reopen", "reopen current", "quit"])
    })

    it("keeps the update when the runner's close fails, which says nothing of its end", async () => {
      const { calls, run } = quit({ fails: ["close runner"] })
      await run()
      expect(calls).toContain("close server")
      expect(calls.slice(-2)).toEqual(["keep update", "quit"])
      expect(calls).not.toContain("install")
    })
  })
})
