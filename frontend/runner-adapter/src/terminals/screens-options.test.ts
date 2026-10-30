import type { BackendConnectionState } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { TerminalEvent } from "@novadeck/protocol"
import type { AttachedTerminal } from "@novadeck/runner-client"
import { noTheme } from "@novadeck/terminal-views/theme"
import { createTerminalScreens } from "@novadeck/terminal/view"
import { WireError } from "@novadeck/wire"
import { afterEach, vi } from "vitest"

import type { SurfaceRuntime } from "../backend"
import { context, describe, expect, it } from "../test"
import { pasteNotice, retainMs, screensOptions } from "./screens-options"

describe("a failed paste's notice", () => {
  it("says the clipboard could not be read", () => {
    expect(pasteNotice({ kind: "clipboard" })).toBe("Novadeck can't read the clipboard")
  })

  it("says an image or a file was too large, as the runner or the client found", () => {
    const error = new WireError("UPLOAD_TOO_LARGE")
    expect(pasteNotice({ kind: "file", type: "image/png", tooLarge: false, error })).toBe(
      "Couldn't paste the image: it's over 32 MB",
    )
    expect(pasteNotice({ kind: "file", type: "application/pdf", tooLarge: false, error })).toBe(
      "Couldn't paste the file: it's over 32 MB",
    )
    expect(
      pasteNotice({ kind: "file", type: "image/png", tooLarge: true, error: new Error("big") }),
    ).toBe("Couldn't paste the image: it's over 32 MB")
  })

  it("says only that it failed for any other reason, as a lost connection", () => {
    const failed = (type: string, error: unknown) =>
      pasteNotice({ kind: "file", type, tooLarge: false, error })
    expect(failed("image/png", new WireError("DISCONNECTED"))).toBe("Couldn't paste the image")
    expect(failed("", new Error("disk full"))).toBe("Couldn't paste the file")
  })
})

// jsdom has no layout observers, media queries or canvas; xterm falls back without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }

// A runtime that gives `attached` for every attach and records what it is told.
const runtimeOf = (attached: AttachedTerminal) => {
  const noted: AttachedTerminal[] = []
  const released = vi.fn<() => void>()
  const runtime: SurfaceRuntime = {
    entry: () => undefined,
    attach: async () => attached,
    upload: async () => "",
    resized: () => {},
    attached: (_key, attachment) => {
      noted.push(attachment)
      return released
    },
    connected: async () => {},
    lost: () => {},
    restart: () => {},
    exited: () => {},
    connection: createStore<BackendConnectionState>("connected"),
    track: (work) => work,
    screen: () => {},
    shown: () => false,
  }
  return { runtime, noted, released }
}

