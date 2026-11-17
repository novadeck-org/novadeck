import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { samePath } from "@novadeck/harness-core/paths"
import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { tourBriefMark } from "../messaging/messages.js"
import { card } from "../tour/brief.js"
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

// Novadeck's tour story (docs/tour.md): the lead opens a copywriter and a designer with
// `open_agent`, who describe themselves and send each other and the lead their parts; the
// copywriter asks the person which tagline in the Inbox; the lead writes welcome.svg and
// shows it. The fake model plays all three, each by the brief it was given: the lead
// follows the brief Novadeck sends it, and each teammate its `message`. What a rule keys on is
// told by the conversation (a teammate's holds its brief as a delivered message), so one
// script serves the three terminals.

/** The tour's folder, as the sandbox's home holds it. */
export const folder = join(".novadeck", "tour")

/** The model Codex's cache lists in these runs, a "luna" as the tour's cheapest pick. */
export const luna = "gpt-e2e-luna"

/** The person's name in the sandbox's git config, which the brief calls them by. */
export const gitName = "Ada Lovelace"

export const taglines = { A: "Hello, bright Ada.", B: "Your day starts here, Ada." } as const
const paragraph = "A calm card for Ada. It says hello."
// The brief's template with sample values put in, as the lead is told to.
const filled = (): string =>
  card.template
    .join("\n")
    .replaceAll("BACKGROUND", "#fff4e6")
    .replaceAll("TEXT", "#212529")
    .replaceAll("ACCENT", "#3b5bdb")
    .replaceAll("FONTS", "Georgia, serif")
    .replace("NAME", "Ada")
    .replace("TAGLINE", taglines.B)
    .replace("PARAGRAPH LINE 1", "A calm card for Ada.")
    .replace("PARAGRAPH LINE 2", "It says hello.")
    .replace("PARAGRAPH LINE 3", "")

/** A small well-formedness check: tags balance, each attribute is quoted, no stray `<` or `&`. */
export const wellFormed = (xml: string): boolean => {
  const stack: string[] = []
  for (const [, close, name, attributes = "", empty] of xml.matchAll(
    /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<&]*")*)\s*(\/?)>/g,
  )) {
    if (close) {
      if (stack.pop() !== name) return false
    } else if (!empty) stack.push(name!)
    void attributes
  }
  const text = xml.replace(/<[^>]*>/g, "")
  return stack.length === 0 && !/[<>]|&(?!(amp|lt|gt|quot|apos);)/.test(text)
}

const look = "Look: background #fff4e6; text #212529; accent #3b5bdb; fonts Georgia, serif"

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

/** One `open_agent` call as the brief gives it: its arguments, and the message to pass. */
export type Opening = {
  readonly agent: AgentName
  readonly model: string
  readonly effort?: string
  readonly message: string
}

/** The two `open_agent` calls the brief asks of its lead, read from its text. */
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

/** What the runner refuses a teammate's `open_agent` with. */
const refusal = "only the tour's lead opens agents"

const text = (words: string): Reply => ({ text: words })

// An opening's arguments for `open_agent`, with `message` for its message.
const open = ({ agent, model, effort }: Opening, message: string) => ({
  agent,
  model,
  ...(effort !== undefined && { effort }),
  message,
})

