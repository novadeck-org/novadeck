import { describe, expect, it, vi } from "vitest"

import type { AttachStream } from "../contract.js"
import { optionsOf, output, snapshot, streamOf } from "./fakes.test-support.js"
import { followTerminal, type Screen } from "./follow.js"
import type { ControlStrip } from "./view-state.js"

const key = "t"

// An observing stream: its mode changes when the test says, and a take is answered as it
// chooses.
const observer = (events = [snapshot("$ ")], take?: AttachStream["take"]) => {
  const base = streamOf(events)
  let mode: "control" | "observe" = "observe"
  const listeners = new Set<(mode: "control" | "observe") => void>()
  const taken: (number | undefined)[] = []
  const attached: AttachStream = {
    ...base.attached,
    get mode() {
      return mode
    },
    onMode: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    take:
      take ??
      (async (options) => {
        taken.push(options?.ifIdleMs)
        set("control")
      }),
  }
  const set = (next: "control" | "observe") => {
    mode = next
    listeners.forEach((listener) => listener(next))
  }
  return { ...base, attached, set, taken }
}

const watching = () => {
  const log: string[] = []
  const screen: Screen = {
    write: async (data) => void log.push(`write:${data}`),
    reset: () => {},
    resize: ({ cols, rows }) => void log.push(`resize:${cols}x${rows}`),
    fit: () => ({ cols: 100, rows: 30 }),
    exited: () => {},
    live: () => {},
    observe: (size) => void log.push(size ? `observe:${size.cols}x${size.rows}` : "observe:off"),
    strip: (strip: ControlStrip | null) => void log.push(`strip:${strip}`),
    took: () => void log.push("took"),
  }
  return { log, screen }
}

const followObserver = async (stream: ReturnType<typeof observer>) => {
  const { log, screen } = watching()
  const resizes: string[] = []
  const options = optionsOf({
    attach: async () => stream.attached,
    on: { resized: (_key, size) => void resizes.push(`${size.cols}x${size.rows}`) },
  })
  const followed = followTerminal(options, key, screen)
  await vi.waitFor(() => expect(log).toContain("write:$ "))
  return { followed, log, resizes }
}

