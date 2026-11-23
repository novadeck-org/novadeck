import type { DeliveryContent, RingContent } from "@novadeck/core/messages"
import type { ThemeSource } from "@novadeck/core/port"
import { createRendererPool, writeTo, type Terminal } from "@novadeck/emulator/browser"
import { afterEach, vi } from "vitest"

import { openEmulator } from "./emulator"
import { contentOf, hueColours, ringRows, type RingFeed } from "./rings"
import { describe, expect, it } from "./test"

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

const noWebgl = createRendererPool<Terminal>({
  load: () => {
    throw new Error("No WebGL here")
  },
  supported: () => false,
  cap: 0,
})

const hues: Record<string, number> = { newtz: 4, hushz: 6 }
const hueOf = (handle: string): number => hues[handle] ?? 1

describe("what the overlay is told of rings and deliveries", () => {
  const rings: RingContent[] = [
    {
      seq: 1,
      nonce: "n7Q2xk",
      at: 1,
      more: 2,
      parts: [
        { kind: "agent", handle: "newtz", text: "Start on the parser" },
        {
          kind: "notice",
          text: "Novadeck · Worktrees\n@newtz gave you a worktree.\n→ Work there.",
        },
        { kind: "person", text: "Picked Push: yes" },
      ],
    },
  ]
  const deliveries: DeliveryContent[] = [
    {
      seq: 2,
      at: 2,
      ids: ["m-1", "m-2"],
      parts: [
        { kind: "agent", handle: "hushz", text: "Run the snapshots", id: "m-1" },
        { kind: "notice", text: "Novadeck · Inbox\nOne waits.", id: "m-2" },
      ],
    },
    {
      seq: 3,
      at: 3,
      ids: ["m-1", "m-2", "m-3"],
      more: 1,
      parts: [{ kind: "agent", handle: "hushz", text: "Run the snapshots", id: "m-1" }],
    },
  ]

  it("gives a ring's parts by its nonce, an agent with its hue, and how many more it held", () => {
    const { rings: byNonce } = contentOf(rings, deliveries, hueOf)
    expect(byNonce.get("n7Q2xk")?.parts[0]).toEqual({
      kind: "agent",
      handle: "newtz",
      hue: 4,
      text: "Start on the parser",
    })
    expect(byNonce.get("n7Q2xk")?.parts[2]).toEqual({ kind: "person", text: "Picked Push: yes" })
    expect(byNonce.get("n7Q2xk")?.more).toBe(2)
  })

  it("tells a notice as its family's line, never its facts", () => {
    const { parts } = contentOf(rings, deliveries, hueOf).rings.get("n7Q2xk")!
    expect(parts[1]).toEqual({ kind: "notice", text: "You notice news about a worktree." })
  })

  it("gives each delivery with the ids of all its messages, apart from the others that share some", () => {
    const { deliveries: told } = contentOf(rings, deliveries, hueOf)
    expect(told.map((each) => each.ids)).toEqual([
      ["m-1", "m-2"],
      ["m-1", "m-2", "m-3"],
    ])
    expect(told[0]?.parts[1]).toEqual({
      kind: "notice",
      text: "You notice an ask leave the Inbox.",
    })
    expect(told[1]?.more).toBe(1)
  })
})

describe("the colours of hues", () => {
  it("takes a hue the theme sets, and leaves the others to the terminal's ANSI colours", () => {
    const colours = hueColours({ "--avatar-hue-1-fg": "#7a45b8", "--avatar-hue-5-fg": "#112233" })
    expect([...colours]).toEqual([
      [1, "#7a45b8"],
      [5, "#112233"],
    ])
  })

  it("takes the person's from the theme, or mixes their strong ink 62% with their muted one in oklab", () => {
    expect(hueColours({ "--avatar-you-fg": "#ff0000" }).get("you")).toBe("#ff0000")
    expect(hueColours({ "--color-strong": "#000000", "--color-muted": "#ffffff" }).get("you")).toBe(
      "#424242",
    )
    expect(hueColours({ "--color-strong": "#000000" }).get("you")).toBeUndefined()
  })
})

