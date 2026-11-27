import type { Effort } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { tourBriefMark } from "./notices.js"

/**
 * What the tour's agents are told. The tour folder's own instruction files, which every harness
 * loads as it starts there, hold only `sandboxNote`, with the run's agent's rule for the shell
 * (`shellRule`): all the agents start in the same folder, and a cheap model follows a script it
 * loads over the message that is its task. The lead's script (`tourBrief`) is sent to it by the
 * doorbell, as Novadeck's first notice to it (`Tour.brief`); its teammates' tasks are the
 * messages it sends them (`mateTask`, inside the lead's script), with each one's part of the
 * plan written in by the lead.
 *
 * The story they play, in the seed project (`seed.ts`), a start for a browser game with a kit
 * of ready effects, sound and UI (`assets/seed/kit`): the lead pitches the person three games
 * built on sparks drawn for the run (`drawSparks`), so no two runs offer the same ones; asks to
 * run the game's dev server; writes the plan (PLAN.md: the game, and which teammate owns which
 * files and functions); opens three teammates (`parts`); and shows the page. The teammates tell
 * each other what they export and need, each asks the person one question while it works on,
 * shows its first version, plays the game with `look` and polishes it once, and reports to the
 * lead. Each writes in a worktree of its own, and the dev server lays them all over the page;
 * once the person keeps the project, the runner brings the work home (`bringHome`).
 *
 * Tuned on Nova (pi, GPT-6 Luna, medium effort), the tour's only agent.
 */

/** What the tour rings its agent where it has gone quiet at a step (`tour.nudge`). */
export const nudgeLine =
  "Novadeck's tour is waiting on you: look at what you've done so far and carry on from the next step of the tour brief Novadeck sent you. Don't redo a step."

/** The seed's places the agents' tasks name. Changing one is changing the task that names it. */
export const modelsGuide = "models/README.md"
export const kitGuide = "kit/README.md"
export const gameEntry = "src/main.js"
export const planFile = "PLAN.md"

/** A teammate the lead opens: the agent, and the model and effort it runs on. */
export type Teammate = {
  readonly agent: AgentName
  readonly model: string
  readonly effort?: Effort
}

/** How the game's dev server is started here, and where its page is. */
export type Serving = {
  /** The command line, run in the tour's folder: `node dev.mjs 5173`, say. */
  readonly command: string
  /** The page's address: `http://127.0.0.1:5173/`. */
  readonly url: string
}

/** What changes with each run of the tour, and so with the lead's brief. */
export type BriefFacts = {
  readonly mate: Teammate
  /** None where this computer has neither Node nor Python to run the dev server with. */
  readonly serving: Serving | null
}

/** What is known of the lead once its terminal is: its handle, as agents address it (@fox). */
export type LeadFacts = BriefFacts & {
  readonly lead: string
  /** The run's sparks (`drawSparks`); drawn afresh where none are given. */
  readonly sparks?: readonly string[]
}

// The arguments `open_agent` takes for a teammate, as the brief gives them.
const openArguments = ({ agent, model, effort }: Teammate): string =>
  `agent "${agent}", model "${model}"${effort !== undefined ? `, effort "${effort}"` : ""}`

/**
 * What an agent is told of the shell, by its harness. Nova (pi) asks no one before a command, so
 * the tour's agents may check their work with node, which a team needs to find its own mistakes;
 * they install nothing, run no git and start no server of their own. Claude Code and Antigravity
 * read and write files with tools of their own, and a shell command of theirs would stop to ask
 * the person, so they run none. Codex reads files only through its shell, so it is told to use
 * the shell for reading and nothing else (probed 2026-11-22, 0.171.0).
 */
export const shellRule = (agent: AgentName): string =>
  agent === "pi"
    ? "You may run node --check and small node scripts to test your work: never install anything, run git or start a server."
    : agent === "codex"
      ? "Use shell commands only to read files (cat, ls): never to change, build, install or run anything."
      : "Run no shell command."

/**
 * The folder's own instructions, which every harness loads: the sandbox's rules and no role or
 * step, so an agent opened there does the task it was given and nothing else.
 */
export const sandboxNote = (agent: AgentName): string => `# Novadeck tour sandbox

Novadeck made this repo for its tour: a start for a small browser game (README.md), with a kit of
ready effects, sound and UI (${kitGuide}). Work only in this repo and in its worktrees under
~/.novadeck/worktrees: don't read or change anything outside them, don't install anything, never
run git, and never read anything in vendor/ (two large libraries). ${shellRule(agent)} If you were
given a task, do only that task.
`

/**
 * The folder's instructions once the person keeps the project (\`Tour.keep\`): the tour's rules
 * are gone, and what is left says what the project is.
 */
