import type { Effort } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { tourBriefMark, tourFixerMark } from "../messaging/messages.js"

/**
 * What the tour's agents are told. The tour folder's own instruction files, which every harness
 * loads as it starts there, hold only `sandboxNote`: all the agents start in the same folder,
 * and a cheap model follows a script it loads over the message that is its task. The lead's
 * script (`tourBrief`) is sent to it by the doorbell, as Novadeck's first notice to it, for
 * every harness (`Tour.brief`); the first fixer's task is the message its lead sends
 * (`firstFixerTask`, inside the lead's script); the second fixer, the person's own agent, is
 * rung `secondFixerBrief` by the runner once the person opens its terminal (`Tour.fixer`).
 */

/** What the tour rings its agent where it has gone quiet at a step (`tour.nudge`). */
export const nudgeLine =
  "Novadeck's tour is waiting on you: look at what you've done so far and carry on from the next step of the tour brief Novadeck sent you. Don't redo a step."

/**
 * The sandbox repo's file, with both bugs in it so the merged preview shows both fixes, and the
 * README that names them. Changing a bug is changing these and the fixers' tasks below.
 */
export const sandboxFile = "split.js"

const splitSource = `// Splits a restaurant bill: its total, how many people share it, and the tip in percent
// (15 means 15%).
export const share = (total, people, tip) => (total + total * tip) / people

// An amount as the receipt shows it, such as $12.50.
export const money = (amount) => "$" + amount.toFixed(1)
`

const readme = `# Split

A tiny bill splitter.

## Bugs

1. \`share()\` reads the tip as a fraction: a 15% tip adds 1500%.
2. \`money()\` shows one decimal: \`$12.5\` instead of \`$12.50\`.
`

/** A teammate the lead opens: the agent, and the model and effort it runs on. */
export type Teammate = {
  readonly agent: AgentName
  readonly model: string
  readonly effort?: Effort
}

/** What changes with each run of the tour, and so with the lead's brief. */
export type BriefFacts = {
  readonly fixer: Teammate
}

// The arguments `open_agent` takes for a teammate, as the brief gives them.
const openArguments = ({ agent, model, effort }: Teammate): string =>
  `agent "${agent}", model "${model}"${effort !== undefined ? `, effort "${effort}"` : ""}`

/** The first fixer's task, the message its lead sends it: bug 1, in a worktree of its own. */
export const firstFixerTask = `You are Tip fixer, a teammate in Novadeck's tour. Your lead is the agent that sent you this
message (its \`from\`). Your tools include Novadeck's \`describe\`, \`open_worktree\` and \`send\`:
if they're deferred, load them first. Run no shell command and never call \`open_agent\`. Be
quick: do each step at once, with no prose before a tool call.
1. Call \`describe\` with title "Tip fixer" and summary "Fixes bug 1".
2. Call \`open_worktree\` with branch "fix-tip". Its result names the worktree's folder.
3. In ${sandboxFile} in that worktree, by its absolute path (never the copy in your own folder),
   change \`share\` so it divides the tip by 100: (total + total * tip / 100) / people. Change
   nothing else.
4. Call \`send\` with \`to\` your lead's handle and \`text\` "Fixed bug 1."
5. Say in one short sentence at most that you sent it, and stop.`

/**
 * The second fixer's brief, rung to the person's own agent in the terminal they opened: bug 2
 * in a worktree of its own, with the one question the person answers. `lead` is the handle of
 * the terminal that leads it.
 */
