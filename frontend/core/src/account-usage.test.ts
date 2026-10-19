import {
  accountUsage,
  movedOrder,
  nextAccountReset,
  resetText,
  runningSeats,
  sameAccounts,
  sameSeats,
} from "./account-usage"
import { createTerminalState } from "./state"
import { describe, expect, it } from "./test"
import { terminalFixture, workspaceFixture } from "./testing"
import type { AgentUsage, TerminalMetadata, Workspace } from "./types"

const hour = 3_600_000

// A running agent and what it reported; without limits, it reported nothing.
const agent = (id: string, program: string, limits?: AgentUsage["limits"]) => ({
  id,
  program,
  limits,
})

const usageOf = (
  agents: readonly ReturnType<typeof agent>[],
  now: number,
  order?: readonly string[],
) =>
  accountUsage(
    agents.map(({ id, program }) => ({ context: "project/initial", id, program })),
    {
      "project/initial": Object.fromEntries(
        agents.flatMap(({ id, limits }) =>
          limits ? [[id, { context: null, limits, model: null, effort: null }]] : [],
        ),
      ),
    },
    now,
    order,
  )

describe("the account's subscription usage", () => {
  it("says each agent's windows once, shortest first, in a steady order of agents", () => {
    const accounts = usageOf(
      [
        agent("1", "claude", [
          { minutes: 10_080, used: 0.18, resetsAt: 9 * hour },
          { minutes: 300, used: 0.42, resetsAt: 2 * hour },
        ]),
        agent("2", "codex", [{ minutes: 300, used: 0.67, resetsAt: hour }]),
      ],
      0,
    )
    // Codex is used more, but how much never moves a subscription.
    expect(accounts.map((account) => account.name)).toEqual(["Claude Code", "Codex"])
    expect(accounts[0]!.windows.map((window) => window.name)).toEqual(["5h", "7d"])
    expect(accounts[0]!.busiest).toMatchObject({ name: "5h", used: 0.42 })
  })

  it("takes the newer of two terminals' readings of a window", () => {
    const [claude] = usageOf(
      [
        agent("1", "claude", [{ minutes: 300, used: 0.9, resetsAt: hour }]),
        agent("2", "claude", [{ minutes: 300, used: 0.1, resetsAt: 6 * hour }]),
        agent("3", "claude", [{ minutes: 300, used: 0.2, resetsAt: 6 * hour }]),
      ],
      0,
    )
    expect(claude!.windows).toEqual([
      { key: "5h#0", name: "5h", minutes: 300, used: 0.2, resetsAt: 6 * hour },
    ])
  })

  it("keeps two windows of the same length in one reading apart, as two quotas", () => {
    // Antigravity's weekly quotas: one untouched, one nearly used up.
    const [agy] = usageOf(
      [
        agent("1", "agy", [
          { minutes: 10_080, used: 0, resetsAt: 9 * hour },
          { minutes: 10_080, used: 0.95, resetsAt: 6 * hour },
        ]),
      ],
      0,
    )
    expect(agy!.windows.map(({ used }) => used)).toEqual([0, 0.95])
    expect(agy!.busiest.used).toBe(0.95)
  })

  it("leaves out a window once it has reset, and terminals that run no agent or report nothing", () => {
    const accounts = usageOf(
      [
        agent("1", "claude", [{ minutes: 300, used: 0.9, resetsAt: hour }]),
        agent("2", "zsh", [{ minutes: 300, used: 0.5, resetsAt: null }]),
        agent("3", "codex"),
      ],
      2 * hour,
    )
    expect(accounts).toEqual([])
  })

  it("names when the soonest window resets", () => {
    const accounts = usageOf(
      [
        agent("1", "claude", [
          { minutes: 300, used: 0.4, resetsAt: hour },
          { minutes: 10_080, used: 0.1, resetsAt: null },
        ]),
      ],
      0,
    )
    expect(nextAccountReset(accounts)).toBe(hour)
  })

  it("says when a window resets: how long from now within a day, the weekday further off", () => {
    const now = new Date(2026, 9, 7, 14, 16).getTime()
    // The time itself is in the viewer's locale, as is the weekday: "Fri", or "pt." in Polish.
    expect(resetText(now + 2 * hour + 14 * 60_000, now)).toMatch(/^in 2h 14m · \S/)
    expect(resetText(now + 48 * 60_000, now)).toMatch(/^in 48m · \S/)
    const friday = new Date(2026, 9, 9, 9, 0)
    const weekday = friday.toLocaleDateString(undefined, { weekday: "short" })
    const text = resetText(friday.getTime(), now)
    expect(text.startsWith(`${weekday} `), text).toBe(true)
    expect(text.length).toBeGreaterThan(weekday.length + 1)
  })

  it("keeps the order the person left, and remembers agents not shown now", () => {
    const terminals = [
      agent("1", "claude", [{ minutes: 300, used: 0.4, resetsAt: null }]),
      agent("2", "codex", [{ minutes: 300, used: 0.4, resetsAt: null }]),
    ]
    const shown = usageOf(terminals, 0)
    const order = movedOrder(shown, ["agy", "claude"], 1, 0)
    expect(order).toEqual(["codex", "claude", "agy"])
    expect(usageOf(terminals, 0, order).map((account) => account.program)).toEqual([
      "codex",
      "claude",
    ])
  })
})

