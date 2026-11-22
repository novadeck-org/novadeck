import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { samePath } from "@novadeck/harness-core/paths"
import type { AgentName, Approval } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { tourArtistMark, tourBriefMark } from "../messaging/messages.js"
import {
  branches,
  configFile,
  coverFile,
  heroFile,
  keptLine,
  projectNote,
  scoreFile,
} from "../tour/brief.js"
import { tourMarker } from "../tour/folder.js"
import { tourWrites } from "../tour/launch.js"
import { worktreesRoot } from "../worktrees/root.js"
import type { AgentSetup } from "./agents/agent.js"
import { freeModel } from "./agents/opencode.js"
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

// Novadeck's tour story (backend/runner/src/tour/brief.ts): the lead opens a sculptor and a
// score fixer with `open_agent`, asks to run the game's dev server (the person approves) and
// shows its page; the sculptor shows the hero's model and asks the person who the hero is,
// tells the lead, and sculpts it in a worktree; the lead names the game in a worktree of its
// own; the fixer fixes the score in one and shows its changes; and the artist, which the tour
// starts on no team, finds the lead with `agents`, asks it what the game is, and draws the
// cover in a worktree, which it shows. The fake model plays all four, each by the brief it was
// given: what a step says (a title, a branch, the words to send) is read out of the brief's
// text, so a brief that changes in a way the story can't follow breaks the test. It has no
// tool call for writing a file in every harness, so its rules make each edit themselves, in
// the worktree its agent opened, where the agent's model would write it. A conversation's role
// is told by what it was briefed with, so one script serves the four terminals.

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
  if (agents.includes("opencode")) await freeModel(run.sandbox)
  await writeFile(join(run.sandbox.home, ".gitconfig"), `[user]\n\tname = ${gitName}\n`)
}

/**
 * Starts the agent of a prepared tour as the client does: it is rung its brief (`ring`, which
 * is `tour.brief` or `tour.artist`) once its prompt shows, and the ring is retried until the
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
      /Call `open_agent`(?: again)? with agent "(\w+)", model "([^"]+)"(?:, effort "(\w+)")?, and as `message` exactly this text:\n\n((?: {3}> ?.*\n?)+)/g,
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

type Role = "artist" | "fixer" | "lead" | "sculptor"

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

const taskOf: Readonly<Record<"fixer" | "sculptor", string>> = {
  sculptor: "You are Sculptor, a teammate in Novadeck's tour.",
  fixer: "You are Score fixer, a teammate in Novadeck's tour.",
}

/**
 * Who a call is for, and what it was briefed with: a teammate by the task it holds as its
 * lead's message, the artist by Novadeck's brief to it, or else the lead.
 */
const briefing = (call: Call, kept: Map<string, Briefing>): Briefing => {
  const key = known(call)
  for (const role of ["sculptor", "fixer"] as const) {
    const task = fromAgents(call).find((one) => one.text.includes(taskOf[role]))
    // A copy of the task with no sender (as Antigravity quotes it back in a tool's error) never
    // takes the place of the lead it was first seen from. The lead is named in the task: its
    // handle, the one address `send` takes, never the id the message came `from`.
    if (task && (task.from || !kept.has(key)))
      kept.set(key, { role, task: task.text, lead: /(@[\w-]+) leads you/.exec(task.text)?.[1] })
  }
  const brief = noticeIn(call, tourArtistMark)
  if (brief && !kept.has(key)) kept.set(key, { role: "artist", task: brief })
  return kept.get(key) ?? { role: "lead" }
}

/** Whether the call is the agent's first look at something new, not after its own tool's result. */
const fresh = (call: Call): boolean => asked(call, "")

// What the person's answer to an ask says: their own words, else the option they picked.
const answerIn = (words: string): string =>
  /<reply>([\s\S]*?)<\/reply>/.exec(words)?.[1]?.trim() ||
  /<quoted-option>([\s\S]*?)<\/quoted-option>/.exec(words)?.[1]?.trim() ||
  ""

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

// The four ready shapes of model/README.md, by the numbers of their primitives.
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