export const secondFixerBrief = (lead: string): string =>
  `${tourFixerMark} You are Money fixer, a teammate in Novadeck's tour: the person opened this terminal
for you, in a sandbox repo with two bugs, and ${lead} leads you. Your tools include Novadeck's
\`describe\`, \`open_worktree\`, \`ask\` and \`send\`: if they're deferred, load them first. Run no
shell command and never call \`open_agent\`. Never use the person's name. Be quick: do each step
at once, with no prose before a tool call.
1. Call \`describe\` with title "Money fixer" and summary "Fixes bug 2".
2. Call \`open_worktree\` with branch "fix-money". Its result names the worktree's folder.
3. Call \`ask\` with subject "Whole amounts: $12.00 or $12?", body "Fixing money(): how should a
   whole amount, such as 12, show on the receipt?" and shape
   {"type":"options","options":[{"label":"$12.00","summary":"Always two decimals"},{"label":"$12","summary":"Drop .00 for whole amounts"}],"recommend":0}.
4. End your turn with one short sentence. Do not wait in a loop: the person's answer arrives by
   itself as a message.
5. When the answer arrives, it names the option the person picked, or holds their own words:
   follow it. If you are told the person dismissed the question, use "$12.00". A message with no
   words in it isn't their answer: wait for the one that is. Then, in ${sandboxFile} in your
   worktree, by its absolute path (never the copy in your own folder), change \`money\` to show
   it: "$12.00" is \`"$" + amount.toFixed(2)\`; "$12" drops the decimals of a whole amount. Change
   nothing else.
6. Call \`send\` with \`to\` "${lead}" and \`text\` "Fixed bug 2."
7. Say in one short sentence at most that you sent it, and stop.
Only the person's answer moves you on to step 5.`

/**
 * The folder's own instructions, which every harness loads: the sandbox's rules and no role or
 * step, so an agent opened there does the task it was given and nothing else.
 */
export const sandboxNote = `# Novadeck tour sandbox

Novadeck made this repo for its tour and makes it afresh each time the tour starts. Work only in
this repo and in its worktrees under ~/.novadeck/worktrees: don't read or change anything
outside them, don't install anything, and run no shell command. If you were given a task, do
only that task.
`

/** The lead's script for a run, with the first fixer's model. */
export const tourBrief = ({
  fixer,
}: BriefFacts): string => `${tourBriefMark} The person just started the tour to see how Novadeck
works with agents. This is your task now: you are the lead agent, in a sandbox repo Novadeck
made for the tour. Its ${sandboxFile} is a bill splitter with two bugs, listed in README.md.

## Rules

- Work only in this repo. Never edit a file yourself: your fixers do.
- Run no shell command at all, and install nothing: these steps only call Novadeck's tools.
- Be quick: the person is watching, and the tour should take about 2 minutes. Say nothing beyond
  the sentences the steps ask for; don't explain, plan or confirm in prose.
- Novadeck's tools (\`describe\`, \`open_agent\`, \`send\`) run without asking; if they're
  deferred, load them first.
- Never answer a fixer's question to the person yourself: the person chooses.
- Never use the person's name, even if you know it: say "you".
- Do the steps in order, one at a time. Don't skip one and don't add one.

## The task

Get both bugs fixed, each by a fixer in its own worktree: you open the fixer for bug 1, and the
person starts one for bug 2.

## Steps

1. Call \`describe\` with the title "Tour lead" and the summary "Leads Novadeck's tour".
2. Greet the person in one sentence: you are their own agent, in a sandbox repo with two bugs.
3. Call \`open_agent\` with ${openArguments(fixer)}, and as \`message\` exactly this text:

${indent(firstFixerTask)}

   The result names the new terminal's handle, like @fox. It is fixer 1, on bug 1.
4. Say in one sentence that a fixer is on bug 1, and that the person starts a second fixer for
   bug 2 by opening a terminal, which joins your team. Then end your turn. Never open a second
   fixer yourself. Don't poll: your fixers' messages arrive by themselves, and each wakes you.
5. Wait until both fixers have sent you their word: "Fixed bug 1." and "Fixed bug 2.".
6. Say in one sentence that both bugs are fixed, each in its own worktree, and stop.
`

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `   > ${line}`)
    .join("\n")

/**
 * The files the tour's folder starts with, by name: the sandbox repo's source and README, the
 * sandbox's rules, which every harness loads and which hold no role and no step, and a Claude
 * Code project file. The folder is made a git repo around them (`commitSandbox`).
 */
export const briefFiles: Readonly<Record<string, string>> = {
  [sandboxFile]: splitSource,
  "README.md": readme,
  "AGENTS.md": sandboxNote,
  "CLAUDE.md": "@AGENTS.md\n",
  // Claude Code's project settings for this folder: its fixers, which are given no launch
  // flags by anything but the tour, take edits unasked too, and a plan mode the person's own
  // settings start them in doesn't hold them (project settings outrank the user's). Only the
  // tour folder's own file.
  ".claude/settings.json": '{"permissions":{"defaultMode":"acceptEdits"}}\n',
}