describe("the terminals that report to the account", () => {
  // A session whose first terminal runs Claude Code in `state`, beside a shell.
  const workspaceOf = (state: "running" | "idle"): Workspace => {
    const base = workspaceFixture()
    const seat: TerminalMetadata =
      state === "running"
        ? {
            ...terminalFixture(1, "~/project"),
            process: "claude",
            state,
            agent: { working: false },
          }
        : { ...terminalFixture(1, "~/project"), process: "claude", state }
    const [project] = base.projects
    return {
      ...base,
      projects: [
        {
          ...project!,
          history: [
            {
              ...project!.history[0]!,
              state: createTerminalState([seat, terminalFixture(2, "~/project")], "grid", "grid"),
            },
          ],
        },
      ],
    }
  }

  it("are the running ones, by the session that holds them", () => {
    const workspace = workspaceOf("running")
    const [project] = workspace.projects
    const [session] = project!.history
    expect(runningSeats(workspace)).toContainEqual({
      context: `${project!.id}/${session!.id}`,
      id: session!.state.roster.terminals[0]!.id,
      program: "claude",
    })
    expect(runningSeats(workspace).every((seat) => seat.program === "claude")).toBe(true)
  })

  it("leave out terminals that are not running, whatever they once reported", () => {
    const workspace = workspaceOf("idle")
    expect(runningSeats(workspace)).toEqual([])
  })

  it("are the same when each says the same, though read again", () => {
    const seat = { context: "p/s", id: "1", program: "claude" }
    expect(sameSeats([seat], [{ ...seat }])).toBe(true)
    expect(sameSeats([seat], [{ ...seat, program: "codex" }])).toBe(false)
    expect(sameSeats([seat], [])).toBe(false)
  })

  it("leave the accounts as they were when a report moves nothing they show", () => {
    const reading = (occupied: number) =>
      accountUsage(
        [{ context: "p/s", id: "1", program: "claude" }],
        {
          "p/s": {
            "1": {
              context: { occupied, capacity: 200_000 },
              limits: [{ minutes: 300, used: 0.4, resetsAt: hour }],
              model: null,
              effort: null,
            },
          },
        },
        0,
      )
    expect(sameAccounts(reading(1), reading(2))).toBe(true)
  })

  it("change them when a window's use or reset moves", () => {
    const reading = (used: number, resetsAt: number) =>
      accountUsage(
        [{ context: "p/s", id: "1", program: "claude" }],
        {
          "p/s": {
            "1": {
              context: null,
              limits: [{ minutes: 300, used, resetsAt }],
              model: null,
              effort: null,
            },
          },
        },
        0,
      )
    expect(sameAccounts(reading(0.4, hour), reading(0.5, hour))).toBe(false)
    expect(sameAccounts(reading(0.4, hour), reading(0.4, 2 * hour))).toBe(false)
    expect(sameAccounts(reading(0.4, hour), [])).toBe(false)
  })
})
