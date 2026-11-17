import type { AgentName } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { lookedEntries, renderLookup } from "./lookup.js"
import { agentLabel } from "./messages.js"
import { peerOf, type Happening, type Peer, type Whereabouts } from "./peers.js"
import type { Entry } from "./team.js"

const now = 10 * 60 * 60_000
const minutes = (count: number) => count * 60_000

// Where a terminal is, as the manager tells it; each fact unknown unless given.
const whereabouts = (overrides: Partial<Whereabouts> = {}): Whereabouts => ({
  title: null,
  summary: null,
  git: null,
  working: false,
  since: null,
  waiting: null,
  waitsOn: null,
  startup: null,
  happenings: [],
  standing: false,
  shell: { running: false, command: null },
  background: null,
  shown: [],
  worktrees: [],
  ...overrides,
})

const peer = (
  agent: AgentName | null,
  where: Partial<Whereabouts> = {},
  fields: { handle?: string; lead?: string | null; asleep?: boolean } = {},
): Peer =>
  peerOf({
    terminalId: (fields.handle ?? "fox").toUpperCase(),
    handle: fields.handle ?? "fox",
    agent,
    expecting: null,
    asleep: fields.asleep ?? false,
    busy: false,
    where: whereabouts(where),
    lead: fields.lead ?? null,
  })

const lookup = (peers: readonly Peer[], exchanges: (peer: Peer) => readonly Entry[] = () => []) =>
  renderLookup({ handle: "moth", lead: null, peers, exchanges, now }).split("\n")

const report = (
  kind: "update" | "done",
  minutesAgo: number,
  subject: string,
  body: string,
): Happening => ({ kind, at: now - minutes(minutesAgo), subject, body, pr: null })

describe("a terminal looked up by handle", () => {
  for (const agent of ["claude", "codex", "agy"] as const)
    it(`shows a peer's ${agent} agent whole, as a teammate's: facts, then its latest with bodies`, () => {
      const fox = peer(agent, {
        title: "API",
        summary: "Users API with paging",
        since: now - minutes(6),
        git: {
          repo: "api",
          branch: "feat/paging",
          state: { detached: false, ahead: 2, gone: false, dirty: false },
        },
        worktrees: [
          {
            path: "/w/feat-paging/api",
            branch: "feat/paging",
            state: { detached: false, ahead: 2, gone: false, dirty: false },
            gone: false,
            pullRequest: {
              number: 12,
              url: "https://github.com/o/api/pull/12",
              title: "Paging",
              state: "open",
              ci: "running",
            },
          },
        ],
        folders: ["src/users", "src/routes"],
        happenings: [
          report("done", 50, "Schema merged", "The users table has a cursor column."),
          report("update", 30, "PR opened", "https://github.com/o/api/pull/12, CI running"),
          { kind: "asked", at: now - minutes(20), subject: "Keep offset paging too?", open: true },
          {
            kind: "turn",
            at: now - minutes(10),
            from: now - minutes(15),
            outcome: "completed",
            text: "Should I drop the old route?",
          },
        ],
      })
      const said = { at: now - minutes(5), text: 'you → @fox: "Leave the old route"' }
      expect(lookup([fox], () => [said])).toEqual([
        "You are @moth in Novadeck.",
        `- @fox · API: ${agentLabel(agent)}, idle for 6 min, peer`,
        '  "Users API with paging" · api feat/paging, 2 ahead',
        "  worktrees: /w/feat-paging/api (feat/paging, 2 ahead, PR #12 open, checks running)",
        "  works in: src/users · src/routes",
        '  open in the user\'s Inbox: 20 min ago "Keep offset paging too?"',
        "  latest:",
        "    50 min ago, done: Schema merged — The users table has a cursor column.",
        "    30 min ago, update: PR opened — https://github.com/o/api/pull/12, CI running",
        "    20 min ago, asked the user: Keep offset paging too? (still open)",
        '    10 min ago, turn ended without a report: "Should I drop the old route?"',
        '    5 min ago, you → @fox: "Leave the old route"',
      ])
    })

  it("shows what an asleep agent did before its latest done, which the listing leaves out", () => {
    const fox = peer(
      "claude",
      {
        happenings: [
          report("done", 90, "First fix", "One"),
          report("update", 80, "Next PR opened", "Two"),
          report("done", 60, "Second fix", "Three"),
        ],
      },
      { asleep: true },
    )
    const lines = lookup([fox])
    expect(lines[1]).toBe(
      "- @fox: Claude Code, asleep, no process running; a message wakes it, peer",
    )
    expect(lines.slice(2)).toEqual([
      "  latest:",
      "    2 h ago, done: First fix — One",
      "    1 h ago, update: Next PR opened — Two",
      "    1 h ago, done: Second fix — Three",
    ])
  })

  it(`shows the latest ${lookedEntries} entries, and counts the earlier ones`, () => {
    const happenings = Array.from({ length: lookedEntries + 3 }, (_, index) =>
      report("update", 100 - index, `Step ${index}`, ""),
    )
    const lines = lookup([peer("codex", { happenings })])
    expect(lines).toContain("  latest (and 3 earlier):")
    expect(lines.filter((line) => line.startsWith("    "))).toHaveLength(lookedEntries)
    expect(lines.at(-1)).toBe(`    1 h ago, update: Step ${lookedEntries + 2}`)
  })

  it("shows several terminals in the order asked, and says when one reported nothing", () => {
    const lines = lookup([peer("agy", {}, { handle: "owl" }), peer(null, {}, { handle: "elk" })])
    expect(lines).toEqual([
      "You are @moth in Novadeck.",
      "- @owl: Antigravity, idle, peer",
      "  nothing reported yet",
      "- @elk: shell, at its prompt",
    ])
  })
})
