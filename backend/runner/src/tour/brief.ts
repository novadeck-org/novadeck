import type { Effort } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { tourBriefMark } from "../messaging/messages.js"

/**
 * What the tour's agents are told. The tour folder's own instruction files, which every harness
 * loads as it starts there, hold only `sandboxNote`, with the run's agent's rule for the shell
 * (`shellRule`): all the agents start in the same folder,
 * and a cheap model follows a script it loads over the message that is its task. The lead's
 * script (`tourBrief`) is sent to it by the doorbell, as Novadeck's first notice to it, for
 * every harness (`Tour.brief`); its two teammates' tasks are the messages it sends them
 * (`modellerTask`, `builderTask`, inside the lead's script), with the person's picks and the
 * models' names written in by the lead.
 *
 * The story they play, in the seed project (`seed.ts`), a blank start for a browser game: the
 * lead asks the person which game to make (a world and a kind), then opens a modeller and a
 * builder and asks to run the game's dev server, whose page it shows. The modeller makes the
 * game's three models (glTF, in `models/`) and shows them; the builder writes the game in `src/`
 * to load them by name and shows its changes. Each puts one question of its own to the person.
 * Each writes in a worktree of its own, and the dev server lays them all over the page; once
 * the person keeps the project, the runner brings the work home (`bringHome`).
 *
 * Tuned on Codex (Luna, low effort) alone, on the owner's word: the other harnesses run the same
 * texts untuned.
 */

/** What the tour rings its agent where it has gone quiet at a step (`tour.nudge`). */
export const nudgeLine =
  "Novadeck's tour is waiting on you: look at what you've done so far and carry on from the next step of the tour brief Novadeck sent you. Don't redo a step."

/** The seed's places the agents' tasks name. Changing one is changing the task that names it. */
export const modelsGuide = "models/README.md"
export const gameEntry = "src/main.js"

/** The branches the teammates' worktrees are on. */
export const branches = { modeller: "models", builder: "game" } as const

/** What the lead's sheet offers, and what it takes where the person dismissed it. */
export const worlds = ["Fantasy", "Sci-fi", "Modern"] as const
export const kinds = ["RPG", "Shooter", "Strategy"] as const
export const defaultPicks = { world: "Fantasy", kind: "RPG" } as const

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
export type LeadFacts = BriefFacts & { readonly lead: string }

// The arguments `open_agent` takes for a teammate, as the brief gives them.
const openArguments = ({ agent, model, effort }: Teammate): string =>
  `agent "${agent}", model "${model}"${effort !== undefined ? `, effort "${effort}"` : ""}`

/**
 * What an agent is told of the shell, by its harness. Claude Code and Antigravity read and write
 * files with tools of their own, and a shell command of theirs would stop to ask the person, so
 * they run none. Codex reads files only through its shell (a read needs no approval in its
 * sandbox), so it is told to use the shell for reading and nothing else: told to run no
 * command at all, it can't read the file it is to change (probed 2026-11-22, 0.171.0: the
 * sculptor showed the guide instead of reading it, and the lead asked the person for the
 * config's text).
 */
export const shellRule = (agent: AgentName): string =>
  agent === "codex"
    ? "Use shell commands only to read files (cat, ls): never to change, build, install or run anything."
    : "Run no shell command."

// What every agent's task says of how to work.
const manners = (agent: AgentName): string =>
  `${shellRule(agent)} Never call \`open_agent\` or run git, never read vendor/, never use the person's name. Do each step at once, with no prose before a tool call.`

// What a teammate's task says of its team, the picks and the models, which the lead fills in:
// each [[name]] is a value the lead writes in before it sends the task.
const picks = (lead: string): string => `${lead} leads you. This repo is a blank browser game
(README.md). The person picked a [[world]] [[kind]] game. Its characters, enemies and units are
glTF models in models/: [[one]].gltf (the player), [[two]].gltf (an enemy) and [[three]].gltf.`

// The tools a teammate is told to load.
const tools = `If Novadeck's tools (\`describe\`, \`open_worktree\`, \`show\`, \`ask\`, \`send\`) are
deferred, load them first.`

