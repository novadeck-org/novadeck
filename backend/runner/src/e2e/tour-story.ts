import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { samePath } from "@novadeck/harness-core/paths"
import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { tourBriefMark, tourFixerMark } from "../messaging/messages.js"
import { sandboxFile } from "../tour/brief.js"
import { tourWrites } from "../tour/launch.js"
import { worktreesRoot } from "../worktrees/root.js"
import type { AgentSetup } from "./agents/agent.js"
import { poll, type DeckTerminal } from "./deck.js"
import { expect, type E2E } from "./fixture.js"
import { asked, tool, type Call, type Reply, type Rule } from "./model/script.js"
import {
  deliveries,
  holds,
  messages,
  own,
  prompted,
  received,
  result,
  sent,
  through,
} from "./scenarios.js"

// Novadeck's tour story (docs/tour.md): the lead opens a fixer for bug 1 with `open_agent`; the
// fixer describes itself, opens a worktree and fixes it there. The person opens a terminal, and
// `tour.fixer` starts their agent in it as the second fixer, led by the lead: it describes
// itself, opens a worktree, asks the person in the Inbox, and fixes bug 2 there by the answer.
// Both tell the lead, which says so. The fake model plays all three, each by the brief it was
// given: the lead follows the brief Novadeck sends it, a fixer its task. It has no tool call
// for writing a file in every harness, so its rules make the edit themselves, in the fixer's
// worktree, where the fixer's model would. What a rule keys on is told by the conversation, so
// one script serves the three terminals.

/** The tour's folder, as the sandbox's home holds it. */
export const folder = join(".novadeck", "tour")

/** The model Codex's cache lists in these runs, a "luna" as the tour's cheapest pick. */
export const luna = "gpt-e2e-luna"

/** A git name in the sandbox's config, which the brief never calls the person by. */
export const gitName = "Ada Lovelace"

/** The fixes, as the fixers' models would write them. */
const fixes = {
  tip: ["(total + total * tip)", "(total + total * tip / 100)"],
  // The person picks "$12", the second option.
  money: ["amount.toFixed(1)", "Number.isInteger(amount) ? String(amount) : amount.toFixed(2)"],
} as const

const fix = (path: string, [from, to]: readonly [string, string]): void => {
  const file = join(path, sandboxFile)
  const source = readFileSync(file, "utf8")
  if (!source.includes(from)) throw new Error(`${file} has no "${from}" to fix`)
  writeFileSync(file, source.replace(from, to))
}

/** What the sandbox needs before the tour is readied: Codex's model catalog, and a git name. */
export const seedTour = async (run: E2E, agents: readonly AgentName[]): Promise<void> => {
  if (agents.includes("codex"))
    await writeFile(
      join(run.sandbox.env.CODEX_HOME ?? "", "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-e2e-big",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          },
          {
            slug: luna,
            visibility: "list",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
          },
        ],
      }),
    )
  await writeFile(join(run.sandbox.home, ".gitconfig"), `[user]\n\tname = ${gitName}\n`)
}

/**
 * Starts the agent of a prepared tour as the client does: a harness that takes no start line
 * on its command line (Antigravity) is rung it once it has bound.
 */
export const begin = async (
  run: E2E,
  terminal: DeckTerminal,
  setup: AgentSetup,
  doorbell: boolean,
): Promise<void> => {
  if (!doorbell) return
  await terminal.reached("ready", { timeoutMs: 60_000 })
  await prompted(terminal, setup)
  await poll(
    () => {
      try {
        run.deck.tour.brief(terminal.id)
        return true
      } catch {
        return undefined
      }
    },
    `${terminal.handle}'s agent to take the tour's brief`,
    30_000,
  )
}

/** The `open_agent` call as the brief gives it: its arguments, and the message to pass. */
export type Opening = {
  readonly agent: AgentName
  readonly model: string
  readonly effort?: string
  readonly message: string
}

/** The `open_agent` call the brief asks of its lead, read from its text. */
export const openings = (brief: string): Opening[] =>
  [
    ...brief.matchAll(
      /Call `open_agent` with agent "(\w+)", model "([^"]+)"(?:, effort "(\w+)")?, and as `message` exactly this text[\s\S]*?:\n\n((?: {3}> ?.*\n?)+)/g,
    ),
  ].map(([, agent, model, effort, quoted]) => ({
    agent: agent as AgentName,
    model: model!,
    ...(effort !== undefined && { effort }),
    message: quoted!
      .split("\n")
      .map((line) => line.replace(/^ {3}> ?/, ""))
      .join("\n")
      .trim(),
  }))

