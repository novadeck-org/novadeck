import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, text, tool, type Call, type Reply } from "./model/script.js"
import { delivered, nestedRuns, own, result, start } from "./scenarios.js"

// The agents listing of a lead's team, every harness in it (docs/agent-messaging.md,
// "agents()"): past five other terminals a line each, and each teammate's folder and
// branch where its agent works now, as its own shell command tells it, whichever harness
// runs it. Files ending in `.mixed.e2e.ts` run only when every harness is selected.

/** What a nested run of a harness is asked, which its seed lets its shell run unasked. */
const asking = nestedRuns.inTurn

const windows = process.platform === "win32"

/** A path with `/`, as Git Bash takes a Windows one. */
const slashed = (path: string): string => path.replaceAll("\\", "/")

/**
 * Antigravity's move on Windows, in its PowerShell: a `Set-Location` and its nested run.
 * Relative to its workspace, where its folder resolves, so its seed can allow it whole.
 */
const agyMove = `Set-Location -LiteralPath 'wt\\docs'; ${agy.shell!.nested(asking)}`

/** Whether the call is a nested run's own, rather than an agent's in a terminal. */
const nested = (call: Call): boolean =>
  !call.side && call.turns.some((turn) => turn.role === "user" && turn.text.includes(asking))

/**
 * Each teammate: the harness, the title its lead gives it, the checkout it moves on to, and
 * the shell call that runs a nested run of itself there, in that harness's own way of
 * naming a command's folder: Claude Code's and Antigravity's leading `cd`, Codex's
 * `workdir`.
 */
const team = [
  {
    agent: "claude",
    title: "ui",
    // Absolute: Claude Code keeps a `cd` inside its project for its next commands. With `/`,
    // which its Bash takes on Windows too, as Git Bash.
    move: (project: string): Reply => ({
      calls: [
        {
          name: "Bash",
          input: {
            command: `cd '${slashed(join(project, "wt", "ui"))}' && ${claude.shell!.nested(asking)}`,
            description: "Run",
          },
        },
      ],
    }),
  },
  {
    agent: "codex",
    title: "api",
    move: (project: string): Reply => ({
      calls: [
        {
          name: "exec_command",
          input: {
            cmd: codex.shell!.nested(asking),
            workdir: join(project, "wt", "api"),
            yield_time_ms: 30_000,
          },
        },
      ],
    }),
  },
  {
    agent: "agy",
    title: "docs",
    // Its run_command took a `Cwd` in 1.2, which 1.4 refuses (probed 2026-10-31, 1.4.12).
    // On Windows its PowerShell's own move, its folder relative to the workspace, as its
    // rule there names the whole command (see `agyMove`).
    move: (project: string): Reply => ({
      calls: [
        {
          name: "run_command",
          input: {
            CommandLine: windows
              ? agyMove
              : `cd '${join(project, "wt", "docs")}' && ${agy.shell!.nested(asking)}`,
            WaitMsBeforeAsync: 10_000,
            toolSummary: "Run a command",
          },
        },
      ],
    }),
  },
] as const satisfies readonly {
  agent: AgentName
  title: string
  move: (project: string) => Reply
}[]

/**
 * The plain terminals the lead opens beside its team, as for dev servers; the person opens
 * one more, as agents open at most five terminals a minute.
 */
const shells = ["dev server", "logs"]

/**
 * How many commands each teammate runs in its new checkout: more than half the places a
 * session keeps, so its folder moves there (see `currentCheckout`).
 */
const moves = 5

const brief = (title: string) => `Work on ${title}.`

/** A git checkout at `folder` on `branch`, as git's own files show one. */
const checkout = (folder: string, branch: string): void => {
  mkdirSync(join(folder, ".git"), { recursive: true })
  writeFileSync(join(folder, ".git", "HEAD"), `ref: refs/heads/${branch}\n`)
}

/** Whether the call is the agent's next look after an `open_agent` or `open_terminal`. */
const afterOpen = (call: Call): boolean => {
  const last = call.turns.at(-1)
  return last?.role === "tool" && last.text.startsWith("Opened a new terminal")
}