// A teammate's one question to the person, then the wait for the answer.
const question = (
  about: string,
): string => `Call \`ask\` once: one short question about ${about}, yours to
   choose, as subject, a one-line body, shape {"type":"options","options":[{"label":"..."},
   {"label":"..."}]} with two or three answers. End your turn with one
   sentence: the answer comes as a message.`

// What a teammate does with the person's answer.
const answer = "The answer is their pick or their own words; dismissed, you decide."

/**
 * The modeller's task, the message its lead sends it: the game's three models, in a worktree of
 * its own, the first shown as soon as it exists, with one question to the person about them.
 * `lead` is the lead's handle, the one address `send` takes (never a terminal id).
 */
export const modellerTask = (
  lead: string,
  agent: AgentName,
): string => `You are Modeller, a teammate in Novadeck's tour. ${picks(lead)} You make them;
Builder writes the game. ${tools} ${manners(agent)}
1. Call \`describe\` with title "Modeller" and summary "Makes the game's 3D models".
2. Call \`open_worktree\` with branch "${branches.modeller}". Its result names the worktree's folder.
   Work only there, by absolute path, never in your own folder.
3. Read ${modelsGuide} there: it says how to make a model.
4. Make models/[[one]].gltf there as it says. Then call
   \`show\` with \`file\` {"path": "<that file's absolute path>"} and \`open\` true.
5. ${question("the look of the game's characters")}
6. ${answer} Make models/[[two]].gltf and
   models/[[three]].gltf, following it, and \`show\` each as in step 4.
7. Call \`send\` with \`to\` "${lead}" (its handle, never an id) and \`text\` "Models done."
8. Say in one short sentence at most that it is done, and stop.`

/**
 * The builder's task, the message its lead sends it: the game, in `src/` of a worktree of its
 * own, loading the modeller's models by name, its changes shown, then one question to the
 * person and that change made.
 */
export const builderTask = (
  lead: string,
  agent: AgentName,
): string => `You are Builder, a teammate in Novadeck's tour. ${picks(lead)} Modeller
makes them; until one exists, the placeholder shows in its place. ${tools} ${manners(agent)}
1. Call \`describe\` with title "Builder" and summary "Writes the game".
2. Call \`open_worktree\` with branch "${branches.builder}". Its result names the worktree's folder.
   Work only there, by absolute path, never in your own folder.
3. Read README.md, ${gameEntry} and src/models.js there.
4. Write the game in src/ there, from ${gameEntry}, in one go: small and playable, its goal
   and controls on screen, a way to win or lose. Load the three models with src/models.js
   (\`loadModel("[[one]]")\` in 3D, \`modelPicture("[[one]]")\` in 2D). Under 400 lines.
   Change nothing in models/, index.html or vendor/.
5. Call \`show\` with \`changes\` {"path": "<your worktree's folder>"} and \`open\` true.
6. ${question("what the game should get next")}
7. ${answer} Make that change in src/ there, and \`show\` the changes again.
8. Call \`send\` with \`to\` "${lead}" (its handle, never an id) and \`text\` "Game done."
9. Say in one short sentence at most that it is done, and stop.`

/**
 * The folder's own instructions, which every harness loads: the sandbox's rules and no role or
 * step, so an agent opened there does the task it was given and nothing else.
 */
export const sandboxNote = (agent: AgentName): string => `# Novadeck tour sandbox

Novadeck made this repo for its tour: a blank start for a small browser game (README.md). Work
only in this repo and in its worktrees under ~/.novadeck/worktrees: don't read or change
anything outside them, don't install anything, never run git, and never read anything in
vendor/ (two large libraries). ${shellRule(agent)} If you were given a task, do only that task.
`

/**
 * The folder's instructions once the person keeps the project (\`Tour.keep\`): the tour's rules
 * are gone, and what is left says what the project is.
 */
export const projectNote = `# Your game

A small browser game that Novadeck's tour built: see README.md for what is where and how to run
it. Every character, enemy and unit is a glTF model in models/ (${modelsGuide} says how to make
one), and the game is in src/. three.js and Phaser are files in vendor/, which is large: don't
read it.
`