// A hero's glTF as model/README.md has it written: the lines above `"materials"` as the seed
// has them, then the materials, the meshes, the nodes and the scene.
const sculpted = (seed: string, parts: readonly Part[]): string => {
  const head = seed.slice(0, seed.indexOf('"materials"'))
  if (head === "") throw new Error(`${heroFile} has no "materials" to replace from`)
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

// The config the lead sets for a hero: a short name, one emoji and two colours.
const configured = (hero: string): Record<"title" | "hero" | "pickup", string> => {
  const noun = hero.replace(/^(a|an|the) /i, "").split(" ")[0] ?? "Hero"
  return {
    title: `${noun[0]!.toUpperCase()}${noun.slice(1)} Dash`,
    hero,
    pickup: /robot/i.test(hero) ? "🔋" : "🐟",
  }
}

const setting = (source: string, key: string, value: string): string => {
  const line = new RegExp(`(\\b${key}: )"[^"]*"`)
  if (!line.test(source)) throw new Error(`${configFile} has no ${key} to set`)
  return source.replace(line, (_, before: string) => `${before}${JSON.stringify(value)}`)
}

// A cover for a game: a dark gradient and a few shapes near the edges, with no text.
const cover = (title: string): string =>
  `<!-- Cover of ${title} -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1d3a"/><stop offset="1" stop-color="#274a7a"/></linearGradient></defs>
  <rect width="960" height="540" fill="url(#sky)"/>
  <circle cx="90" cy="80" r="40" fill="#f5f0d0"/>
  <polygon points="0,540 120,380 240,540" fill="#e8f1ff"/>
  <polygon points="720,540 840,360 960,540" fill="#e8f1ff"/>
  <circle cx="860" cy="90" r="6" fill="#fff"/>
  <circle cx="780" cy="50" r="4" fill="#fff"/>
  <circle cx="40" cy="300" r="5" fill="#fff"/>
  <rect x="0" y="500" width="960" height="40" fill="#cfe3ff"/>
</svg>
`

/** What the story's rules learned from the conversations, for the test to check. */
export type Learned = {
  /** The lead's brief as Novadeck's notice delivered it. */
  readonly script: () => string
  /** The tasks the teammates were sent, as they held them. */
  readonly tasks: () => Readonly<Partial<Record<"fixer" | "sculptor", string>>>
  /** What `agents` answered the artist. */
  readonly listing: () => string | undefined
  /** The hero the sculptor was told, as it sent it to the lead. */
  readonly hero: () => string | undefined
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

// A step that writes a file as the agent's model would, and says nothing: the next goes on.
const writes =
  (file: () => string, change: (before: string) => string): Step =>
  () => {
    writeFileSync(file(), change(readFileSync(file(), "utf8")))
    return undefined
  }

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
  const tasks: Partial<Record<"fixer" | "sculptor", string>> = {}
  let listing: string | undefined
  let hero: string | undefined
  const kept = new Map<string, Briefing>()
  const minds: Record<Role, Mind> = {
    lead: mind(),
    sculptor: mind(),
    fixer: mind(),
    artist: mind(),
  }
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
  // The steps every teammate and the artist begin with, as their briefs have them.
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
    using("open_worktree", () => ({
      branch: read(brief, /call `open_worktree` with branch "([^"]+)"/i, "open_worktree")[0],
    }))
  const showing = (brief: string, file: () => string): Step =>
    using("show", () => {
      const [kind] = read(brief, /Call `show` with `(file|changes)` \{"path"/, "show")
      return { [kind!]: { path: file() }, open: true }
    })
  const telling = (
    brief: string,
    to: () => string,
    said: RegExp,
    replace?: [string, string],
  ): Step =>
    using("send", () => {
      const [words] = read(brief, said, "send's text")
      return { to: to(), text: replace ? words!.replace(...replace) : words }
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
        const [first, second] = openings(brief)
        if (!first || !second) throw new Error("The lead's brief has no two open_agent calls")
        const open = (mate: Opening, words?: string): Step =>
          using(
            "open_agent",
            () => ({
              agent: mate.agent,
              model: mate.model,
              ...(mate.effort !== undefined && { effort: mate.effort }),
              message: mate.message,
            }),
            words,
          )
        lead.queue.push(
          describing(brief),
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
          ends(
            "I'm your own agent, and my team is at work making this game yours. It starts once you approve the command.",
          ),
        )
      } else if (fresh(one)) {
        for (const message of deliveries(one)) {
          const id = `${message.from}|${message.text}`
          if (lead.seen.has(id)) continue
          lead.seen.add(id)
          news = true
          const brief = script!
          if (message.from === "novadeck" && /approved running/.test(message.text)) {
            const [url] = read(brief, /`page` \{"url": "([^"]+)"\}/, "show page")
            lead.queue.push(using("show", () => ({ page: { url }, open: true })))
          } else if (message.text.startsWith("The hero is")) {
            hero = message.text
            const branch = branchOf(read(brief, /(Your sculptor tells you[\s\S]*)/, "messages")[0]!)
            const config = (): string => join(worktree(branch), configFile)
            lead.queue.push(
              using("open_worktree", () => ({ branch })),
              writes(config, (before) => {
                const made = configured(message.text.replace(/^The hero is |\.$/g, ""))
                return setting(
                  setting(setting(before, "title", made.title), "hero", made.hero),
                  "pickup",
                  made.pickup,
                )
              }),
              ends("The game is named."),
            )
          } else if (message.from !== "novadeck" && /what is it called/i.test(message.text)) {
            // Answered once the sculptor has told it who the hero is, as the brief says.
            lead.queue.push((from) => {
              const told = hero?.replace(/^The hero is |\.$/g, "")
              const made = configured(told ?? "")
              const answer = using("send", () => ({
                to: `@${message.from}`,
                text: `The game is called ${made.title}. Its hero is ${told}. Draw its picture in ${coverFile}.`,
              }))
              return told === undefined ? text("Waiting for my sculptor first.") : answer(from)
            })
          }
        }
      }
      return goes(one, news) ? proceed(lead, one, "Noted.") : undefined
    }),
    // The sculptor: shows the model, asks the person, tells the lead the hero, sculpts it.
    own((one) => {
      const { role, task, lead: leader } = briefing(one, kept)
      if (role !== "sculptor" || !task) return undefined
      tasks.sculptor ??= task
      const sculptor = minds.sculptor
      let news = false
      if (!sculptor.begun) {
        if (!fresh(one) || one.turns.some((turn) => turn.role === "assistant")) return undefined
        sculptor.begun = news = true
        const file = (): string => join(worktree(branchOf(task)), heroFile)
        sculptor.queue.push(
          describing(task),
          opening(task),
          showing(task, file),
          using("ask", () => {
            const [subject, body, shape] = read(
              task,
              /Call `ask` with subject "([^"]+)", body "([^"]+)" and shape (\{.*?\})\.\s+5\./,
              "ask",
            ) as [string, string, string]
            return { subject, body, shape: JSON.parse(shape) as unknown }
          }),
          ends("Asked you who the hero is."),
        )
      } else if (fresh(one)) {
        const answer = deliveries(one).find((each) => each.from === "you")
        const words = answer && answerIn(answer.text)
        if (words && !sculptor.seen.has("answered")) {
          sculptor.seen.add("answered")
          news = true
          const to = (): string => leader ?? ""
          const file = (): string => join(worktree(branchOf(task)), heroFile)
          sculptor.queue.push(
            telling(task, to, /`text` "(The hero is <the hero>\.)"/, ["<the hero>", words]),
            writes(file, (before) => sculpted(before, /robot/i.test(words) ? robot : penguin)),
            telling(task, to, /`text` "(Hero sculpted\.)"/),
            ends("Hero sculpted."),
          )
        }
      }
      return goes(one, news) ? proceed(sculptor, one, "Done.") : undefined
    }),
    // The score fixer: fixes the score, the README, shows its changes.
    own((one) => {
      const { role, task, lead: leader } = briefing(one, kept)
      if (role !== "fixer" || !task) return undefined
      tasks.fixer ??= task
      const fixer = minds.fixer
      let news = false
      if (!fixer.begun) {
        if (!fresh(one) || one.turns.some((turn) => turn.role === "assistant")) return undefined
        fixer.begun = news = true
        const where = (): string => worktree(branchOf(task))
        fixer.queue.push(
          describing(task),
          opening(task),
          writes(
            () => join(where(), scoreFile),
            (before) => {
              const [line] = read(task, /make `add` return the new score: `([^`]+)`/, "the fix")
              return before.replace(/export const add =[\s\S]*$/, `${line}\n`)
            },
          ),
          writes(
            () => join(where(), "README.md"),
            (before) => before.replace(/\n## Known bug[\s\S]*$/, "\n").trimEnd() + "\n",
          ),
          showing(task, where),
          telling(task, () => leader ?? "", /`text` "(Score fixed\.)"/),
          ends("Score fixed."),
        )
        news = true
      }
      return goes(one, news) ? proceed(fixer, one, "Done.") : undefined
    }),
    // The artist: finds the lead with `agents`, asks it, draws the cover by its answer.
    own((one) => {
      const { role, task } = briefing(one, kept)
      if (role !== "artist" || !task) return undefined
      const artist = minds.artist
      let news = false
      if (!artist.begun) {
        if (!asked(one, "brief for Novadeck")) return undefined
        artist.begun = news = true
        // The lead's handle as `agents` lists it: the line that names its title.
        const lead = (from: Call): string => {
          listing = result(from)
          const handle = /@(\w+)[^\n]*Game lead|Game lead[^\n]*?@(\w+)/.exec(listing ?? "")
          const name = handle?.[1] ?? handle?.[2]
          if (!name)
            throw new Error(`The artist can't find the lead in what agents lists:\n${listing}`)
          return `@${name}`
        }
        artist.queue.push(
          describing(task),
          using("agents", () => ({})),
          (from) => {
            const to = lead(from)
            const [words] = read(task, /`text` "(I'm drawing[^"]*)"/, "the question")
            artist.seen.add(to)
            return using("send", () => ({ to, text: words }))(from)
          },
          ends("Asked the lead what the game is."),
        )
      } else if (fresh(one)) {
        const answer = deliveries(one).find(
          (each) => each.from !== "novadeck" && each.from !== "you",
        )
        if (answer && !artist.seen.has("answered")) {
          artist.seen.add("answered")
          news = true
          const title = /called (.+?)\. Its hero/.exec(answer.text)?.[1] ?? ""
          const file = (): string => join(worktree(branchOf(task)), coverFile)
          artist.queue.push(
            opening(task),
            () => {
              mkdirSyncFor(file())
              writeFileSync(file(), cover(title))
              return undefined
            },
            showing(task, file),
            using("send", () => ({
              to: [...artist.seen].find((each) => each.startsWith("@")) ?? "",
              text: read(task, /`text` "(The cover is done: [^"]*)"/, "the report")[0],
            })),
            ends("The cover is done."),
          )
        }
      }
      return goes(one, news) ? proceed(artist, one, "Done.") : undefined
    }),
  ]
  return {
    rules,
    script: () => {
      if (script === undefined) throw new Error("The lead was never sent its brief")
      return script
    },
    tasks: () => tasks,
    listing: () => listing,
    hero: () => hero,
  }
}

