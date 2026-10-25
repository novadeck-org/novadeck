// What the model is told. It is a 2B model reading a few kilobytes: the prompt is short,
// what to write comes last where it weighs most, and every rule is one the model was seen to
// break without it (see docs/murmur.md).
import type { AgentDigest, Input, NoteDigest } from "./describer.js"
import {
  exampleGists,
  exampleTitles,
  gistCharacters,
  gistWords,
  titleCharacters,
  titleWords,
} from "./description.js"

/** What murmur writes: a terminal's title, a reply's gist. */
export type Task = "title" | "gist"

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

export const gistSystem = `You write one line for a developer's notification list. You get the reply an AI coding agent ended its turn with. Reply with a JSON object holding a gist.

gist: ${gistWords.min} to ${gistWords.max} words, at most ${gistCharacters} characters, a complete phrase of about 4 to 8 words naming the result, what the agent did or found, not the topic. Never copy a sentence from the reply.

Rules:
- The gist is a statement, never a question and never the reply's own question. When the reply asks, the gist still says what the agent found, proposed or did ("Two rounding modes proposed"): never "question", "clarify" or "open question".
- Write in the language of the reply, whatever language these instructions are in.
- Use only facts in the reply. Never say tests pass, CI is green or something works unless the reply says so in those words.
- When the turn ended with an error, say what failed if the reply says so.
- Use no markdown, no quotation marks and no full stop.

Examples of the reply, which show the shape only: never reuse their words for another reply:
A reply that rounds checkout totals per line and ends "Which rounding mode should I keep?" gives:
{"gist":"${exampleGists[0]}"}
A reply that adds the validation and ends "Want me to add more?" gives:
{"gist":"${exampleGists[1]}"}
A reply that ends on a build error and "Tell me which Node version CI uses" gives:
{"gist":"${exampleGists[2]}"}`

const gistSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gist"],
  properties: {
    gist: { type: "string", minLength: 3, maxLength: gistCharacters + overrun },
  },
} as const

/** What each task asks of the engine: the shape of the reply and how many tokens it may take. */
export const formats = {
  title: { responseFormat, maxTokens: 64 },
  gist: {
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "reply_gist", strict: true, schema: gistSchema },
    },
    maxTokens: 128,
  },
} as const

// Rough budgets in characters, to keep a job inside the model's 4096-token window. The
// terminals side already trims; this is the last guard.
const budget = {
  row: 160,
  rows: 30,
  olderRows: 6,
  // A reply is budgeted in tokens, estimated by `cost` as a ceiling, since a chat window of
  // 4096 tokens holds very different amounts of text by script: the system prompt (about 450),
  // the answer (128) and a margin come out of it, and 3100 are left for the reply.
  replyHead: 1550,
  replyTail: 1550,
}

