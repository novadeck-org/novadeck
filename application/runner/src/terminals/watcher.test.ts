import type { TerminalSummary } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { TerminalWatcher, Watcher } from "./watcher.js"

const terminal = (id: string, changes: Partial<TerminalSummary> = {}): TerminalSummary => ({
  id,
  sessionId: "session",
  title: "Terminal 01",
  titleSource: { kind: "default" },
  handle: "t1",
  started: true,
  command: null,
  lastProgram: null,
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  exit: null,
  agent: null,
  ready: null,
  activity: null,
  telemetry: null,
  process: { name: "sh", argv: null },
  run: 1,
  ...changes,
})

const read = async (watcher: TerminalWatcher, count: number) => {
  const changes = []
  for (let index = 0; index < count; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
    changes.push(await watcher.next())
  }
  return changes
}

describe("terminal watcher", () => {
  it("reports every current terminal, then synced, then later changes", async () => {
    const watcher = new TerminalWatcher([terminal("a"), terminal("b")])
    watcher.changed(terminal("c"))
    expect(await read(watcher, 4)).toEqual([
      { type: "changed", terminal: terminal("a") },
      { type: "changed", terminal: terminal("b") },
      { type: "synced" },
      { type: "changed", terminal: terminal("c") },
    ])
  })

  it("keeps only the latest unread summary of each terminal, in the order they first changed", async () => {
    const watcher = new TerminalWatcher([])
    watcher.changed(terminal("a", { process: { name: "vim", argv: null } }))
    watcher.changed(terminal("b"))
    for (let index = 0; index < 1000; index += 1) {
      watcher.changed(terminal("a", { process: { name: `step-${index}`, argv: null } }))
    }
    expect(await read(watcher, 3)).toEqual([
      { type: "synced" },
      { type: "changed", terminal: terminal("a", { process: { name: "step-999", argv: null } }) },
      { type: "changed", terminal: terminal("b") },
    ])
  })

  it("reports removal only of terminals the reader was told about", async () => {
    const watcher = new TerminalWatcher([terminal("initial")])
    watcher.removed(terminal("initial"))
    watcher.changed(terminal("unseen"))
    watcher.removed(terminal("unseen"))
    expect(await read(watcher, 3)).toEqual([
      { type: "changed", terminal: terminal("initial") },
      { type: "synced" },
      { type: "removed", terminalId: "initial", sessionId: "session" },
    ])
    watcher.changed(terminal("seen"))
    expect(await watcher.next()).toMatchObject({ type: "changed" })
    watcher.removed(terminal("seen"))
    expect(await watcher.next()).toEqual({
      type: "removed",
      terminalId: "seen",
      sessionId: "session",
    })
  })

  it("ends a waiting read when finished and ignores later changes", async () => {
    const watcher = new TerminalWatcher([])
    await watcher.next()
    const pending = watcher.next()
    watcher.finish()
    watcher.changed(terminal("late"))
    await expect(pending).resolves.toBeUndefined()
    await expect(watcher.next()).resolves.toBeUndefined()
  })
})

describe("keyed watcher", () => {
  it("keeps each key's latest change in its first place, a removal included, behind the current state", async () => {
    const watcher = new Watcher<string, string>([["a", "a1"]], "synced")
    watcher.changed("b", "b1")
    watcher.changed("a", "a2")
    watcher.changed("b", "b2")
    watcher.removed("a", "a gone")
    expect([await watcher.next(), await watcher.next()]).toEqual(["a1", "synced"])
    expect([await watcher.next(), await watcher.next()]).toEqual(["b2", "a gone"])
    // A window renamed after it was undocked stays ahead of the item it holds.
    watcher.changed("window", "window opened")
    watcher.changed("item", "item in window")
    watcher.changed("window", "window renamed")
    expect([await watcher.next(), await watcher.next()]).toEqual([
      "window renamed",
      "item in window",
    ])
    // A key the reader no longer knows leaves without a word.
    watcher.removed("a", "a gone again")
    watcher.finish()
    await expect(watcher.next()).resolves.toBeUndefined()
  })
})