// A folder for a file the model writes, which its tool would make.
const mkdirSyncFor = (file: string): void => {
  mkdirSync(dirname(file), { recursive: true })
}

/** Checks that `terminal` works in the tour's folder, `directory`, as the runner knows it. */
const inTour = (terminal: DeckTerminal, directory: string): void => {
  const { cwd } = terminal.summary()
  expect(samePath(cwd, directory), `${terminal.handle} works in ${cwd}, not ${directory}`).toBe(
    true,
  )
}

/** What the person says to the sculptor's question: their own words, or the option they pick. */
export type Answer = { readonly words: string } | { readonly option: number }

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()

/**
 * Runs the story with `setup`'s agent as the lead, the sculptor, the fixer and the artist, as
 * the person drives it, and checks what each did (see the scenarios in tour-story.e2e.ts).
 * With `worktreesFolder`, the folder of agents' worktrees is there before the lead starts, as
 * on every computer Novadeck has run agents on, and each harness's shim passes it on as
 * `--add-dir`.
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
  const seed = await readFile(join(prepared.directory, heroFile), "utf8")

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
    await play(run, setup, answer, prepared, story, requests, asks, seed)
  } finally {
    watching.abort()
  }
}

type Prepared = Awaited<ReturnType<E2E["deck"]["tour"]["prepare"]>>

const play = async (
  run: E2E,
  setup: AgentSetup,
  answer: Answer,
  prepared: Prepared,
  story: ReturnType<typeof storyRules>,
  requests: ReturnType<E2E["deck"]["answerRequests"]>,
  asks: ReturnType<typeof arrivals<Extract<Approval, { type: "request" }>>>,
  seed: string,
): Promise<void> => {
  const directory = prepared.directory
  // 1. The lead: the prepared command, rung its brief.
  const lead = await run.deck.openAt(directory, prepared.command)
  await begin(lead, setup, (id) => run.deck.tour.brief(id))
  // 2. It opens the sculptor and the fixer, on the brief's model and effort.
  const sculptor = await requests.next(90_000)
  const fixer = await requests.next(90_000)
  const instructions = story.script()
  expect(instructions).toContain("browser game")
  expect(instructions).not.toContain("Ada")
  const [first, second] = openings(instructions)
  expect(first).toBeDefined()
  expect(second).toBeDefined()
  for (const mate of [sculptor, fixer]) {
    expect(run.deck.store.terminal(mate.id)?.ledBy).toBe(lead.id)
    inTour(mate, directory)
  }
  // Their command lines only on Linux, as the runner reads no foreground process's argv on
  // Windows or macOS.
  if (process.platform === "linux")
    for (const mate of [sculptor, fixer]) {
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
  // Each got exactly the task the brief quotes, as its lead's message.
  await poll(
    () => (story.tasks().sculptor && story.tasks().fixer ? true : undefined),
    "both teammates to read their tasks",
    90_000,
  )
  expect(story.tasks().sculptor).toBe(first!.message)
  expect(story.tasks().fixer).toBe(second!.message)

  // 2b. It asks to run the game's dev server: the person is asked, and nothing opens first.
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
  await expect(requests.next(1_500)).rejects.toThrow()
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

  // 3. The sculptor describes itself, works in a worktree on `hero`, shows its model, asks.
  await sculptor.poll(
    () => (sculptor.summary().title === "Sculptor" ? true : undefined),
    "its title",
    90_000,
  )
  expect(sculptor.summary()).toMatchObject({
    titleSource: { kind: "agent", by: sculptor.handle },
    agent: setup.agent,
    ledBy: lead.id,
  })
  const hero = await sculptor.poll(
    () => run.deck.worktrees.all().find((each) => each.branch === branches.sculptor),
    "its worktree",
    90_000,
  )
  expect(hero.terminalId).toBe(sculptor.id)
  const model = await sculptor.poll(
    () => run.deck.items.bar(sculptor.id).find((each) => each.kind === "model"),
    "its model shown",
    90_000,
  )
  expect(model).toMatchObject({ by: "agent", from: { terminalId: sculptor.id } })
  expect(model.name).toBe("hero.gltf")
  const ask = await sculptor.poll(
    () =>
      run.deck.terminals
        .inboxEntries()
        .find((each) => each.content.kind === "ask" && each.terminalId === sculptor.id),
    "its ask in the Inbox",
    90_000,
  )
  expect(ask.content).toMatchObject({
    kind: "ask",
    ask: {
      subject: "Who is your game's hero?",
      shape: {
        type: "options",
        options: [{ label: "A rocket" }, { label: "A robot" }, { label: "A cat" }],
      },
    },
  })
  // The person answers in the Inbox: their own words, or the option they pick.
  const before = run.model.mark()
  const words = "words" in answer ? answer.words : "A robot"
  run.deck.terminals.answerAsk(
    ask.id,
    "words" in answer
      ? { type: "reply", option: null, text: answer.words }
      : { type: "reply", option: answer.option, text: "" },
  )
  const heard = await run.model.waitFor(
    (call) => !call.side && deliveries(call).some((each) => each.from === "you"),
    { after: before, timeoutMs: 90_000 },
  )
  expect(deliveries(heard).find((each) => each.from === "you")?.text).toContain(words)
  // It tells the lead, sculpts the hero in its worktree, and tells the lead it is done.
  await sculptor.reached(holds(sculptor.handle, lead.handle, "delivered"), { timeoutMs: 90_000 })
  await poll(
    () =>
      messages(lead).some((each) => each.from === sculptor.handle && each.text === "Hero sculpted.")
        ? true
        : undefined,
    "Hero sculpted. to reach the lead",
    90_000,
  )
  expect(
    messages(lead)
      .filter((each) => each.from === sculptor.handle)
      .map((each) => each.text),
  ).toEqual([`The hero is ${words}.`, "Hero sculpted."])
  const sculptedHero = await readFile(join(hero.path, heroFile), "utf8")
  expect(sculptedHero).not.toBe(seed)
  const parsed = JSON.parse(sculptedHero) as { nodes: unknown[]; meshes: unknown[] }
  expect(parsed.nodes.length).toBeGreaterThanOrEqual(6)
  expect(sculptedHero.slice(0, sculptedHero.indexOf('"materials"'))).toBe(
    seed.slice(0, seed.indexOf('"materials"')),
  )
  // The lead opens a worktree on `game` and sets src/config.js there.
  const game = await lead.poll(
    () => run.deck.worktrees.all().find((each) => each.branch === branches.lead),
    "its worktree",
    90_000,
  )
  expect(game.terminalId).toBe(lead.id)
  const config = await poll(
    async () => {
      // The worktree's folder may not be made yet when its row is there.
      const made = await readFile(join(game.path, configFile), "utf8").catch(() => "Untitled Game")
      return made.includes("Untitled Game") ? undefined : made
    },
    `${configFile} set in the lead's worktree`,
    90_000,
  )
  expect(config).toContain(`hero: ${JSON.stringify(words)}`)

  // 4. The fixer: describes itself, fixes the score in a worktree, shows its changes.
  await fixer.poll(
    () => (fixer.summary().title === "Score fixer" ? true : undefined),
    "its title",
    90_000,
  )
  const fix = await fixer.poll(
    () => run.deck.worktrees.all().find((each) => each.branch === branches.fixer),
    "its worktree",
    90_000,
  )
  expect(fix.terminalId).toBe(fixer.id)
  const changes = await fixer.poll(
    () => run.deck.items.bar(fixer.id).find((each) => each.kind === "changes"),
    "its changes shown",
    90_000,
  )
  expect(changes).toMatchObject({ by: "agent", from: { terminalId: fixer.id } })
  await fixer.reached(holds(fixer.handle, lead.handle, "delivered"), { timeoutMs: 90_000 })
  expect(
    messages(lead)
      .filter((each) => each.from === fixer.handle)
      .map((each) => each.text),
  ).toEqual(["Score fixed."])
  expect(await readFile(join(fix.path, scoreFile), "utf8")).toContain(
    "export const add = (score, sinceLast) => score + points(sinceLast)",
  )
  expect(await readFile(join(fix.path, "README.md"), "utf8")).not.toContain("Known bug")

  // 5. The artist: the person opens a terminal in the folder with the same command, and the
  // tour rings it its brief. It is on no team.
  const artist = await run.deck.openBeside(lead, directory, prepared.command)
  await begin(artist, setup, (id) => run.deck.tour.artist(id))
  // Asked again for its artist, the runner rings nothing more and refuses nothing.
  run.deck.tour.artist(artist.id)
  await artist.poll(
    () => (artist.summary().title === "Cover artist" ? true : undefined),
    "its title",
    90_000,
  )
  expect(artist.summary()).toMatchObject({
    titleSource: { kind: "agent", by: artist.handle },
    agent: setup.agent,
  })
  expect(run.deck.store.terminal(artist.id)?.ledBy ?? null).toBeNull()
  inTour(artist, directory)
  // It found the lead among `agents`' answer, and asked it what the game is.
  await poll(() => story.listing(), "what agents answered the artist", 90_000)
  expect(story.listing()).toContain(lead.handle)
  await lead.reached(holds(artist.handle, lead.handle, "delivered"), { timeoutMs: 90_000 })
  // The lead answers it with `send`, by the hero it was told.
  await artist.reached(holds(lead.handle, artist.handle, "delivered"), { timeoutMs: 90_000 })
  const title = /called (.+?)\. Its hero/.exec(
    messages(artist).find((each) => each.from === lead.handle)?.text ?? "",
  )?.[1]
  expect(title).toMatch(/Dash$/)
  expect(messages(artist).find((each) => each.from === lead.handle)?.text).toContain(
    `Its hero is ${words}.`,
  )
  // It draws the cover in a worktree on `cover`, shows it, and tells the lead.
  const art = await artist.poll(
    () => run.deck.worktrees.all().find((each) => each.branch === branches.artist),
    "its worktree",
    90_000,
  )
  expect(art.terminalId).toBe(artist.id)
  const picture = await artist.poll(
    () => run.deck.items.bar(artist.id).find((each) => each.kind === "image"),
    "its cover shown",
    90_000,
  )
  expect(picture).toMatchObject({ by: "agent", from: { terminalId: artist.id } })
  await poll(
    () =>
      messages(lead).some(
        (each) => each.from === artist.handle && each.text.startsWith("The cover is done"),
      )
        ? true
        : undefined,
    "The cover is done to reach the lead",
    90_000,
  )
  // The cover is the answer's: the lead's title, in the file's own comment.
  const svg = await readFile(join(art.path, coverFile), "utf8")
  expect(svg).toContain(`Cover of ${title}`)
  expect(svg).toContain("<svg")
  await through(lead, ["settled"])

  // 6. The end state: four works, each with its files; the tour folder's own checkout as it
  // was; and the open policy, which lets only the lead open agents there.
  const branchesNow = run.deck.worktrees.all().map((each) => each.branch)
  expect(branchesNow.toSorted()).toEqual(Object.values(branches).toSorted())
  expect(git(directory, "status", "--porcelain")).toBe("")
  expect(await readFile(join(directory, heroFile), "utf8")).toBe(seed)
  expect(await readFile(join(directory, scoreFile), "utf8")).toContain(
    "score + points(sinceLast)\n  return score",
  )
  await expect(readdir(join(directory, "art"))).rejects.toThrow()
  const policy = (terminal: DeckTerminal) => run.deck.tour.openPolicy(terminal.id)
  expect(policy(lead).refusal).toBeUndefined()
  expect(policy(lead).flags).toBeDefined()
  for (const other of [sculptor, fixer, artist])
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
  expect(await (await served("/model/hero.gltf")).text()).toBe(sculptedHero)
  expect(await (await served("/src/score.js")).text()).toBe(
    await readFile(join(fix.path, scoreFile), "utf8"),
  )
  expect(await (await served("/src/config.js")).text()).toBe(config)
  expect(await (await served("/art/cover.svg")).text()).toBe(svg)

  // 7. The person keeps the project: the folder is theirs, and the next run uses another.
  const kept = await readdir(directory)
  expect(kept).toContain(tourMarker)
  await run.deck.tour.keep()
  const afterwards = await readdir(directory, { recursive: false })
  expect(afterwards).not.toContain(tourMarker)
  expect(afterwards).not.toContain(".claude")
  expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(projectNote)
  // Git holds the project as the person keeps it: nothing of the tour's rules is changed,
  // skipped or tracked, so a worktree made from here carries none of them.
  expect(git(directory, "status", "--porcelain")).toBe("")
  expect(git(directory, "ls-files", "-v", "AGENTS.md")).toMatch(/^H /)
  expect(git(directory, "ls-files")).not.toContain(".claude/")
  // Asked again, as the client does at the story's end and again on the button: nothing changes.
  await run.deck.tour.keep()
  expect(git(directory, "status", "--porcelain")).toBe("")
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
  expect(await readFile(join(directory, heroFile), "utf8")).toBe(seed)
}
