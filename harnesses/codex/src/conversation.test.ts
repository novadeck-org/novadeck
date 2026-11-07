import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { conversation } from "./conversation.js"

// A UUIDv7 made at 2026-11-06 21:54:21 UTC, as Codex numbers a thread.
const made = Date.UTC(2026, 10, 6, 21, 54, 21)
const v7 = (time: number, tail = "7ab0-80b5-3c549b9aa49c") =>
  `${time
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})/, "$1-")}-${tail}`
const id = v7(made)
let home = ""
const install = (env: NodeJS.ProcessEnv = {}) => ({
  env,
  home,
  platform: process.platform,
  plugin: "",
})
const sessions = () => join(home, ".codex", "sessions")
const day = (time: number) => {
  const at = new Date(time)
  return [
    String(at.getFullYear()),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
  ]
}
const rollout = (session: string, time: number, suffix = ".jsonl") => {
  const folder = join(sessions(), ...day(time))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `rollout-2026-11-06T22-54-21-${session}${suffix}`), "")
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-conversation-"))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("Codex's conversation", () => {
  it("is found in the folder of the day its id was made, compressed or not", async () => {
    rollout(id, made)
    expect(await conversation(install(), id)).toBe("found")
    const other = v7(made, "7ab0-80b5-000000000001")
    rollout(other, made, ".jsonl.zst")
    expect(await conversation(install(), other)).toBe("found")
  })

  it("is found a day off, for a clock at a time zone's edge", async () => {
    rollout(id, made + 86_400_000)
    expect(await conversation(install(), id)).toBe("found")
  })

  it("is gone once archived out of sessions, and unknown with no sessions folder", async () => {
    expect(await conversation(install(), id)).toBe("unknown")
    rollout(v7(made, "7ab0-80b5-000000000002"), made)
    mkdirSync(join(home, ".codex", "archived_sessions"), { recursive: true })
    writeFileSync(join(home, ".codex", "archived_sessions", `rollout-x-${id}.jsonl`), "")
    expect(await conversation(install(), id)).toBe("gone")
  })

  it("follows CODEX_HOME", async () => {
    const moved = join(home, "moved")
    mkdirSync(join(moved, "sessions", ...day(made)), { recursive: true })
    writeFileSync(join(moved, "sessions", ...day(made), `rollout-t-${id}.jsonl`), "")
    expect(await conversation(install({ CODEX_HOME: moved }), id)).toBe("found")
    expect(await conversation(install(), id)).toBe("unknown")
  })

  it("looks for an id with no date newest day first, and calls it gone once all are read", async () => {
    const old = "0d3a6e0e-5c52-4c1b-8d52-9f3a1b2c3d4e"
    rollout(old, Date.UTC(2026, 0, 3, 12))
    rollout(v7(made, "7ab0-80b5-000000000003"), made)
    expect(await conversation(install(), old)).toBe("found")
    expect(await conversation(install(), "11111111-2222-4333-8444-555555555555")).toBe("gone")
  })

  it("reads an id that is no file name as unknown", async () => {
    rollout(id, made)
    expect(await conversation(install(), "../sessions")).toBe("unknown")
  })
})