describe("the runner's terminal screens' options", () => {
  it("follow the runner's attachment as the terminal library's stream", async () => {
    const attached: AttachedTerminal = {
      id: "t",
      mode: "control",
      [Symbol.asyncIterator]: () => attached,
      next: async () => ({ value: undefined, done: true }),
      return: async () => ({ value: undefined, done: true }),
      write: vi.fn<AttachedTerminal["write"]>(async () => {}),
      resize: vi.fn<AttachedTerminal["resize"]>(async () => {}),
      detach: vi.fn<AttachedTerminal["detach"]>(async () => {}),
    }
    const { runtime, noted, released } = runtimeOf(attached)
    const options = screensOptions(runtime, { theme: noTheme })
    const stream = await options.attach(key)
    expect(stream.mode).toBe("control")
    await stream.write("ls\r")
    await stream.resize(100, 30)
    stream.close()
    expect(attached.write).toHaveBeenCalledWith("ls\r")
    expect(attached.resize).toHaveBeenCalledWith({ cols: 100, rows: 30 })
    expect(attached.detach).toHaveBeenCalledOnce()
    // The runtime notes the runner's own attachment, and its release is the one handed back.
    expect(options.on?.attached?.(key, stream)).toBe(released)
    expect(noted).toEqual([attached])
  })

  it("tell a busy runner and a lost link apart from a failure", () => {
    const { classify } = screensOptions(runtimeOf({} as AttachedTerminal).runtime, {
      theme: noTheme,
    })
    expect(classify(new WireError("RESOURCE_LIMIT"))).toBe("busy")
    expect(classify(new WireError("DISCONNECTED"))).toBe("offline")
    expect(classify(new WireError("CONTROL_IN_USE"))).toBe("fatal")
    expect(classify(new Error("boom"))).toBe("fatal")
  })

  it("wait for Enter after an exit that can start again, not after a clean one", () => {
    const { waitsAfter } = screensOptions(runtimeOf({} as AttachedTerminal).runtime, {
      theme: noTheme,
    })
    expect(waitsAfter({ code: 0, signal: null, ranMs: 60_000 })).toBe(false)
    expect(waitsAfter({ code: 1, signal: null, ranMs: 60_000 })).toBe(true)
    // Ended by a signal, and quickly: still a shell to start again.
    expect(waitsAfter({ code: null, signal: "SIGKILL", ranMs: 500 })).toBe(true)
  })

  context("with and without the desktop app", () => {
    afterEach(() => void Reflect.deleteProperty(globalThis, "novadeck"))

    it("name a copied file by its own path as the desktop app does, and read its clipboard unasked", () => {
      const file = new File(["x"], "notes.txt")
      Object.defineProperty(globalThis, "novadeck", {
        configurable: true,
        value: { pathForFile: (pasted: File) => (pasted === file ? "/home/me/notes.txt" : "") },
      })
      const { paste } = screensOptions(runtimeOf({} as AttachedTerminal).runtime, {
        theme: noTheme,
      })
      expect(paste.pathOf?.(file)).toBe("/home/me/notes.txt")
      expect(paste.trustedClipboard).toBe(true)
    })

    it("upload a browser's files, and ask before reading its clipboard", () => {
      const { paste } = screensOptions(runtimeOf({} as AttachedTerminal).runtime, {
        theme: noTheme,
      })
      expect(paste.pathOf).toBeUndefined()
      expect(paste.trustedClipboard).toBe(false)
    })
  })
})

