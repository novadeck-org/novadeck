import type { Effort } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { tourBriefMark } from "../messaging/messages.js"
import { stripFont } from "./strip-font.js"

/**
 * What the tour's agents are told. The tour folder's own instruction files, which every harness
 * loads as it starts there, hold only `sandboxNote`: the agents the lead opens start in the
 * same folder, and a cheap model follows a script it loads over the message that is its task.
 * The lead's script (`tourBrief`) is sent to it instead, by the doorbell, as Novadeck's first
 * notice to it, for every harness (`Tour.brief`); a teammate's task is the message its lead sends.
 */

/** What the tour rings its agent where it has gone quiet at a step (`tour.nudge`). */
export const nudgeLine =
  "Novadeck's tour is waiting on you: look at what you've done so far and carry on from the next step of the tour brief Novadeck sent you. Don't redo a step."

/**
 * The strip the lead makes, a three-panel comic of the run with the person's pick as its
 * punchline: its file, and how that file is described to the lead. Novadeck shows an HTML file
 * as a page. It is all one file, its look inline, lettered in the comic font the tour puts beside
 * it (`stripFont`), which the page loads from its own folder. Changing the strip's format is
 * changing this (and the words of the steps that name it).
 */
export const card = {
  file: "tour-strip.html",
  form: "the template below, filled in, changing nothing else",
  template: [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    ":root{--p:PAPER;--i:INK;--a:ACCENT}",
    "@font-face{font-family:S;src:url(strip.woff2)}",
    "body{margin:0;background:var(--i);font-family:S,Impact,sans-serif;letter-spacing:.04em}",
    ".s{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr);gap:10px;padding:10px;min-height:100vh;box-sizing:border-box}",
    ".p{padding:0 14px 20px;background:var(--p);color:var(--i)}",
    ".c,.b,.t{text-transform:uppercase}",
    ".c{display:inline-block;margin:0 0 30px -14px;padding:5px 12px;background:var(--i);color:var(--p)}",
    ".b{display:inline-block;padding:6px 10px;background:#fff;color:#111;border:2px solid;box-shadow:3px 3px 0}",
    ".t{font-size:40px;line-height:1;overflow-wrap:anywhere}",
    '</style></head><body><div class="s">',
    '<div class="p"><b class="c">You press start</b><p class="b">your agent:<br>On it. Hiring two.</p></div>',
    '<div class="p"><b class="c">Two hires, two opinions</b><p class="b">designer:<br>LOOK LINE</p><p class="b">copywriter:<br>COPY LINE</p></div>',
    '<div class="p" style="background:var(--a)"><b class="c">Your pick</b><p class="t">TAGLINE</p><p>Made by your team, in Novadeck.</p></div>',
    "</div></body></html>",
  ],
} as const

// The strip's look where the designer's is missing or broken.
const defaults = {
  background: "#fff6dc",
  text: "#140b1f",
  accent: "#ffe24a",
} as const

/** A teammate the lead opens: the agent, and the model and effort it runs on. */
export type Teammate = {
  readonly agent: AgentName
  readonly model: string
  readonly effort?: Effort
}

/** What changes with each run of the tour, and so with the brief. */
export type BriefFacts = {
  readonly copywriter: Teammate
  readonly designer: Teammate
}

// The arguments `open_agent` takes for a teammate, as the brief gives them.
const openArguments = ({ agent, model, effort }: Teammate): string =>
  `agent "${agent}", model "${model}"${effort !== undefined ? `, effort "${effort}"` : ""}`

const copywriterBrief = (): string =>
  `You are the copywriter in Novadeck's tour, a teammate. Your lead is the agent that sent you
this message (its \`from\`): act on its messages. Your tools include Novadeck's \`describe\`,
\`ask\` and \`send\`: if they're deferred, load them first. Never write files or call
\`open_agent\`. Be quick: do each step at once, with no prose before a tool call.
1. Call \`describe\` with title "Copywriter" and summary "Writes the strip's words".
2. Write two tagline options for a comic strip about the person's first look at Novadeck, A and B,
   of at most 40 characters each, and your own line for the strip, of at most 32 characters.
   Then go straight to step 3.
3. Call \`ask\` with subject "Which tagline for the comic strip?", body "The lead is making a
   comic strip of the tour for you. Which tagline should be its punchline?" and shape
   {"type":"options","options":[{"label":"A","summary":"<tagline A>"},{"label":"B","summary":"<tagline B>"}],"recommend":0}.
4. End your turn with one short sentence. Do not wait in a loop: the person's answer arrives by
   itself as a message.
5. When the answer arrives, it names the option the person picked, or holds their own words:
   use that option's tagline, or their words as the tagline. If you are told the person
   dismissed the question, use tagline A. A message with no words in it isn't their answer:
   wait for the one that is. Then call \`send\` once, with \`to\` your lead's handle and
   \`text\` "Tagline: <the tagline>. Line: <your line>".
6. Say in one short sentence at most that you sent it, and stop.
Only the person's answer moves you on to step 5.`