export const projectNote = `# Your game

A small browser game that Novadeck's tour built: see README.md for what is where and how to run
it, and ${planFile} for the game's plan. The game is in src/, built on the kit in kit/ (${kitGuide}
lists its parts: stage, effects, particles, shapes, sound, music, UI, input). Characters can be
glTF models in models/ (${modelsGuide} says how to make one). three.js and Phaser are files in
vendor/, which is large: don't read it.
`

/** What the lead is rung once the tour is over and the project is the person's: the tour's rules no longer hold. */
export const keptLine = `Novadeck's tour is over, and this project is now the person's to build on. The tour brief's rules and steps no longer apply: from now on work as you normally would, on whatever the person asks. Novadeck committed the team's work on main in this folder ("The team's game"), and its worktrees hold nothing more.`

// Sparks: a few words the runner draws at random for each run, which the lead builds its three
// pitches around, so no two runs offer the same games.
const settings = [
  "a sunken city",
  "a moon mine",
  "a haunted carnival",
  "a desert of glass",
  "a cloud kingdom",
  "a neon megacity",
  "a frozen lighthouse",
  "a living forest",
  "a junkyard planet",
  "a volcano lab",
  "an underground mushroom realm",
  "a toy box",
  "a dream",
  "a pirate archipelago",
  "an orbital station",
  "a candy factory gone wrong",
  "a museum at night",
  "a storm at sea",
  "inside a computer",
  "a giant's garden",
]
const mechanics = [
  "gravity flips",
  "time only moves when you move",
  "you grow with every pickup",
  "light is your health",
  "everything you shoot bounces",
  "you steer a swarm, not a hero",
  "the floor falls away behind you",
  "enemies copy your last move",
  "rhythm: act on the beat",
  "build towers that fight for you",
  "grapple and swing",
  "push and pull with a magnet",
  "you can rewind three seconds",
  "stealth: stay out of the light",
  "chain reactions",
  "draw your own path",
  "one-button control",
  "drift and boost",
  "possess your enemies",
  "the map rotates",
]
const moods = [
  "cosy",
  "frantic",
  "eerie",
  "silly",
  "epic",
  "dreamy",
  "tense",
  "triumphant",
  "chaotic",
  "calm",
]


// `count` different items of `list`, in a random order.
const drawMany = <T>(list: readonly T[], count: number, random: () => number): T[] => {
  const left = [...list]
  return Array.from(
    { length: count },
    () => left.splice(Math.floor(random() * left.length), 1)[0] as T,
  )
}

/** Three sparks for a run: a setting, a mechanic and a mood each, none of them twice. */
export const drawSparks = (random: () => number = Math.random): readonly string[] => {
  const [where, how, feel] = [settings, mechanics, moods].map((list) => drawMany(list, 3, random))
  return [0, 1, 2].map((at) => `${where?.[at]}; ${how?.[at]}; ${feel?.[at]}`)
}

/** The game's parts as the lead's plan starts them, which a teammate's role and branch name. */
export const parts = [
  {
    role: "Core",
    branch: "core",
    owns: "src/main.js",
    does: "the rules, the player, enemies and items, input and the game loop",
  },
  {
    role: "World",
    branch: "world",
    owns: "src/world.js and models/",
    does: "the scene and its look (stage, sky, ground, effects) and the player as a glTF model in models/, shown first",
  },
  {
    role: "Feel",
    branch: "feel",
    owns: "src/feel.js",
    does: "title, HUD and end screens, sound and music, and the juice (shake, flashes, numbers)",
  },
] as const

/**
 * What the lead sends each teammate: its part of the plan. The lead fills in [[role]],
 * [[branch]] and [[part]] (two lines from PLAN.md).
 */
export const mateTask = (
  lead: string,
  url: string | undefined,
): string => `You are [[role]], one of three teammates building a browser game for the person, in
Novadeck's tour. ${lead} leads you. Your part: [[part]]
If Novadeck's tools (\`describe\`, \`open_worktree\`, \`show\`, \`look\`, \`ask\`, \`send\`) are deferred, load them all first.
1. Call \`describe\` with title "[[role]]" and a one-line summary of your part.
2. Read ${planFile} in the folder you started in. Call \`open_worktree\` with branch "[[branch]]" and
   title "[[role]]", then work only in its folder, by absolute path, on the files PLAN.md gives you.
3. Read README.md and ${kitGuide} there. The kit is ready-made: stage with bloom, sky, ground,
   particles, juice, shapes, shaders, sound, music, UI, input. Build on it; never rewrite it.
4. \`send\` each teammate your part touches one line: what you export to it or need from it, by
   name. Answer their lines the same way, and keep to what you agree.
5. Get a rough version of your part working fast, by 5 minutes from now. Check each file with
   \`node --check\`. Install nothing, run no git, start no server.${
     url
       ? ` After a change you can see,
   \`look\` with page {"url": "${url}"} and fix what it shows wrong in your files. If it says the
   page drew no frame in time, that's slow drawing here, not your bug: \`node --check\` and go on.`
       : ""
   }