/** Whether the call is the agent's next look after its `open_worktree` opened one. */
const worktreeOpened = (call: Call): boolean => /You own it\./.test(result(call) ?? "")

const text = (words: string): Reply => ({ text: words })

// The `ask` a fixer's brief gives, as its arguments, and no others: the subject, the body and
// the shape.
const asking = (message: string): Record<string, unknown> => {
  const flat = message.replace(/\s+/g, " ")
  const found =
    /Call `ask` with subject "([^"]+)", body "([^"]+)" and shape (\{.*?\})\.\s+4\./.exec(flat)
  if (!found) throw new Error("The fixer's brief has no ask")
  return {
    subject: found[1],
    body: found[2],
    shape: JSON.parse(found[3]!) as unknown,
  }
}

// The messages an agent was sent by other agents: Novadeck's own notices, as the lead's brief
// (which quotes its fixer's task), are no teammate's task.
const fromAgents = (call: Call) => received(call).filter((one) => one.from !== "novadeck")

/** The lead's brief as Novadeck's notice delivered it, in the call that carries it. */
const scriptIn = (call: Call): string | undefined =>
  received(call).find((one) => one.from === "novadeck" && one.text.startsWith(tourBriefMark))?.text

/** The second fixer's brief as Novadeck's notice delivered it. */
const fixerBriefIn = (call: Call): string | undefined =>
  received(call).find((one) => one.from === "novadeck" && one.text.startsWith(tourFixerMark))?.text

type Role = "fixer1" | "fixer2" | "lead"

/** What a fixer's conversation was briefed with: its role and its lead's handle. */
type Briefing = { readonly role: Role; readonly lead?: string | undefined }

// A conversation by the doorbell's first notice to it, whose id no other's shares (a harness's
// first user turn can be its own preamble, the same in every session, as Antigravity's is), else
// by its first user turn: the harness may stop carrying a delivered brief in later calls
// (Antigravity does), so what a fixer was briefed with is kept by it.
const known = (call: Call): string => {
  const users = call.turns.filter((turn) => turn.role === "user").map((turn) => turn.text)
  // The doorbell's ring id, as its tag types it (or the bracket line it typed before).
  const rung = users
    .map((turn) => /ring=["']([A-Za-z0-9]+)["']|agent messages waiting, (\w+)\]/.exec(turn))
    .map((found) => found?.[1] ?? found?.[2])
    .find(Boolean)
  return rung ?? users[0] ?? ""
}

/**
 * Who a call is for, and what it was briefed with: the first fixer, by the task it holds as its
 * lead's message (or held when its conversation began); the second, by Novadeck's brief to it;
 * or else the lead.
 */
const briefing = (call: Call, kept: Map<string, Briefing>): Briefing => {
  const task = fromAgents(call).find((one) =>
    one.text.includes("You are Tip fixer, a teammate in Novadeck's tour."),
  )
  // A copy of the task with no sender (as Antigravity quotes it back in a tool's error) never
  // takes the place of the lead it was first seen from. The lead is named in the task: its
  // handle, the one address `send` takes, never the id the message came `from`.
  if (task && (task.from || !kept.has(known(call))))
    kept.set(known(call), { role: "fixer1", lead: /(@[\w-]+) leads you/.exec(task.text)?.[1] })
  const brief = fixerBriefIn(call)
  if (brief && !kept.has(known(call)))
    kept.set(known(call), {
      role: "fixer2",
      lead: /(@[\w-]+) leads you/.exec(brief)?.[1],
    })
  return kept.get(known(call)) ?? { role: "lead" }
}

/** Whether the call is the agent's first look at something new, not after its own tool's result. */
const fresh = (call: Call): boolean => asked(call, "")

const opensMade = (call: Call): number =>
  call.turns
    .flatMap((turn) => (turn.role === "assistant" ? turn.calls : []))
    .filter(({ name }) => name.endsWith("open_agent")).length

const handleOpened = (call: Call): string | undefined =>
  /Opened a new terminal, @(\w+)/.exec(result(call) ?? "")?.[1]

/** The words a fixer sends its lead when it is done. */
const reports = { tip: "Fixed bug 1.", money: "Fixed bug 2." } as const

/**
 * The rules of the whole story. A tool's name is found among those any call of the run
 * offered, as the first call of an agent goes out before its MCP tools load.
 */
export const storyRules = (run: E2E): { rules: Rule[]; script: () => string } => {
  // The lead's brief, kept from the first call that carries it: a harness may drop an old
  // delivery from the calls after.
  let script: string | undefined
  const scripted = (from: Call): void => {
    script ??= scriptIn(from)
  }
  const fixer = (): Opening => {
    const [opening] = openings(script ?? "")
    if (!opening) throw new Error("The lead's brief has no open_agent call")
    return opening
  }
  // The second fixer's brief, kept as the lead's is.
  let fixerBrief: string | undefined
  const kept = new Map<string, Briefing>()
  const heard = new Map<string, Set<string>>()
  const roleOf = (call: Call): Role => briefing(call, kept).role
  const named = (call: Call, name: string): string | undefined =>
    [call, ...run.model.calls].map((one) => tool(one, name)).find(Boolean)
  const call = (from: Call, name: string, input: Record<string, unknown>): Reply | undefined => {
    const found = named(from, name)
    return found ? { calls: [{ name: found, input }] } : undefined
  }
  // The worktree a fixer opened, by its branch: where its model would write.
  const worktree = (branch: string): string => {
    const row = run.deck.worktrees.all().find((each) => each.branch === branch)
    if (!row) throw new Error(`No worktree on ${branch}`)
    return row.path
  }
  const rules = [
    // The lead, by the brief's steps.
    own((one) => {
      if (roleOf(one) !== "lead") return undefined
      scripted(one)
      const started =
        asked(one, "brief for Novadeck") &&
        deliveries(one).some(
          (each) => each.from === "novadeck" && each.text.startsWith(tourBriefMark),
        )
      if (started)
        return call(one, "describe", { title: "Tour lead", summary: "Leads Novadeck's tour" })
      if (result(one)?.includes("Described this terminal") && opensMade(one) === 0) {
        const { agent, model, effort, message } = fixer()
        const opening = call(one, "open_agent", {
          agent,
          model,
          ...(effort !== undefined && { effort }),
          message,
        })
        return opening && { ...opening, text: "The tour has begun." }
      }
      if (handleOpened(one) && opensMade(one) === 1)
        return text("A fixer is on bug 1. You start the second one.")
      return undefined
    }),
    own((one) => {
      if (roleOf(one) !== "lead" || !fresh(one) || deliveries(one).length === 0) return undefined
      if (opensMade(one) < 1) return undefined
      // What the lead was told so far, kept: a harness may stop carrying an old delivery.
      const told = heard.get(known(one)) ?? new Set<string>()
      heard.set(known(one), told)
      for (const each of received(one))
        for (const part of Object.values(reports)) if (each.text.startsWith(part)) told.add(part)
      return told.size === 2
        ? text("Both bugs are fixed, each in its own worktree.")
        : text("Noted.")
    }),
    // The first fixer, on bug 1.
    own((one) => {
      if (roleOf(one) !== "fixer1") return undefined
      if (fresh(one) && !one.turns.some((t) => t.role === "assistant"))
        return call(one, "describe", {
          title: "Tip fixer",
          summary: "Fixes bug 1",
        })
      const { lead } = briefing(one, kept)
      // As a model that follows the lead's script instead would: it tries to open an agent.
      if (result(one)?.includes("Described this terminal"))
        return call(one, "open_worktree", { branch: "fix-tip" })
      if (worktreeOpened(one)) {
        fix(worktree("fix-tip"), fixes.tip)
        return lead ? call(one, "send", { to: lead, text: reports.tip }) : undefined
      }
      if (lead && sent(one, lead)) return text("Sent it.")
      return undefined
    }),
    // The second fixer, on bug 2: asks first.
    own((one) => {
      if (roleOf(one) !== "fixer2") return undefined
      fixerBrief ??= fixerBriefIn(one)
      if (
        fresh(one) &&
        fixerBrief !== undefined &&
        !one.turns.some((t) => t.role === "assistant") &&
        deliveries(one).some((each) => each.text.startsWith(tourFixerMark))
      )
        return call(one, "describe", {
          title: "Money fixer",
          summary: "Fixes bug 2",
        })
      if (result(one)?.includes("Described this terminal"))
        return call(one, "open_worktree", { branch: "fix-money" })
      if (worktreeOpened(one) && fixerBrief !== undefined)
        return call(one, "ask", asking(fixerBrief))
      if (/is in the user's Inbox/.test(result(one) ?? "")) return text("Asked you to choose.")
      const { lead } = briefing(one, kept)
      if (lead && sent(one, lead)) return text("Sent it.")
      const answer = deliveries(one).find((each) => each.from === "you")
      if (fresh(one) && answer && lead) {
        fix(worktree("fix-money"), fixes.money)
        return call(one, "send", { to: lead, text: reports.money })
      }
      return undefined
    }),
  ]
  return {
    rules,
    script: () => {
      if (script === undefined) throw new Error("The lead was never sent its brief")
      return script
    },
  }
}

/** Checks that `terminal` works in the tour's folder, `directory`, as the runner knows it. */
const inTour = (terminal: DeckTerminal, directory: string): void => {
  const { cwd } = terminal.summary()
  expect(samePath(cwd, directory), `${terminal.handle} works in ${cwd}, not ${directory}`).toBe(
    true,
  )
}

/** The words of the model and effort flags a harness starts with, as `open_agent` gives them. */
const flags = (agent: AgentName, { model, effort }: Opening): string =>
  harnesses[agent].launch
    .choose({ model, ...(effort !== undefined && { effort: effort as never }) })
    .join(" ")

/**
 * Runs the story with `lead` leading, on a deck whose harnesses include every agent the brief
 * names, and checks what it did: the first fixer started by its lead on the model and effort the
 * brief names with the tour's write flags, the person's terminal taken as the second fixer by
 * `tour.fixer`, led by the lead, started on the tour's model and flags and given its brief,
 * both describing themselves, each in a worktree of its own (tracked and its changes shown, with
 * the person's setting off), the second fixer's ask in the Inbox and its answer delivered, both
 * fixes in one preview of `split.js`, and the lead saying both are done, every agent in the
 * tour's folder. Returns the first fixer's opening. With `worktreesFolder`, the folder of
 * agents' worktrees is there before the lead starts, as on every computer Novadeck has run
 * agents on, and each harness's shim passes it on as `--add-dir`.
 */
export const tell = async (
  run: E2E,
  setup: AgentSetup,
  agents: readonly AgentName[],
  { worktreesFolder = false }: { readonly worktreesFolder?: boolean } = {},
): Promise<Opening> => {
  await seedTour(run, agents)
  if (worktreesFolder) await mkdir(worktreesRoot(run.sandbox.home), { recursive: true })
  const prepared = await run.deck.tour.prepare(setup.agent)
  // The folder's own instruction files hold no script: it reaches the lead as a notice.
  for (const name of ["AGENTS.md", "CLAUDE.md"])
    // eslint-disable-next-line no-await-in-loop -- Two small files.
    expect(await readFile(join(prepared.directory, name), "utf8")).not.toMatch(/open_agent|Steps/)
  expect(prepared.command).not.toContain("Novadeck tour")
  const story = storyRules(run)
  run.model.use(...story.rules)
  const requests = run.deck.answerRequests()
  const calls = run.model.mark()

  const lead = await run.deck.openAt(prepared.directory, prepared.command)
  await begin(run, lead, setup, prepared.brief === "doorbell")
  const first = await requests.next()
  // What the lead was sent: the whole script, as Novadeck's notice, naming the person.
  const instructions = story.script()
  expect(instructions).toContain("bill splitter with two bugs")
  expect(instructions).not.toContain("Ada")
  const [opening] = openings(instructions)
  expect(opening).toBeDefined()

  // Started by the lead, on the brief's model and effort, in the harness the brief names, with
  // the tour's write flags for that harness, in the tour's folder, the lead's.
  expect(run.deck.store.terminal(first.id)?.ledBy).toBe(lead.id)
  inTour(first, prepared.directory)
  // Its command line only on Linux, as the runner reads no foreground process's argv on
  // Windows or macOS; everywhere, the harness it runs is checked below.
  if (process.platform === "linux") {
    const argv = await poll(
      () => {
        const words = first.summary().process?.argv?.join(" ")
        return words?.includes(flags(opening!.agent, opening!)) ? words : undefined
      },
      `${first.handle} to start on ${flags(opening!.agent, opening!)} (now ${first.summary().process?.argv?.join(" ")})`,
      45_000,
    )
    expect(argv.startsWith(opening!.agent) || argv.includes(opening!.agent)).toBe(true)
    expect(argv).toContain(tourWrites[opening!.agent].join(" "))
  }
  // It describes itself, as its task says.
  await first.poll(
    () => (first.summary().title === "Tip fixer" ? true : undefined),
    "its title",
    60_000,
  )
  expect(first.summary()).toMatchObject({
    title: "Tip fixer",
    titleSource: { kind: "agent", by: first.handle },
    agent: opening!.agent,
  })
  // In a worktree of its own, whatever the person's setting says: tracked, its changes shown.
  const tip = await first.poll(
    () => run.deck.worktrees.all().find((each) => each.branch === "fix-tip"),
    "its worktree",
    90_000,
  )
  expect(tip.terminalId).toBe(first.id)
  await first.poll(
    () => run.deck.items.bar(first.id).find((each) => each.kind === "changes"),
    "its changes shown",
    30_000,
  )

  // The person opens a terminal; the tour starts their agent in it, led by the lead.
  const mine = await run.deck.openBeside(lead, prepared.directory)
  await run.deck.tour.fixer(mine.id, run.deck.owner)
  expect(run.deck.store.terminal(mine.id)?.ledBy).toBe(lead.id)
  await expect(
    Promise.resolve().then(() => run.deck.tour.fixer(mine.id, run.deck.owner)),
  ).rejects.toMatchObject({ code: "CONFLICT" })
  if (process.platform === "linux") {
    const argv = await poll(
      () => {
        const words = mine.summary().process?.argv?.join(" ")
        return words?.includes(tourWrites[setup.agent].join(" ")) ? words : undefined
      },
      `${mine.handle} to start with the tour's flags (now ${mine.summary().process?.argv?.join(" ")})`,
      45_000,
    )
    expect(argv).toContain(setup.agent)
  }
  await mine.poll(
    () => (mine.summary().title === "Money fixer" ? true : undefined),
    "its title",
    90_000,
  )
  expect(mine.summary()).toMatchObject({
    titleSource: { kind: "agent", by: mine.handle },
    agent: setup.agent,
    ledBy: lead.id,
  })
  inTour(mine, prepared.directory)
  const money = await mine.poll(
    () => run.deck.worktrees.all().find((each) => each.branch === "fix-money"),
    "its worktree",
    90_000,
  )
  expect(money.terminalId).toBe(mine.id)

  // Its ask is in the Inbox, with both ways as its options.
  const ask = await mine.poll(
    () =>
      run.deck.terminals
        .inboxEntries()
        .find((each) => each.content.kind === "ask" && each.terminalId === mine.id),
    "its ask in the Inbox",
    90_000,
  )
  expect(ask.content).toMatchObject({
    kind: "ask",
    ask: {
      subject: "Whole amounts: $12.00 or $12?",
      shape: {
        type: "options",
        options: [
          { label: "$12.00", summary: "Always two decimals" },
          { label: "$12", summary: "Drop .00 for whole amounts" },
        ],
      },
    },
  })
  const before = run.model.mark()
  run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 1, text: "" })

  // The answer reaches the fixer, who fixes bug 2 and tells the lead.
  const answered = await run.model.waitFor(
    (one) => !one.side && deliveries(one).some((each) => each.from === "you"),
    { after: before, timeoutMs: 90_000 },
  )
  expect(deliveries(answered).find((each) => each.from === "you")?.text).toContain(
    "<quoted-option>$12</quoted-option>",
  )
  await first.reached(holds(first.handle, lead.handle, "delivered"), {
    timeoutMs: 90_000,
  })
  await mine.reached(holds(mine.handle, lead.handle, "delivered"), {
    timeoutMs: 90_000,
  })
  expect(
    messages(lead)
      .filter((each) => each.from === first.handle || each.from === mine.handle)
      .map((each) => [each.from, each.text]),
  ).toEqual(
    expect.arrayContaining([
      [first.handle, reports.tip],
      [mine.handle, reports.money],
    ]),
  )
  // The lead says so, once both have reported.
  await lead.until("Both bugs are fixed, each in its own worktree.", 90_000)
  await through(lead, ["settled"])

  // Both fixes, in one file: what the Files panel previews, main's copy with each work's hunks.
  const projectId = run.deck.store.session(run.deck.terminals.get(lead.id).sessionId).projectId
  const preview = await poll(
    async () => {
      const found = await run.deck.works.preview(projectId, sandboxFile)
      return found.works.length === 2 && found.works.every((each) => each.hunks.length > 0)
        ? found
        : undefined
    },
    "both works' hunks in the preview",
    60_000,
  )
  expect(preview.main).toContain("amount.toFixed(1)")
  expect(preview.works.map((each) => each.branch).toSorted()).toEqual(["fix-money", "fix-tip"])
  expect(JSON.stringify(preview.works.find((each) => each.branch === "fix-tip")!.hunks)).toContain(
    "tip / 100",
  )
  expect(
    JSON.stringify(preview.works.find((each) => each.branch === "fix-money")!.hunks),
  ).toContain("Number.isInteger")
  // The team stayed at two: no fixer opened another agent.
  await expect(requests.next(2000)).rejects.toThrow()
  expect(run.model.calls.length).toBeGreaterThan(calls)
  // The lead's own folder, as its harness reported it all along, is still the tour's.
  inTour(lead, prepared.directory)
  return opening!
}
