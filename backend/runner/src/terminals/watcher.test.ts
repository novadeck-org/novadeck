import type { TerminalSummary } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { TerminalWatcher } from "./watcher.js"

const terminal = (id: string, changes: Partial<TerminalSummary> = {}): TerminalSummary => ({
  id,
  sessionId: "session",
  title: "Terminal 01",
  titleSource: { kind: "default" },
  handle: "moth",
  started: true,
  ledBy: null,
  openedBy: null,
  agentRan: false,
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
  reported: null,
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
})