/** What the lead is rung once the tour is over and the project is the person's: the tour's rules no longer hold. */
export const keptLine = `Novadeck's tour is over, and this project is now the person's to build on. The tour brief's rules and steps no longer apply: from now on work as you normally would, on whatever the person asks. Novadeck committed the team's work on main in this folder ("The team's game"), and its worktrees hold nothing more.`

// The lead's steps for the dev server, where this computer can run one.
const servingSteps = ({ command, url }: Serving): string => `
6. Call \`open_terminal\` with \`command\` "${command}" and \`title\` "Game server". Then say
   in one sentence that the team is at work and the game starts once the person approves it,
   and end your turn.
7. When Novadeck tells you the person approved it, call \`show\` with \`page\`
   {"url": "${url}"} and \`open\` true, and end your turn. If they declined, carry on without it.`

const noServingSteps = `
6. Say in one sentence that the team is at work, and end your turn.`

// The call the lead's second turn runs to: said by name, as the tasks it quotes number their own steps.
const secondTurnEnds = (serving: Serving | null): string =>
  serving ? "`open_terminal`" : "the second `open_agent`"

// The lead's sheet: the world and the kind, as `ask`'s questions shape.
const sheet = JSON.stringify({
  type: "questions",
  questions: [
    {
      header: "The world",
      question: "Where is your game set?",
      options: worlds.map((label) => ({ label })),
    },
    {
      header: "The kind",
      question: "What kind of game is it?",
      options: kinds.map((label) => ({ label })),
    },
  ],
})

/** The lead's script for a run, with its teammates' model. */
export const tourBrief = ({
  mate,
  serving,
  lead,
}: LeadFacts): string => `${tourBriefMark} The person just started the tour to see how Novadeck
works with agents. Your task now: lead a small team that builds the browser game the person
chooses, in a sandbox repo Novadeck made for the tour: a blank start (README.md).

## Rules

- ${shellRule(mate.agent)} Install nothing, run no git, never read vendor/.
- Be quick: the person is watching. Say only the sentences the steps ask for.
- Novadeck's tools (\`describe\`, \`ask\`, \`open_agent\`, \`open_terminal\`, \`show\`, \`send\`)
  need no permission of yours; if they're deferred, load all six in one go before step 1.
- Write no code and make no model: your teammates do. Never answer their questions to the
  person. Call \`show\` only where a step says to. Never use the person's name: say "you".
- Do the steps in order, none skipped or added. Never poll or wait in a loop: messages wake you.

## Steps

1. Call \`describe\` with the title "Game lead" and the summary "Leads the team building your game".
2. Call \`ask\` with subject "Which game shall we build?", body "Pick a world and a kind, or
   write your own: a small team of agents builds it." and shape
   ${sheet}
   Then say in one sentence that you're their own agent and your team builds what they pick,
   and end your turn.
3. The answer arrives as a message: the world and the kind picked, or the person's own words.
   If they dismissed it, take ${defaultPicks.world} and ${defaultPicks.kind}. A message with no words isn't the answer.
   Pick three lowercase one-word names for the game's models, fitting the picks: the player,
   an enemy, and one thing more (a unit, a building or an item), as knight, goblin, chest.
   From here your turn runs to ${secondTurnEnds(serving)}: no sentence, no end of turn before it.
4. Call \`open_agent\` with ${openArguments(mate)}, and as \`message\` this text, each [[name]]
   replaced: [[world]] and [[kind]] by the picks, [[one]], [[two]], [[three]] by the names:

${indent(modellerTask(lead, mate.agent))}

5. Call \`open_agent\` again with ${openArguments(mate)}, and as \`message\` this text, replaced
   the same way:

${indent(builderTask(lead, mate.agent))}
${serving ? servingSteps(serving) : noServingSteps}

## Messages

After that, whenever a message arrives, do what fits it, then end your turn:

- A teammate asks you something: answer it with \`send\` to its handle, in one sentence.
- A teammate is done: one short sentence at most; once both are, say the game is ready to play.
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