// The `ask` the copywriter's brief gives, as its arguments, and no others: the subject, the
// body and the shape, with the taglines the script has put in the placeholders.
const asking = (message: string): Record<string, unknown> => {
  const flat = message.replace(/\s+/g, " ")
  const found = /Call `ask` with subject "([^"]+)", body "([^"]+)" and shape (\{.*\})\./.exec(flat)
  if (!found) throw new Error("The copywriter's brief has no ask")
  const shape = found[3]!.replace("<tagline A>", taglines.A).replace("<tagline B>", taglines.B)
  return { subject: found[1], body: found[2], shape: JSON.parse(shape) as unknown }
}

// The messages an agent was sent by other agents: Novadeck's own notices, as the lead's brief
// (which quotes each teammate's), are no teammate's task.
const fromAgents = (call: Call) => received(call).filter((one) => one.from !== "novadeck")

const briefed = (call: Call, who: string): boolean =>
  fromAgents(call).some((one) => one.text.includes(`You are the ${who} in Novadeck's tour`))

/** The lead's brief as Novadeck's notice delivered it, in the call that carries it. */
const scriptIn = (call: Call): string | undefined =>
  received(call).find((one) => one.from === "novadeck" && one.text.startsWith(tourBriefMark))?.text

type Role = "copywriter" | "designer" | "lead"

/** What a teammate's conversation was briefed with: its role, its lead's handle, its mate's. */
type Briefing = { readonly role: Role; readonly lead?: string; readonly mate?: string }

// A conversation by its first user turn, which no other's shares: the harness may stop
// carrying a delivered brief in later calls (Antigravity does), so what a teammate was briefed
// with is kept by it.
const known = (call: Call): string => call.turns.find((turn) => turn.role === "user")?.text ?? ""

/**
 * Who a call is for, and what it was briefed with: a teammate, by the brief it holds as a
 * message (or held when its conversation began), or else the lead.
 */
const briefing = (call: Call, kept: Map<string, Briefing>): Briefing => {
  for (const role of ["copywriter", "designer"] as const) {
    const brief = fromAgents(call).find((one) =>
      one.text.includes(`You are the ${role} in Novadeck's tour`),
    )
    if (brief)
      kept.set(known(call), {
        role,
        lead: brief.from,
        ...(role === "designer" && { mate: /`to` @(\w+)/.exec(brief.text)?.[1] }),
      } as Briefing)
  }
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

/**
 * The rules of the whole story. `lead` is the lead's setup, `brief` its lead.md. A tool's
 * name is found among those any call of the run offered, as the first call of an agent goes
 * out before its MCP tools load.
 */
export const storyRules = (run: E2E): { rules: Rule[]; script: () => string } => {
  // The lead's brief, kept from the first call that carries it: a harness may drop an old
  // delivery from the calls after.
  let script: string | undefined
  const scripted = (from: Call): void => {
    script ??= scriptIn(from)
  }
  const mates = (): readonly [Opening, Opening] => {
    const [writer, designer] = openings(script ?? "")
    if (!writer || !designer) throw new Error("The lead's brief has no two open_agent calls")
    return [writer, designer]
  }
  const kept = new Map<string, Briefing>()
  const heard = new Map<string, Set<string>>()
  const roleOf = (call: Call): Role => briefing(call, kept).role
  const named = (call: Call, name: string): string | undefined =>
    [call, ...run.model.calls].map((one) => tool(one, name)).find(Boolean)
  const call = (from: Call, name: string, input: Record<string, unknown>): Reply | undefined => {
    const found = named(from, name)
    return found ? { calls: [{ name: found, input }] } : undefined
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
        const [writer] = mates()
        const opening = call(one, "open_agent", open(writer, writer.message))
        return opening && { ...opening, text: "The tour has begun." }
      }
      const handle = handleOpened(one)
      if (handle && opensMade(one) === 1) {
        const [, designer] = mates()
        return call(
          one,
          "open_agent",
          open(designer, designer.message.replaceAll("COPYWRITER", `@${handle}`)),
        )
      }
      if (handle && opensMade(one) === 2) return text("The team is working.")
      return undefined
    }),
    own((one) => {
      if (roleOf(one) !== "lead" || !fresh(one) || deliveries(one).length === 0) return undefined
      if (opensMade(one) < 2) return undefined
      // What the lead was told so far, kept: a harness may stop carrying an old delivery.
      const told = heard.get(known(one)) ?? new Set<string>()
      heard.set(known(one), told)
      for (const each of received(one))
        for (const part of ["Look:", "Tagline:"]) if (each.text.startsWith(part)) told.add(part)
      const both = told.has("Look:") && told.has("Tagline:")
      return both ? call(one, "show", { file: { path: card.file }, open: true }) : text("Noted.")
    }),
    own((one) =>
      roleOf(one) === "lead" && (result(one) ?? "").includes(card.file)
        ? text("The card is ready.")
        : undefined,
    ),
    // The copywriter.
    own((one) => {
      if (roleOf(one) !== "copywriter") return undefined
      if (
        fresh(one) &&
        briefed(one, "copywriter") &&
        !one.turns.some((t) => t.role === "assistant")
      )
        return call(one, "describe", { title: "Copywriter", summary: "Writes the card's words" })
      // As a model that follows the lead's script instead would: it tries to open an agent.
      if (result(one)?.includes("Described this terminal"))
        return call(one, "open_agent", { agent: mates()[0].agent, message: "Help me." })
      if ((result(one) ?? "").includes(refusal)) return call(one, "ask", asking(mates()[0].message))
      if (/is in the user's Inbox/.test(result(one) ?? "")) return text("Asked you to choose.")
      const { lead } = briefing(one, kept)
      if (lead && sent(one, lead)) return text("Sent it to the lead.")
      const answer = deliveries(one).find((each) => each.from === "you")
      if (fresh(one) && answer && lead) {
        const picked = /<quoted-option>([AB])<\/quoted-option>/.exec(answer.text)?.[1] as
          | "A"
          | "B"
          | undefined
        return call(one, "send", {
          to: lead,
          text: `Tagline: ${taglines[picked ?? "A"]} Paragraph: ${paragraph}`,
        })
      }
      if (fresh(one) && deliveries(one).some((each) => each.text.startsWith("Look:")))
        return text("Noted the look.")
      return undefined
    }),
    // The designer.
    own((one) => {
      if (roleOf(one) !== "designer") return undefined
      if (fresh(one) && !one.turns.some((t) => t.role === "assistant"))
        return call(one, "describe", { title: "Designer", summary: "Picks the card's look" })
      const { lead, mate } = briefing(one, kept)
      if (result(one)?.includes("Described this terminal"))
        return call(one, "open_agent", { agent: mates()[1].agent, message: "Help me." })
      if ((result(one) ?? "").includes(refusal) && mate)
        return call(one, "send", { to: mate, text: look })
      if (lead && mate && sent(one, mate)) return call(one, "send", { to: lead, text: look })
      if (lead && sent(one, lead)) return text("Sent the look.")
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
 * names, and checks what it did: each teammate started by its lead on the model and effort the
 * brief names, described itself, its messages delivered, the copywriter's ask in the Inbox and
 * its answer delivered, and the page shown on the lead's bar, opened, every one of them in the
 * tour's folder. Returns the openings. With `worktreesFolder`, the folder of agents' worktrees
 * is there before the lead starts, as on every computer Novadeck has run agents on, and each
 * harness's shim passes it on as `--add-dir`.
 */
export const tell = async (
  run: E2E,
  setup: AgentSetup,
  agents: readonly AgentName[],
  { worktreesFolder = false }: { readonly worktreesFolder?: boolean } = {},
): Promise<readonly [Opening, Opening]> => {
  await seedTour(run, agents)
  if (worktreesFolder) await mkdir(worktreesRoot(run.sandbox.home), { recursive: true })
  const prepared = await run.deck.tour.prepare(setup.agent)
  // The folder's own instruction files hold no script: it reaches the lead as a notice.
  for (const name of ["AGENTS.md", "CLAUDE.md"])
    // eslint-disable-next-line no-await-in-loop -- Two small files.
    expect(await readFile(join(prepared.directory, name), "utf8")).not.toMatch(/open_agent|Steps/)
  expect(prepared.command).not.toContain("Novadeck tour")
  // The lead's own write, which the fake model has no tool call for in every harness.
  const svg = filled()
  expect(wellFormed(svg)).toBe(true)
  await writeFile(join(prepared.directory, card.file), svg)
  const story = storyRules(run)
  run.model.use(...story.rules)
  const requests = run.deck.answerRequests()
  const calls = run.model.mark()

  const lead = await run.deck.openAt(prepared.directory, prepared.command)
  await begin(run, lead, setup, prepared.brief === "doorbell")
  const first = await requests.next()
  const second = await requests.next()
  const mates = { copywriter: first, designer: second }
  // What the lead was sent: the whole script, as Novadeck's notice, naming the person.
  const instructions = story.script()
  expect(instructions).toContain("welcome card for Ada,")
  expect(instructions).toContain("</svg>")
  const [writer, designer] = openings(instructions)
  expect(writer).toBeDefined()
  expect(designer).toBeDefined()

  // Started by the lead, on the brief's model and effort, in the harness the brief names.
  for (const [mate, opening] of [
    [mates.copywriter, writer!],
    [mates.designer, designer!],
  ] as const) {
    expect(run.deck.store.terminal(mate.id)?.ledBy).toBe(lead.id)
    // In the tour's folder, the lead's, never another its harness was given to write in.
    inTour(mate, prepared.directory)
    // Its command line only on Linux, as the runner reads no foreground process's argv on
    // Windows or macOS; everywhere, the harness it runs is checked below.
    if (process.platform === "linux") {
      // eslint-disable-next-line no-await-in-loop -- Two, one after the other.
      const argv = await poll(
        () => {
          const words = mate.summary().process?.argv?.join(" ")
          return words?.includes(flags(opening.agent, opening)) ? words : undefined
        },
        `${mate.handle} to start on ${flags(opening.agent, opening)} (now ${mate.summary().process?.argv?.join(" ")})`,
        45_000,
      )
      expect(argv.startsWith(opening.agent) || argv.includes(opening.agent)).toBe(true)
    }
  }
  // Each describes itself, as its brief says.
  await Promise.all([
    mates.copywriter.poll(
      () => (mates.copywriter.summary().title === "Copywriter" ? true : undefined),
      "its title",
      60_000,
    ),
    mates.designer.poll(
      () => (mates.designer.summary().title === "Designer" ? true : undefined),
      "its title",
      60_000,
    ),
  ])
  for (const [mate, title, opening] of [
    [mates.copywriter, "Copywriter", writer!],
    [mates.designer, "Designer", designer!],
  ] as const)
    expect(mate.summary()).toMatchObject({
      title,
      titleSource: { kind: "agent", by: mate.handle },
      agent: opening.agent,
    })

  // The designer's look reaches the copywriter and the lead.
  await mates.designer.reached(holds(mates.designer.handle, mates.copywriter.handle, "delivered"), {
    timeoutMs: 90_000,
  })
  await mates.designer.reached(holds(mates.designer.handle, lead.handle, "delivered"), {
    timeoutMs: 90_000,
  })

  // The copywriter's ask is in the Inbox, with both taglines as its options.
  const ask = await mates.copywriter.poll(
    () =>
      run.deck.terminals
        .inboxEntries()
        .find((each) => each.content.kind === "ask" && each.terminalId === mates.copywriter.id),
    "its ask in the Inbox",
    90_000,
  )
  expect(ask.content).toMatchObject({
    kind: "ask",
    ask: {
      subject: "Which tagline for the welcome card?",
      body: "The lead is making a welcome card for Ada. Which tagline should it carry?",
      shape: {
        type: "options",
        options: [
          { label: "A", summary: taglines.A },
          { label: "B", summary: taglines.B },
        ],
      },
    },
  })
  const before = run.model.mark()
  run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 1, text: "" })

  // The answer reaches the copywriter, who sends the chosen tagline to the lead.
  const answered = await run.model.waitFor(
    (one) => !one.side && deliveries(one).some((each) => each.from === "you"),
    { after: before, timeoutMs: 90_000 },
  )
  expect(deliveries(answered).find((each) => each.from === "you")?.text).toContain(
    "<quoted-option>B</quoted-option>",
  )
  await mates.copywriter.reached(holds(mates.copywriter.handle, lead.handle, "delivered"), {
    timeoutMs: 90_000,
  })
  const told = messages(lead).filter((each) => each.from === mates.copywriter.handle)
  expect(told.map((each) => each.text)).toEqual([expect.stringContaining(taglines.B)])
  const looks = messages(lead).filter((each) => each.from === mates.designer.handle)
  expect(looks.map((each) => each.text)).toEqual([look])

  // The lead shows the card it wrote, opened.
  await lead.until("The card is ready.", 90_000)
  await through(lead, ["settled"])
  const shown = run.deck.items.bar(lead.id).filter((each) => each.name === card.file)
  expect(shown).toMatchObject([
    {
      kind: "image",
      name: card.file,
      by: "agent",
      openAsked: true,
      from: { terminalId: lead.id, handle: lead.handle },
    },
  ])
  expect(shown[0]?.path?.endsWith(card.file)).toBe(true)
  // The pane gets the image's own bytes, as a data URL.
  const content = await run.deck.items.load(shown[0]!.id, false)
  expect(content).toMatchObject({
    state: "ready",
    content: { kind: "image", src: expect.stringMatching(/^data:image\/svg\+xml;base64,/) },
  })
  // Each teammate tried to open an agent and was refused, so the team stayed at two.
  const refused = run.model.calls.filter(
    (one) => !one.side && (result(one) ?? "").includes(refusal),
  )
  expect(refused.length).toBeGreaterThanOrEqual(2)
  await expect(requests.next(2000)).rejects.toThrow()
  expect(tourWrites[setup.agent].length).toBeGreaterThan(0)
  expect(run.model.calls.length).toBeGreaterThan(calls)
  // The lead's own folder, as its harness reported it all along, is still the tour's.
  inTour(lead, prepared.directory)
  return [writer!, designer!]
}

/**
 * Runs the story far enough to see the designer's terminal held at its harness's folder-trust
 * question: the lead's harness has it trusted or never asks (so run `lead` on Codex), the
 * designer's is `trusted: false` in the seed. Checks the runner reads that question as the
 * startup screen the tour's coach points at, and that the designer stays there, saying nothing,
 * until the person answers it, which is theirs to do.
 */
export const holdAtTrust = async (
  run: E2E,
  setup: AgentSetup,
  agents: readonly AgentName[],
): Promise<AgentName> => {
  await seedTour(run, agents)
  const prepared = await run.deck.tour.prepare(setup.agent)
  const story = storyRules(run)
  run.model.use(...story.rules)
  const requests = run.deck.answerRequests()
  const lead = await run.deck.openAt(prepared.directory, prepared.command)
  await begin(run, lead, setup, prepared.brief === "doorbell")
  await requests.next()
  const second = await requests.next()
  const [, designer] = openings(story.script())
  const held = await second.poll(
    () => second.summary().startup ?? undefined,
    "its startup screen",
    90_000,
  )
  expect(held).toEqual({ agent: designer!.agent, screen: "startup" })
  const before = run.model.mark()
  await new Promise((resolve) => setTimeout(resolve, 8000))
  // Still at the question: no agent bound, nothing described, no model call of its own.
  expect(second.summary().startup).toEqual({ agent: designer!.agent, screen: "startup" })
  expect(second.summary().title).not.toBe("Designer")
  expect(run.model.calls.slice(before).some((one) => !one.side && briefed(one, "designer"))).toBe(
    false,
  )
  return designer!.agent
}