const designerBrief = (): string =>
  `You are the designer in Novadeck's tour, a teammate. Your lead is the agent that sent you this
message (its \`from\`): act on its messages. Your tools include Novadeck's \`describe\` and
\`send\`: if they're deferred, load them first. Never write files or call \`open_agent\`. Be
quick: do each step at once, with no prose before a tool call.
1. Call \`describe\` with title "Designer" and summary "Picks the strip's look".
2. Pick the look of the tour's comic strip in one go, with no deliberating: three colours as
   hex codes (background, text and accent, with the text easy to read on the background), and
   your own line for the strip, of at most 32 characters. Then go straight to step 3.
3. Call \`send\` with \`to\` your lead's handle and \`text\` "Look: background <hex>; text <hex>;
   accent <hex>; line <your line>".
4. Say in one short sentence at most that you sent it, and stop.`

/**
 * The folder's own instructions, which every harness loads: the sandbox's rules and no role or
 * step, so an agent opened there does the task it was given and nothing else.
 */
export const sandboxNote = `# Novadeck tour sandbox

Novadeck made this folder for its tour and empties it each time the tour starts. Work only in
this folder: don't read or change anything outside it, don't install anything, and don't run git.
If you were given a task, do only that task.
`

/** The lead's script for a run, with the teammates' models. */
export const tourBrief = ({
  copywriter,
  designer,
}: BriefFacts): string => `${tourBriefMark} The person just started the tour to see how Novadeck
works with agents. This is your task now: you are the lead agent, in a sandbox folder Novadeck
made for the tour.

## Rules

- Work only in this folder. Don't read or change anything outside it.
- Run no shell command at all, and install nothing: these steps only call Novadeck's tools and
  write one file.
- Be quick: the person is watching, and the tour should take about 2 minutes. Say nothing beyond
  the one-sentence greeting and the final line; don't explain, plan or confirm in prose.
- Novadeck's tools (\`describe\`, \`open_agent\`, \`send\`, \`ask\`, \`show\`) run without asking;
  if they're deferred, load them first.
- Only you, the lead, write files here. Your teammates never do.
- Never answer your teammates' questions to the person yourself: the person chooses.
- Never use the person's name, even if you know it: say "you".
- Do the steps in order, one at a time. Don't skip one and don't add one.

## The task

Make a three-panel comic strip of this tour for the person, with two teammates: a copywriter and
a designer. Its punchline is the tagline the person picks.

## Steps

1. Call \`describe\` with the title "Tour lead" and the summary "Leads Novadeck's tour".
2. Greet the person in one sentence: you are their own agent, running in a sandbox, and the
   tour has begun.
3. Call \`open_agent\` with ${openArguments(copywriter)}, and as \`message\` exactly this text:

${indent(copywriterBrief())}

   The result names the new terminal's handle, like @fox. It is the copywriter's.
4. Call \`open_agent\` with ${openArguments(designer)}, and as \`message\` exactly this text
   (steps 3 and 4 may run at once):

${indent(designerBrief())}

5. End your turn with one short sentence, such as "The team is working." Don't poll: your
   teammates' messages arrive by themselves, and each wakes you.
6. Wait until the designer has sent you the look, and the copywriter the chosen tagline.
7. Write \`${card.file}\` in this folder: ${card.form}. Put in the designer's background for
   PAPER, text colour for INK, accent for ACCENT and line for LOOK LINE; the chosen tagline
   for TAGLINE; the copywriter's line for COPY LINE. The font file beside it is Novadeck's.
   - In what you put in, write "&" as "and", and drop "<", ">", "{", "}", ";" and '"'.
   - A colour that isn't "#" and 3 or 6 hex digits, or one never sent, is ${defaults.background}
     for PAPER, ${defaults.text} for INK, ${defaults.accent} for ACCENT.
   - Cut a tagline to 40 characters and a line to 32; a missing line is "Looks good.".
   The template:

${card.template.map((line) => `   ${line}`).join("\n")}

8. Call \`show\` with \`file\` {"path":"${card.file}"} and \`open\` true.
9. Say in one sentence that the strip is ready, and stop.
`

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `   > ${line}`)
    .join("\n")

/**
 * The files the tour's folder starts with, by name: the sandbox's rules, which every harness
 * loads and which hold no role and no step, and a Claude Code project file. The lead's
 * script is `tourBrief`, rung to it.
 */
export const briefFiles: Readonly<Record<string, string | Uint8Array>> = {
  "AGENTS.md": sandboxNote,
  "CLAUDE.md": "@AGENTS.md\n",
  // Claude Code's project settings for this folder: its teammates, which are given no launch
  // flags, take edits unasked too, and a plan mode the person's own settings start them in
  // doesn't hold them (project settings outrank the user's). Only the tour folder's own file.
  ".claude/settings.json": '{"permissions":{"defaultMode":"acceptEdits"}}\n',
  // The strip's lettering, which the strip loads from beside it.
  [stripFont.file]: stripFont.bytes(),
}