// What text costs the model, in tokens, as a ceiling that does not undercount whatever the text
// is. Measured on the engine's own tokenizer, per character: English words 0.27, digits 1.0,
// hex and random letters and digits 0.7 to 0.9, symbols 0.7, common Chinese 0.5 to 1.7, random
// Chinese and Korean up to 2.2, rare characters up to 3, emoji 2.6 to 2.9 and rare ones up to 4.
// A plain word (lower case, or capitalised) is counted at 0.65 a character, as short random
// words cost about that, and other ASCII and digits at 1.
const plainWord = /^[!-&(-/:-@[-`{-~]{0,2}[A-Z]?[a-z']+[!-/:-@[-`{-~]{0,3}$/
const characterCost = (character: string): number => {
  const code = character.codePointAt(0) ?? 0
  if (code < 128) {
    if (code >= 48 && code <= 57) return 1
    return code <= 32 ? 0.1 : 1
  }
  if (code >= 0x10000) return 4
  // Letters of Latin, Greek and Cyrillic, then Hebrew, Arabic, Indic scripts and Thai.
  if (code < 0x590) return code < 0x2c0 || code >= 0x370 ? 2 : 3
  if (code < 0x1000) return 1.5
  // Han, kana, and Hangul syllables.
  if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff)) return 2
  if (code >= 0xac00 && code <= 0xd7a3) return 2.4
  return 3
}
// One word or one run of white space. A word is at least a token, and so is each line
// break, as short lines (versions, line numbers) cost one or two tokens apiece.
const pieceCost = (piece: string): number => {
  if (/^\s/.test(piece)) return [...piece].reduce((sum, c) => sum + (c === "\n" ? 1 : 0.1), 0)
  const price = plainWord.test(piece)
    ? 0.65 * piece.length
    : // A number takes the space before it as a token of its own.
      [...piece].reduce(
        (sum, character) => sum + characterCost(character),
        /^\d/.test(piece) ? 1 : 0,
      )
  return Math.max(1, price)
}

// Words and the white space between them, in order.
const pieces = (text: string): string[] => text.split(/(\s+)/).filter(Boolean)

const cost = (text: string): number =>
  pieces(text).reduce((sum, piece) => sum + pieceCost(piece), 0)

// The longest start of `text` that costs at most `limit` tokens, by whole words and then by
// characters of the word that does not fit.
const startWithin = (text: string, limit: number): string => {
  let units = 0
  let taken = ""
  for (const piece of pieces(text)) {
    const price = pieceCost(piece)
    if (units + price <= limit) {
      units += price
      taken += piece
      continue
    }
    for (const character of piece) {
      units += characterCost(character)
      if (units > limit) break
      taken += character
    }
    break
  }
  return taken
}

// The longest end of `text` that costs at most `limit` tokens.
const endWithin = (text: string, limit: number): string => {
  let units = 0
  let taken = ""
  for (const piece of pieces(text).toReversed()) {
    const price = pieceCost(piece)
    if (units + price <= limit) {
      units += price
      taken = piece + taken
      continue
    }
    for (const character of [...piece].toReversed()) {
      units += characterCost(character)
      if (units > limit) break
      taken = character + taken
    }
    break
  }
  return taken
}

// Fenced code, replaced by a marker: a fence is a line that begins with three or more
// backticks, and ends at a line of at least as many (or the end of the reply, when unclosed).
// Backticks inside a sentence are no fence.
const withoutCode = (text: string): string => {
  const lines: string[] = []
  let fence = 0
  for (const line of text.split("\n")) {
    const ticks = /^[ \t]*(`{3,})/.exec(line)?.[1]?.length ?? 0
    if (fence === 0) {
      if (ticks === 0) lines.push(line)
      else {
        fence = ticks
        lines.push("[code]")
      }
    } else if (ticks >= fence && /^[ \t]*`+[ \t]*$/.test(line)) fence = 0
  }
  return lines.join("\n")
}

// A reply without what is no prose, so the budget goes to the words: code blocks, link
// addresses, bare URLs and the rows of tables are marked or dropped. It works on redacted text,
// whose marks it leaves as they are.
const prose = (text: string): string =>
  withoutCode(text)
    .replaceAll(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, (link, label: string) =>
      label === "redacted" ? link : label,
    )
    .replaceAll(/\b(?:https?|ftp):\/\/\S+/g, "[link]")
    .replaceAll(/(?:^[ \t]*\|.*\n?){2,}/gm, (rows) => `${rows.split("\n")[0]?.trim()}\n[table]\n`)
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()

const head = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`

// The chat for a note. The text is cut here, after redaction, so a cut never splits a secret
// that redaction would have caught whole.
const noteMessages = (input: NoteDigest): Message[] => {
  const lines: string[] = []
  const reply = prose(input.reply)
  const whole = cost(reply) <= budget.replyHead + budget.replyTail
  if (input.failed) lines.push("The turn ended with an error.", "")
  // The two ends are named and the cut marked, so they are not read as one text.
  lines.push(
    ...(whole
      ? ["The agent's reply:", reply]
      : [
          "The start of the agent's reply:",
          startWithin(reply, budget.replyHead).trimEnd(),
          "[…]",
          "The end of the agent's reply:",
          endWithin(reply, budget.replyTail).trimStart(),
        ]),
  )
  lines.push("", "Write the gist in the language of the reply.")
  return [
    { role: "system", content: gistSystem },
    { role: "user", content: lines.join("\n") },
  ]
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
export const messages = (digest: Input): Message[] => {
  if (digest.kind === "reply") return noteMessages(digest)
  if (digest.kind === "agent") return agentMessages(digest)
  const lines: string[] = ["Terminal: a plain shell"]
  const screen = digest.screen.slice(-budget.rows).map((row) => head(row, budget.row))
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
