import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { claudeApart, homeOf, parseLock } from "./daemon.js"

// As Claude Code 2.1.329 wrote it (probed 2026-11-20), trimmed.
const lockFile = (more: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid: 500,
    version: "2.1.329",
    startedAt: 1_795_178_948_527,
    origin: "transient",
    spawnedBy: { label: "claude", cwd: "/work/project", pid: 400 },
    procStart: "75822456",
    ...more,
  })

describe("Claude Code's background service lock", () => {
  it("names the service by its pid and start", () => {
    expect(parseLock(lockFile())).toEqual({ pid: 500, start: "75822456", startFt: undefined })
    expect(
      parseLock(lockFile({ procStart: undefined, procStartFt: "134080000000000000" })),
    ).toEqual({ pid: 500, start: undefined, startFt: "134080000000000000" })
  })

  it("recognizes no lock that isn't one", () => {
    expect(parseLock("{")).toBeUndefined()
    expect(parseLock("[]")).toBeUndefined()
    expect(parseLock(lockFile({ pid: "500" }))).toBeUndefined()
    expect(parseLock(lockFile({ pid: 1 }))).toBeUndefined()
  })

  it("lies in the configuration folder the session's transcript is in", () => {
    expect(homeOf("/home/me/.claude/projects/-work-project/abc.jsonl")).toBe("/home/me/.claude")
    expect(homeOf("/home/me/elsewhere/projects/-work/abc.jsonl")).toBe("/home/me/elsewhere")
    expect(homeOf("/home/me/abc.jsonl")).toBeUndefined()
  })
})

describe("what a Claude Code terminal's close leaves running", () => {
  let home: string | undefined
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  // A configuration folder, as `CLAUDE_CONFIG_DIR` may name one, with a session's transcript.
  const folder = () => {
    home = mkdtempSync(join(tmpdir(), "novadeck-claude-apart-"))
    mkdirSync(join(home, "projects", "-work-project"), { recursive: true })
    return { home, transcript: join(home, "projects", "-work-project", "abc.jsonl") }
  }

  it("is the service of the folder the closed session's transcript is in", async () => {
    const { home: where, transcript } = folder()
    writeFileSync(join(where, "daemon.lock"), lockFile())
    expect(await claudeApart({ transcript })).toEqual([{ pid: 500, start: "75822456" }])
  })

  it("is nothing without a transcript, a lock, or a start it can name it by", async () => {
    const { home: where, transcript } = folder()
    expect(await claudeApart({})).toEqual([])
    expect(await claudeApart({ transcript })).toEqual([])
    writeFileSync(join(where, "daemon.lock"), "{ half")
    expect(await claudeApart({ transcript })).toEqual([])
    writeFileSync(join(where, "daemon.lock"), lockFile({ procStart: undefined }))
    expect(await claudeApart({ transcript })).toEqual([])
    expect(await claudeApart({ transcript: join(where, "abc.jsonl") })).toEqual([])
  })
})
