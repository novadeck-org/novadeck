import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Shipping } from "./service.js"

// A permitted opencode call's permits, as the hook's answer holds them by lease (`spend`) until
// its acknowledgement, or until its dialog's answer shows it ran (`confirmed`).
let dir: string
let repo: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e", ...args], {
    cwd,
    stdio: "pipe",
  })
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "novadeck-leases-")))
  repo = join(dir, "app")
  git(dir, "init", "-q", "-b", "main", repo)
  git(repo, "remote", "add", "origin", "https://github.com/r/app.git")
  git(repo, "commit", "-q", "--allow-empty", "-m", "first")
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const service = () =>
  new Shipping({
    enabled: () => true,
    owned: { ofTerminal: () => [], all: () => [] },
    notify: () => true,
  })
const force = "git push -f origin main"
const forceKey = "push-force:r/app:origin/main"
const pushKey = "push:r/app:origin/main"
const hooked = (shipping: Shipping, command: string, call: string, until: number) =>
  shipping.answer(
    "t",
    "opencode",
    { event: "PreToolUse", command, cwd: repo, conversation: "ses_1", call },
    until,
  )
const asked = (shipping: Shipping, command: string, call: string) =>
  shipping.answer(
    "t",
    "opencode",
    { event: "PermissionRequest", command, cwd: repo, conversation: "ses_1", call },
    Date.now() + 15_000,
  )

describe("an opencode call's permits, held by lease", () => {
  it("are given back by their own timer, though another answer's sweep comes past their expiry first", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.now() })
    const shipping = service()
    shipping.permits.give("t", forceKey, true, { type: "quote", quote: "force it" })
    shipping.permits.give("t", pushKey, false, { type: "quote", quote: "push it" })
    expect((await hooked(shipping, force, "c1", Date.now() + 1000))?.leaseId).toBeTypeOf("string")
    // Never acknowledged; the clock passes its expiry before its timer runs.
    vi.setSystemTime(Date.now() + 1600)
    await hooked(shipping, "git push origin main", "c2", Date.now() + 1000)
    vi.advanceTimersByTime(5000)
    expect(shipping.permits.covering("t", forceKey)).toBeDefined()
  }, 30_000)

  it("are spent by the dialog's answer for that call, whether or not the hook's acknowledgement comes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.now() })
    const shipping = service()
    shipping.permits.give("t", forceKey, true, { type: "quote", quote: "force it" })
    await hooked(shipping, force, "c1", Date.now() + 1000)
    const dialog = await asked(shipping, force, "c1")
    expect(dialog?.stdout).toContain("once")
    vi.advanceTimersByTime(5000)
    expect(shipping.permits.covering("t", forceKey)).toBeUndefined()
  }, 30_000)
})
