import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { logs, useLogger } from "../log.js"
import type { WorktreeRecord } from "../worktrees/records.js"
import { setAgyPreToolUse } from "./hooks.js"
import { launchMode, pendingMs, Shipping } from "./service.js"

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
    // No process known: an earlier line may be another process's, so the launch's counts, else gated.
    expect(shipping.agyMode("t", ["--mode", "accept-edits"], null)).toBe("accept-edits")
    expect(shipping.agyMode("t", undefined, null)).toBe("")
    shipping.statusLine("t", { cycle_mode: "bypass" }, null)
    expect(shipping.agyMode("t", undefined, null)).toBe("")
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
    over: { askedAt?: number; requestId?: string; whole?: boolean } = {},
  ) => ({
    detail,
    call: command,
    requestId: over.requestId ?? "confirmation:run_command:3",
    askedAt: over.askedAt ?? Date.now() + 50,
    whole: over.whole ?? true,
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

  it("answers nothing where the dialog isn't shown whole, or its text isn't the note's exactly", async () => {
    const shipping = service()
    permitted(shipping)
    await hooked(shipping, push)
    // A cut one, a start of the command, and the command with another's tail.
    expect(
      await shipping.autoAnswer("t", "agy", dialog(push, push, { whole: false })),
    ).toBeUndefined()
    expect(await shipping.autoAnswer("t", "agy", dialog("git push origin", push))).toBeUndefined()
    expect(await shipping.autoAnswer("t", "agy", dialog(`${push} `, `${push} `))).toBeUndefined()
    expect(await shipping.autoAnswer("t", "agy", dialog(push, ` ${push}`))).toBeUndefined()
    expect(await shipping.autoAnswer("t", "agy", dialog(push, push))).toBeDefined()
  })

  it("answers nothing where another call's hook was seen near the note, whoever's it was", async () => {
    const hookedBy = (shipping: Shipping, command: string, conversation: string, step: number) =>
      shipping.answer(
        "t",
        "agy",
        { ...call(command), launch: ["--mode", "accept-edits"], step, conversation },
        Date.now() + slow,
      )
    // After it: a subagent's call, with the same step in a conversation of its own.
    const after = service()
    permitted(after)
    await hookedBy(after, push, "root", 3)
    await hookedBy(after, "git status", "sub", 3)
    expect(await after.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
    // Before it.
    const before = service()
    permitted(before)
    await hookedBy(before, "git status", "sub", 2)
    await hookedBy(before, push, "root", 3)
    expect(await before.autoAnswer("t", "agy", dialog(push, push))).toBeUndefined()
    // Alone, and another terminal's hook counts for nothing.
    const alone = service()
    permitted(alone)
    await alone.answer("u", "agy", {
      ...call("git status"),
      launch: ["--mode", "plan"],
      step: 4,
      conversation: "sub",
    })
    await hookedBy(alone, push, "root", 3)
    expect(await alone.autoAnswer("t", "agy", dialog(push, push))).toBeDefined()
  })

  it("is not stopped by the hook's own earlier refusal of the same command", async () => {
    // The usual way: denied, a permit given, run again. A denied call shows no dialog.
    const shipping = service()
    expect(await hooked(shipping, push, 2)).toMatchObject({ leaseId: null })
    permitted(shipping)
    await hooked(shipping, push, 3)
    expect(
      await shipping.autoAnswer(
        "t",
        "agy",
        dialog(push, push, { requestId: "confirmation:run_command:3" }),
      ),
    ).toBeDefined()
  })

  it("gives a single-use permit back only where nothing ended permits meanwhile, and never a standing one", async () => {
    const single = service()
    permitted(single, forceKey, true)
    await hooked(single, force)
    const auto = await single.autoAnswer("t", "agy", dialog(force, force))
    expect(single.permits.covering("t", forceKey)).toBeUndefined()
    // A revoke (the PR's base changed) ended permits while the keys went: nothing comes back.
    single.permits.revoke(forceKey)
    auto!.release()
    expect(single.permits.covering("t", forceKey)).toBeUndefined()
    // A standing permit was never taken, so it is neither lost nor re-added after a revoke.
    const standing = service()
    permitted(standing)
    await hooked(standing, push)
    const kept = await standing.autoAnswer("t", "agy", dialog(push, push))
    expect(standing.permits.covering("t", pushKey)).toBeDefined()
    standing.permits.revoke(pushKey)
    kept!.release()
    expect(standing.permits.covering("t", pushKey)).toBeUndefined()
  })

  it("refuses a command of the rules' shapes the gate couldn't decide in time, and leaves others to agy", async () => {
    const shipping = service()
    const slowGate = (shipping as unknown as { gate: { decide: () => Promise<unknown> } }).gate
    slowGate.decide = () => new Promise(() => {})
    const late = (command: string) =>
      shipping.answer("t", "agy", { ...call(command), launch: [] }, Date.now() + 40)
    const refused = await late("gh pr create --title x")
    expect(JSON.parse(refused!.stdout)).toMatchObject({ decision: "deny" })
    expect(JSON.parse((await late("cd /w && gh pr merge 5"))!.stdout)).toMatchObject({
      decision: "deny",
    })
    expect(await late("git push origin main")).toBeUndefined()
    slowGate.decide = () => Promise.reject(new Error("git failed"))
    expect(JSON.parse((await late("gh pr merge 5"))!.stdout)).toMatchObject({ decision: "deny" })
    expect(await late("ls")).toBeUndefined()
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

describe("a standing permit", () => {
  it("stands past ten minutes once the person allowed it, and the agent is told how long", () => {
    vi.useFakeTimers()
    try {
      const told: string[] = []
      const shipping = new Shipping({
        enabled: () => true,
        owned: { ofTerminal: () => [], all: () => [] },
        notify: (_terminalId, text) => told.push(text) > 0,
      })
      const card = shipping.cards.ask(
        "t",
        ["pr-merge:r/app#5"],
        false,
        "Merge PR #5 into main?",
        "",
      ).card
      shipping.answered(card, true)
      vi.advanceTimersByTime(3 * 60 * 60_000)
      expect(shipping.permits.covering("t", "pr-merge:r/app#5")).toMatchObject({
        group: card.id,
        title: "Merge PR #5 into main",
      })
      expect(told[0]).toContain("The permit stands for 12 hours, until its first use")
    } finally {
      vi.useRealTimers()
    }
  })

  it("ends once its PR merged or closed, as GitHub says, and stays while gh can't say", async () => {
    const states = new Map<string, boolean | undefined>([
      ["5", false],
      ["6", true],
      ["feat/x", undefined],
    ])
    const asked: string[] = []
    const shipping = new Shipping({
      enabled: () => true,
      owned: { ofTerminal: () => [], all: () => [] },
      notify: () => true,
      prOpen: async (repoName, pr) => {
        asked.push(`${repoName} ${pr}`)
        return states.get(pr)
      },
    })
    const quote = { type: "quote", quote: "merge stuff" } as const
    shipping.permits.give("t", "pr-merge:r/app#5", false, quote, { group: "a" })
    shipping.permits.give("t", "pr-merge:r/app@feat/a", false, quote, { group: "a" })
    shipping.permits.give("t", "pr-merge:r/app#6", false, quote, { group: "b" })
    shipping.permits.give("t", "pr-merge:r/app@feat/x", false, quote, { group: "c" })
    shipping.permits.give("t", "push:r/app:origin/main", false, quote, { group: "d" })
    await shipping.sweep(["t"])
    expect(shipping.permits.of("t").map(({ key }) => key)).toEqual([
      "pr-merge:r/app#6",
      "pr-merge:r/app@feat/x",
      "push:r/app:origin/main",
    ])
    // A push isn't a PR: it isn't asked about.
    expect(asked).toEqual(["r/app 5", "r/app 6", "r/app feat/x"])
  })
})

describe("what the person sees stand, and takes back", () => {
  const joined = () => {
    const told: string[] = []
    const shipping = new Shipping({
      enabled: () => true,
      owned: { ofTerminal: () => [], all: () => [] },
      notify: (_terminalId, text) => told.push(text) > 0,
    })
    const changed: string[] = []
    const records = new Map([["t", { summary: { id: "t" }, bound: undefined }]]) as never
    shipping.attach(records, (record: { summary: { id: string } }) =>
      changed.push(record.summary.id),
    )
    return { shipping, told, changed }
  }

  it("shows one entry for each declaration or card, with the person's own words, never the agent's", () => {
    const { shipping, changed } = joined()
    const quote = { type: "quote", quote: "merge stuff" } as const
    const given = { group: "g", title: "Merge PR #5 into main" }
    shipping.permits.give("t", "pr-merge:r/app#5", false, quote, given)
    shipping.permits.give("t", "pr-merge:r/app@feat/x", false, quote, given)
    shipping.permits.give(
      "t",
      "land:r/app:main",
      false,
      { type: "answer", card: "c" },
      {
        group: "c",
        title: "Land work on main",
      },
    )
    const { permits } = shipping.held("t")
    expect(permits).toEqual([
      expect.objectContaining({
        id: "g",
        title: "Merge PR #5 into main",
        quote: "merge stuff",
        usedAt: null,
      }),
      expect.objectContaining({ id: "c", title: "Land work on main", quote: null }),
    ])
    expect(permits[0]!.until - permits[0]!.givenAt).toBe(12 * 60 * 60_000)
    // Each change republishes the terminal's detail.
    expect(changed).toEqual(["t", "t", "t"])
  })

  it("takes a permit back whole, tells the agent, and says so; a terminal it doesn't know is no terminal", () => {
    const { shipping, told } = joined()
    const quote = { type: "quote", quote: "merge stuff" } as const
    shipping.permits.give("t", "pr-merge:r/app#5", false, quote, {
      group: "g",
      title: "Merge PR #5 into main",
    })
    shipping.permits.give("t", "pr-merge:r/app@feat/x", false, quote, {
      group: "g",
      title: "Merge PR #5 into main",
    })
    expect(shipping.takeBack("t", "g")).toBe(true)
    expect(shipping.permits.covering("t", "pr-merge:r/app@feat/x")).toBeUndefined()
    expect(shipping.held("t").permits).toEqual([])
    expect(told[0]).toContain(
      "The user took back the permit: Merge PR #5 into main. No permit covers it now.",
    )
    expect(shipping.takeBack("t", "g")).toBe(false)
    expect(shipping.takeBack("gone", "g")).toBeUndefined()
  })
})

describe("the gate while off", () => {
  it("holds nothing for the detail, so the agent's detail is as it was", () => {
    let on = true
    const shipping = new Shipping({
      enabled: () => on,
      owned: { ofTerminal: () => [], all: () => [] },
      notify: () => true,
    })
    shipping.permits.give("t", "land:r/app:main", false, { type: "quote", quote: "land it" })
    shipping.cards.ask("t", ["push:r/app:origin/main"], false, "Push to origin/main?", "")
    expect(shipping.held("t").permits).toHaveLength(1)
    on = false
    expect(shipping.held("t")).toEqual({ cards: [], permits: [] })
  })
})
