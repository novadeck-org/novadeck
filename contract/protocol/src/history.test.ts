import { describe, expect, it } from "vitest"

import { contract } from "./contract.js"
import { closedTerminal, closedTerminalState, historyChange } from "./history.js"
import { terminalSummary } from "./terminals.js"

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  title: "Fix login",
  summary: "Fixes the login bug.",
  handle: "moth",
  agent: "claude",
  program: null,
  cwd: "/shop",
  closedAt: 1_700_000_000_000,
  closedBy: "fox",
  availability: { state: "ready" },
}

describe("a closed terminal", () => {
  it("carries each availability with what it needs", () => {
    for (const state of [
      { state: "ready" },
      { state: "restoring" },
      { state: "gone", reason: "conversation" },
      { state: "gone", reason: "folder" },
      { state: "disconnected", agent: "codex" },
      { state: "open", handle: "owl", terminalId: "00000000-0000-4000-8000-000000000001" },
    ])
      expect(closedTerminalState.safeParse(state).success, JSON.stringify(state)).toBe(true)
    for (const state of [
      { state: "gone" },
      { state: "gone", reason: "other" },
      { state: "disconnected" },
      { state: "open", handle: "Not A Handle", terminalId: "00000000-0000-4000-8000-000000000001" },
      { state: "unknown" },
    ])
      expect(closedTerminalState.safeParse(state).success, JSON.stringify(state)).toBe(false)
  })

  it("is a row of a plain terminal as well, with no agent and no handle to name it", () => {
    expect(closedTerminal.safeParse(row).success).toBe(true)
    expect(
      closedTerminal.safeParse({
        ...row,
        agent: null,
        handle: null,
        program: "vim",
        closedBy: null,
      }).success,
    ).toBe(true)
    expect(closedTerminal.safeParse({ ...row, transcript: "screen" }).success).toBe(false)
  })

  it("is followed by changes, removals and the end of the first set", () => {
    expect(historyChange.safeParse({ type: "changed", closed: row }).success).toBe(true)
    expect(
      historyChange.safeParse({ type: "removed", id: row.id, projectId: row.projectId }).success,
    ).toBe(true)
    expect(historyChange.safeParse({ type: "synced" }).success).toBe(true)
  })
})

describe("a restore", () => {
  const create = contract.terminals.create["~orpc"].inputSchema!
  const base = { id: row.id, sessionId: row.projectId, cols: 80, rows: 24 }

  it("names the row and nothing else about the terminal", () => {
    expect(create.safeParse({ ...base, closed: row.projectId }).success).toBe(true)
    for (const more of [{ command: "ls" }, { restore: true }, { resume: "claude" }, { cwd: "/x" }])
      expect(create.safeParse({ ...base, closed: row.projectId, ...more }).success).toBe(false)
  })
})

describe("a terminal's summary", () => {
  it("requires whether it is restorable and busy", () => {
    const { restorable, busy } = terminalSummary.shape
    expect(restorable.safeParse(undefined).success).toBe(false)
    expect(busy.safeParse(undefined).success).toBe(false)
    expect(restorable.safeParse(false).success).toBe(true)
    expect(busy.safeParse(true).success).toBe(true)
  })
})