describe("the runner's terminal screens over a runtime", () => {
  const holds: { release: () => void }[] = []
  // A screen closes once its session has stayed off screen for its retention; it closes here,
  // while the file's DOM is still there to take its listeners off.
  afterEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      holds.splice(0).forEach((hold) => hold.release())
      vi.advanceTimersByTime(31 * 60 * 1000)
    } finally {
      vi.useRealTimers()
    }
  })

  const exit = { code: 1, signal: null, ranMs: 60_000 }
  const event = (sequence: number, rest: object): TerminalEvent =>
    ({ terminalId: "t", sequence, ...rest }) as TerminalEvent
  // An attachment that replays a snapshot, some output and an exit, then ends.
  const replaying = (): AttachedTerminal => {
    const queue = [
      event(1, { type: "snapshot", cols: 80, rows: 24, data: "$ ", exit: null }),
      event(2, { type: "output", data: "ls\r\n" }),
      event(3, { type: "exited", exit }),
    ]
    const attached: AttachedTerminal = {
      id: "t",
      mode: "control",
      [Symbol.asyncIterator]: () => attached,
      next: async () =>
        queue.length ? { value: queue.shift()!, done: false } : { value: undefined, done: true },
      return: async () => ({ value: undefined, done: true }),
      write: async () => {},
      resize: async () => {},
      detach: async () => {},
    }
    return attached
  }

  // A runtime that records what the screens ask of it and tell it.
  const recording = (over: Partial<SurfaceRuntime> = {}) => {
    const asked: string[] = []
    const told: string[] = []
    const connection = createStore<BackendConnectionState>("connected")
    let shown = false
    const runtime: SurfaceRuntime = {
      entry: (asking) => {
        asked.push(`entry ${asking.terminalId}`)
        return {
          ready: Promise.resolve(true),
          revived: new Promise<void>(() => {}),
          closed: false,
          size: { cols: 80, rows: 24 },
        }
      },
      attach: async (terminalId) => {
        asked.push(`attach ${terminalId}`)
        return replaying()
      },
      upload: async () => "",
      resized: (resizing, size) => void told.push(`resized ${resizing.terminalId} ${size.cols}`),
      attached: () => () => {},
      connected: async () => {},
      lost: () => {},
      restart: () => {},
      exited: (exiting, ended) => void told.push(`exited ${exiting.terminalId} ${ended.code}`),
      connection,
      track: (work) => work,
      screen: (screening, stage) => void told.push(`${screening.terminalId} ${stage}`),
      shown: () => shown,
      ...over,
    }
    return { runtime, asked, told, connection, show: (value: boolean) => (shown = value) }
  }
  const open = (runtime: SurfaceRuntime, which = key) => {
    const screens = createTerminalScreens(screensOptions(runtime, { theme: noTheme }))
    const element = document.createElement("div")
    document.body.append(element)
    const hold = screens.acquire(which, { label: "Input for T", phase: "running", webgl: false })
    hold.place(element)
    holds.push({
      release: () => {
        hold.release()
        element.remove()
      },
    })
    return { screens, hold, element }
  }

  it("follows the terminal its runtime has for the key, and tells the runtime how it goes", async () => {
    const { runtime, asked, told } = recording()
    const { element } = open(runtime)
    // The output arrives through the runtime's attachment, as the library's stream.
    await vi.waitFor(() => expect(element.textContent).toContain("ls"))
    await vi.waitFor(() => expect(told).toContain("exited t 1"))
    expect(asked).toContain("entry t")
    expect(asked).toContain("attach t")
    expect(told).toEqual(expect.arrayContaining(["t mounted", "t shown"]))
    const options = screensOptions(runtime, { theme: noTheme })
    options.on?.resized?.(key, { cols: 100, rows: 30 })
    expect(told).toContain("resized t 100")
  })

  it("keeps a screen per session and terminal", () => {
    const { runtime } = recording()
    const screens = createTerminalScreens(screensOptions(runtime, { theme: noTheme }))
    const containerOf = (which: typeof key) => {
      const element = document.createElement("div")
      screens.acquire(which, { label: "T", phase: "running", webgl: false }).place(element)
      return element.firstElementChild
    }
    const containers = [
      containerOf(key),
      containerOf({ ...key, workspaceSessionId: "other" }),
      containerOf({ ...key, terminalId: "other" }),
      containerOf({ ...key, projectId: "other" }),
    ]
    expect(new Set(containers).size).toBe(4)
    expect(containerOf(key)).toBe(containers[0])
  })

  it("keeps a screen nobody shows while the runtime says its session is on screen", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { runtime, told, show } = recording()
      const { hold } = open(runtime)
      hold.release()
      show(true)
      vi.advanceTimersByTime(retainMs + 60_000)
      expect(told).not.toContain("t gone")
      show(false)
      vi.advanceTimersByTime(retainMs + 60_000)
      expect(told).toContain("t gone")
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives a screen reader the terminal in focus", () => {
    // jsdom's window never has focus; a page a person types in does.
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    const { runtime } = recording()
    const { element } = open(runtime)
    expect(element.querySelector("[aria-live]")).toBeNull()
    element.querySelector("textarea")!.focus()
    expect(element.querySelector("[aria-live]")).not.toBeNull()
  })

  it("locks as the runtime's connection does", () => {
    const { runtime, connection } = recording()
    const { hold } = open(runtime)
    expect(hold.state.getSnapshot().lock).toBe("loading")
    connection.update(() => "reconnecting")
    expect(hold.state.getSnapshot().lock).toBe("reconnecting")
  })

  it("saves a pasted image through the runtime, and tells in the app's words when it fails", async () => {
    const upload = vi.fn<SurfaceRuntime["upload"]>(() =>
      Promise.reject(new WireError("DISCONNECTED")),
    )
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { runtime } = recording({ upload })
    const { hold, element } = open(runtime)
    const paste = new Event("paste", { bubbles: true, cancelable: true })
    const image = new File([new Uint8Array([1])], "", { type: "image/png" })
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [], items: [{ kind: "file", getAsFile: () => image }], getData: () => "" },
    })
    element.querySelector("textarea")!.dispatchEvent(paste)
    await vi.waitFor(() => expect(hold.state.getSnapshot().notice).toBe("Couldn't paste the image"))
    expect(upload).toHaveBeenCalledWith("t", expect.objectContaining({ name: expect.any(String) }))
  })
})
