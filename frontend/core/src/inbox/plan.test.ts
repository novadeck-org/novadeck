import type { AgentName } from "../harnesses"
import type { InboxEntry } from "../inbox"
import { itemIdOf, type Item } from "../items"
import { context, describe, expect, it } from "../test"
import { workspaceFixture } from "../testing"
import { planItemOf, planKey, planTextOf, planWaitMs, sessionItems } from "./plan"

const asked = 1_000_000

// A plan approval on terminal `t`, as each harness's dialog reads.
const approval = (
  agent: AgentName,
  { subagent = false, at = asked }: { subagent?: boolean; at?: number } = {},
): InboxEntry => ({
  id: "request:r",
  source: {
    projectId: "p",
    workspaceSessionId: "s",
    terminalId: "t",
    handle: "moth",
    agent,
    title: "Checkout",
    projectName: "Storefront",
  },
  at,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id: "r",
    kind: "plan",
    tool: {
      claude: "ExitPlanMode",
      codex: "plan",
      agy: "artifact",
      opencode: "plan_exit",
      pi: "plan",
    }[agent],
    subject: null,
    choices: [],
    subagent,
    dialog: null,
    answered: false,
    askedAt: 0,
  },
})

// A plan item as the runner shows each harness's: Claude Code's plan file, Codex's plan in
// its rollout, Antigravity's artifact in its brain folder, opencode's plan file in the project.
const sources = {
  claude: { path: "/home/me/.claude/plans/checkout.md", source: "file", agent: "Claude Code" },
  codex: { path: "/home/me/.codex/sessions/rollout.jsonl", source: "text", agent: "Codex" },
  agy: {
    path: "/home/me/.gemini/antigravity-cli/brain/c0/implementation_plan.md",
    source: "file",
    agent: "Antigravity",
  },
  opencode: {
    path: "/home/me/project/.opencode/plans/1795350000000-calm-fox.md",
    source: "file",
    agent: "opencode",
  },
  // pi has no plan mode: a row stands here only as every harness's table has one.
  pi: { path: "/home/me/.pi/agent/plan.md", source: "file", agent: "pi" },
} as const

const plan = (
  agent: AgentName,
  shownAt: number,
  {
    id = `plan-${agent}`,
    role = "root",
    terminalId = "t",
    holder = { terminalId },
    version = 1,
  }: {
    id?: string
    role?: "root" | "subagent"
    terminalId?: string
    holder?: Item["holder"]
    version?: number
  } = {},
): Item => ({
  id: itemIdOf(id),
  holder,
  kind: "plan",
  name: "Checkout",
  detail: sources[agent].path,
  path: sources[agent].path,
  url: null,
  lines: null,
  secret: false,
  by: "agent",
  from: { terminalId, handle: "moth" },
  version,
  openAsked: false,
  shownAt,
  plan: { agent: sources[agent].agent, role, source: sources[agent].source },
})