6. \`ask\` the person one question about your part, a real choice, with a short subject, a one-line
   body and shape {"type":"options","options":[{"label":"..."},{"label":"..."}]}. Don't wait:
   go on working, and make their choice when the answer comes as a message.
7. When your first version works, call \`show\` (\`changes\` with your worktree's folder, or \`file\`
   with a model you made) and \`send\` ${lead} "[[role]]: first version in".
8. Play it${url ? " with `look`" : ""}, then make the one change that makes it best: the game beatable in about two
   minutes but not trivial, the effects, the sound. Then \`send\` ${lead} "[[role]]: polished",
   say one short sentence, and end your turn. After that, answer only what messages ask.`

/** The lead's script for a run. */
export const tourBrief = ({
  mate,
  serving,
  lead,
  sparks = drawSparks(),
}: LeadFacts): string => `${tourBriefMark} The person just started the tour to see how Novadeck
works with agents. Your task: lead a team of three agents that builds a small browser game the
person picks, in a sandbox repo Novadeck made for the tour (README.md; kit/README.md is a kit of
ready effects, sound and UI). The game should be playable about 7 minutes from now.

## Rules

- You may read files and run \`node --check\`. Install nothing, run no git, never read vendor/,
  start no server but the one step 3 says.
- Be quick: the person is watching. Say only the sentences the steps ask for.
- Novadeck's tools (\`describe\`, \`ask\`, \`open_agent\`, \`open_terminal\`, \`show\`, \`look\`, \`send\`)
  need no permission of yours; if they're deferred, load them all in one go before step 1.
- Write no game code: your teammates do. Never answer their questions to the person.
  Never use the person's name: say "you". Never poll or wait in a loop: messages wake you.

## Steps

1. Call \`describe\` with the title "Game lead" and the summary "Leads the team building your game".
2. Invent three different small games, a title and one line each, one on each of these sparks
   (stretch them; make each surprising and fun in two minutes of play):
${sparks.map((spark) => `   - ${spark}`).join("\n")}
   Call \`ask\` with subject "Which game shall we build?", body "Pick one, or write your own: a
   team of agents builds it." and shape {"type":"options","options":[...]} with the three, each
   {"label": "<title>", "summary": "<its line>"}. Then say in one sentence that you're their own
   agent and your team builds what they pick, and end your turn.
3. The answer comes as a message: a pick or their own words (dismissed: take the first).${
  serving
    ? `
   Call \`open_terminal\` with \`command\` "${serving.command}" and \`title\` "Game server", and go on
   in the same turn:`
    : ""
}
4. Write ${planFile} in your folder, under 50 lines: the game in three lines; controls; how to win
   or lose, beatable in about two minutes; the kit look and camera; sounds and music. Then the
   three parts, each with its owner, branch, files and the functions it exports and calls, so
   they fit. Parts:
${parts.map((part) => `   - ${part.role} (branch "${part.branch}", ${part.owns}): ${part.does}.`).join("\n")}
5. Call \`open_agent\` three times, with ${openArguments(mate)}, one per part, and as
   \`message\` this text with [[role]], [[branch]] and [[part]] (two lines from PLAN.md) filled in:

${indent(mateTask(lead, serving?.url))}
${
  serving
    ? `
6. When Novadeck says the server started, call \`show\` with \`page\` {"url": "${serving.url}"} and \`open\` true.`
    : ""
}
7. Say in one sentence that the team is at work, and end your turn.

## Messages

After that, whenever a message arrives, do what fits it, then end your turn:

- A teammate asks you something: answer it with \`send\` in one sentence.
- A teammate's first version is in:${
  serving
    ? ` \`look\` at the page, and if something's broken, \`send\` its
  owner one line on what.`
    : " one short sentence at most."
}
- Once all three have said "polished", say in one sentence that the game is ready to play.
`

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")

/**
 * The files the tour writes beside the seed project, by name: the sandbox's rules, which every
 * harness loads and which hold no role and no step, and a Claude Code project file. The folder
 * is made a git repo around them and the seed (`commitSandbox`).
 */
export const briefFiles = (agent: AgentName): Readonly<Record<string, string>> => ({
  "AGENTS.md": sandboxNote(agent),
  "CLAUDE.md": "@AGENTS.md\n",
  // Claude Code's project settings for this folder: its teammates, which are given no launch
  // flags by anything but the tour, take edits unasked too, and a plan mode the person's own
  // settings start them in doesn't hold them (project settings outrank the user's). Only the
  // tour folder's own file, removed once the person keeps the project.
  ".claude/settings.json": '{"permissions":{"defaultMode":"acceptEdits"}}\n',
})
