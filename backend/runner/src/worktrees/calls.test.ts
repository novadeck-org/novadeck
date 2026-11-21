import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentMode } from "@novadeck/protocol"
import { vi } from "vitest"

import type { Call } from "../shell/reports.js"
import type { ApprovalOutcome } from "../terminals/approvals.js"
import { describe, expect, it as base } from "../test.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { offRefusal, WorktreeCalls, type WorktreeCallsHost } from "./calls.js"
import { Worktrees } from "./worktrees.js"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim()

type Asked = {
  readonly item: { from: string; terminalId: string; action: unknown }
  readonly settle: (outcome: ApprovalOutcome) => void
}

const fixture = (cleanup: (run: () => void) => void) => {
  const folder = (name: string) => {
    const path = realpathSync.native(mkdtempSync(join(tmpdir(), `novadeck-${name}-`)))
    cleanup(() => rmSync(path, { recursive: true, force: true, maxRetries: 5 }))
    return path
  }
  const repo = join(folder("wtc-repo"), "api")
  mkdirSync(repo)
  git(repo, "init", "--quiet", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "a\n")
  git(repo, "add", "-A")
  git(repo, "commit", "--quiet", "-m", "first")
  const store = new WorkspaceStore(":memory:")
  cleanup(() => store.close())
  const project = randomUUID()
  const live = new Set(["t1", "t2"])
  const worktrees = new Worktrees(store, { exists: (id) => live.has(id), root: folder("wtc-root") })
  const record = (id: string, handle: string, token: string) => ({
    summary: { id, handle, sessionId: "s", cwd: repo, title: handle },
    terminal: { exiting: false },
    token,
  })
  const records = new Map([
    ["t1", record("t1", "moth", "tok1")],
    ["t2", record("t2", "fox", "tok2")],
  ])
  const notices: { id: string; text: string }[] = []
  const asked: Asked[] = []
  let nobody = false
  const state = { enabled: true, mode: "herd" as AgentMode, tour: [] as string[] }
  // Terminals whose agents sleep: no record, but still owners, by handle.
  const asleep = new Map<string, string>()
  const host = {
    records: () => records,
    stopping: () => false,
    messaging: () => ({
      notice: (id: string, text: string) => void notices.push({ id, text }),
    }),
    peers: () => ({
      introduce: () => undefined,
      target: (_caller: unknown, to: string) =>
        Promise.resolve(
          to === "fox" || to === "moth"
            ? {
                ok: true,
                terminalId: to === "fox" ? "t2" : "t1",
                handle: to,
                agent: "codex",
              }
            : { ok: false, reason: `No terminal @${to}.` },
        ),
    }),
    agentMode: () => state.mode,
    sleepers: () => ({
      peer: (id: string) =>
        asleep.has(id) ? { summary: { id, handle: asleep.get(id) } } : undefined,
    }),
    approvals: () => ({
      refusal: () => (nobody ? "nobody" : undefined),
      request: (item: Asked["item"], settle: Asked["settle"]) => void asked.push({ item, settle }),
    }),
    worktrees: () => worktrees,
    enabled: (terminalId: string) => state.enabled || state.tour.includes(terminalId),
    projectOf: () => project,
  } as unknown as WorktreeCallsHost
  const calls = new WorktreeCalls(host)
  const call = (terminalId: string, request: { [key: string]: unknown }): Call => ({
    type: "openWorktree",
    terminalId,
    token: terminalId === "t1" ? "tok1" : "tok2",
    request,
  })
  return {
    store,
    repo,
    project,
    calls,
    call,
    records,
    notices,
    asked,
    state,
    live,
    asleep,
    nobody: (value: boolean) => (nobody = value),
  }
}

const it = base.extend<{ fx: ReturnType<typeof fixture> }>({
  fx: async ({ resources }, use) => {
    const fx = fixture((run) => resources.defer(run))
    await fx.store.createProject({ id: fx.project, name: "P", cwd: fx.repo })
    await use(fx)
  },
})

