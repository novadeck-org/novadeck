// What the model is told. It is a 2B model reading a few kilobytes: the prompt is short,
// what to write comes last where it weighs most, and every rule is one the model was seen to
// break without it (see docs/murmur.md).
import { ellipsized } from "../text.js"
import type { AgentDigest, Digest } from "./describer.js"
import { exampleTitles, titleCharacters, titleWords } from "./description.js"

/** What murmur writes: a terminal's title. */
export type Task = "title"

export type Message = { readonly role: "system" | "user"; readonly content: string }

// A title is a short noun name, like a ticket or a branch ("Webhook key rotation", "EMO-118"),
// of the work an agent's summary names or what a shell's window shows.
const nameRules = `title: ${titleWords.min} to 3 words, at most ${titleCharacters} characters, a short memorable name like a ticket or branch name: a noun phrase, not a sentence. Never a verb phrase or filler such as "Help with", "Review", "Updating" or "Working on", never a raw command line, never the project's name. A ticket id from the text may be used ("EMO-118").`

// An agent's title is named from its own summary alone, which was written with the whole
// session in view: the person's prompts and the agent's replies pulled the model to the
// latest step ("Critic PR pass" for a summary of a preference switch). The previous name is
// not shown, as the model kept wrong ones; the terminals side keeps it when the new title
// shares a word with it.
export const agentSystem = `You name AI coding agent sessions in a developer's sidebar, from the agent's own summary of its work. Reply with a JSON object holding a title.

${nameRules}

Rules:
- Name the work the summary describes: not a label it opens with ("Task x:", "Lead for", "Done:") and not its progress (merged, in CI, PR numbers).
- Start the title with its subject, not with a verb: "${exampleTitles[0]}", not "Rotate the webhook signing keys".
- Write the title in the language of the summary, whatever language these instructions are in.
- Use only facts in the summary. Use no markdown and no quotation marks.

Examples of the reply, which show the shape only: never reuse their words for another session:
Summary "Task billing-keys: rotates the webhook signing keys for billing; PR #12 in CI" gives:
{"title":"${exampleTitles[0]}"}
Summary "Dodaje walidację formularza rejestracji" gives:
{"title":"${exampleTitles[1]}"}
Summary "Szukam, dlaczego testy się wywalają" gives:
{"title":"${exampleTitles[2]}"}`

export const shellSystem = `You name plain shell windows in a developer's sidebar. Reply with a JSON object holding a title.

${nameRules}

Rules:
- Name what the window shows now, not that a command runs or ran: the last command and its output matter most, older rows are background. After a file tree, name the tree; after failing tests, name the failures ("Login test failures"); after passing tests, "Passing tests"; after git log, "Git history"; for a dev server, name the tool it runs ("Vite dev server"). Never "Running", "Finished" or "Waiting for".
- The command's own words are not a name: "pnpm dev", "ls" or "git log" say what was typed, not what the window is about.
- When the command is a program with no output to read (htop, vim), name the program.
- Write the title in the language of the screen, English if unsure, whatever language these instructions are in.
- A shell that tails logs, watches files or serves something is running it, not failing, even when the lines it shows contain errors.
- Use only facts in the text. Use no markdown and no quotation marks.

Examples of the reply, which show the shape only: never reuse their words for another window:
A shell running tail -f /var/log/nginx/access.log gives:
{"title":"${exampleTitles[3]}"}`

// The schemas allow more than the parser does. The engine's grammar cuts a string at the
// schema's length, so a text that ran over would be cut mid-phrase and pass; with room above the
// limit it comes out whole and is refused.
const overrun = 32

const titleText = { type: "string", minLength: 2, maxLength: titleCharacters + overrun } as const

/** The schema for `response_format` of a title, which keeps the reply to the title. */
export const schema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: { title: titleText },
} as const

export const responseFormat = {
  type: "json_schema",
  json_schema: { name: "terminal_title", strict: true, schema },
} as const

/** What each task asks of the engine: the shape of the reply and how many tokens it may take. */
export const formats = {
  title: { responseFormat, maxTokens: 64 },
} as const

// Rough budgets in characters, to keep a job inside the model's 4096-token window. The
// terminals side already trims; this is the last guard.
const budget = {
  row: 160,
  rows: 30,
  olderRows: 6,
}

// The chat for an agent's title: its summary, and what to make of it last.
const agentMessages = (digest: AgentDigest): Message[] => [
  { role: "system", content: agentSystem },
  {
    role: "user",
    content: [
      "The agent's summary of its work:",
      // At most 200 characters, as `summarize` takes it.
      digest.summary.trim(),
      "",
      "Name what the work is about in at most 3 words: its subject, not its label or its progress (merged, done, closed), in the language of the summary.",
    ].join("\n"),
  },
]

/** The chat that asks the model to write about `input`; it should already be redacted. */
export const messages = (digest: Digest): Message[] => {
  if (digest.kind === "agent") return agentMessages(digest)
  const lines: string[] = ["Terminal: a plain shell"]
  const screen = digest.screen.slice(-budget.rows).map((row) => ellipsized(row, budget.row))
  // The runner says on which row the last command was typed (`commandAt`, from the shell
  // integration's prompt report). The rows from it lead as the last command and its output;
  // the rows above are background, as a small model otherwise names the oldest thing it reads.
  // Without it nothing is claimed of the rows: they are the screen.
  const first = digest.screen.length - screen.length
  const start =
    digest.commandAt === undefined ||
    !Number.isInteger(digest.commandAt) ||
    digest.commandAt < first ||
    digest.commandAt >= digest.screen.length
      ? -1
      : digest.commandAt - first
  const older = screen.slice(0, Math.max(0, start)).slice(-budget.olderRows)
  if (older.length > 0) lines.push("", "Earlier on the screen (background only):", ...older)
  if (screen.length > 0 && start === -1)
    lines.push(
      "",
      "The screen, oldest row first (the last command and its output matter most):",
      ...screen,
    )
  // A full-screen program's screen is not shown, only what it runs.
  else if (screen.length > 0)
    lines.push("", "The last command and its output:", ...screen.slice(start))
  // The program comes last, and what to title with it, since it is what the window is about
  // now. A shell is renamed on every command, so its previous title is not shown: it would
  // only be kept.
  lines.push(
    "",
    digest.command === null || digest.command.trim() === ""
      ? "Nothing runs now: the shell waits at its prompt."
      : `Running now: ${digest.command.trim()}`,
    "Title what this window shows now, by the last command's output: what it is about, such as a folder's file tree, a project's git history or failing login tests. Never just that a command runs or finished.",
  )
  return [
    { role: "system", content: shellSystem },
    { role: "user", content: lines.join("\n") },
  ]
}
