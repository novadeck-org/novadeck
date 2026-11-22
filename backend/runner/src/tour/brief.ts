import type { Effort } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { tourArtistMark, tourBriefMark } from "../messaging/messages.js"

/**
 * What the tour's agents are told. The tour folder's own instruction files, which every harness
 * loads as it starts there, hold only `sandboxNote`, with the run's agent's rule for the shell
 * (`shellRule`): all the agents start in the same folder,
 * and a cheap model follows a script it loads over the message that is its task. The lead's
 * script (`tourBrief`) is sent to it by the doorbell, as Novadeck's first notice to it, for
 * every harness (`Tour.brief`); its two teammates' tasks are the messages it sends them
 * (`sculptorTask`, `fixerTask`, inside the lead's script); the artist, an agent on no team
 * that the tour starts beside them, is rung `artistBrief` by the runner (`Tour.artist`).
 *
 * The story they play, in the seed project (`seed.ts`): a small browser game whose hero is a 3D
 * model. The lead opens a sculptor and a score fixer, and asks to run the game's dev server,
 * whose page it shows. The sculptor shows the model, asks the person who the hero is, tells the
 * lead, and sculpts it; the lead names the game after it. The fixer fixes the score and shows
 * its changes. The artist finds the lead by itself, asks what the game is, and draws its cover.
 * Each writes in a worktree of its own, and the dev server lays them all over the page.
 */

/** What the tour rings its agent where it has gone quiet at a step (`tour.nudge`). */
export const nudgeLine =
  "Novadeck's tour is waiting on you: look at what you've done so far and carry on from the next step of the tour brief Novadeck sent you. Don't redo a step."

/** The seed's files the agents' tasks name. Changing one is changing the task that names it. */
export const heroFile = "model/hero.gltf"
export const heroGuide = "model/README.md"
export const scoreFile = "src/score.js"
export const configFile = "src/config.js"
export const coverFile = "art/cover.svg"

/** The branches the agents' worktrees are on, by who opens each. */
export const branches = {
  lead: "game",
  sculptor: "hero",
  fixer: "fix-score",
  artist: "cover",
} as const

/** The hero where the person dismissed the sculptor's question. */
export const defaultHero = "a rocket"

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
  `${shellRule(agent)} Never call \`open_agent\`, and never read anything in vendor/. Never use the person's name. Be quick: do each step at once, with no prose before a tool call.`

/**
 * The sculptor's task, the message its lead sends it: it shows the hero's model, asks the
 * person who the hero is, tells the lead, and sculpts it in a worktree of its own. `lead` is
 * the lead's handle, the one address `send` takes (never a terminal id).
 */
export const sculptorTask = (
  lead: string,
  agent: AgentName,
): string => `You are Sculptor, a teammate in Novadeck's tour. ${lead} leads you. This repo is a small
browser game whose hero is a 3D model, ${heroFile}: for now a ball and a box. Your tools
include Novadeck's \`describe\`, \`open_worktree\`, \`show\`, \`ask\` and \`send\`: if they're
deferred, load them first. ${manners(agent)}
1. Call \`describe\` with title "Sculptor" and summary "Sculpts the game's hero".
2. Call \`open_worktree\` with branch "${branches.sculptor}". Its result names the worktree's folder. Work
   only there, by absolute path, never in the copy in your own folder.
3. Call \`show\` with \`file\` {"path": "<that folder>/${heroFile}"} and \`open\` true.
4. Call \`ask\` with subject "Who is your game's hero?", body "I'll sculpt it in 3D out of simple
   shapes. Pick one, or type anything you like." and shape
   {"type":"options","options":[{"label":"A rocket"},{"label":"A robot"},{"label":"A cat"}],"recommend":null}.
5. End your turn with one short sentence. Don't wait in a loop: the answer arrives by itself as
   a message.
6. When the answer arrives, it names the option the person picked, or holds their own words:
   that is the hero. If you are told the person dismissed the question, the hero is
   ${defaultHero}. A message with no words in it isn't their answer: wait for the one that is.
   Call \`send\` with \`to\` "${lead}" (its handle, never an id) and \`text\` "The hero is <the hero>."
7. Read ${heroGuide} in your worktree, then sculpt the hero as it says, in ${heroFile} in
   your worktree.
8. Call \`send\` with \`to\` "${lead}" and \`text\` "Hero sculpted."
9. Say in one short sentence at most that it is done, and stop.
Only the person's answer moves you on to step 6.`

