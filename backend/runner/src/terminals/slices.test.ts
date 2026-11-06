import { createScreen, written, type Screen } from "@novadeck/emulator/headless"
import { sliceLimits, type SliceChange } from "@novadeck/protocol"
import type { BoxProfile } from "@novadeck/tui-input/box"
import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { Slices, type Slicing } from "./slices.js"

const box = {
  read: ({ rows }: { rows: readonly string[] }) => {
    const at = rows.findLastIndex((row) => row.startsWith("> "))
    return at < 0 ? undefined : { text: rows[at]!.slice(2).trim(), first: at, last: at }
  },
} as unknown as BoxProfile

const profile = {
  leading: ["/"],
  words: [],
  side: () => "above" as const,
  secret: (rows: readonly string[]) => rows.some((row) => row.includes("Paste")),
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Long enough for a look at no throttle to run. */
const settle = () => sleep(10)

/** A terminal the test draws on, and the slices of it, on a clock the test moves. */
const setup = async () => {
  const screen: Screen = createScreen({ cols: 20, rows: 6, scrollback: 0 })
  const draw = async (rows: readonly string[]) => {
    await written(screen, `\x1b[2J\x1b[H${rows.join("\r\n")}`)
  }
  const reads = vi.fn<() => void>()
  let slicing: Slicing | undefined = {
    box,
    profile,
    waiting: false,
    unread: false,
    read: async (read) => {
      reads()
      return read(screen)
    },
  }
  let clock = 0
  const slices = new Slices(() => slicing, {
    now: () => clock,
    throttleMs: 0,
    viewStillMs: 120,
  })
  const seen: SliceChange[] = []
  const controller = new AbortController()
  const reading = (async () => {
    for await (const change of slices.watch("t", controller.signal)) seen.push(change)
  })()
  await settle()
  return {
    draw,
    reads,
    seen,
    slices,
    controller,
    reading,
    set: (next: Partial<Slicing> | undefined) => {
      slicing = next && { ...slicing!, ...next }
    },
    show: async (rows: readonly string[]) => {
      await draw(rows)
      slices.changed("t")
      await settle()
    },
    /** Moves the clock on, and looks again. */
    pass: async (ms: number) => {
      clock += ms
      slices.changed("t")
      await settle()
    },
  }
}

const texts = (change: SliceChange | undefined) =>
  change?.slice?.rows.map((row) => row.map(({ text }) => text).join(""))

describe("Slices", () => {
  it("starts with none, and tells a menu as it opens and as it closes", async () => {
    const { seen, show } = await setup()
    await show(["one", "> "])
    expect(seen).toEqual([{ slice: null }])
    await show(["one", "menu", "> /"])
    expect(texts(seen.at(-1))).toEqual(["menu"])
    expect(seen.at(-1)?.slice).toMatchObject({ reason: "menu", columns: 20, secret: false })
    await show(["one", "> "])
    expect(seen.at(-1)).toEqual({ slice: null })
  })

  it("tells no change twice", async () => {
    const { seen, show } = await setup()
    await show(["one", "> "])
    await show(["one", "menu", "> /"])
    await show(["one", "menu", "> /"])
    expect(seen).toHaveLength(2)
  })

  it("takes changes that came together in one look, the last draw's", async () => {
    const { reads, seen, draw, slices, show } = await setup()
    await show(["one", "> "])
    reads.mockClear()
    await draw(["one", "first", "> /"])
    await draw(["one", "second", "> /"])
    slices.changed("t")
    slices.changed("t")
    await settle()
    expect(reads).toHaveBeenCalledTimes(1)
    expect(texts(seen.at(-1))).toEqual(["second"])
  })

  it("looks once at the start, past no throttle", async () => {
    const reads = vi.fn<() => void>()
    const slices = new Slices(
      () => {
        reads()
        return undefined
      },
      { now: () => 0, throttleMs: 40 },
    )
    const controller = new AbortController()
    const reading = (async () => {
      for await (const change of slices.watch("t", controller.signal)) void change
    })()
    await settle()
    expect(reads).toHaveBeenCalledTimes(1)
    controller.abort()
    await reading
  })

  it("holds a view back until it has stayed, as a redraw shows no box either", async () => {
    const { seen, show, pass } = await setup()
    await show(["one", "> "])
    await show(["one", "view"])
    expect(seen).toHaveLength(1)
    await pass(119)
    expect(seen).toHaveLength(1)
    await pass(1)
    expect(texts(seen.at(-1))).toEqual(["view"])
  })

  it("lets a redraw go by without telling it", async () => {
    const { seen, show, pass } = await setup()
    await show(["one", "> "])
    await show(["one", ""])
    await show(["one", "> "])
    await pass(200)
    expect(seen).toEqual([{ slice: null }])
  })

  it("updates a view that shows at once", async () => {
    const { seen, show, pass } = await setup()
    await show(["one", "> "])
    await show(["one", "view"])
    await pass(120)
    await show(["one", "view 2"])
    expect(texts(seen.at(-1))).toEqual(["view 2"])
  })

  it("marks a slice the harness knows as a secret prompt", async () => {
    const { seen, show } = await setup()
    await show(["one", "> "])
    await show(["one", "Paste code", "> /"])
    expect(seen.at(-1)?.slice?.secret).toBe(true)
  })

  it("gives the cursor in the slice's rows, null when it is elsewhere", async () => {
    const { seen, show, pass } = await setup()
    await show(["one", "> "])
    await show(["one", "menu", "> /"])
    expect(seen.at(-1)?.slice?.cursor).toBeNull()
    await show(["one", "view"])
    await pass(120)
    expect(seen.at(-1)?.slice?.cursor).toEqual({ row: 0, column: 4 })
  })

  it("tells none with no agent bound, and forgets the screen at rest", async () => {
    const { seen, show, set, draw, slices } = await setup()
    await show(["one", "> "])
    await show(["one", "menu", "> /"])
    set(undefined)
    await draw(["$ "])
    slices.changed("t")
    await settle()
    expect(seen.at(-1)).toEqual({ slice: null })
  })

  it("is no slice past its limits: rows cut short would be the wrong rows", async () => {
    const wide: Screen = createScreen({ cols: sliceLimits.columns + 1, rows: 6, scrollback: 0 })
    await written(wide, "one\r\n> ")
    const { seen, set, show, slices } = await setup()
    set({ read: async (read) => read(wide) })
    slices.changed("t")
    await settle()
    await written(wide, "\x1b[2J\x1b[Hone\r\nmenu\r\n> /")
    await show(["unused"])
    expect(seen).toEqual([{ slice: null }])
  })

  it("looks at nothing with no reader", async () => {
    const reads = vi.fn<() => void>()
    const slices = new Slices(() => {
      reads()
      return undefined
    })
    slices.changed("t")
    await settle()
    expect(reads).not.toHaveBeenCalled()
  })

  it("ends its readers as the terminal goes, and stops looking", async () => {
    const { slices, reading, reads, show } = await setup()
    await show(["one", "> "])
    slices.end("t")
    await reading
    reads.mockClear()
    slices.changed("t")
    await settle()
    expect(reads).not.toHaveBeenCalled()
  })

  it("lets a reader go on abort, and starts afresh for the next", async () => {
    const { controller, reading, slices, reads } = await setup()
    controller.abort()
    await reading
    reads.mockClear()
    slices.changed("t")
    await settle()
    expect(reads).not.toHaveBeenCalled()
  })
})
