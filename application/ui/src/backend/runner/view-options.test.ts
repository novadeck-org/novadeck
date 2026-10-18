import type { AttachedTerminal } from "@novadeck/protocol/client"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { createStore } from "#core/store"

import { describe, expect, it } from "../../test"
import type { BackendConnectionState } from "../port"
import type { SurfaceRuntime } from "./backend"
import { pasteNotice, viewOptions } from "./view-options"

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

describe("the runner's terminal views' options", () => {
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
    const options = viewOptions(runtime)
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
    const { classify } = viewOptions(runtimeOf({} as AttachedTerminal).runtime)
    expect(classify(new WireError("RESOURCE_LIMIT"))).toBe("busy")
    expect(classify(new WireError("DISCONNECTED"))).toBe("offline")
    expect(classify(new WireError("CONTROL_IN_USE"))).toBe("fatal")
    expect(classify(new Error("boom"))).toBe("fatal")
  })

  it("wait for Enter after an exit that can start again, not after a clean one", () => {
    const { waitsAfter } = viewOptions(runtimeOf({} as AttachedTerminal).runtime)
    expect(waitsAfter({ code: 0, signal: null, ranMs: 60_000 })).toBe(false)
    expect(waitsAfter({ code: 1, signal: null, ranMs: 60_000 })).toBe(true)
  })
})