/** The fixer's task, the message its lead sends it: the score bug, in a worktree of its own. */
export const fixerTask = (
  lead: string,
  agent: AgentName,
): string => `You are Score fixer, a teammate in Novadeck's tour. ${lead} leads you. This repo is a small
browser game with one bug: its score never goes up (README.md, "Known bug"). Your tools include
Novadeck's \`describe\`, \`open_worktree\`, \`show\` and \`send\`: if they're deferred, load them
first. ${manners(agent)}
1. Call \`describe\` with title "Score fixer" and summary "Fixes the game's score".
2. Call \`open_worktree\` with branch "${branches.fixer}". Its result names the worktree's folder.
   Work only there, by absolute path, never in the copy in your own folder.
3. In ${scoreFile} in your worktree, make \`add\` return the new score:
   \`export const add = (score, sinceLast) => score + points(sinceLast)\`. Change nothing else.
4. In README.md in your worktree, remove the "Known bug" section, its heading and all.
5. Call \`show\` with \`changes\` {"path": "<your worktree's folder>"} and \`open\` true.
6. Call \`send\` with \`to\` "${lead}" (its handle, never an id) and \`text\` "Score fixed."
7. Say in one short sentence at most that it is done, and stop.`

/**
 * The artist's brief, rung to an agent the tour starts on no team: its task is the game's
 * cover, and it knows neither the game nor who leads it, so it finds the lead among the
 * project's agents and asks. Nothing in it names the lead: `agents` does.
 */
export const artistBrief = (agent: AgentName): string =>
  `${tourArtistMark} The person started you in Novadeck's tour, on your own: you are on no team. This
repo is a small browser game that other agents are building right now. Your task is its cover,
the picture behind its start screen. You don't know yet what the game is about: whoever leads
its team does. Your tools include Novadeck's \`describe\`, \`agents\`, \`send\`, \`open_worktree\`
and \`show\`: if they're deferred, load them first. ${manners(agent)}
1. Call \`describe\` with title "Cover artist" and summary "Draws the game's cover".
2. Call \`agents\`. Find the terminal that leads the game's team, and call \`send\` with \`to\` its
   handle (never an id) and \`text\` "I'm drawing the cover for your game. What is it called, and
   who is its hero?" Then end your turn with one short sentence. Don't wait in a loop: the answer
   arrives by itself as a message.
3. When the lead answers, call \`open_worktree\` with branch "${branches.artist}". Its result names the
   worktree's folder. Work only there, by absolute path.
4. Write ${coverFile} in your worktree: the backdrop for that game, with no text and no
   hero in it (the game draws its hero and its name over it). An SVG with viewBox "0 0 960 540":
   the neon city at night where that hero lives. A dark gradient for the sky that fills it,
   then ten to twenty simple shapes (rects for towers, small bright rects, circles and lines for
   windows, signs and rain) in two or three neon colours, most of them near the edges, the
   middle left calm. Under 1500 characters.
5. Call \`show\` with \`file\` {"path": "<that file's absolute path>"} and \`open\` true.
6. Call \`send\` with \`to\` the lead's handle and \`text\` "The cover is done: ${coverFile} in my worktree."
7. Say in one short sentence at most that it is done, and stop.
Only the lead's answer moves you on to step 3.`

/**
 * The folder's own instructions, which every harness loads: the sandbox's rules and no role or
 * step, so an agent opened there does the task it was given and nothing else.
 */
export const sandboxNote = (agent: AgentName): string => `# Novadeck tour sandbox

Novadeck made this repo for its tour: a small browser game (README.md). Work only in this repo
and in its worktrees under ~/.novadeck/worktrees: don't read or change anything outside them,
don't install anything, and never read anything in vendor/ (two large libraries).
${shellRule(agent)} If you were given a task, do only that task.
`

/**
 * The folder's instructions once the person keeps the project (\`Tour.keep\`): the tour's rules
 * are gone, and what is left says what the project is.
 */
export const projectNote = `# Your game

A small browser game, set in a neon city at night, that Novadeck's tour started: see README.md
for what is where and how to run it. Phaser runs the game and three.js draws its hero, a 3D
model (model/README.md says how to reshape it). Both libraries are files in vendor/, which is
large: don't read it.

The tour's agents each worked in a git worktree of their own, on the branches ${Object.values(branches).join(", ")}:
none of that is merged into main yet. The dev server (dev.mjs, dev.py) lays every worktree's
changed files over this folder, so the page shows all of it. Merge the branches when the person
asks for it.
`