describe("a terminal's ring rows", () => {
  const tag = (nonce: string): string => `<novadeck-doorbell from="newtz" ring="${nonce}"/>`
  const feedOf = () => {
    let rings: RingContent[] = []
    let deliveries: DeliveryContent[] = []
    const listeners = new Set<() => void>()
    const feed: RingFeed = {
      get: () => ({ rings, deliveries, agent: true }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
    return {
      feed,
      set: (next: { rings?: RingContent[]; deliveries?: DeliveryContent[] }) => {
        rings = next.rings ?? rings
        deliveries = next.deliveries ?? deliveries
        listeners.forEach((listener) => listener())
      },
      listeners,
    }
  }
  const theme: ThemeSource = { tokens: () => ({}), onChange: () => () => {}, hueOf }
  const ring = (nonce: string, at: number): RingContent => ({
    seq: 1,
    nonce,
    at,
    parts: [{ kind: "agent", handle: "newtz", text: "hello" }],
  })
  const open = () => {
    const element = document.body.appendChild(document.createElement("div"))
    const view = openEmulator({ pool: noWebgl })(element, {
      fontSize: 13,
      fontFamily: "monospace",
      theme: {},
    })
    view.terminal.resize(100, 10)
    const source = feedOf()
    const rows = ringRows(view, { feed: source.feed, theme })
    return { view, rows, ...source, write: (data: string) => writeTo(view.terminal, data) }
  }
  afterEach(() => document.body.replaceChildren())

  it("draws a ring told of as it is typed, found at the rows written now", async () => {
    const { rows, set, write } = open()
    set({ rings: [ring("n7Q2xk", Date.now())] })
    await write(`${tag("n7Q2xk")}\r\nout\r\n`)
    expect(rows.drawn()).toBe(1)
    rows.dispose()
  })

  it("draws a ring on the screen when it is told of, and rings it was not told of never", async () => {
    const { rows, set, write } = open()
    await write(`${tag("n7Q2xk")}\r\nout\r\n${tag("other1")}\r\nout\r\n`)
    set({ rings: [ring("n7Q2xk", Date.now())] })
    expect(rows.drawn()).toBe(1)
    rows.dispose()
  })

  it("finds rings in the scrollback once a snapshot is drawn, and when old ones are told of after it", async () => {
    const { view, rows, set, write } = open()
    set({ rings: [ring("n7Q2xk", Date.now() - 3_600_000)] })
    await write(`${tag("n7Q2xk")}\r\nout\r\n${"output\r\n".repeat(40)}`)
    // Typed an hour ago: nothing arms a scan for it, so only a restore finds it.
    expect(rows.drawn()).toBe(0)
    view.terminal.reset()
    await write(`${tag("n7Q2xk")}\r\nout\r\n${"output\r\n".repeat(40)}`)
    rows.restored()
    expect(rows.drawn()).toBe(1)
    rows.dispose()
  })

  it("rescans when the old rings are told of after the snapshot came", async () => {
    const { rows, set, write } = open()
    await write(`${tag("n7Q2xk")}\r\nout\r\n${"output\r\n".repeat(40)}`)
    rows.restored()
    expect(rows.drawn()).toBe(0)
    set({ rings: [ring("n7Q2xk", Date.now() - 3_600_000)] })
    expect(rows.drawn()).toBe(1)
    rows.dispose()
  })

  it("does no work for a change that tells it nothing new, and none once it is disposed", async () => {
    const { rows, set, write, listeners } = open()
    set({ rings: [ring("n7Q2xk", Date.now())] })
    await write(`${tag("n7Q2xk")}\r\nout\r\n`)
    const before = rows.drawn()
    set({ rings: [ring("n7Q2xk", Date.now())] })
    expect(rows.drawn()).toBe(before)
    rows.dispose()
    expect(listeners.size).toBe(0)
    expect(rows.drawn()).toBe(0)
  })
})
