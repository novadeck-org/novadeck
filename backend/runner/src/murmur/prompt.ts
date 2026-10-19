// What the model is told. It is a 2B model reading a few kilobytes: the prompt is short,
// the person's current ask comes last where it weighs most, and every rule is one the
// model was seen to break without it (see docs/murmur.md).
import type { AgentDigest, Input, NoteDigest } from "./describer.js"
import {
  exampleGists,
  exampleHeadlines,
  exampleTitles,
  gistCharacters,
  gistWords,
  headlineCharacters,
  headlineWords,
  titleCharacters,
  titleWords,
} from "./description.js"

/** What murmur writes: a terminal's title, a headline for a question or plan, a reply's gist. */
export type Task = "title" | "headline" | "gist"

export type Message = { readonly role: "system" | "user"; readonly content: string }

// A title is a short noun name, like a ticket or a branch ("Webhook key rotation", "EMO-118"),
// of what a session works toward or what a window shows. The two kinds of terminal are told
// apart, as an agent's session is named by its goal over many turns and a shell's window by
// the command it just ran.
const nameRules = `title: ${titleWords.min} to 3 words, at most ${titleCharacters} characters, a short memorable name like a ticket or branch name: a noun phrase, not a sentence. Never a verb phrase or filler such as "Help with", "Review", "Updating" or "Working on", never a raw command line, never the project's name. A ticket id from the text may be used ("EMO-118").`

export const agentSystem = `You name AI coding agent sessions in a developer's sidebar. Reply with a JSON object holding changed and title, in that order.

changed: true when the work now differs from the previous name's, false when the previous name still fits. With no previous name it is true.
${nameRules}

Rules:
- Name the goal the whole session works toward, from the person's substantial prompts, the agent's summary, the plan and the agent's reply. Not the latest step, a side question or a tool the agent ran.
- Start the title with its subject, not with a verb: "${exampleTitles[0]}", not "Rotate the webhook signing keys".
- The latest prompt counts most when it moves the session to different work. A short reply such as "yes" or "continue" moves nothing.
- Write the title in the language of the agent's own summary when one is given, otherwise in the language of the person's prompts, whatever language these instructions are in.
- When changed is false, repeat the previous name word for word.
- Do not repeat a greeting, a question or a request back, such as "How is it going" or "Try again".
- Use only facts in the text. Use no markdown and no quotation marks.

Examples of the reply, which show the shape only: never reuse their words for another session:
Prompt "rotate the webhook signing keys for billing" gives:
{"changed":true,"title":"${exampleTitles[0]}"}
Prompt "dodaj walidację formularza rejestracji" gives:
{"changed":true,"title":"${exampleTitles[1]}"}
Prompt "sprawdź, dlaczego testy się wywalają" gives:
{"changed":true,"title":"${exampleTitles[2]}"}`

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

// `changed` comes first because the engine's grammar writes properties in this order, so the
// model has decided whether the work moved on before it names anything.
export const agentTitleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["changed", "title"],
  properties: { changed: { type: "boolean" }, title: titleText },
} as const

/** The schema for `response_format` of a shell's title, which keeps the reply to the title. */
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

export const headlineSystem = `You write one line for a developer's notification list. You get a question an AI coding agent asks the person, or a plan it asks the person to review. Reply with a JSON object holding a headline.

headline: ${headlineWords.min} to ${headlineWords.max} words, at most ${headlineCharacters} characters, saying what the agent wants decided.

Rules:
- A question always starts with "Asks" (or the same verb in the language of the question), then names the specific subject of the choice, such as the file, feature or tool, never just "which approach". Never start with a verb such as "Ship" or "Drop", nor with "Should", "Shall", "Can", "Could", "Would", "Will", "Do", "Does", "Did", "Is" or "Are": the headline reports that something is asked, it is not the question and not a decision.
- A plan starts with "Plan to" (or the same in the language of the plan) and names what it will change.
- Write in the language of the text, whatever language these instructions are in.
- Use only facts in the text. Never answer the question and never pick one of its options.
- Use no markdown, no quotation marks and no full stop.

Examples of the reply, which show the shape only: never reuse their words for another text:
Question "Which database should the billing service use? Options: Postgres, SQLite" gives:
{"headline":"${exampleHeadlines[0]}"}
Question "Którą bazę mam wybrać dla usługi rozliczeń?" gives:
{"headline":"${exampleHeadlines[1]}"}
A plan "1. Move invoicing out of the billing module 2. Add a queue between them" gives:
{"headline":"${exampleHeadlines[2]}"}`