describe("the plan a plan approval asks about", () => {
  context("for each harness", () => {
    it("is Claude Code's plan, shown in the hook that asked", () => {
      const item = plan("claude", asked + 40)
      expect(planItemOf([item], approval("claude"), asked)).toEqual({ state: "found", item })
    })

    it("is Codex's proposed plan, shown just before its dialog", () => {
      const item = plan("codex", asked - 2000)
      expect(planItemOf([item], approval("codex"), asked)).toEqual({ state: "found", item })
    })

    it("is Antigravity's artifact, written a while before its review shows", () => {
      const item = plan("agy", asked - 4 * 60_000)
      expect(planItemOf([item], approval("agy"), asked)).toEqual({ state: "found", item })
    })

    it("is opencode's plan file, which its plan_exit question names as it asks", () => {
      const item = plan("opencode", asked - 20_000)
      expect(planItemOf([item], approval("opencode"), asked)).toEqual({ state: "found", item })
    })
  })

  it("is the plan still, hidden from its bar or undocked into a window", () => {
    // Hiding a plan only changes the bar's arrangement: the item stays.
    const undocked = plan("claude", asked, { holder: { windowId: "w" } })
    expect(planItemOf([undocked], approval("claude"), asked)).toEqual({
      state: "found",
      item: undocked,
    })
  })

  it("is none for another terminal's plan", () => {
    const other = plan("claude", asked, { terminalId: "u" })
    expect(planItemOf([other], approval("claude"), asked + planWaitMs)).toEqual({ state: "none" })
  })

  it("is none for another terminal's plan docked on this terminal's bar", () => {
    const docked = plan("claude", asked, { terminalId: "u", holder: { terminalId: "t" } })
    expect(planItemOf([docked], approval("claude"), asked + planWaitMs)).toEqual({ state: "none" })
  })

  it("is never a plan version an earlier approval was answered with: a sent-back round's waits for its new one", () => {
    const sentBack = plan("agy", asked - 60_000)
    const used = new Set([planKey(sentBack)])
    expect(planItemOf([sentBack], approval("agy"), asked, used)).toEqual({
      state: "waiting",
      until: asked + planWaitMs,
    })
    const rewritten = plan("agy", asked + 400, { version: 2 })
    expect(planItemOf([rewritten], approval("agy"), asked + 500, used)).toEqual({
      state: "found",
      item: rewritten,
    })
  })

  it("is not Codex's plan from a round more than a minute before its dialog", () => {
    const earlier = plan("codex", asked - 90_000)
    expect(planItemOf([earlier], approval("codex"), asked + planWaitMs)).toEqual({ state: "none" })
  })

  it("is none for an entry that is no plan approval", () => {
    const entry = approval("claude")
    const permission: InboxEntry = {
      ...entry,
      kind: "request",
      request: { ...(entry.kind === "request" && entry.request), kind: "permission", tool: "Bash" },
    } as InboxEntry
    expect(planItemOf([plan("claude", asked)], permission, asked)).toEqual({ state: "none" })
  })

  context("when the plan was revised", () => {
    it("is the newest of the actor's plans", () => {
      const older = plan("agy", asked - 60_000, { id: "older" })
      const newer = plan("agy", asked - 1000, { id: "newer" })
      expect(planItemOf([newer, older], approval("agy"), asked)).toEqual({
        state: "found",
        item: newer,
      })
    })

    it("waits for the new round's plan rather than show the round the person sent back", () => {
      // The second ExitPlanMode's dialog reached the UI before the plan its hook showed.
      const earlier = plan("claude", asked - 5 * 60_000, { version: 1 })
      expect(planItemOf([earlier], approval("claude"), asked + 10)).toEqual({
        state: "waiting",
        until: asked + planWaitMs,
      })
      const rewritten = { ...earlier, version: 2, shownAt: asked + 20 }
      expect(planItemOf([rewritten], approval("claude"), asked + 30)).toEqual({
        state: "found",
        item: rewritten,
      })
    })

    it("takes Claude Code's plan from a dialog seen again with a fresh time", () => {
      // A slow hook or a runner restart: the dialog's time is later than its plan's.
      const shown = plan("claude", asked - 20_000)
      expect(planItemOf([shown], approval("claude"), asked)).toEqual({
        state: "found",
        item: shown,
      })
    })

    it("is none once the wait is over and no new plan came", () => {
      const earlier = plan("codex", asked - 5 * 60_000)
      expect(planItemOf([earlier], approval("codex"), asked + planWaitMs)).toEqual({
        state: "none",
      })
    })
  })

  context("with a subagent planning beside the root", () => {
    const root = plan("claude", asked, { id: "root" })
    const sub = plan("claude", asked + 5, { id: "sub", role: "subagent" })

    it("is the root's plan for the root's approval", () => {
      expect(planItemOf([sub, root], approval("claude"), asked)).toEqual({
        state: "found",
        item: root,
      })
    })

    it("is the subagent's plan for a subagent's approval", () => {
      expect(planItemOf([root, sub], approval("claude", { subagent: true }), asked)).toEqual({
        state: "found",
        item: sub,
      })
    })
  })
})

describe("the items of an Inbox entry's session", () => {
  it("are those its terminal's session holds", () => {
    const workspace = workspaceFixture()
    const project = workspace.projects[0]!
    const session = project.history[0]!
    const item = plan("claude", asked)
    const withPlan = {
      ...workspace,
      projects: [
        {
          ...project,
          history: [{ ...session, state: { ...session.state, items: [item] } }],
        },
      ],
    }
    const target = { projectId: project.id, workspaceSessionId: session.id }
    expect(sessionItems(withPlan, target)).toEqual([item])
    expect(sessionItems(withPlan, { ...target, workspaceSessionId: "gone" })).toEqual([])
  })
})

describe("a plan's text for the sheet", () => {
  it("is undefined while it loads, and null where it can't be read", () => {
    expect(planTextOf(undefined)).toBeUndefined()
    expect(planTextOf({ state: "unavailable", reason: "gone", size: null })).toBeNull()
  })

  it("is its Markdown, which says so at its end when cut short", () => {
    const ready = (truncated: boolean) =>
      ({
        state: "ready",
        stamp: "1",
        content: {
          kind: "plan",
          text: "# Plan\n\n1. Do it",
          truncated,
          writable: true,
          skill: true,
        },
      }) as const
    expect(planTextOf(ready(false))).toBe("# Plan\n\n1. Do it")
    expect(planTextOf(ready(true))).toBe(
      "# Plan\n\n1. Do it\n\n*It's long, so only its start is shown.*",
    )
  })
})