describe("following a terminal this client only observes", () => {
  it("draws at the pty's size, tells the strip, and never sends a size", async () => {
    const stream = observer()
    const { followed, log, resizes } = await followObserver(stream)
    expect(log).toContain("strip:observing")
    expect(log).toContain("observe:80x24")
    followed.refit()
    expect(stream.resized).toEqual([])
    expect(resizes).toEqual([])
    stream.push({ sequence: 2, type: "resized", cols: 132, rows: 40 })
    await vi.waitFor(() => expect(log).toContain("observe:132x40"))
    expect(stream.resized).toEqual([])
    followed.stop()
  })

  it("fits the frame and sends its size once it becomes the controller", async () => {
    const stream = observer()
    const { followed, log } = await followObserver(stream)
    stream.set("control")
    expect(log.slice(-2)).toEqual(["strip:null", "observe:off"])
    await vi.waitFor(() => expect(stream.resized).toEqual(["100x30"]))
    expect(log).toContain("resize:100x30")
    followed.stop()
  })

  it("sends one size when it takes control, fitted once the strip is gone", async () => {
    const stream = observer()
    const { log, screen: base } = watching()
    // The strip takes room until React removes it, a moment after it is told to go.
    let stripShown = true
    const screen: Screen = {
      ...base,
      fit: () => ({ cols: 100, rows: stripShown ? 29 : 30 }),
      strip: (state) => {
        base.strip?.(state)
        if (state === null) setTimeout(() => (stripShown = false), 20)
      },
    }
    const followed = followTerminal(optionsOf({ attach: async () => stream.attached }), key, screen)
    await vi.waitFor(() => expect(log).toContain("write:$ "))
    stream.set("control")
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(stream.resized).toEqual(["100x30"])
    followed.stop()
  })

  it("says it observes again when control is lost", async () => {
    const stream = observer()
    const { followed, log } = await followObserver(stream)
    stream.set("control")
    stream.set("observe")
    expect(log.filter((line) => line.startsWith("strip:"))).toEqual([
      "strip:observing",
      "strip:null",
      "strip:observing",
    ])
    followed.stop()
  })

  describe("input", () => {
    it("takes control with typed text, and delivers it", async () => {
      const stream = observer()
      const { followed } = await followObserver(stream)
      followed.input("a")
      await vi.waitFor(() => expect(stream.written).toEqual(["a"]))
      expect(stream.taken).toEqual([2000])
      followed.stop()
    })

    it("takes control with a paste, and delivers it whole", async () => {
      const stream = observer()
      const { followed } = await followObserver(stream)
      followed.input("\u001b[200~ls\u001b[201~")
      await vi.waitFor(() => expect(stream.written).toEqual(["\u001b[200~ls\u001b[201~"]))
      expect(stream.taken).toEqual([2000])
      followed.stop()
    })

    it.each([
      ["Enter", "\r"],
      ["Esc", "\u001b"],
      ["an arrow", "\u001b[B"],
      ["a Ctrl chord", "\u0004"],
      ["an Alt chord", "\u001bf"],
    ])("takes control with %s, tells so, and does not deliver it", async (_name, data) => {
      const stream = observer()
      const { followed, log } = await followObserver(stream)
      followed.input(data)
      await vi.waitFor(() => expect(log).toContain("took"))
      expect(stream.taken).toEqual([2000])
      expect(stream.written).toEqual([])
      // The next press goes through.
      followed.input(data)
      await vi.waitFor(() => expect(stream.written).toEqual([data]))
      expect(stream.taken).toEqual([2000])
      followed.stop()
    })

    it("keeps what is typed in order when it is typed after control came but writes still wait", async () => {
      const base = streamOf([snapshot("$ ")])
      let mode: "control" | "observe" = "observe"
      const listeners = new Set<(mode: "control" | "observe") => void>()
      const attached: AttachStream = {
        ...base.attached,
        get mode() {
          return mode
        },
        onMode: (listener) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
        // Control is ours at once, but the call answers after the link's delay.
        take: async () => {
          mode = "control"
          listeners.forEach((listener) => listener(mode))
          await new Promise((resolve) => setTimeout(resolve, 60))
        },
      }
      const { log, screen } = watching()
      const followed = followTerminal(optionsOf({ attach: async () => attached }), key, screen)
      await vi.waitFor(() => expect(log).toContain("write:$ "))
      followed.input("h")
      await vi.waitFor(() => expect(attached.mode).toBe("control"))
      for (const letter of "ello") followed.input(letter)
      await vi.waitFor(() => expect(base.written).toEqual(["h", "e", "l", "l", "o"]))
      followed.stop()
    })

    it("delivers nothing and says so when the controller is busy", async () => {
      const refused = vi
        .fn<NonNullable<AttachStream["take"]>>()
        .mockRejectedValue(Object.assign(new Error("busy"), { code: "CONTROL_BUSY" }))
      const stream = observer(undefined, refused)
      const { followed, log } = await followObserver(stream)
      followed.input("a")
      await vi.waitFor(() => expect(log).toContain("strip:busy"))
      expect(stream.written).toEqual([])
      expect(refused).toHaveBeenCalledWith({ ifIdleMs: 2000 })
      followed.stop()
    })

    it("takes nothing for the emulator's own reports", async () => {
      const stream = observer()
      const { followed } = await followObserver(stream)
      followed.input("\u001b[<0;3;4M")
      followed.input("\u001b[I")
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(stream.taken).toEqual([])
      expect(stream.written).toEqual([])
      followed.stop()
    })

    it("keeps what is typed in order while control is being taken", async () => {
      const stream = observer()
      const { followed } = await followObserver(stream)
      for (const letter of "abc") followed.input(letter)
      await vi.waitFor(() => expect(stream.written).toEqual(["a", "b", "c"]))
      expect(stream.taken).toEqual([2000])
      followed.stop()
    })
  })

  it("takes control at once, with no idle limit, when asked by the button", async () => {
    const taken: unknown[] = []
    const stream = observer(undefined, async (options) => void taken.push(options))
    const { followed } = await followObserver(stream)
    followed.take()
    await vi.waitFor(() => expect(taken).toEqual([undefined]))
    followed.stop()
  })

  it("leaves a stream that has control as it is: input goes straight through", async () => {
    const stream = observer([snapshot("$ "), output("x", 2)])
    stream.set("control")
    const { followed } = await followObserver(stream)
    followed.input("\r")
    await vi.waitFor(() => expect(stream.written).toEqual(["\r"]))
    expect(stream.taken).toEqual([])
    followed.stop()
  })
})
