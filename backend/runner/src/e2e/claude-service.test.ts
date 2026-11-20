import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Member } from "@novadeck/terminal/pty"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { endClaudeService, filetimeMs, isSession } from "./claude-service.js"

const relay = () => ({
  read: vi.fn<(root: number | Member) => Promise<readonly Member[] | undefined>>(),
  end: vi.fn<(members: readonly Member[]) => Promise<void>>(),
})

describe("the sandbox's Claude Code background service", () => {
  it("takes only its background sessions by their command lines", () => {
    expect(isSession("claude bg-pty-host --bg-pty-host /tmp/cc/spare/a.pty.sock 200 50 -- x")).toBe(
      true,
    )
    expect(isSession("claude bg-spare --bg-spare /tmp/cc/spare/a.claim.sock")).toBe(true)
    expect(isSession("claude --settings x")).toBe(false)
    expect(isSession("/usr/bin/claude bg-pty-host")).toBe(false)
    expect(isSession("claude bg-pty-hostile")).toBe(false)
  })

  it("reads a Windows FILETIME start to the millisecond", () => {
    // 2026-11-20T12:49:08.527Z.
    const ms = Date.UTC(2026, 10, 20, 12, 49, 8, 527)
    const filetime = (BigInt(ms) + 11_644_473_600_000n) * 10_000n + 1234n
    expect(filetimeMs(filetime.toString())).toBe(ms)
    expect(filetimeMs("12a")).toBeUndefined()
  })

  it("ends nothing without a lock it recognizes", async () => {
    const home = mkdtempSync(join(tmpdir(), "novadeck-claude-service-"))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    const trees = relay()
    expect(await endClaudeService(home, trees)).toEqual([])
    writeFileSync(join(home, "daemon.lock"), "{ half")
    expect(await endClaudeService(home, trees)).toEqual([])
    expect(trees.end).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === "win32")(
    "ends nothing where the lock's pid names another process now",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "novadeck-claude-service-"))
      onTestFinished(() => rmSync(home, { recursive: true, force: true }))
      const kill = vi.spyOn(process, "kill")
      onTestFinished(() => kill.mockRestore())
      // This very process, but not started when the lock says.
      writeFileSync(
        join(home, "daemon.lock"),
        JSON.stringify({ pid: process.pid, procStart: "1", startedAt: 1 }),
      )
      expect(await endClaudeService(home, relay())).toEqual([])
      expect(kill).not.toHaveBeenCalled()
    },
  )
})
