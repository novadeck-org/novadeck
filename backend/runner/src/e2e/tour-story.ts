import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { samePath } from "@novadeck/harness-core/paths"
import type { AgentName, Approval } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { tourBriefMark } from "../messaging/messages.js"
import { branches, gameEntry, keptLine, kinds, projectNote, worlds } from "../tour/brief.js"
import { tourMarker } from "../tour/folder.js"
import { tourWrites } from "../tour/launch.js"
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

// Novadeck's tour story (backend/runner/src/tour/brief.ts): the lead asks the person which game
// to make (a world and a kind, one sheet of two questions), then opens a modeller and a builder
// with `open_agent`, their tasks with the picks and three models' names written in, asks to run
// the game's dev server (the person approves) and shows its page. The modeller makes the first
// model in a worktree, shows it, asks the person one thing, then makes the other two; the builder
// writes the game in a worktree, shows its changes, asks one thing, and makes that change. Once
// the person keeps the project, the runner commits their work on main. The fake model plays all
// three, each by the brief it was given: what a step says (a title, a branch, the words to send)
// is read out of the brief's text, so a brief that changes in a way the story can't follow breaks
// the test. It has no tool call for writing a file in every harness, so its rules make each edit
// themselves, in the worktree its agent opened, where the agent's model would write it. A
// conversation's role is told by what it was briefed with, so one script serves the three.

/** The tour's folder, as the sandbox's home holds it. */
export const folder = join(".novadeck", "tour")

/** The model Codex's cache lists in these runs, a "luna" as the tour's cheapest pick. */
export const luna = "gpt-e2e-luna"

/** A git name in the sandbox's config, which no brief calls the person by. */
export const gitName = "Ada Lovelace"

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

/** The `open_agent` calls the brief asks of its lead, read from its text, in order. */
export const openings = (brief: string): Opening[] =>
  [
    ...brief.matchAll(
      /Call `open_agent`(?: again)? with agent "(\w+)", model "([^"]+)"(?:, effort "(\w+)")?, and as `message` this text[^\n]*(?:\n[^\n>]+)*:\n\n((?:> ?.*\n?)+)/g,
    ),
  ].map(([, agent, model, effort, quoted]) => ({
    agent: agent as AgentName,
    model: model!,
    ...(effort !== undefined && { effort }),
    message: quoted!
      .split("\n")
      .map((line) => line.replace(/^> ?/, ""))
      .join("\n")
      .trim(),
  }))

/** The words of the model and effort flags a harness starts with, as `open_agent` gives them. */
const flags = (agent: AgentName, { model, effort }: Opening): string =>
  harnesses[agent].launch
    .choose({ model, ...(effort !== undefined && { effort: effort as never }) })
    .join(" ")

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

type Mate = "builder" | "modeller"
type Role = Mate | "lead"

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

const taskOf: Readonly<Record<Mate, string>> = {
  modeller: "You are Modeller, a teammate in Novadeck's tour.",
  builder: "You are Builder, a teammate in Novadeck's tour.",
}

