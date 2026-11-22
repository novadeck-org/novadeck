import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { logs, useLogger } from "../log.js"
import type { WorktreeRecord } from "../worktrees/records.js"
import { Shipping } from "./service.js"

let dir: string
let repo: string
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e", ...args], {
    cwd,
    stdio: "pipe",
  })
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gate-")))
  repo = join(dir, "app")
  sh(dir, "init", "-q", "-b", "main", repo)
  sh(repo, "remote", "add", "origin", "https://github.com/r/app.git")
  sh(repo, "commit", "-q", "--allow-empty", "-m", "first")
})
// A test whose answer lost the race to the deadline can leave its git lookup running in the
// folder, and Windows refuses to remove a folder a process is in until it ends.
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const service = (rows: readonly WorktreeRecord[] = []) =>
  new Shipping({
    enabled: () => true,
    owned: {
      ofTerminal: (id) => rows.filter((row) => row.terminalId === id),
      all: () => rows,
    },
    notify: () => true,
  })
const call = (command: string, event: "PreToolUse" | "PermissionRequest" = "PreToolUse") =>
  ({ event, command, cwd: repo }) as const
const force = "git push -f origin main"
const forceKey = "push-force:r/app:origin/main"

describe("which harnesses the gate covers", () => {
  it("covers Claude Code and Codex while on, and never Antigravity", () => {
    expect(service().covers("claude")).toBe(true)
    expect(service().covers("codex")).toBe(true)
    expect(service().covers("antigravity")).toBe(false)
    const off = new Shipping({
      enabled: () => false,
      owned: { ofTerminal: () => [], all: () => [] },
      notify: () => true,
    })
    expect(off.covers("claude")).toBe(false)
  })
})

describe("what the gate's answer does once printed", () => {
  it("uses a single-use permit only when the hook acknowledges the lease, in time", async () => {
    const shipping = service()
    shipping.permits.give("t", forceKey, true, { type: "quote", quote: "force it" })
    const answer = await shipping.answer("t", "claude", call(force), Date.now() + 3_000)
    expect(JSON.parse(answer!.stdout).hookSpecificOutput.permissionDecision).toBe("allow")
    expect(answer!.leaseId).toBeTypeOf("string")
    // Printed, but not yet acknowledged: nothing was used.
    expect(shipping.permits.covering("t", forceKey)).toBeDefined()
    // Another terminal's acknowledgement of it counts for nothing.
    shipping.acknowledged("u", answer!.leaseId!)
    expect(shipping.permits.covering("t", forceKey)).toBeDefined()
    shipping.acknowledged("t", answer!.leaseId!)
    expect(shipping.permits.covering("t", forceKey)).toBeUndefined()
    // A lease is acknowledged once.
    shipping.permits.give("t", forceKey, true, { type: "quote", quote: "force it" })
    shipping.acknowledged("t", answer!.leaseId!)
    expect(shipping.permits.covering("t", forceKey)).toBeDefined()
  })

  it("ignores an acknowledgement that came after the hook's deadline", async () => {
    const shipping = service()
    shipping.permits.give("t", forceKey, true, { type: "quote", quote: "force it" })
    // A deadline the answer meets even on a slow Windows runner, and an acknowledgement past it.
    const deadline = Date.now() + 3_000
    const answer = await shipping.answer("t", "claude", call(force), deadline)
    expect(answer?.leaseId).toBeTypeOf("string")
    vi.useFakeTimers({ now: deadline + 10_000, toFake: ["Date"] })
    try {
      shipping.acknowledged("t", answer!.leaseId!)
    } finally {
      vi.useRealTimers()
    }
    expect(shipping.permits.covering("t", forceKey)).toBeDefined()
  })

  it("gives no lease to a deny, and no answer to a command it has no opinion of", async () => {
    const shipping = service()
    const denied = await shipping.answer(
      "t",
      "claude",
      call("git push origin main"),
      Date.now() + 3_000,
    )
    expect(denied).toMatchObject({ leaseId: null })
    expect(JSON.parse(denied!.stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    expect(
      await shipping.answer("t", "claude", call("git status"), Date.now() + 3_000),
    ).toBeUndefined()
  })

  it("has no opinion once the hook's deadline passed or comes first, and never allows then", async () => {
    const shipping = service()
    shipping.permits.give("t", forceKey, true, { type: "quote", quote: "force it" })
    expect(await shipping.answer("t", "claude", call(force), Date.now() - 1)).toBeUndefined()
    const slow = (shipping as unknown as { gate: { decide: () => Promise<unknown> } }).gate
    slow.decide = () =>
      new Promise((resolve) => setTimeout(() => resolve({ stdout: "late", commit: () => {} }), 300))
    const started = Date.now()
    expect(await shipping.answer("t", "claude", call(force), started + 30)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(250)
  })

  it("answers nothing while it is off, or for Antigravity", async () => {
    const off = new Shipping({
      enabled: () => false,
      owned: { ofTerminal: () => [], all: () => [] },
      notify: () => true,
    })
    expect(await off.answer("t", "claude", call(force))).toBeUndefined()
    expect(await service().answer("t", "agy", call(force))).toBeUndefined()
  })
})

describe("the record of permits", () => {
  it("names who, what, where, on whose word and when, for a quote and for a card", async () => {
    const lines: { code: string; data: Record<string, unknown> }[] = []
    const before = logs.current()
    const note = (code: string, _text: string, extra?: { data?: Record<string, unknown> }) =>
      lines.push({ code, data: extra?.data ?? {} })
    useLogger({
      for: () => ({ debug: note, info: note, warn: note, error: note, fatal: note }) as never,
      flush: () => {},
      close: () => {},
    })
    try {
      const shipping = service()
      shipping.permits.give("t", "pr-merge:r/app#5", false, { type: "quote", quote: "merge it" })
      const card = shipping.cards.ask(
        "t",
        ["land:r/app:main"],
        false,
        "Land work on main?",
        "",
      ).card
      shipping.answered(card, true, "window-3")
      expect(lines.map((line) => line.code)).toEqual(["shipping.permit", "shipping.permit"])
      expect(lines[0]!.data).toMatchObject({
        terminalId: "t",
        target: "pr-merge:r/app#5",
        action: "merge PR #5 in r/app",
        singleUse: false,
        quote: "merge it",
      })
      expect(lines[0]!.data.at).toBeTypeOf("string")
      expect(lines[1]!.data).toMatchObject({
        target: "land:r/app:main",
        card: card.id,
        client: "window-3",
      })
    } finally {
      useLogger(before)
    }
  })
})