export const gistSystem = `You write one line for a developer's notification list. You get the reply an AI coding agent ended its turn with. Reply with a JSON object holding asks and a gist, in that order.

asks: true when the reply ends by asking the person to pick, decide or supply something the agent needs to go on, with or without a question mark: "Which direction appeals to you?", "Tell me where it downloaded". false for an offer to do more, such as "Want me to add tests?", "Should I also update the docs?" or "Let me know if you need anything else".
gist: ${gistWords.min} to ${gistWords.max} words, at most ${gistCharacters} characters, a complete phrase of about 4 to 8 words naming the result, what the agent did or found, not the topic. Never copy a sentence from the reply.

Rules:
- The gist is a statement, never a question and never the reply's own question: asks carries that. When the reply asks, the gist still says what the agent found, proposed or did ("Two rounding modes proposed"): never "question", "clarify" or "open question".
- Write in the language of the reply, whatever language these instructions are in.
- Use only facts in the reply. Never say tests pass, CI is green or something works unless the reply says so in those words.
- When the turn ended with an error, say what failed if the reply says so.
- Use no markdown, no quotation marks and no full stop.

Examples of the reply, which show the shape only: never reuse their words for another reply:
A reply that rounds checkout totals per line and ends "Which rounding mode should I keep?" gives:
{"asks":true,"gist":"${exampleGists[0]}"}
A reply that adds the validation and ends "Want me to add more?" gives:
{"asks":false,"gist":"${exampleGists[1]}"}
A reply that ends on a build error and "Tell me which Node version CI uses" gives:
{"asks":true,"gist":"${exampleGists[2]}"}`

/** The schema for `response_format`, which keeps the reply to the headline. */
const headlineSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline"],
  properties: {
    headline: { type: "string", minLength: 3, maxLength: headlineCharacters + overrun },
  },
} as const

// `asks` comes first because the engine's grammar writes properties in this order, so the
// model has decided it before it writes a gist that might otherwise talk around it.
const gistSchema = {
  type: "object",
  additionalProperties: false,
  required: ["asks", "gist"],
  properties: {
    asks: { type: "boolean" },
    gist: { type: "string", minLength: 3, maxLength: gistCharacters + overrun },
  },
} as const

/** What each task asks of the engine: the shape of the reply and how many tokens it may take. */
export const formats = {
  title: { responseFormat, maxTokens: 64 },
  headline: {
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "request_headline", strict: true, schema: headlineSchema },
    },
    maxTokens: 96,
  },
  gist: {
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "reply_gist", strict: true, schema: gistSchema },
    },
    maxTokens: 128,
  },
} as const

/** What each input asks of the engine: an agent's title also carries `changed`. */
export const formatOf = (
  task: Task,
  input: Input,
): { readonly responseFormat: object; readonly maxTokens: number } =>
  task === "title" && input.kind === "agent"
    ? {
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "agent_title", strict: true, schema: agentTitleSchema },
        },
        maxTokens: formats.title.maxTokens,
      }
    : formats[task]

