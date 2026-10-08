import { describe, expect, it } from "../test"
import { accountUsage, movedOrder, nextAccountReset, resetText } from "./account-usage"
import type { AgentUsage, TerminalMetadata } from "./types"

const hour = 3_600_000

const agent = (
  id: string,
  process: string,
  limits: AgentUsage["limits"],
  state: TerminalMetadata["state"] = "running",
): TerminalMetadata =>
  ({
    id,
    name: id,
    directory: "~/work",
    command: process,
    process,
    state,
    ...(state === "running"
      ? { agent: { working: false, usage: { context: null, limits, model: null, effort: null } } }
      : {}),
  }) as TerminalMetadata

describe("the account's subscription usage", () => {
  it("says each agent's windows once, shortest first, in a steady order of agents", () => {
    const accounts = accountUsage(
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
    const [claude] = accountUsage(
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
    const [agy] = accountUsage(
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

  it("leaves out a window once it has reset, and terminals that don't run an agent", () => {
    const accounts = accountUsage(
      [
        agent("1", "claude", [{ minutes: 300, used: 0.9, resetsAt: hour }]),
        agent("2", "zsh", [{ minutes: 300, used: 0.5, resetsAt: null }]),
        agent("3", "codex", [{ minutes: 300, used: 0.5, resetsAt: null }], "idle"),
      ],
      2 * hour,
    )
    expect(accounts).toEqual([])
  })

  it("names when the soonest window resets", () => {
    const accounts = accountUsage(
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
    // The time itself is in the viewer's locale.
    expect(resetText(now + 2 * hour + 14 * 60_000, now)).toMatch(/^in 2h 14m · \S/)
    expect(resetText(now + 48 * 60_000, now)).toMatch(/^in 48m · \S/)
    expect(resetText(new Date(2026, 9, 9, 9, 0).getTime(), now)).toMatch(/^Fri \S/)
  })

  it("keeps the order the person left, and remembers agents not shown now", () => {
    const terminals = [
      agent("1", "claude", [{ minutes: 300, used: 0.4, resetsAt: null }]),
      agent("2", "codex", [{ minutes: 300, used: 0.4, resetsAt: null }]),
    ]
    const shown = accountUsage(terminals, 0)
    const order = movedOrder(shown, ["agy", "claude"], 1, 0)
    expect(order).toEqual(["codex", "claude", "agy"])
    expect(accountUsage(terminals, 0, order).map((account) => account.program)).toEqual([
      "codex",
      "claude",
    ])
  })
})