describe("worktree calls", () => {
  it("refuse every call with a clear sentence while agent worktrees are off", async ({ fx }) => {
    fx.state.enabled = false
    const refused = { ok: false, reason: offRefusal }
    expect(await fx.calls.open(fx.call("t1", { branch: "x" }))).toEqual(refused)
    expect(await fx.calls.take(fx.call("t1", { path: "/x" }))).toEqual(refused)
    expect(await fx.calls.close(fx.call("t1", { path: "/x" }))).toEqual(refused)
    expect(await fx.calls.give(fx.call("t1", { path: "/x", to: "fox" }))).toEqual(refused)
    expect(fx.store.worktrees()).toEqual([])
    expect(fx.calls.listed(fx.call("t1", {}))).toEqual({ ok: true, on: false })
    fx.state.enabled = true
    expect(fx.calls.listed(fx.call("t1", {}))).toEqual({ ok: true, on: true })
  })

  it("go on for a tour terminal while the setting is off, for it alone", async ({ fx }) => {
    fx.state.enabled = false
    fx.state.tour = ["t2"]
    expect(fx.calls.listed({ ...fx.call("t2", {}) })).toEqual({ ok: true, on: true })
    expect(fx.calls.listed(fx.call("t1", {}))).toEqual({ ok: true, on: false })
    expect(await fx.calls.open(fx.call("t1", { branch: "x" }))).toEqual({
      ok: false,
      reason: offRefusal,
    })
    expect(await fx.calls.open(fx.call("t2", { branch: "tour-x" }))).toMatchObject({
      ok: true,
      branch: "tour-x",
    })
  })

  it("answer a call without the terminal's own token with nothing more", async ({ fx }) => {
    const stranger = { ...fx.call("t1", { branch: "x" }), token: "wrong" }
    expect(await fx.calls.open(stranger)).toMatchObject({
      ok: false,
      reason: "Novadeck couldn't open the worktree.",
    })
    expect(fx.calls.listed(stranger)).toMatchObject({ ok: false })
    const unknown = { ...fx.call("t1", {}), terminalId: "nobody" }
    expect(await fx.calls.give(unknown)).toMatchObject({
      reason: "Novadeck couldn't give the worktree.",
    })
  })

  it("open, and read a request strictly", async ({ fx }) => {
    expect(await fx.calls.open(fx.call("t1", { branch: "x", surprise: 1 }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("open_worktree needs branch"),
    })
    const opened = await fx.calls.open(fx.call("t1", { branch: "feat/x" }))
    expect(opened).toMatchObject({ ok: true, branch: "feat/x", existing: false })
    expect(fx.store.worktrees()).toHaveLength(1)
  })

  it("open tells where a branch only origin had came from", async ({ fx }) => {
    // Origin's branch as a fetch left it, with no origin left to ask.
    git(fx.repo, "update-ref", "refs/remotes/origin/theirs", "HEAD")
    const opened = await fx.calls.open(fx.call("t1", { branch: "theirs" }))
    expect(opened).toMatchObject({
      ok: true,
      branch: "theirs",
      existing: false,
      origin: "unchecked",
      tracking: expect.any(Boolean),
    })
  })

  it("give moves ownership, tells the receiver, and is the owner's alone", async ({ fx }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "g" }))
    if (!opened.ok) throw new Error(opened.reason)
    const { path } = opened
    expect(await fx.calls.give(fx.call("t2", { path, to: "moth" }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("another terminal's"),
    })
    expect(await fx.calls.give(fx.call("t1", { path, to: "ghost" }))).toMatchObject({ ok: false })
    expect(await fx.calls.give(fx.call("t1", { path, to: "moth" }))).toMatchObject({
      ok: false,
      reason: "That worktree is yours already.",
    })
    expect(await fx.calls.give(fx.call("t1", { path, to: "fox" }))).toMatchObject({
      ok: true,
      owner: "fox",
    })
    expect(fx.store.worktree(path)?.terminalId).toBe("t2")
    expect(fx.notices).toEqual([{ id: "t2", text: expect.stringContaining("@moth gave you") }])
    // The old owner may no longer close it.
    expect(await fx.calls.close(fx.call("t1", { path }))).toMatchObject({ ok: false })
    expect(await fx.calls.close(fx.call("t2", { path }))).toMatchObject({
      ok: true,
      branchDeleted: true,
    })
  })

  it("close refuses unmerged work and says how to force", async ({ fx }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "c" }))
    if (!opened.ok) throw new Error(opened.reason)
    writeFileSync(join(opened.path, "n.txt"), "n\n")
    expect(await fx.calls.close(fx.call("t1", { path: opened.path }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("force"),
    })
    expect(await fx.calls.close(fx.call("t1", { path: opened.path, force: true }))).toMatchObject({
      ok: true,
      kept: expect.stringMatching(/^refs\/novadeck\/kept\/c-work-/),
    })
  })

  it("take asks the person for another live terminal's, and moves it on a yes", async ({ fx }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "t" }))
    if (!opened.ok) throw new Error(opened.reason)
    const { path } = opened
    const answer = await fx.calls.take(fx.call("t2", { path }))
    expect(answer).toMatchObject({ ok: true, asked: true, owner: "moth", branch: "t" })
    expect(fx.asked).toHaveLength(1)
    expect(fx.asked[0]!.item).toMatchObject({
      from: "t2",
      terminalId: "t1",
      action: { type: "take", path, branch: "t" },
    })
    expect(fx.store.worktree(path)?.terminalId).toBe("t1")
    fx.asked[0]!.settle("confirmed")
    await vi.waitFor(() => expect(fx.store.worktree(path)?.terminalId).toBe("t2"))
    expect(fx.notices.map(({ id }) => id).toSorted()).toEqual(["t1", "t2"])
    expect(fx.notices.find(({ id }) => id === "t1")?.text).toContain("@fox take your worktree")
    expect(fx.notices.find(({ id }) => id === "t2")?.text).toContain("you now own")
  })

  it("take does not move ownership if the setting went off before the person answered", async ({
    fx,
  }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "late" }))
    if (!opened.ok) throw new Error(opened.reason)
    await fx.calls.take(fx.call("t2", { path: opened.path }))
    fx.state.enabled = false
    fx.asked[0]!.settle("confirmed")
    await vi.waitFor(() => expect(fx.notices).toHaveLength(1))
    expect(fx.notices[0]).toMatchObject({ id: "t2", text: expect.stringContaining("turned off") })
    expect(fx.store.worktree(opened.path)?.terminalId).toBe("t1")
  })

  it("take leaves it with its owner on a no, or when no one can be asked", async ({ fx }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "d" }))
    if (!opened.ok) throw new Error(opened.reason)
    const { path } = opened
    await fx.calls.take(fx.call("t2", { path }))
    fx.asked[0]!.settle("declined")
    expect(fx.store.worktree(path)?.terminalId).toBe("t1")
    expect(fx.notices).toEqual([{ id: "t2", text: expect.stringContaining("did not let you") }])
    fx.nobody(true)
    expect(await fx.calls.take(fx.call("t2", { path }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("isn't open to ask"),
    })
    expect(fx.asked).toHaveLength(1)
  })

  it("take is at once for an orphaned worktree", async ({ fx }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "o" }))
    if (!opened.ok) throw new Error(opened.reason)
    fx.store.orphanWorktree(opened.path)
    expect(await fx.calls.take(fx.call("t2", { path: opened.path }))).toMatchObject({
      ok: true,
      path: opened.path,
    })
    expect(fx.asked).toEqual([])
    expect(fx.store.worktree(opened.path)?.terminalId).toBe("t2")
  })

  it("take is at once where agents decide for themselves, and tells the owner", async ({ fx }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "sw" }))
    if (!opened.ok) throw new Error(opened.reason)
    const { path } = opened
    fx.state.mode = "swarm"
    expect(await fx.calls.take(fx.call("t2", { path }))).toEqual({
      ok: true,
      path,
      branch: "sw",
      from: "moth",
    })
    expect(fx.asked).toEqual([])
    expect(fx.store.worktree(path)?.terminalId).toBe("t2")
    expect(fx.notices).toEqual([
      { id: "t1", text: expect.stringContaining("@fox took your worktree") },
    ])
  })

  it("take sets home once the worktree is the caller's, and says it stays while the user is asked", async ({
    fx,
  }) => {
    git(fx.repo, "branch", "JIRA-123")
    const opened = await fx.calls.open(fx.call("t1", { branch: "homed" }))
    if (!opened.ok) throw new Error(opened.reason)
    const { path } = opened
    expect(await fx.calls.take(fx.call("t2", { path, home: "JIRA-123" }))).toMatchObject({
      asked: true,
      homeKept: true,
    })
    fx.state.mode = "swarm"
    expect(await fx.calls.take(fx.call("t2", { path, home: "JIRA-123" }))).toMatchObject({
      ok: true,
      from: "moth",
      home: "JIRA-123",
    })
    expect(git(fx.repo, "config", "--get", "branch.homed.novadeckHome")).toBe("JIRA-123")
  })

  it("take tells a sleeping owner, so it hears of the loss when it wakes", async ({ fx }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "zz" }))
    if (!opened.ok) throw new Error(opened.reason)
    const { path } = opened
    // The owner's agent goes to sleep: no record, still in messaging.
    fx.asleep.set("t1", "moth")
    fx.records.delete("t1")
    fx.state.mode = "swarm"
    expect(await fx.calls.take(fx.call("t2", { path }))).toMatchObject({ ok: true, from: "moth" })
    expect(fx.notices).toEqual([
      { id: "t1", text: expect.stringContaining("@fox took your worktree") },
    ])
  })

  it("take tells a sleeping owner of an approved take too", async ({ fx }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "yy" }))
    if (!opened.ok) throw new Error(opened.reason)
    const { path } = opened
    fx.asleep.set("t1", "moth")
    fx.records.delete("t1")
    expect(await fx.calls.take(fx.call("t2", { path }))).toMatchObject({
      asked: true,
      owner: "moth",
    })
    fx.asked[0]!.settle("confirmed")
    await vi.waitFor(() => expect(fx.store.worktree(path)?.terminalId).toBe("t2"))
    expect(fx.notices.find(({ id }) => id === "t1")?.text).toContain("@fox take your worktree")
  })

  it("take reads the mode at each call, so a change reaches an agent already running", async ({
    fx,
  }) => {
    const opened = await fx.calls.open(fx.call("t1", { branch: "live" }))
    if (!opened.ok) throw new Error(opened.reason)
    expect(await fx.calls.take(fx.call("t2", { path: opened.path }))).toMatchObject({ asked: true })
    fx.state.mode = "swarm"
    expect(await fx.calls.take(fx.call("t2", { path: opened.path }))).toMatchObject({
      ok: true,
      from: "moth",
    })
    fx.state.mode = "solo"
    expect(await fx.calls.take(fx.call("t1", { path: opened.path }))).toMatchObject({ asked: true })
  })
})