// Rough budgets in characters, to keep a job inside the model's 4096-token window. The
// terminals side already trims; this is the last guard.
const budget = {
  earlier: 240,
  earlierCount: 3,
  current: 800,
  reply: 900,
  summary: 600,
  row: 160,
  rows: 30,
  olderRows: 6,
  question: 600,
  choices: 8,
  choice: 80,
  plan: 1500,
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
const tail = (text: string, limit: number): string =>
  text.length <= limit ? text : `…${text.slice(text.length - limit + 1).trimStart()}`

const fact = (name: string, value: string | null): string[] =>
  value === null || value.trim() === "" ? [] : [`${name}: ${value.trim()}`]

// The chat for a note. The text is cut here, after redaction, so a cut never splits a secret
// that redaction would have caught whole.
const noteMessages = (input: NoteDigest): Message[] => {
  const lines: string[] = []
  if (input.kind === "question") {
    lines.push(
      "The agent asks the person this question:",
      head(input.question.trim(), budget.question),
    )
    const choices = input.choices.filter((choice) => choice.trim() !== "")
    if (choices.length > 0) {
      lines.push("", "The answers it offers:")
      for (const choice of choices.slice(0, budget.choices))
        lines.push(`- ${head(choice.trim(), budget.choice)}`)
    }
    lines.push("", "Write the headline in the language of the question.")
  } else if (input.kind === "plan") {
    lines.push(
      "The agent asks the person to review this plan:",
      head(input.plan.trim(), budget.plan),
    )
    lines.push("", "Write the headline in the language of the plan.")
  } else {
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
  }
  return [
    { role: "system", content: input.kind === "reply" ? gistSystem : headlineSystem },
    { role: "user", content: lines.join("\n") },
  ]
}

// The chat for an agent's title. The goal of the session is what is named, so the person's
// first prompt and the agent's summary lead, the latest prompt comes last where it weighs
// most, and the stage says how freely the previous name may be replaced. The project's name
// is left out: the person sits in it, and the parser would strip it from the title anyway.
const agentMessages = (digest: AgentDigest): Message[] => {
  const lines: string[] = [`Terminal: a ${digest.harness} agent session`]
  lines.push(...fact("Git branch", digest.branch), ...fact("Plan", digest.plan))
  if (digest.folders.length > 0) lines.push(`Writes mostly in: ${digest.folders.join(", ")}`)
  // A settled name already holds the earlier prompts, so only the latest is weighed against it.
  const settled = digest.stage === "settled" && digest.previous !== null
  const asked = digest.prompts.filter((prompt) => prompt.trim() !== "")
  const latest = settled || asked.length > 1 ? asked.at(-1) : undefined
  const first = settled ? undefined : asked.at(0)
  const between = settled ? [] : asked.slice(1, -1).slice(-budget.earlierCount)
  if (digest.summary !== null && digest.summary.trim() !== "")
    lines.push(
      "",
      "The agent's own summary of its work (written with full context; trust it):",
      head(digest.summary.trim(), budget.summary),
    )
  if (first !== undefined) {
    lines.push("", asked.length > 1 ? "The person's first prompt:" : "The person's prompt:")
    lines.push(head(first.trim(), budget.current))
  }
  if (between.length > 0) {
    lines.push("", "Later prompts from the person, oldest first:")
    for (const prompt of between) lines.push(`- ${head(prompt.trim(), budget.earlier)}`)
  }
  if (digest.reply !== null && digest.reply.trim() !== "")
    lines.push("", "The agent's latest reply, its end:", tail(digest.reply.trim(), budget.reply))
  if (latest !== undefined) {
    lines.push("", "The person's latest prompt:", head(latest.trim(), budget.current))
  }
  lines.push("")
  if (digest.previous === null) lines.push("Name what this session works toward. changed is true.")
  else if (!settled)
    lines.push(
      `Previous name: ${digest.previous.title}`,
      "The session is still taking shape, so a better name may replace the previous one: changed is true when your title names different or clearer work than the previous name does. A command or step (run, commit, merge, open, show, push) names no work: then changed is false.",
    )
  else
    lines.push(
      `Previous name: ${digest.previous.title}`,
      "The name has settled. changed is true when the person's latest prompt starts a different feature, bug or area than the previous name names. changed is false for a follow-up, fix, test, review or next step of the same work, and the title then repeats the previous name.",
    )
  lines.push(
    `Reply with changed, then a title of ${titleWords.min} to 3 words: a noun name, not a sentence.`,
  )
  const summarized = digest.summary !== null && digest.summary.trim() !== ""
  lines.push(
    summarized
      ? "Write the title in the language of the agent's summary above."
      : "Write the title in the language of the person's prompts above.",
  )
  return [
    { role: "system", content: agentSystem },
    { role: "user", content: lines.join("\n") },
  ]
}

/** The chat that asks the model to write about `input`; it should already be redacted. */
export const messages = (digest: Input): Message[] => {
  if (digest.kind === "question" || digest.kind === "plan" || digest.kind === "reply")
    return noteMessages(digest)
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
