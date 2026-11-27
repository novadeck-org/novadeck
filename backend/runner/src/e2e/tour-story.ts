import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { samePath } from "@novadeck/harness-core/paths"
import { ownModel } from "@novadeck/harness-nova/model"
import type { AgentName, Approval } from "@novadeck/protocol"
import { gameEntry, keptLine, parts, planFile, projectNote } from "@novadeck/tour-runner/brief"
import { tourMarker } from "@novadeck/tour-runner/folder"
import { tourEffort } from "@novadeck/tour-runner/launch"
import { tourBriefMark } from "@novadeck/tour-runner/notices"

import { worktreesRoot } from "../worktrees/root.js"
import type { AgentSetup } from "./agents/agent.js"
import { arrivals, poll, type DeckTerminal } from "./deck.js"
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
  through,
} from "./scenarios.js"

// Novadeck's tour story (backend/tour/src/brief.ts): the lead asks the person which game to make
// (three pitches to pick from, or their own words), then asks to run the game's dev server; once
// the person approves it writes PLAN.md, opens Core, World and Feel with `open_agent`, their
// tasks as the brief quotes them with their role, branch and part written in, and shows its page.
// Each teammate opens a worktree, tells the teammates opened before it what its part exports,
// asks the person one thing and goes on working without waiting, writes its files, shows them,
// tells the lead its first version is in, and, once the person has answered, makes one more
// change and tells the lead it is polished. Once the person keeps the project, the runner commits
// their work on main. The fake model plays all four, each by the brief it was given: what a step
// says (a title, a branch, the words to send) is read out of the brief's text, so a brief that
// changes in a way the story can't follow breaks the test. It has no tool call for writing a file
// in every harness, so its rules make each edit themselves, in the worktree its agent opened,
// where the agent's model would write it. A conversation's role is told by what it was briefed
// with, so one script serves the four.

/** The tour's folder, as the sandbox's home holds it. */
export const folder = join(".novadeck", "tour")

/** A git name in the sandbox's config, which no brief calls the person by. */
export const gitName = "Ada Lovelace"

/** What the sandbox needs before the tour is readied: a git name. */
export const seedTour = async (run: E2E): Promise<void> => {
  await writeFile(join(run.sandbox.home, ".gitconfig"), `[user]\n\tname = ${gitName}\n`)
}

/**
 * Points the runner's tour at the fake model's own tour service (`/tour/v1/tickets` gives its one
 * credential as the ticket, `/tour/v1/chat/completions` is its chat dialect), which the runner
 * reads as it asks. Returns what puts the endpoint back.
 */
export const fakeTourService = (run: E2E): (() => void) => {
  const before = process.env.NOVADECK_TOUR_ENDPOINT
  process.env.NOVADECK_TOUR_ENDPOINT = `${run.model.url}/tour/v1`
  return () => {
    if (before === undefined) delete process.env.NOVADECK_TOUR_ENDPOINT
    else process.env.NOVADECK_TOUR_ENDPOINT = before
  }
}

/**
 * Starts the agent of a prepared tour as the client does: it is rung its brief (`ring`, which
 * is `tour.brief`) once its prompt shows, and the ring is retried until the
 * runner takes it, as the client retries on a CONFLICT.
 */
export const begin = async (
  terminal: DeckTerminal,
  setup: AgentSetup,
  ring: (terminalId: string) => void,
): Promise<void> => {
  await terminal.reached("ready", { timeoutMs: 60_000 })
  await prompted(terminal, setup)
  await poll(
    () => {
      try {
        ring(terminal.id)
        return true
      } catch {
        return undefined
      }
    },
    `${terminal.handle}'s agent to take the tour's brief`,
    30_000,
  )
}

/** The `open_agent` call as the lead's brief gives it: its arguments, and the message to pass. */
export type Opening = {
  readonly agent: AgentName
  readonly model: string
  readonly effort?: string
  readonly message: string
}

/** The one `open_agent` call the brief asks of its lead, three times over, read from its text. */
export const opening = (brief: string): Opening => {
  const found =
    /Call `open_agent` three times, with agent "(\w+)", model "([^"]+)"(?:, effort "(\w+)")?, one per part, and as\s+`message` this text[^\n]*\n\n((?:> ?.*\n?)+)/.exec(
      brief,
    )
  if (!found) throw new Error("The lead's brief has no open_agent call for its three parts")
  const [, agent, model, effort, quoted] = found
  return {
    agent: agent as AgentName,
    model: model!,
    ...(effort !== undefined && { effort }),
    message: quoted!
      .split("\n")
      .map((line) => line.replace(/^> ?/, ""))
      .join("\n")
      .trim(),
  }
}

// The text of a brief with its line breaks and indents as single spaces.
const flat = (words: string): string => words.replace(/\s+/g, " ")

// What a brief says, by a pattern with one group per thing wanted; a brief that no longer says
// it fails the test with what was looked for.
const read = (brief: string | undefined, pattern: RegExp, what: string): string[] => {
  const found = pattern.exec(flat(brief ?? ""))
  if (!found) throw new Error(`The brief has no ${what}: ${String(pattern)}`)
  return found.slice(1) as string[]
}

const text = (words: string): Reply => ({ text: words })

// The messages an agent was sent by other agents: Novadeck's own notices, as the lead's brief
// (which quotes its teammates' tasks), are no teammate's task.
const fromAgents = (call: Call) => received(call).filter((one) => one.from !== "novadeck")

const noticeIn = (call: Call, mark: string): string | undefined =>
  received(call).find((one) => one.from === "novadeck" && one.text.startsWith(mark))?.text

/** A teammate: the part it has, by the role its title reads. */
type Part = (typeof parts)[number]
type Mate = Lowercase<Part["role"]>
type Role = Mate | "lead"