/** Who a call is for, and what it was briefed with: a teammate by the task it holds as its lead's message, or else the lead. */
const briefing = (call: Call, kept: Map<string, Briefing>): Briefing => {
  const key = known(call)
  for (const role of ["modeller", "builder"] as const) {
    const task = fromAgents(call).find((one) => one.text.includes(taskOf[role]))
    // A copy of the task with no sender (as Antigravity quotes it back in a tool's error) never
    // takes the place of the lead it was first seen from. The lead is named in the task: its
    // handle, the one address `send` takes, never the id the message came `from`.
    if (task && (task.from || !kept.has(key)))
      kept.set(key, { role, task: task.text, lead: /(@[\w-]+) leads you/.exec(task.text)?.[1] })
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

// The person's answers to an ask of several questions, one per question in its order.
const answersIn = (words: string): string[] =>
  words
    .split(/Your question \d+/)
    .slice(1)
    .map((part) => answerIn(part))

/** The names the fake lead gives the game's three models. */
export const modelNames = ["hero", "foe", "chest"] as const

// A task with the lead's values written in for its [[name]]s.
const filled = (task: string, world: string, kind: string): string =>
  task
    .replaceAll("[[world]]", world)
    .replaceAll("[[kind]]", kind)
    .replaceAll("[[one]]", modelNames[0])
    .replaceAll("[[two]]", modelNames[1])
    .replaceAll("[[three]]", modelNames[2])

// The game the builder writes, loading the three models by name, with what the person asked for.
const gameOf = (world: string, kind: string, next?: string): string =>
  `// A ${world} ${kind} game.
import * as THREE from "three"
import { loadModel } from "./models.js"

const [hero, foe, chest] = await Promise.all(${JSON.stringify(modelNames)}.map(loadModel))
const scene = new THREE.Scene()
scene.add(hero, foe, chest)
${next === undefined ? "" : `// Next, as asked: ${next}\n`}`

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

type Part = {
  readonly name: string
  readonly shape: keyof typeof primitives
  readonly colour: keyof typeof colours
  readonly at: readonly [number, number, number]
  readonly size: readonly [number, number, number]
}

const penguin: readonly Part[] = [
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

const robot: readonly Part[] = [
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
const sculpted = (seed: string, parts: readonly Part[]): string => {
  const head = seed.slice(0, seed.indexOf('"materials"'))
  if (head === "") throw new Error(`The placeholder has no "materials" to replace from`)
  const used = [...new Set(parts.map((part) => part.colour))]
  const pairs = [...new Set(parts.map((part) => `${part.colour} ${part.shape}`))]
  const materials = used.map(
    (name) =>
      `{"name":"${name}","pbrMetallicRoughness":{"baseColorFactor":[${[...colours[name]!, 1].join(",")}],"metallicFactor":0,"roughnessFactor":0.7}}`,
  )
  const meshes = pairs.map((pair) => {
    const [colour, shape] = pair.split(" ") as [string, keyof typeof primitives]
    const { POSITION, NORMAL, indices } = primitives[shape]
    return `{"name":"${pair}","primitives":[{"attributes":{"POSITION":${POSITION},"NORMAL":${NORMAL}},"indices":${indices},"material":${used.indexOf(colour)}}]}`
  })
  const nodes = parts.map(
    (part) =>
      `{"name":"${part.name}","mesh":${pairs.indexOf(`${part.colour} ${part.shape}`)},"translation":[${part.at.join(",")}],"scale":[${part.size.join(",")}]}`,
  )
  return `${head}"materials": ${list(materials)},\n  "meshes": ${list(meshes)},\n  "nodes": ${list(nodes)},\n  "scenes": [{"nodes":[${parts.map((_, index) => index).join(",")}]}]\n}\n`
}

/** What the story's rules learned from the conversations, for the test to check. */
export type Learned = {
  /** The lead's brief as Novadeck's notice delivered it. */
  readonly script: () => string
  /** The tasks the teammates were sent, as they held them. */
  readonly tasks: () => Readonly<Partial<Record<Mate, string>>>
  /** The world and the kind the lead read in the person's answer. */
  readonly picks: () => readonly [world: string, kind: string] | undefined
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

// The branch a brief has its agent open a worktree on.
const branchOf = (brief: string): string =>
  read(brief, /call `open_worktree` with branch "([^"]+)"/i, "open_worktree")[0]!

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
 * offered, as the first call of an agent goes out before its MCP tools load.
 */
export const storyRules = (run: E2E): { rules: Rule[] } & Learned => {
  // The lead's brief, kept from the first call that carries it: a harness may drop an old
  // delivery from the calls after.
  let script: string | undefined
  const tasks: Partial<Record<Mate, string>> = {}
  let picks: readonly [string, string] | undefined
  const kept = new Map<string, Briefing>()
  const minds: Record<Role, Mind> = { lead: mind(), modeller: mind(), builder: mind() }
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
  // The steps every teammate begins with, as its task has them.
  const describing = (brief: string): Step =>
    using("describe", () => {
      const [title, summary] = read(
        brief,
        /Call `describe` with (?:the )?title "([^"]+)" and (?:the )?summary "([^"]+)"/,
        "describe",
      ) as [string, string]
      return { title, summary }
    })
  const opening = (brief: string): Step =>
    using("open_worktree", () => ({ branch: branchOf(brief) }))
  const showing = (brief: string, file: () => string): Step =>
    using("show", () => {
      const [kind] = read(brief, /call `show` with `(file|changes)` \{"path"/i, "show")
      return { [kind!]: { path: file() }, open: true }
    })
  const telling = (brief: string, to: () => string, said: RegExp): Step =>
    using("send", () => ({ to: to(), text: read(brief, said, "send's text")[0] }))
  // A teammate's one question: its words are its own, the shape as its task has it.
  const asking = (subject: string, labels: readonly string[]): Step =>
    using("ask", () => ({
      subject,
      body: "Pick one, or write your own.",
      shape: { type: "options", options: labels.map((label) => ({ label })) },
    }))
  // The person's answer to a teammate's question, once: what it says, or undefined.
  const heard = (call: Call, one: Mind): string | undefined => {
    if (one.seen.has("answered")) return undefined
    const answer = deliveries(call).find((each) => each.from === "you")
    const words = answer && answerIn(answer.text)
    if (words) one.seen.add("answered")
    return words || undefined
  }

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
          describing(brief),
          using("ask", () => {
            const [subject, body, shape] = read(
              brief,
              /Call `ask` with subject "([^"]+)", body "([^"]+)" and shape (\{.*?\}) Then say/,
              "ask",
            ) as [string, string, string]
            return { subject, body, shape: JSON.parse(shape) as unknown }
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
          if (message.from === "you" && picks === undefined) {
            const [world = "", kind = ""] = answersIn(message.text)
            picks = [world, kind]
            const [first, second] = openings(brief)
            if (!first || !second) throw new Error("The lead's brief has no two open_agent calls")
            const open = (mate: Opening): Step =>
              using("open_agent", () => ({
                agent: mate.agent,
                model: mate.model,
                ...(mate.effort !== undefined && { effort: mate.effort }),
                message: filled(mate.message, world, kind),
              }))
            lead.queue.push(
              open(first),
              open(second),
              using("open_terminal", () => {
                const [command, title] = read(
                  brief,
                  /Call `open_terminal` with `command` "([^"]+)" and `title` "([^"]+)"/,
                  "open_terminal",
                ) as [string, string]
                return { command, title }
              }),
              ends("The team is at work: the game starts once you approve the command."),
            )
          } else if (message.from === "novadeck" && /approved running/.test(message.text)) {
            const [url] = read(brief, /`page` \{"url": "([^"]+)"\}/, "show page")
            lead.queue.push(using("show", () => ({ page: { url }, open: true })))
          }
        }
      }
      return goes(one, news) ? proceed(lead, one, "Noted.") : undefined
    }),
    // The modeller: makes the first model and shows it, asks the person, makes the other two.
    own((one) => {
      const { role, task, lead: leader } = briefing(one, kept)
      if (role !== "modeller" || !task) return undefined
      tasks.modeller ??= task
      const modeller = minds.modeller
      const model = (name: string): string =>
        join(worktree(branchOf(task)), "models", `${name}.gltf`)
      const make =
        (name: string, parts: readonly Part[]): Step =>
        () => {
          const placeholder = readFileSync(
            join(worktree(branchOf(task)), "models", "placeholder.gltf"),
            "utf8",
          )
          writeFileSync(model(name), sculpted(placeholder, parts))
          return undefined
        }
      let news = false
      if (!modeller.begun) {
        if (!fresh(one) || one.turns.some((turn) => turn.role === "assistant")) return undefined
        modeller.begun = news = true
        const [first] = read(task, /Make models\/([\w-]+)\.gltf there/, "the first model")
        modeller.queue.push(
          describing(task),
          opening(task),
          make(first!, robot),
          showing(task, () => model(first!)),
          asking("What should the characters look like?", ["Robots", "Penguins"]),
          ends("Asked you how the characters look."),
        )
      } else if (fresh(one)) {
        const words = heard(one, modeller)
        if (words) {
          news = true
          const parts = /penguin/i.test(words) ? penguin : robot
          const [second, third] = read(
            task,
            /Make models\/([\w-]+)\.gltf and models\/([\w-]+)\.gltf/,
            "the other models",
          ) as [string, string]
          modeller.queue.push(
            make(second, parts),
            showing(task, () => model(second)),
            make(third, parts),
            showing(task, () => model(third)),
            telling(task, () => leader ?? "", /`text` "(Models done\.)"/),
            ends("Models done."),
          )
        }
      }
      return goes(one, news) ? proceed(modeller, one, "Done.") : undefined
    }),
    // The builder: writes the game and shows its changes, asks the person, makes that change.
    own((one) => {
      const { role, task, lead: leader } = briefing(one, kept)
      if (role !== "builder" || !task) return undefined
      tasks.builder ??= task
      const builder = minds.builder
      const where = (): string => worktree(branchOf(task))
      const [world, kind] = read(task, /The person picked a (.+?) (\S+) game\./, "the picks") as [
        string,
        string,
      ]
      const write =
        (next?: string): Step =>
        () => {
          writeFileSync(join(where(), gameEntry), gameOf(world, kind, next))
          return undefined
        }
      let news = false
      if (!builder.begun) {
        if (!fresh(one) || one.turns.some((turn) => turn.role === "assistant")) return undefined
        builder.begun = news = true
        builder.queue.push(
          describing(task),
          opening(task),
          write(),
          showing(task, where),
          asking("What should the game get next?", ["More enemies", "A score"]),
          ends("Asked you what comes next."),
        )
      } else if (fresh(one)) {
        const words = heard(one, builder)
        if (words) {
          news = true
          builder.queue.push(
            write(words),
            showing(task, where),
            telling(task, () => leader ?? "", /`text` "(Game done\.)"/),
            ends("Game done."),
          )
        }
      }
      return goes(one, news) ? proceed(builder, one, "Done.") : undefined
    }),
  ]
  return {
    rules,
    script: () => {
      if (script === undefined) throw new Error("The lead was never sent its brief")
      return script
    },
    tasks: () => tasks,
    picks: () => picks,
  }
}

/** Checks that `terminal` works in the tour's folder, `directory`, as the runner knows it. */
const inTour = (terminal: DeckTerminal, directory: string): void => {
  const { cwd } = terminal.summary()
  expect(samePath(cwd, directory), `${terminal.handle} works in ${cwd}, not ${directory}`).toBe(
    true,
  )
}

/** What the person says of the world in the lead's sheet: their own words, or the option they pick. */
export type Answer = { readonly words: string } | { readonly option: number }

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()

/**
 * Runs the story with `setup`'s agent as the lead, the modeller and the builder, as the person
 * drives it, and checks what each did (see the scenarios in tour-story.e2e.ts). With
 * `worktreesFolder`, the folder of agents' worktrees is there before the lead starts, as on
 * every computer Novadeck has run agents on, and each harness's shim passes it on as `--add-dir`.
 */
export const tell = async (
  run: E2E,
  setup: AgentSetup,
  answer: Answer,
  { worktreesFolder = false }: { readonly worktreesFolder?: boolean } = {},
): Promise<void> => {
  await seedTour(run, [setup.agent])
  if (worktreesFolder) await mkdir(worktreesRoot(run.sandbox.home), { recursive: true })
  const prepared = await run.deck.tour.prepare(setup.agent)
  // The folder's own instruction files hold no script: it reaches the lead as a notice.
  for (const name of ["AGENTS.md", "CLAUDE.md"])
    // eslint-disable-next-line no-await-in-loop -- Two small files.
    expect(await readFile(join(prepared.directory, name), "utf8")).not.toMatch(/open_agent|Steps/)
  expect(prepared.command).not.toContain("Novadeck tour")
  // Node is here, so the lead can run the game's dev server.
  expect(prepared.page).toBe(true)

  const story = storyRules(run)
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
  // 1. The lead: the prepared command, rung its brief. It asks the person which game, in one
  // sheet of two questions, and opens nobody before the answer.
  const lead = await run.deck.openAt(directory, prepared.command)
  await begin(lead, setup, (id) => run.deck.tour.brief(id))
  const sheet = await askOf(run, lead)
  expect(sheet.content).toMatchObject({
    kind: "ask",
    ask: {
      subject: "Which game shall we build?",
      shape: {
        type: "questions",
        questions: [
          { header: "The world", options: worlds.map((label) => ({ label })) },
          { header: "The kind", options: kinds.map((label) => ({ label })) },
        ],
      },
    },
  })
  const instructions = story.script()
  expect(instructions).toContain("browser game")
  expect(instructions).not.toContain("Ada")
  await expect(requests.next(1_500)).rejects.toThrow()
  const world = "words" in answer ? answer.words : worlds[answer.option]!
  run.deck.terminals.answerAsk(sheet.id, {
    type: "questions",
    answers: [
      "words" in answer
        ? { options: [], text: answer.words }
        : { options: [answer.option], text: "" },
      { options: [0], text: "" },
    ],
  })

  // 2. It opens the modeller and the builder, on the brief's model and effort, each with its
  // task as the brief quotes it, the picks and the models' names written in.
  const modeller = await requests.next(90_000)
  const builder = await requests.next(90_000)
  expect(story.picks()).toEqual([world, kinds[0]])
  const [first, second] = openings(instructions)
  expect(first).toBeDefined()
  expect(second).toBeDefined()
  for (const mate of [modeller, builder]) {
    expect(run.deck.store.terminal(mate.id)?.ledBy).toBe(lead.id)
    inTour(mate, directory)
  }
  // Their command lines only on Linux, as the runner reads no foreground process's argv on
  // Windows or macOS.
  if (process.platform === "linux")
    for (const mate of [modeller, builder]) {
      const wanted = flags(first!.agent, first!)
      // eslint-disable-next-line no-await-in-loop -- Two terminals, one after the other.
      const argv = await poll(
        () => {
          const words = mate.summary().process?.argv?.join(" ")
          return words?.includes(wanted) ? words : undefined
        },
        `${mate.handle} to start on ${wanted} (now ${mate.summary().process?.argv?.join(" ")})`,
        45_000,
      )
      expect(argv).toContain(tourWrites[first!.agent].join(" "))
    }
  await poll(
    () => (story.tasks().modeller && story.tasks().builder ? true : undefined),
    "both teammates to read their tasks",
    90_000,
  )
  for (const task of [story.tasks().modeller!, story.tasks().builder!]) {
    expect(task).not.toContain("[[")
    expect(task).toContain(`The person picked a ${world} ${kinds[0]} game.`)
  }
  expect(story.tasks().modeller).toBe(filled(first!.message, world, kinds[0]))
  expect(story.tasks().builder).toBe(filled(second!.message, world, kinds[0]))

  // 3. It asks to run the game's dev server: the person is asked, and approves.
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
  // The lead is told and shows the page: a page item for the address, on the lead's bar.
  const [url] = read(instructions, /`page` \{"url": "([^"]+)"\}/, "page") as [string]
  const page = await lead.poll(
    () => run.deck.items.bar(lead.id).find((each) => each.kind === "page"),
    "its page shown",
    90_000,
  )
  expect(page).toMatchObject({ kind: "page", by: "agent", from: { terminalId: lead.id } })
  expect(JSON.stringify(page)).toContain(url)

  // 4. The modeller: describes itself, works in a worktree, shows its first model, asks the
  // person, then makes the other two and tells the lead.
  await modeller.poll(
    () => (modeller.summary().title === "Modeller" ? true : undefined),
    "its title",
    90_000,
  )
  expect(modeller.summary()).toMatchObject({
    titleSource: { kind: "agent", by: modeller.handle },
    agent: setup.agent,
    ledBy: lead.id,
  })
  const models = await modeller.poll(
    () => run.deck.worktrees.all().find((each) => each.branch === branches.modeller),
    "its worktree",
    90_000,
  )
  expect(models.terminalId).toBe(modeller.id)
  const shown = await modeller.poll(
    () => run.deck.items.bar(modeller.id).find((each) => each.kind === "model"),
    "its model shown",
    90_000,
  )
  expect(shown).toMatchObject({ by: "agent", from: { terminalId: modeller.id } })
  expect(shown.name).toBe(`${modelNames[0]}.gltf`)
  await answerFirst(run, modeller)
  await poll(
    () =>
      messages(lead).some((each) => each.from === modeller.handle && each.text === "Models done.")
        ? true
        : undefined,
    "Models done. to reach the lead",
    90_000,
  )
  const made: Record<string, string> = {}
  for (const name of modelNames) {
    // eslint-disable-next-line no-await-in-loop -- Three small files.
    made[name] = await readFile(join(models.path, "models", `${name}.gltf`), "utf8")
    const parsed = JSON.parse(made[name]) as { nodes: unknown[] }
    expect(parsed.nodes.length).toBeGreaterThanOrEqual(6)
  }

  // 5. The builder: describes itself, writes the game in a worktree, shows its changes, asks
  // the person, makes that change and tells the lead.
  await builder.poll(
    () => (builder.summary().title === "Builder" ? true : undefined),
    "its title",
    90_000,
  )
  const game = await builder.poll(
    () => run.deck.worktrees.all().find((each) => each.branch === branches.builder),
    "its worktree",
    90_000,
  )
  expect(game.terminalId).toBe(builder.id)
  const changes = await builder.poll(
    () => run.deck.items.bar(builder.id).find((each) => each.kind === "changes"),
    "its changes shown",
    90_000,
  )
  expect(changes).toMatchObject({ by: "agent", from: { terminalId: builder.id } })
  await answerFirst(run, builder)
  await builder.reached(holds(builder.handle, lead.handle, "delivered"), { timeoutMs: 90_000 })
  expect(
    messages(lead)
      .filter((each) => each.from === builder.handle)
      .map((each) => each.text),
  ).toEqual(["Game done."])
  const code = await readFile(join(game.path, gameEntry), "utf8")
  expect(code).toContain(`A ${world} ${kinds[0]} game.`)
  expect(code).toContain("Next, as asked: More enemies")
  await through(lead, ["settled"])

  // 6. The end state: two works, each with its files; the tour folder's own checkout as it
  // was; and the open policy, which lets only the lead open agents there.
  const branchesNow = run.deck.worktrees.all().map((each) => each.branch)
  expect(branchesNow.toSorted()).toEqual(Object.values(branches).toSorted())
  expect(git(directory, "status", "--porcelain")).toBe("")
  expect(await readFile(join(directory, gameEntry), "utf8")).toBe(seed)
  const policy = (terminal: DeckTerminal) => run.deck.tour.openPolicy(terminal.id)
  expect(policy(lead).refusal).toBeUndefined()
  expect(policy(lead).flags).toBeDefined()
  for (const other of [modeller, builder])
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
  for (const name of modelNames)
    // eslint-disable-next-line no-await-in-loop -- Three small files.
    expect(await (await served(`/models/${name}.gltf`)).text()).toBe(made[name])
  expect(await (await served(`/${gameEntry}`)).text()).toBe(code)

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
  for (const name of modelNames)
    // eslint-disable-next-line no-await-in-loop -- Three small files.
    expect(await readFile(join(directory, "models", `${name}.gltf`), "utf8")).toBe(made[name])
  expect(git(directory, "log", "-1", "--format=%s")).toBe("The team's game")
  // Git holds the project as the person keeps it: nothing of the tour's rules is changed,
  // skipped or tracked, so a worktree made from here carries none of them.
  expect(git(directory, "status", "--porcelain")).toBe("")
  expect(git(directory, "ls-files", "-v", "AGENTS.md")).toMatch(/^H /)
  expect(git(directory, "ls-files")).not.toContain(".claude/")
  // Each worktree holds that commit and nothing more.
  const main = git(directory, "rev-parse", "HEAD")
  for (const worktree of [models.path, game.path]) {
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
  const next = await run.deck.tour.prepare(setup.agent)
  expect(next.directory).toBe(join(run.sandbox.home, ".novadeck", "tour-2"))
  expect(next.removed).toEqual([])
  expect(snapshot()).toBe(left)
  expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(projectNote)
  expect(await readFile(join(directory, gameEntry), "utf8")).toBe(code)
}