describe.skipIf(!supported)("a lead's team of every harness", () => {
  // Antigravity's rule on Windows allows only a command it names whole: its move's.
  const it = e2e.seeded({ commands: [agyMove] }, claude, codex, agy)

  it("lists a team past five terminals a line each, each teammate where it works now", async ({
    e2e: run,
  }) => {
    const { project } = run.sandbox
    checkout(project, "main")
    for (const { title } of team) checkout(join(project, "wt", title), `task/${title}`)
    const opens = [
      ...team.map(({ agent, title }) => ({
        tool: "open_agent",
        input: { agent, title, message: brief(title) },
      })),
      ...shells.map((title) => ({ tool: "open_terminal", input: { title } })),
    ]
    const listings: string[] = []
    // The ui teammate's handle, known once the lead opened it.
    let ui = ""
    // Each listing the lead asks for, by its words: what it calls `agents` with.
    const asks = [
      { words: "List the team", input: () => ({}) },
      { words: "List everyone in full", input: () => ({ full: true }) },
      { words: "Show the ui terminal", input: () => ({ terminal: `@${ui}` }) },
    ]
    const lists = own((call) => {
      const agents = tool(call, "agents")
      const ask = asks.find(({ words }) => asked(call, words))
      if (agents && ask) return { calls: [{ name: agents, input: ask.input() }] }
      const listed = result(call)
      if (!listed?.startsWith("You are @moth")) return undefined
      listings.push(listed)
      return { text: `Listing ${listings.length} done.` }
    })
    const requests = run.deck.answerRequests()
    run.model.use(
      own((call) => (nested(call) ? { text: "nested word" } : undefined)),
      // The lead opens its team and the shells one by one.
      own((call) => {
        if (!asked(call, "Open the team") && !afterOpen(call)) return undefined
        const done = call.turns.filter(
          (turn) => turn.role === "tool" && turn.text.startsWith("Opened a new terminal"),
        ).length
        const next = opens[done]
        if (!next) return { text: "Team open." }
        const name = tool(call, next.tool)
        return name ? { calls: [{ name, input: next.input }] } : undefined
      }),
      // Each teammate moves on to its own checkout, then says so.
      ...team.map(({ title, move }) =>
        own((call) => {
          // Its brief, which Antigravity carries only in the call it came with, then its own
          // moves, which every later call holds, the first as made (Claude Code drops a `cd`
          // to where it already is from those after).
          const first = call.turns.findIndex(
            (turn) =>
              turn.role === "assistant" &&
              turn.calls.some((one) =>
                JSON.stringify(one.input).replaceAll("\\\\", "/").includes(`wt/${title}`),
              ),
          )
          const briefed = delivered(call, "moth") && text(call).includes(brief(title))
          if (
            !(briefed && asked(call, brief(title))) &&
            !(first >= 0 && call.turns.at(-1)?.role === "tool")
          )
            return undefined
          const ran =
            first < 0 ? 0 : call.turns.slice(first).filter((turn) => turn.role === "tool").length
          return ran >= moves ? { text: `Moved to ${title}.` } : move(project)
        }),
      ),
      lists,
    )
    const lead = await start(run, claude)
    await run.deck.open()

    await lead.submit("Open the team")
    const opened: DeckTerminal[] = []
    for (let index = 0; index < opens.length; index += 1)
      // eslint-disable-next-line no-await-in-loop -- Opened one after another.
      opened.push(await requests.next())
    await lead.until("Team open.")
    // Every teammate ran its command in its checkout.
    await Promise.all(
      team.map((member, index) => opened[index]!.until(`Moved to ${member.title}.`, 120_000)),
    )

    ui = opened[0]!.handle
    for (const [index, { words }] of asks.entries()) {
      // eslint-disable-next-line no-await-in-loop -- One listing after another.
      await lead.submit(words)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await lead.until(`Listing ${index + 1} done.`)
    }
    const [compact, full, one] = listings
    if (process.env.NOVADECK_E2E_LISTING)
      writeFileSync(process.env.NOVADECK_E2E_LISTING, listings.join("\n\n---\n\n"))

    const handles = opened.map((terminal) => terminal.handle)
    // A line each, its title and branch where the agent works now, and no block lines.
    expect(compact).toContain("Other terminals in this project and session (6). One line each")
    expect(compact?.split("\n").filter((line) => line.startsWith("  "))).toEqual([])
    for (const [index, { title }] of team.entries())
      expect(compact).toMatch(
        new RegExp(`^- @${handles[index]} · ${title}: [^\\n]*, on task/${title}, led by you`, "m"),
      )
    for (const [index, title] of shells.entries())
      expect(compact).toMatch(new RegExp(`^- @${handles[team.length + index]} · ${title}: `, "m"))
    // In full: where each works now, where its terminal started, and its lead's title.
    for (const { title } of team) {
      expect(full).toContain(
        `  folder: wt/${title}, branch task/${title} (its agent works here now; its terminal started in .)`,
      )
      expect(full).toContain(`  title: ${title} (set by @moth, not the user)`)
    }
    // One terminal's details alone.
    expect(one?.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      expect.stringMatching(new RegExp(`^- @${handles[0]}: Claude Code, `)),
    ])
  })
})
