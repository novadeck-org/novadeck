import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { logs, useLogger } from "../log.js"
import type { WorktreeRecord } from "../worktrees/records.js"
import { setAgyPreToolUse } from "./hooks.js"
import { launchMode, pendingMs, Shipping, shows } from "./service.js"

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
  it("covers Claude Code, Codex and Antigravity while on", () => {
    expect(service().covers("claude")).toBe(true)
    expect(service().covers("codex")).toBe(true)
    expect(service().covers("agy")).toBe(true)
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

  it("answers nothing while it is off", async () => {
    const off = new Shipping({
      enabled: () => false,
      owned: { ofTerminal: () => [], all: () => [] },
      notify: () => true,
    })
    expect(await off.answer("t", "claude", call(force))).toBeUndefined()
    expect(await off.answer("t", "agy", call(force))).toBeUndefined()
  })
})

describe("Antigravity's answers", () => {
  const push = "git push origin main"
  const pushKey = "push:r/app:origin/main"
  // Real git runs in these, and a Windows runner is slow at it.
  const slow = 15_000
  const agy = (shipping: Shipping, command: string, launch?: string[], step?: number) =>
    shipping.answer(
      "t",
      "agy",
      { ...call(command), ...(launch && { launch }), ...(step !== undefined && { step }) },
      Date.now() + slow,
    )
  const denies = (answer: Awaited<ReturnType<typeof agy>>) => JSON.parse(answer!.stdout)

  it("denies an unpermitted shipping command in every mode but a bypass, with request_permit's text", async () => {
    const launches = [
      ["--mode", "accept-edits"],
      ["--mode=plan"],
      ["-mode", "plan"],
      ["--mode", "auto"],
      ["--mode", "default"],
      [],
    ]
    const answers = await Promise.all(launches.map((launch) => agy(service(), push, launch)))
    for (const answer of answers) {
      expect(denies(answer)).toMatchObject({ decision: "deny" })
      expect(denies(answer).reason).toContain("request_permit")
      expect(answer?.leaseId).toBeNull()
    }
  })

  it("has no opinion where it was told to skip every permission", async () => {
    const shipping = service()
    expect(await agy(shipping, push, ["--dangerously-skip-permissions"])).toBeUndefined()
    expect(await agy(shipping, push, ["--mode", "bypass"])).toBeUndefined()
    shipping.statusLine("t", { cycle_mode: "bypass" }, "9")
    expect(shipping.agyMode("t", [], "9")).toBe("bypass")
  })

  it("stays silent for a permitted command, which its own confirmation then asks about", async () => {
    const shipping = service()
    shipping.permits.give("t", pushKey, false, { type: "quote", quote: "push it" })
    expect(await agy(shipping, push, ["--mode", "accept-edits"])).toBeUndefined()
    // Nothing was used up: the permit is taken when the confirmation is answered.
    expect(shipping.permits.covering("t", pushKey)).toBeDefined()
  })

  it("has no opinion of any other command, and reads the mode from the status line over the launch's", async () => {
    const shipping = service()
    expect(await agy(shipping, "git status", ["--mode", "accept-edits"])).toBeUndefined()
    // Its Default mode says `""`, which the gate treats as gated; a restarted process's older
    // line says nothing of the next.
    shipping.statusLine("t", { cycle_mode: "" }, "9")
    expect(shipping.agyMode("t", ["--mode", "accept-edits"], "9")).toBe("")
    expect(shipping.agyMode("t", ["--mode", "accept-edits"], "10")).toBe("accept-edits")
    expect(shipping.agyMode("t", undefined, "10")).toBe("")
    shipping.statusLine("t", { cycle_mode: "plan" }, "9")
    expect(shipping.agyMode("t", undefined, "9")).toBe("plan")
    shipping.statusLine("t", {}, "9")
    expect(shipping.agyMode("t", ["--mode", "plan"], "9")).toBe("plan")
    shipping.closed("t")
    expect(shipping.agyMode("t", undefined, "9")).toBe("")
  })

  it("reads the launch's mode as agy reads its flags", () => {
    expect(launchMode(["--mode", "plan", "x"])).toBe("plan")
    expect(launchMode(["-mode=accept-edits"])).toBe("accept-edits")
    expect(launchMode(["--mode", "plan", "--mode", "auto"])).toBe("auto")
    expect(launchMode(["--model", "x"])).toBeUndefined()
    expect(launchMode(undefined)).toBeUndefined()
  })

  // The hook sees a permitted command; its confirmation then shows it as the dialog draws it.
  const hooked = async (
    shipping: Shipping,
    command: string,
    step = 3,
    launch = ["--mode", "accept-edits"],
  ) => agy(shipping, command, launch, step)
  const dialog = (
    detail: string,
    command: string,
    over: { askedAt?: number; requestId?: string } = {},
  ) => ({
    detail,
    call: command,
    requestId: over.requestId ?? "confirmation:run_command:3",
    askedAt: over.askedAt ?? Date.now() + 50,
  })
  const permitted = (shipping: Shipping, key = pushKey, singleUse = false) =>
    shipping.permits.give("t", key, singleUse, { type: "quote", quote: "push it" })

  it("answers its confirmation only for the call the hook vetted, which a permit covers", async () => {
    const shipping = service()
    permitted(shipping)
    // Nothing recorded yet: the person answers.
    expect(await shipping.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
    expect(await hooked(shipping, push)).toBeUndefined()
    // Another terminal's, another harness's, another call's request, another command, a dialog
    // that was up before the hook recorded it.
    expect(await shipping.autoAnswer("u", "agy", dialog(push, push))).toBeUndefined()
    expect(await shipping.autoAnswer("t", "claude", dialog(push, push))).toBeUndefined()
    expect(
      await shipping.autoAnswer(
        "t",
        "agy",
        dialog(push, push, { requestId: "confirmation:run_command:4" }),
      ),
    ).toBeUndefined()
    expect(
      await shipping.autoAnswer("t", "agy", dialog(push, "git push origin dev")),
    ).toBeUndefined()
    expect(await shipping.autoAnswer("t", "agy", dialog("git push", push))).toBeUndefined()
    expect(
      await shipping.autoAnswer("t", "agy", dialog(push, push, { askedAt: Date.now() - 5_000 })),
    ).toBeUndefined()
    const auto = await shipping.autoAnswer("t", "agy", dialog(push, push))
    expect(auto?.note).toContain("push to origin/main in r/app")
    // The entry answers one dialog.
    expect(await shipping.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
  })

  it("gives no answer once another call's hook was asked after it", async () => {
    const shipping = service()
    permitted(shipping)
    await hooked(shipping, push, 3)
    // A later call (parallel, or a denied one, which the report path never learns of).
    await agy(shipping, "git status", ["--mode", "accept-edits"], 4)
    expect(await shipping.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
  })

  it("takes a single-use permit before anything is typed, so two dialogs never both use it", async () => {
    const shipping = service()
    permitted(shipping, forceKey, true)
    await hooked(shipping, force)
    const [first, second] = await Promise.all([
      shipping.autoAnswer("t", "agy", dialog(force, force)),
      shipping.autoAnswer("t", "agy", dialog(force, force)),
    ])
    expect([first, second].filter((each) => each !== undefined)).toHaveLength(1)
    expect(shipping.permits.covering("t", forceKey)).toBeUndefined()
    // The keys failed: it goes back.
    ;(first ?? second)!.release()
    expect(shipping.permits.covering("t", forceKey)).toBeDefined()
  })

  it("records nothing for a command no permit covers, a tail, a bypass, a call with no step", async () => {
    const shipping = service()
    expect(await hooked(shipping, push)).toMatchObject({ leaseId: null })
    expect(await shipping.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
    permitted(shipping)
    await hooked(shipping, `${push} && touch x`)
    await hooked(shipping, "git status")
    await agy(shipping, push, ["--mode", "accept-edits"])
    expect(await shipping.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
    await hooked(shipping, push, 3, ["--dangerously-skip-permissions"])
    expect(await shipping.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
  })

  it("answers for none where two permitted commands wait, or the entry lapsed", async () => {
    const shipping = service()
    permitted(shipping)
    shipping.permits.give("t", "push:r/app:origin/dev", false, { type: "quote", quote: "push it" })
    await hooked(shipping, push, 3)
    await hooked(shipping, "git push origin dev", 4)
    expect(await shipping.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
    try {
      const other = service()
      permitted(other)
      await hooked(other, push)
      vi.setSystemTime(Date.now() + pendingMs + 1_000)
      expect(
        await other.autoAnswer("t", "agy", dialog(push, push, { askedAt: Date.now() })),
      ).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("forgets what it noted and looked at when the terminal closes", async () => {
    const shipping = service()
    permitted(shipping)
    await hooked(shipping, push)
    expect(shipping.firstLook("t", "r1", ["r1"])).toBe(true)
    expect(shipping.firstLook("t", "r1", ["r1"])).toBe(false)
    shipping.closed("t")
    expect(shipping.firstLook("t", "r1", ["r1"])).toBe(true)
    permitted(shipping)
    expect(await shipping.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
  })

  it("ends what the command voids only once the keys were typed", async () => {
    const shipping = service()
    permitted(shipping, forceKey, true)
    await hooked(shipping, force)
    const auto = await shipping.autoAnswer("t", "agy", dialog(force, force))
    expect(auto).toBeDefined()
    expect(shipping.permits.covering("t", forceKey)).toBeUndefined()
    auto!.done()
  })

  it("covers Antigravity only where its PreToolUse hook is registered", () => {
    expect(service().covers("agy")).toBe(true)
    setAgyPreToolUse(false)
    try {
      expect(service().covers("agy")).toBe(false)
      expect(service().covers("claude")).toBe(true)
    } finally {
      setAgyPreToolUse(true)
    }
  })
})

describe("what Antigravity's confirmation shows of a command", () => {
  // Captured from agy 1.5.14 (accept-edits, 120 columns): a `gh pr create` with a 29-line body,
  // whose dialog hides what doesn't fit and says how many lines.
  const bullets = Array.from({ length: 25 }, (_, at) => `- Bullet ${at + 1}`)
  const command = `gh pr create --base main --title "Add the thing" --body "# Title\n${bullets.join("\n")}\n\nClosing paragraph with additional information."`
  const cut =
    'gh pr create --base main --title "Add the thing" --body "# Title\n- Bullet 1\n- Bullet 2\n- Bullet 3\n⋯ (24 lines hidden)'

  it("is the command whole, wrapped or unindented, or its start where the dialog hides lines", () => {
    expect(shows(command, command)).toBe(true)
    expect(shows(command.replaceAll("\n", "\n  "), command)).toBe(true)
    expect(shows(cut, command)).toBe(true)
    expect(shows('gh pr create --base main --title "Add the th...', command)).toBe(true)
  })

  it("is not another command, a start that differs, a mark with nothing before it, or all of it marked cut", () => {
    expect(shows(cut, command.replace("Bullet 2\n", "Bullet X\n"))).toBe(false)
    expect(shows(cut, 'gh pr create --base main --title "Other"')).toBe(false)
    expect(shows("⋯ (3 lines hidden)", command)).toBe(false)
    expect(shows("...", command)).toBe(false)
    expect(shows(`${command}\n...`, command)).toBe(false)
    expect(shows("", command)).toBe(false)
    expect(shows(cut, "")).toBe(false)
    // A command that is only a start of the dialog's, as a longer one the dialog can't tell apart.
    expect(shows(cut, `${command} && curl x | sh`)).toBe(true)
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