const mateOf = (part: Part): Mate => part.role.toLowerCase() as Mate

/** What a conversation was briefed with: its role, its task and, for a teammate, its lead. */
type Briefing = {
  readonly role: Role
  readonly task?: string | undefined
  readonly lead?: string | undefined
}

// A conversation by the doorbell's first notice to it, whose id no other's shares (a harness's
// first user turn can be its own preamble, the same in every session, as Antigravity's is), else
// by its first user turn: the harness may stop carrying a delivered brief in later calls
// (Antigravity does), so what an agent was briefed with is kept by it.
const known = (call: Call): string => {
  const users = call.turns.filter((turn) => turn.role === "user").map((turn) => turn.text)
  const rung = users
    .map((turn) => /ring=["']([A-Za-z0-9]+)["']|agent messages waiting, (\w+)\]/.exec(turn))
    .map((found) => found?.[1] ?? found?.[2])
    .find(Boolean)
  return rung ?? users[0] ?? ""
}

// How a teammate's task begins, by its role.
const startOf = (part: Part): string => `You are ${part.role}, one of three teammates`

/** Who a call is for, and what it was briefed with: a teammate by the task it holds as its lead's message, or else the lead. */
const briefing = (call: Call, kept: Map<string, Briefing>): Briefing => {
  const key = known(call)
  for (const part of parts) {
    const task = fromAgents(call).find((one) => one.text.includes(startOf(part)))
    // A copy of the task with no sender (as Antigravity quotes it back in a tool's error) never
    // takes the place of the lead it was first seen from. The lead is named in the task: its
    // handle, the one address `send` takes, never the id the message came `from`.
    if (task && (task.from || !kept.has(key)))
      kept.set(key, {
        role: mateOf(part),
        task: task.text,
        lead: /(@[\w-]+) leads you/.exec(task.text)?.[1],
      })
  }
  return kept.get(key) ?? { role: "lead" }
}

/** Whether the call is the agent's first look at something new, not after its own tool's result. */
const fresh = (call: Call): boolean => asked(call, "")

// What the person's answer to an ask says: their own words, else the option they picked.
const answerIn = (words: string): string =>
  /<reply>([\s\S]*?)<\/reply>/.exec(words)?.[1]?.trim() ||
  /<quoted-option>([\s\S]*?)<\/quoted-option>/.exec(words)?.[1]?.trim() ||
  ""

/** The three games the fake lead pitches, each a title and a line, from the sparks it was given. */
export const pitches = [
  { label: "Glass Drift", summary: "Drift a skiff over a desert of glass." },
  { label: "Magnet Rush", summary: "Pull and push with a magnet through a neon city." },
  { label: "Beat Cat", summary: "Guide a cat through a haunted carnival on the beat." },
] as const

/** The one model the fake World makes. */
export const modelName = "hero"

/** The one question each fake teammate asks the person, and the answers it offers. */
export const questions: Readonly<Record<Mate, { subject: string; labels: readonly string[] }>> = {
  core: { subject: "How hard should the game be?", labels: ["Gentle", "Brutal"] },
  world: { subject: "What should the hero look like?", labels: ["Robot", "Penguin"] },
  feel: { subject: "What should the game sound like?", labels: ["Chiptune", "Calm"] },
}

/** What each fake teammate says to the lead as its work comes along, as its task words it. */
export const firstVersion = (part: Part): string => `${part.role}: first version in`
export const polished = (part: Part): string => `${part.role}: polished`

// A task with the lead's values written in for its [[name]]s: the plan's two lines for the part.
const partLines = (part: Part): string => `${part.owns}: ${part.does}.`
const filled = (task: string, part: Part): string =>
  task
    .replaceAll("[[role]]", part.role)
    .replaceAll("[[branch]]", part.branch)
    .replaceAll("[[part]]", partLines(part))

// The plan the fake lead writes: the game in a line, then each part with its owner and files.
const planOf = (pick: string): string =>
  `# Plan\n\nA browser game: ${pick}.\n\n${parts
    .map((part) => `- ${part.role} (branch ${part.branch}), ${partLines(part)}`)
    .join("\n")}\n`

// ---- The files the agents write, as their models would. ----

const coreOf = (pick: string, next?: string): string =>
  `// ${pick}: the rules, the player and the loop.
import { buildWorld } from "./world.js"
import { hud } from "./feel.js"

export const start = (scene, state) => {
  buildWorld(scene)
  hud(state)
}
${next === undefined ? "" : `// As asked: ${next}\n`}`

const worldOf = (pick: string): string =>
  `// ${pick}: the scene, built on the kit, and the hero's model.
import { loadModel } from "./models.js"

export const buildWorld = async (scene) => {
  scene.add(await loadModel("${modelName}"))
}
`

const feelOf = (pick: string, next?: string): string =>
  `// ${pick}: the title, the HUD and the juice.
export const hud = (state) => {
  state.title = "${pick}"
}
${next === undefined ? "" : `// As asked: ${next}\n`}`

// ---- The files the agents write, as their models would. ----

const colours: Readonly<Record<string, readonly [number, number, number]>> = {
  black: [0.1, 0.1, 0.14],
  white: [0.95, 0.95, 0.95],
  orange: [1, 0.55, 0.1],
  brown: [0.5, 0.3, 0.15],
  grey: [0.55, 0.55, 0.6],
  red: [0.9, 0.2, 0.2],
  blue: [0.25, 0.55, 0.95],
  yellow: [1, 0.85, 0.2],
}

// The four ready shapes of models/README.md, by the numbers of their primitives.
const primitives = {
  box: { POSITION: 0, NORMAL: 1, indices: 2 },
  sphere: { POSITION: 3, NORMAL: 4, indices: 5 },
  cone: { POSITION: 6, NORMAL: 7, indices: 8 },
  cylinder: { POSITION: 9, NORMAL: 10, indices: 11 },
} as const

type Piece = {
  readonly name: string
  readonly shape: keyof typeof primitives
  readonly colour: keyof typeof colours
  readonly at: readonly [number, number, number]
  readonly size: readonly [number, number, number]
}

const penguin: readonly Piece[] = [
  { name: "board", shape: "box", colour: "brown", at: [0, 0.2, 0], size: [1.8, 0.1, 0.6] },
  { name: "wheel", shape: "sphere", colour: "grey", at: [-0.6, 0.1, 0.2], size: [0.2, 0.2, 0.2] },
  { name: "wheel", shape: "sphere", colour: "grey", at: [-0.6, 0.1, -0.2], size: [0.2, 0.2, 0.2] },
  { name: "wheel", shape: "sphere", colour: "grey", at: [0.6, 0.1, 0.2], size: [0.2, 0.2, 0.2] },
  { name: "wheel", shape: "sphere", colour: "grey", at: [0.6, 0.1, -0.2], size: [0.2, 0.2, 0.2] },
  { name: "body", shape: "sphere", colour: "black", at: [0, 0.95, 0], size: [0.9, 1.3, 0.7] },
  { name: "belly", shape: "sphere", colour: "white", at: [0, 0.9, 0.2], size: [0.6, 1, 0.45] },
  { name: "head", shape: "sphere", colour: "black", at: [0, 1.75, 0], size: [0.6, 0.55, 0.55] },
  { name: "beak", shape: "cone", colour: "orange", at: [0, 1.7, 0.4], size: [0.2, 0.25, 0.2] },
  { name: "foot", shape: "box", colour: "orange", at: [-0.25, 0.3, 0.2], size: [0.3, 0.1, 0.4] },
  { name: "foot", shape: "box", colour: "orange", at: [0.25, 0.3, 0.2], size: [0.3, 0.1, 0.4] },
]

const robot: readonly Piece[] = [
  { name: "leg", shape: "box", colour: "grey", at: [-0.3, 0.4, 0], size: [0.3, 0.8, 0.3] },
  { name: "leg", shape: "box", colour: "grey", at: [0.3, 0.4, 0], size: [0.3, 0.8, 0.3] },
  { name: "body", shape: "box", colour: "blue", at: [0, 1.2, 0], size: [1, 0.9, 0.6] },
  { name: "arm", shape: "box", colour: "grey", at: [-0.7, 1.2, 0], size: [0.3, 0.8, 0.3] },
  { name: "arm", shape: "box", colour: "grey", at: [0.7, 1.2, 0], size: [0.3, 0.8, 0.3] },
  { name: "head", shape: "box", colour: "grey", at: [0, 1.95, 0], size: [0.6, 0.5, 0.5] },
  { name: "eye", shape: "sphere", colour: "yellow", at: [-0.15, 2, 0.25], size: [0.15, 0.15, 0.1] },
  { name: "eye", shape: "sphere", colour: "yellow", at: [0.15, 2, 0.25], size: [0.15, 0.15, 0.1] },
  { name: "antenna", shape: "cylinder", colour: "red", at: [0, 2.35, 0], size: [0.06, 0.3, 0.06] },
]

const list = (items: readonly string[]): string => `[\n    ${items.join(",\n    ")}\n  ]`

// A model's glTF as models/README.md has it written: the lines above `"materials"` as the seed
// has them, then the materials, the meshes, the nodes and the scene.
const sculpted = (seed: string, pieces: readonly Piece[]): string => {
  const head = seed.slice(0, seed.indexOf('"materials"'))
  if (head === "") throw new Error(`The placeholder has no "materials" to replace from`)
  const used = [...new Set(pieces.map((part) => part.colour))]
  const pairs = [...new Set(pieces.map((part) => `${part.colour} ${part.shape}`))]
  const materials = used.map(
    (name) =>
      `{"name":"${name}","pbrMetallicRoughness":{"baseColorFactor":[${[...colours[name]!, 1].join(",")}],"metallicFactor":0,"roughnessFactor":0.7}}`,
  )
  const meshes = pairs.map((pair) => {
    const [colour, shape] = pair.split(" ") as [string, keyof typeof primitives]
    const { POSITION, NORMAL, indices } = primitives[shape]
    return `{"name":"${pair}","primitives":[{"attributes":{"POSITION":${POSITION},"NORMAL":${NORMAL}},"indices":${indices},"material":${used.indexOf(colour)}}]}`
  })
  const nodes = pieces.map(
    (part) =>
      `{"name":"${part.name}","mesh":${pairs.indexOf(`${part.colour} ${part.shape}`)},"translation":[${part.at.join(",")}],"scale":[${part.size.join(",")}]}`,
  )
  return `${head}"materials": ${list(materials)},\n  "meshes": ${list(meshes)},\n  "nodes": ${list(nodes)},\n  "scenes": [{"nodes":[${pieces.map((_, index) => index).join(",")}]}]\n}\n`
}

/** What the story's rules learned from the conversations, for the test to check. */
export type Learned = {
  /** The lead's brief as Novadeck's notice delivered it. */
  readonly script: () => string
  /** The tasks the teammates were sent, as they held them. */
  readonly tasks: () => Readonly<Partial<Record<Mate, string>>>
  /** The game the lead read in the person's answer. */
  readonly pick: () => string | undefined
}

// A conversation's plan: steps to take one at a time, each as the agent's tool call or, for a
// file its model writes, as the side effect alone (nothing returned: the next step goes on).
type Step = (call: Call) => Reply | undefined
type Mind = { begun: boolean; queue: Step[]; readonly seen: Set<string> }
const mind = (): Mind => ({ begun: false, queue: [], seen: new Set() })

// A step that ends the turn with `words`.
const ends =
  (words: string): Step =>
  () =>
    text(words)

// Whether the call is the agent's to answer: after its own tool's result, or with news.
const goes = (call: Call, news: boolean): boolean => news || result(call) !== undefined

// The branch and title a brief has its agent open a worktree with.
const openedOf = (brief: string): { branch: string; title: string } => {
  const [branch, title] = read(
    brief,
    /call `open_worktree` with branch "([^"]+)" and title "([^"]+)"/i,
    "open_worktree",
  ) as [string, string]
  return { branch, title }
}

// Gives the next step's reply, those that only write passed over; none left, the turn ends.
const proceed = (one: Mind, call: Call, closing: string): Reply => {
  for (let step = one.queue.shift(); step; step = one.queue.shift()) {
    const reply = step(call)
    if (reply) return reply
  }
  return text(closing)
}

/**
 * The rules of the whole story. A tool's name is found among those any call of the run
 * offered, as the first call of an agent goes out before its MCP tools load. `directory` is the
 * tour's folder, where the lead writes its plan.
 */
export const storyRules = (run: E2E, directory: string): { rules: Rule[] } & Learned => {
  // The lead's brief, kept from the first call that carries it: a harness may drop an old
  // delivery from the calls after.
  let script: string | undefined
  const tasks: Partial<Record<Mate, string>> = {}
  let pick: string | undefined
  const kept = new Map<string, Briefing>()
  const minds = Object.fromEntries(
    ["lead", ...parts.map(mateOf)].map((role) => [role, mind()]),
  ) as Record<Role, Mind>
  const named = (call: Call, name: string): string | undefined =>
    [call, ...run.model.calls].map((one) => tool(one, name)).find(Boolean)
  const using =
    (name: string, input: (call: Call) => Record<string, unknown>, words?: string): Step =>
    (from) => {
      const found = named(from, name)
      if (!found) throw new Error(`The model was never offered ${name}`)
      return {
        ...(words !== undefined && { text: words }),
        calls: [{ name: found, input: input(from) }],
      }
    }
  // The worktree an agent opened, by its branch: where its model would write.
  const worktree = (branch: string): string => {
    const row = run.deck.worktrees.all().find((each) => each.branch === branch)
    if (!row) throw new Error(`No worktree on ${branch}`)
    return row.path
  }
  // The handles of the teammates the lead has opened so far, in the order it opened them, by
  // role: a teammate writes the ones opened before it, which are there to be written to.
  const handles = (lead: string | undefined): readonly string[] => {
    const leader = run.deck.store.terminals().find((each) => `@${each.handle}` === lead)
    return run.deck.store
      .terminals()
      .filter((each) => leader !== undefined && each.ledBy === leader.id)
      .map((each) => `@${each.handle}`)
  }
  // The steps every teammate begins with, as its task has them.
  const describing = (task: string, part: Part): Step =>
    using("describe", () => {
      const [title] = read(task, /Call `describe` with title "([^"]+)"/, "describe") as [string]
      return { title, summary: part.does }
    })
  const worktreeOpening = (task: string): Step => using("open_worktree", () => openedOf(task))
  // One line to each teammate opened before this one: what its part exports.
  const telling =
    (part: Part, lead: string | undefined): Step =>
    (from) => {
      const mine = handles(lead)
      const found = named(from, "send")
      if (!found) throw new Error("The model was never offered send")
      const earlier = mine.slice(
        0,
        parts.findIndex((each) => each.role === part.role),
      )
      if (earlier.length === 0) return undefined
      return {
        calls: earlier.map((to) => ({
          name: found,
          input: { to, text: `${part.role}: ${part.owns} is mine; ask me what it exports.` },
        })),
      }
    }
  // A teammate's one question: its words are its own, the shape as its task has it.
  const asking = (mate: Mate): Step =>
    using("ask", () => ({
      subject: questions[mate].subject,
      body: "Pick one, or write your own.",
      shape: { type: "options", options: questions[mate].labels.map((label) => ({ label })) },
    }))
  // What a teammate shows: its worktree's changes, or a model it made.
  const showing = (task: string, file?: () => string): Step =>
    using("show", () => {
      read(task, /call `show` \(`changes` with your worktree's folder/i, "show")
      return file
        ? { file: { path: file() }, open: true }
        : { changes: { path: worktree(openedOf(task).branch) }, open: true }
    })
  // A teammate's word to the lead.
  const reporting = (lead: string | undefined, said: string): Step =>
    using("send", () => ({ to: lead ?? "", text: said }))
  // The person's answer to a teammate's question, once: what it says, or undefined.
  const heard = (call: Call, one: Mind): string | undefined => {
    if (one.seen.has("answered")) return undefined
    const answer = deliveries(call).find((each) => each.from === "you")
    const words = answer && answerIn(answer.text)
    if (words) one.seen.add("answered")
    return words || undefined
  }

  // The lead's calls that open its team: one per part, each with the task as the brief quotes it
  // and the part's role, branch and lines written in.
  const hire = (brief: string): Step[] => {
    const mate = opening(brief)
    return parts.map((part) =>
      using("open_agent", () => ({
        agent: mate.agent,
        model: mate.model,
        ...(mate.effort !== undefined && { effort: mate.effort }),
        message: filled(mate.message, part),
      })),
    )
  }
  // The lead writes its plan in its own folder, as its model would.
  const planning = (): Step => () => {
    writeFileSync(join(directory, planFile), planOf(pick ?? ""))
    return undefined
  }
  // The game as the lead read it in the person's answer.
  const gameName = (): string => pick ?? "the game"
  // Whether the lead has opened its team.
  let hired = false

  // A teammate's rule: briefed, it describes itself, opens its worktree, tells the teammates
  // opened before it what its part exports, asks the person its one question and goes on
  // without waiting, writes its files, shows them and tells the lead its first version is in;
  // the person's answer wakes it for one more change, and its word that it is polished.
  const teammate = (
    part: Part,
    write: (where: string, pick: string, next?: string) => void,
    show: (task: string, where: () => string) => Step,
  ): Rule =>
    own((one) => {
      const mate = mateOf(part)
      const { role, task, lead: leader } = briefing(one, kept)
      if (role !== mate || !task) return undefined
      tasks[mate] ??= task
      const mine = minds[mate]
      const where = (): string => worktree(openedOf(task).branch)
      const writing =
        (next?: string): Step =>
        () => {
          write(where(), gameName(), next)
          return undefined
        }
      let news = false
      if (!mine.begun) {
        if (!fresh(one) || one.turns.some((turn) => turn.role === "assistant")) return undefined
        mine.begun = news = true
        mine.queue.push(
          describing(task, part),
          worktreeOpening(task),
          telling(part, leader),
          asking(mate),
          writing(),
          show(task, where),
          reporting(leader, firstVersion(part)),
          ends(`${part.role}: first version in.`),
        )
      } else if (fresh(one)) {
        const words = heard(one, mine)
        if (words) {
          news = true
          mine.queue.push(
            writing(words),
            show(task, where),
            reporting(leader, polished(part)),
            ends(`${part.role}: polished.`),
          )
        }
      }
      return goes(one, news) ? proceed(mine, one, "Done.") : undefined
    })

  const rules: Rule[] = [
    // The lead, by the brief's steps and what it is told after.
    own((one) => {
      const { role } = briefing(one, kept)
      if (role !== "lead") return undefined
      script ??= noticeIn(one, tourBriefMark)
      const lead = minds.lead
      let news = false
      if (!lead.begun) {
        if (!asked(one, "brief for Novadeck") || script === undefined) return undefined
        lead.begun = news = true
        const brief = script
        lead.queue.push(
          using("describe", () => {
            const [title, summary] = read(
              brief,
              /Call `describe` with the title "([^"]+)" and the summary "([^"]+)"/,
              "describe",
            ) as [string, string]
            return { title, summary }
          }),
          using("ask", () => {
            const [subject, body] = read(
              brief,
              /Call `ask` with subject "([^"]+)", body "([^"]+)" and shape/,
              "ask",
            ) as [string, string]
            return {
              subject,
              body,
              shape: {
                type: "options",
                options: pitches.map(({ label, summary }) => ({ label, summary })),
              },
            }
          }),
          ends("I'm your own agent, and my team builds the game you pick."),
        )
      } else if (fresh(one)) {
        for (const message of deliveries(one)) {
          const id = `${message.from}|${message.text}`
          if (lead.seen.has(id)) continue
          lead.seen.add(id)
          news = true
          const brief = script!
          if (message.from === "you" && pick === undefined) {
            pick = answerIn(message.text)
            // Where the dev server can run, the lead asks for it and opens its team only once
            // the person has answered that; else it opens the team at once.
            if (/Call `open_terminal`/.test(brief))
              lead.queue.push(
                using("open_terminal", () => {
                  const [command, title] = read(
                    brief,
                    /Call `open_terminal` with `command` "([^"]+)" and `title` "([^"]+)"/,
                    "open_terminal",
                  ) as [string, string]
                  return { command, title }
                }),
                ends("The game starts once you approve the command."),
              )
            else {
              hired = true
              lead.queue.push(planning(), ...hire(brief), ends("The team is at work."))
            }
          } else if (
            message.from === "novadeck" &&
            /(approved|declined) running/.test(message.text) &&
            pick !== undefined &&
            !hired
          ) {
            hired = true
            lead.queue.push(planning(), ...hire(brief))
            if (/approved running/.test(message.text)) {
              const [url] = read(brief, /`page` \{"url": "([^"]+)"\}/, "show page")
              lead.queue.push(using("show", () => ({ page: { url }, open: true })))
            }
            lead.queue.push(ends("The team is at work."))
          }
        }
      }
      return goes(one, news) ? proceed(lead, one, "Noted.") : undefined
    }),
    // Core: the rules and the loop, in src/main.js.
    teammate(
      parts[0],
      (where, game, next) => writeFileSync(join(where, gameEntry), coreOf(game, next)),
      (task) => showing(task),
    ),
    // World: the scene in src/world.js, and the hero's model, which it shows. Its answer picks
    // the model's look.
    teammate(
      parts[1],
      (where, game, next) => {
        writeFileSync(join(where, "src", "world.js"), worldOf(game))
        const placeholder = readFileSync(join(where, "models", "placeholder.gltf"), "utf8")
        writeFileSync(
          join(where, "models", `${modelName}.gltf`),
          sculpted(placeholder, next !== undefined && /penguin/i.test(next) ? penguin : robot),
        )
      },
      (task, where) => showing(task, () => join(where(), "models", `${modelName}.gltf`)),
    ),
    // Feel: the title, the HUD and the juice, in src/feel.js.
    teammate(
      parts[2],
      (where, game, next) => writeFileSync(join(where, "src", "feel.js"), feelOf(game, next)),
      (task) => showing(task),
    ),
  ]
  return {
    rules,
    script: () => {
      if (script === undefined) throw new Error("The lead was never sent its brief")
      return script
    },
    tasks: () => tasks,
    pick: () => pick,
  }
}

/** Checks that `terminal` works in the tour's folder, `directory`, as the runner knows it. */
const inTour = (terminal: DeckTerminal, directory: string): void => {
  const { cwd } = terminal.summary()
  expect(samePath(cwd, directory), `${terminal.handle} works in ${cwd}, not ${directory}`).toBe(
    true,
  )
}

/** What the person says of the game in the lead's pitch: their own words, or the option they pick. */
export type Answer = { readonly words: string } | { readonly option: number }

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()

/**
 * Runs the story with `setup`'s agent as the lead and its three teammates, as the person drives
 * it, and checks what each did (see the scenarios in tour-story.e2e.ts). With
 * `worktreesFolder`, the folder of agents' worktrees is there before the lead starts, as on
 * every computer Novadeck has run agents on, and each harness's shim passes it on as `--add-dir`.
 */
export const tell = async (
  run: E2E,
  setup: AgentSetup,
  answer: Answer,
  { worktreesFolder = false }: { readonly worktreesFolder?: boolean } = {},
): Promise<void> => {
  await seedTour(run)
  const restore = fakeTourService(run)
  try {
    await told(run, setup, answer, worktreesFolder)
  } finally {
    restore()
  }
}

const told = async (
  run: E2E,
  setup: AgentSetup,
  answer: Answer,
  worktreesFolder: boolean,
): Promise<void> => {
  if (worktreesFolder) await mkdir(worktreesRoot(run.sandbox.home), { recursive: true })
  const prepared = await run.deck.tour.prepare()
  // The folder's own instruction files hold no script: it reaches the lead as a notice.
  for (const name of ["AGENTS.md", "CLAUDE.md"])
    // eslint-disable-next-line no-await-in-loop -- Two small files.
    expect(await readFile(join(prepared.directory, name), "utf8")).not.toMatch(/open_agent|Steps/)
  expect(prepared.command).not.toContain("Novadeck tour")
  // Node is here, so the lead can run the game's dev server.
  expect(prepared.page).toBe(true)

  const story = storyRules(run, prepared.directory)
  run.model.use(...story.rules)
  const requests = run.deck.answerRequests()
  // The person's approvals, followed here and answered by the test, not by the deck.
  const asks = arrivals<Extract<Approval, { type: "request" }>>("an approval")
  const watching = new AbortController()
  void (async () => {
    try {
      for await (const approval of run.deck.terminals.approvals(run.deck.owner, watching.signal))
        if (approval.type === "request") asks.push(approval)
    } catch (error) {
      if (!watching.signal.aborted) asks.fail(error as Error)
    }
  })()
  try {
    await play(run, setup, answer, prepared, story, requests, asks)
  } finally {
    watching.abort()
  }
}

type Prepared = Awaited<ReturnType<E2E["deck"]["tour"]["prepare"]>>

// The ask a terminal put in the Inbox, once it is there.
const askOf = (run: E2E, terminal: DeckTerminal) =>
  terminal.poll(
    () =>
      run.deck.terminals
        .inboxEntries()
        .find(
          (each) => each.content.kind === "ask" && each.terminalId === terminal.id && !each.settled,
        ),
    "its ask in the Inbox",
    90_000,
  )

// The person answers a teammate's question with its first option, and the teammate hears it.
const answerFirst = async (run: E2E, terminal: DeckTerminal): Promise<void> => {
  const ask = await askOf(run, terminal)
  expect(ask.content).toMatchObject({ kind: "ask", ask: { shape: { type: "options" } } })
  const before = run.model.mark()
  run.deck.terminals.answerAsk(ask.id, { type: "reply", option: 0, text: "" })
  await run.model.waitFor(
    (call) => !call.side && deliveries(call).some((each) => each.from === "you"),
    { after: before, timeoutMs: 90_000 },
  )
}

// Whether the lead has been told `said` by `from`.
const reported = (to: DeckTerminal, from: DeckTerminal, said: string): boolean =>
  messages(to).some((each) => each.from === from.handle && each.text === said)

// Whether `from` has written something to `to`.
const among = (from: DeckTerminal, to: DeckTerminal): boolean =>
  messages(from).some((each) => each.from === from.handle && each.to === to.handle)

const play = async (
  run: E2E,
  setup: AgentSetup,
  answer: Answer,
  prepared: Prepared,
  story: ReturnType<typeof storyRules>,
  requests: ReturnType<E2E["deck"]["answerRequests"]>,
  asks: ReturnType<typeof arrivals<Extract<Approval, { type: "request" }>>>,
): Promise<void> => {
  const directory = prepared.directory
  const seed = await readFile(join(directory, gameEntry), "utf8")
  // 1. The lead: the prepared command, rung its brief. It pitches three games, as one question
  // of options, and opens nobody before the answer.
  const lead = await run.deck.openAt(directory, prepared.command)
  await begin(lead, setup, (id) => run.deck.tour.brief(id))
  const pitch = await askOf(run, lead)
  expect(pitch.content).toMatchObject({
    kind: "ask",
    ask: {
      subject: "Which game shall we build?",
      shape: {
        type: "options",
        options: pitches.map(({ label }) => expect.objectContaining({ label })),
      },
    },
  })
  const instructions = story.script()
  expect(instructions).toContain("browser game")
  expect(instructions).not.toContain("Ada")
  await expect(requests.next(1_500)).rejects.toThrow()
  const game = "words" in answer ? answer.words : pitches[answer.option]!.label
  run.deck.terminals.answerAsk(
    pitch.id,
    "words" in answer
      ? { type: "reply", option: null, text: answer.words }
      : { type: "reply", option: answer.option, text: "" },
  )

  // 2. It asks to run the game's dev server, and opens nobody before the person answers: the
  // person is asked, and approves, and the server's terminal is the first the lead opens.
  const approval = await asks.next(90_000)
  expect(approval).toMatchObject({
    from: lead.id,
    terminalId: lead.id,
    action: {
      type: "run",
      command: expect.stringMatching(/^(node dev\.mjs|python3? dev\.py) \d+$/),
    },
  })
  expect(samePath(approval.action.type === "run" ? approval.action.cwd : "", directory)).toBe(true)
  run.deck.terminals.answerApproval(
    { requestId: approval.requestId, approved: true },
    run.deck.owner,
  )
  const server = await requests.next(90_000)
  inTour(server, directory)
  expect(server.summary().title).toBe("Game server")

  // 3. Then it writes its plan and opens Core, World and Feel, on the brief's model and effort,
  // each with its task as the brief quotes it, its role, branch and lines written in.
  const mates = [await requests.next(90_000), await requests.next(90_000)]
  mates.push(await requests.next(90_000))
  const [core, world, feel] = mates as [DeckTerminal, DeckTerminal, DeckTerminal]
  expect(story.pick()).toBe(game)
  expect(await readFile(join(directory, planFile), "utf8")).toContain(game)
  const template = opening(instructions)
  for (const mate of mates) {
    expect(run.deck.store.terminal(mate.id)?.ledBy).toBe(lead.id)
    inTour(mate, directory)
  }
  // Their command lines only on Linux, as the runner reads no foreground process's argv on
  // Windows or macOS.
  if (process.platform === "linux")
    for (const mate of mates) {
      // Novadeck's own pi, which the lead's open_agent started by its word: the process is pi's
      // program, from Novadeck's own folder (`<data>/bundled/pi`), on the tour's model and
      // thinking level whatever the call named, and carrying Novadeck's extension.
      const wanted = `--model ${ownModel} --thinking ${tourEffort}`
      // eslint-disable-next-line no-await-in-loop -- Three terminals, one after the other.
      const argv = await poll(
        () => {
          const words = mate.summary().process?.argv?.join(" ")
          return words?.includes(wanted) ? words : undefined
        },
        `${mate.handle} to start on ${wanted} (now ${mate.summary().process?.argv?.join(" ")})`,
        45_000,
      )
      expect(argv).toContain(join(run.sandbox.root, "data", "bundled", "pi"))
      expect(argv).toContain(" -e ")
      // eslint-disable-next-line no-await-in-loop -- As above.
      await poll(
        async () => {
          const screen = await mate.screen()
          return screen.includes("gpt-6-luna") && screen.includes("medium") ? true : undefined
        },
        `${mate.handle}'s footer to name GPT-6 Luna at medium`,
        45_000,
      )
    }
  await poll(
    () => (parts.every((part) => story.tasks()[mateOf(part)]) ? true : undefined),
    "all three teammates to read their tasks",
    90_000,
  )
  for (const part of parts) {
    const task = story.tasks()[mateOf(part)]!
    expect(task).not.toContain("[[")
    expect(task).toBe(filled(template.message, part))
  }

  // The lead shows its page once the team is open: a page item for the address, on its bar.
  const [url] = read(instructions, /`page` \{"url": "([^"]+)"\}/, "page") as [string]
  const page = await lead.poll(
    () => run.deck.items.bar(lead.id).find((each) => each.kind === "page"),
    "its page shown",
    90_000,
  )
  expect(page).toMatchObject({ kind: "page", by: "agent", from: { terminalId: lead.id } })
  expect(JSON.stringify(page)).toContain(url)

  // 4. Each teammate: describes itself by its part's role, works in a worktree on its branch,
  // tells the teammates opened before it what its part exports, asks the person one thing,
  // shows its work and tells the lead its first version is in.
  const trees: Record<string, string> = {}
  for (const [index, part] of parts.entries()) {
    const mate = mates[index]!
    // eslint-disable-next-line no-await-in-loop -- Each teammate is checked in its turn.
    await mate.poll(
      () => (mate.summary().title === part.role ? true : undefined),
      `${part.role}'s title`,
      90_000,
    )
    expect(mate.summary()).toMatchObject({
      titleSource: { kind: "agent", by: mate.handle },
      agent: setup.agent,
      ledBy: lead.id,
    })
    // eslint-disable-next-line no-await-in-loop -- As above.
    const tree = await mate.poll(
      () => run.deck.worktrees.all().find((each) => each.branch === part.branch),
      `${part.role}'s worktree`,
      90_000,
    )
    expect(tree.terminalId).toBe(mate.id)
    trees[part.branch] = tree.path
    // eslint-disable-next-line no-await-in-loop -- As above.
    const shown = await mate.poll(
      () =>
        run.deck.items
          .bar(mate.id)
          .find((each) => each.kind === (index === 1 ? "model" : "changes") && each.by === "agent"),
      `${part.role}'s work shown`,
      90_000,
    )
    expect(shown).toMatchObject({ by: "agent", from: { terminalId: mate.id } })
    if (index === 1) expect(shown.name).toBe(`${modelName}.gltf`)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await poll(
      () => (reported(lead, mate, firstVersion(part)) ? true : undefined),
      `${part.role}'s first version to reach the lead`,
      90_000,
    )
    // Its question is waiting in the Inbox, and it has not said it is polished.
    // eslint-disable-next-line no-await-in-loop -- As above.
    const ask = await askOf(run, mate)
    expect(ask.content).toMatchObject({
      kind: "ask",
      ask: { subject: questions[mateOf(part)].subject, shape: { type: "options" } },
    })
    expect(reported(lead, mate, polished(part))).toBe(false)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await through(mate, ["settled"])
  }
  // Teammates wrote to each other, not through the lead: World, opened after Core, wrote it, and
  // Feel wrote both.
  expect(among(world, core)).toBe(true)
  expect(among(feel, core)).toBe(true)
  expect(among(feel, world)).toBe(true)

  // 5. The person answers each one's question; each hears it, makes one more change and tells the
  // lead it is polished.
  for (const mate of mates)
    // eslint-disable-next-line no-await-in-loop -- Each answer is heard before the next.
    await answerFirst(run, mate)
  for (const [index, part] of parts.entries())
    // eslint-disable-next-line no-await-in-loop -- Each report is waited for in turn.
    await poll(
      () => (reported(lead, mates[index]!, polished(part)) ? true : undefined),
      `${part.role} to tell the lead it is polished`,
      90_000,
    )
  for (const mate of mates)
    // eslint-disable-next-line no-await-in-loop -- Each turn is waited for in turn.
    await mate.reached(holds(mate.handle, lead.handle, "delivered"), { timeoutMs: 90_000 })
  const code = await readFile(join(trees.core!, gameEntry), "utf8")
  expect(code).toContain(game)
  expect(code).toContain("As asked: Gentle")
  const files: Record<string, string> = {
    world: await readFile(join(trees.world!, "src", "world.js"), "utf8"),
    feel: await readFile(join(trees.feel!, "src", "feel.js"), "utf8"),
    model: await readFile(join(trees.world!, "models", `${modelName}.gltf`), "utf8"),
  }
  expect(files.feel).toContain("As asked: Chiptune")
  expect(JSON.parse(files.model!) as { nodes: unknown[] }).toMatchObject({
    nodes: expect.arrayContaining([expect.anything()]),
  })
  expect((JSON.parse(files.model!) as { nodes: unknown[] }).nodes.length).toBeGreaterThanOrEqual(6)
  await through(lead, ["settled"])

  // 6. The end state: three works, each with its files; the tour folder's own checkout as it
  // was, bar the plan the lead wrote; and the open policy, which lets only the lead open agents
  // there.
  const branchesNow = run.deck.worktrees.all().map((each) => each.branch)
  expect(branchesNow.toSorted()).toEqual(parts.map(({ branch }) => branch).toSorted())
  expect(git(directory, "status", "--porcelain")).toBe(`?? ${planFile}`)
  expect(await readFile(join(directory, gameEntry), "utf8")).toBe(seed)
  const policy = (terminal: DeckTerminal) => run.deck.tour.openPolicy(terminal.id)
  expect(policy(lead).refusal).toBeUndefined()
  expect(policy(lead).flags).toBeDefined()
  for (const other of mates)
    expect(policy(other).refusal, `${other.handle}'s open_agent is refused`).toMatch(
      /Only the lead of Novadeck's tour/,
    )

  // The dev server lays the worktrees over the folder: the page answers, and the files the
  // agents wrote are the ones served.
  const served = async (path: string): Promise<Response> =>
    poll(
      async () => {
        const answered = await fetch(new URL(path, url)).catch(() => undefined)
        return answered?.status === 200 ? answered : undefined
      },
      `${path} to be served at ${url}`,
      30_000,
    )
  expect((await served("/")).status).toBe(200)
  expect(await (await served(`/models/${modelName}.gltf`)).text()).toBe(files.model)
  expect(await (await served(`/${gameEntry}`)).text()).toBe(code)
  expect(await (await served("/src/world.js")).text()).toBe(files.world)
  expect(await (await served("/src/feel.js")).text()).toBe(files.feel)

  // 7. The person keeps the project: the team's work comes home, committed on main, and the
  // folder is theirs; the next run uses another.
  const kept = await readdir(directory)
  expect(kept).toContain(tourMarker)
  await run.deck.tour.keep()
  const afterwards = await readdir(directory, { recursive: false })
  expect(afterwards).not.toContain(tourMarker)
  expect(afterwards).not.toContain(".claude")
  expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(projectNote)
  expect(await readFile(join(directory, gameEntry), "utf8")).toBe(code)
  expect(await readFile(join(directory, "src", "world.js"), "utf8")).toBe(files.world)
  expect(await readFile(join(directory, "src", "feel.js"), "utf8")).toBe(files.feel)
  expect(await readFile(join(directory, "models", `${modelName}.gltf`), "utf8")).toBe(files.model)
  expect(git(directory, "log", "-1", "--format=%s")).toBe("The team's game")
  // Git holds the project as the person keeps it: nothing of the tour's rules is changed,
  // skipped or tracked, so a worktree made from here carries none of them.
  expect(git(directory, "status", "--porcelain")).toBe("")
  expect(git(directory, "ls-files", "-v", "AGENTS.md")).toMatch(/^H /)
  expect(git(directory, "ls-files")).not.toContain(".claude/")
  // Each worktree holds that commit and nothing more.
  const main = git(directory, "rev-parse", "HEAD")
  for (const worktree of Object.values(trees)) {
    expect(git(worktree, "rev-parse", "HEAD")).toBe(main)
    expect(git(worktree, "status", "--porcelain")).toBe("")
  }
  // Asked again, as the client does at the story's end and again on the button: nothing changes.
  await run.deck.tour.keep()
  expect(git(directory, "status", "--porcelain")).toBe("")
  expect(git(directory, "rev-parse", "HEAD")).toBe(main)
  // The lead is told the tour is over.
  await run.model.waitFor(
    (call) => !call.side && deliveries(call).some((each) => each.text.includes(keptLine)),
    { timeoutMs: 60_000 },
  )
  const snapshot = (): string => git(directory, "status", "--porcelain", "--ignored")
  const left = snapshot()
  const next = await run.deck.tour.prepare()
  expect(next.directory).toBe(join(run.sandbox.home, ".novadeck", "tour-2"))
  expect(next.removed).toEqual([])
  expect(snapshot()).toBe(left)
  expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(projectNote)
  expect(await readFile(join(directory, gameEntry), "utf8")).toBe(code)
}
