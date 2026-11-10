import type { ClosedTerminal, HistoryState } from "@novadeck/core/history"
import { itemIdOf } from "@novadeck/core/items"
import { createStore } from "@novadeck/core/store"
import { terminalFixture } from "@novadeck/core/testing"
import type { Tile } from "@novadeck/core/types"

import { context, describe, expect, it } from "../test"
import { openCommands } from "../test/commands"
import { closeTip, dropSlackMs, dropWords, watchHistoryDrops } from "./history-drops"

const startedAt = 1_000_000

const row = (id: string, parts: Partial<ClosedTerminal> = {}): ClosedTerminal => ({
  id,
  projectId: "project",
  title: id,
  summary: null,
  handle: null,
  agent: null,
  program: "zsh",
  cwd: "~/project",
  closedAt: startedAt + 1_000,
  closedBy: null,
  availability: { state: "ready" },
  ...parts,
})

// The watcher over a History that holds `rows` as it starts; `publish` replaces them, newest
// first, as the backend does.
const watching = (rows: readonly ClosedTerminal[] = []) => {
  const { workspace, ui } = openCommands()
  const state = createStore<HistoryState>({ rows })
  const stop = watchHistoryDrops({ state }, workspace, ui, () => startedAt)
  return {
    workspace,
    publish: (next: readonly ClosedTerminal[]) => state.update(() => ({ rows: next })),
    drops: () => ui.getSnapshot().historyDrops,
    last: () => ui.getSnapshot().lastDrop,
    stop,
  }
}

describe("a terminal landing in History", () => {
  it("counts each close in the open project, named by who closed it", () => {
    const history = watching()
    history.publish([row("Tests")])
    expect(history.drops()).toBe(1)
    expect(history.last()).toEqual({ title: "Tests", closedBy: null })
    history.publish([row("Dev server", { closedBy: "crow" }), row("Tests")])
    expect(history.drops()).toBe(2)
    expect(history.last()).toEqual({ title: "Dev server", closedBy: "crow" })
    history.stop()
  })

  it("counts rows that land together once, named by the newest", () => {
    const history = watching()
    history.publish([row("Lead", { closedAt: startedAt + 2_000 }), row("Worker")])
    expect(history.drops()).toBe(1)
    expect(history.last()?.title).toBe("Lead")
  })

  it("leaves out rows read at startup, after a reconnection or for another project", () => {
    const history = watching([row("Held")])
    // The first read: rows that closed before this run began.
    history.publish([row("Held"), row("Old", { closedAt: startedAt - dropSlackMs - 1 })])
    // A reconnection reports the same rows again; an availability change rewrites one.
    history.publish([row("Held", { availability: { state: "restoring" } }), row("Old")])
    // Another project's close.
    history.publish([row("Elsewhere", { projectId: "other" }), row("Held"), row("Old")])
    expect(history.drops()).toBe(0)
  })

  it("counts a terminal again when it was restored and closed once more", () => {
    const history = watching([row("Tests")])
    history.publish([])
    history.publish([row("Tests", { closedAt: startedAt + 5_000 })])
    expect(history.drops()).toBe(1)
  })

  it("stops counting once stopped", () => {
    const history = watching()
    history.stop()
    history.publish([row("Tests")])
    expect(history.drops()).toBe(0)
  })
})

context("the words for a landing", () => {
  it("names the agent that closed it, or only the terminal when the person did", () => {
    expect(dropWords({ title: "Dev server", closedBy: "crow" })).toBe(
      "@crow closed Dev server just now",
    )
    expect(dropWords({ title: "Tests", closedBy: null })).toBe("Tests closed just now")
  })
})

context("the close button's tooltip", () => {
  const keeps = {
    history: { state: createStore<HistoryState>({ rows: [] }), list: async () => [] },
  }
  const window: Tile = {
    id: "w1",
    home: "undocked",
    itemId: itemIdOf("hero"),
    name: "hero",
    titleSource: { kind: "default" },
  }

  it("says a terminal stays in History where the backend keeps closed terminals", () => {
    expect(closeTip(keeps, terminalFixture(1, "~/project"))).toBe("Close · stays in History")
    expect(closeTip({}, terminalFixture(1, "~/project"))).toBe("Close")
  })

  it("says only Close for a companion's window, which History doesn't keep", () => {
    expect(closeTip(keeps, window)).toBe("Close")
  })
})