/** What the lead is rung once the tour is over and the project is the person's: the tour's rules no longer hold. */
export const keptLine = `Novadeck's tour is over, and this project is now the person's to build on. The tour brief's rules and steps no longer apply: from now on work as you normally would, on whatever the person asks. The tour's work is on the branches ${Object.values(branches).join(", ")}, each in its own worktree and none merged into main yet; the dev server shows them all laid over the folder.`

// The lead's steps for the dev server, where this computer can run one.
const servingSteps = ({ command, url }: Serving): string => `
4. Call \`open_terminal\` with \`command\` "${command}" and \`title\` "Game server". The person
   is asked to approve it. Only now greet the person, in two short sentences: you are their
   own agent and your team is at work making this game theirs; the game starts once they
   approve the command. Then end your turn.
5. When Novadeck tells you the person approved it, call \`show\` with \`page\`
   {"url": "${url}"} and \`open\` true, and end your turn. If they declined, carry on without it.`

const noServingSteps = `
4. Only now greet the person, in one sentence: you are their own agent, and your team is at
   work making this game theirs. Then end your turn.`

// The call the lead's first turn runs to: said by name, as the tasks it quotes number their own steps.
const firstTurnEnds = (serving: Serving | null): string =>
  serving ? "`open_terminal`" : "the second `open_agent`"

/** The lead's script for a run, with its teammates' model. */
export const tourBrief = ({
  mate,
  serving,
  lead,
}: LeadFacts): string => `${tourBriefMark} The person just started the tour to see how Novadeck
works with agents. This is your task now: you lead the agents in a sandbox repo Novadeck made
for the tour. It holds a small browser game (README.md), set in a neon city at night, whose
hero is a 3D model, for now a ball and a box. Your team makes the game the person's own.

## Rules

- ${shellRule(mate.agent)} Install nothing, and never read anything in vendor/.
- Be quick: the person is watching. Say nothing beyond the sentences the steps ask for; don't
  explain, plan or confirm in prose.
- Novadeck's tools (\`describe\`, \`open_agent\`, \`open_terminal\`, \`open_worktree\`, \`show\`,
  \`send\`) need no permission of yours to call; if they're deferred, load all six in one go
  before step 1.
- Never answer a teammate's question to the person yourself: the person chooses.
- Never use the person's name, even if you know it: say "you".
- Do the steps in order. Don't skip one and don't add one. Your first turn runs from
  \`describe\` to ${firstTurnEnds(serving)}: write no sentence and don't end your turn
  before you have called it, as a teammate you opened needs nothing more from you. Never poll
  or wait in a loop: messages arrive by themselves, and each wakes you.

## Steps

1. Call \`describe\` with the title "Game lead" and the summary "Leads the team building the game".
2. Call \`open_agent\` with ${openArguments(mate)}, and as \`message\` exactly this text:

${indent(sculptorTask(lead, mate.agent))}

3. Call \`open_agent\` again with ${openArguments(mate)}, and as \`message\` exactly this text:

${indent(fixerTask(lead, mate.agent))}
${serving ? servingSteps(serving) : noServingSteps}

## Messages

After that, whenever a message arrives, do what fits it, then end your turn:

- Your sculptor tells you who the hero is: call \`open_worktree\` with branch "${branches.lead}", then
  in ${configFile} in that worktree, by its absolute path (never the copy in your own
  folder), set \`title\` (a short name for a game with that hero in a neon city at night, two
  or three words), \`hero\` (who it is), \`pickup\` (one emoji that hero would grab in that
  city), \`background\` (the night sky: one very dark colour) and \`accent\` (the city's neon:
  one bright, saturated colour that fits the hero), both as #rrggbb. Change nothing else.
- An agent that isn't your teammate asks about the game: answer it with \`send\` to its handle:
  the game's title, who its hero is, that it is set in a neon city at night, and that its
  picture belongs in ${coverFile}. If your
  sculptor hasn't told you the hero yet, answer once it has.
- Anything else, as a teammate's word that it is done: say one short sentence at most.
`

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `   > ${line}`)
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
