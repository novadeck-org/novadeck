// What the model is told. It is a 2B model reading a few kilobytes: the prompt is short,
// the person's current ask comes last where it weighs most, and every rule is one the
// model was seen to break without it (see docs/murmur.md).
import type { Digest } from "./describer.js"
import { exampleTitles, titleCharacters, titleWords } from "./description.js"

export type Message = { readonly role: "system" | "user"; readonly content: string }

export const system = `You name terminals in a developer's sidebar. You get what one terminal shows: an AI coding agent's session, or a plain shell. Reply with a JSON object holding a title.

title: ${titleWords.min} to ${titleWords.max} words, at most ${titleCharacters} characters, naming the concrete task or program. Write it like a tab name: no verb needed, no full sentence, never a raw command line.

Rules:
- Write the title in the language of the agent's own summary when one is given, otherwise in the language of the person's CURRENT prompt, whatever language these instructions are in. For a plain shell, use the language of the screen, English if unsure.
- When the agent's own summary is given, it was written with full context: name what it says, unless the current prompt has plainly moved on.
- The title names the work or the program, never the person's last message. Do not repeat a greeting, a question or a request back, such as "How is it going" or "Try again".
- Name the CURRENT prompt, the last one, even when earlier prompts or the agent's reply are about something else. Earlier prompts are only background.
- A previous title may be given. Keep it word for word unless the work has clearly moved on to something else.
- Use only facts in the text. Never say something failed unless it plainly says so.
- A shell that tails logs, watches files or serves something is running it, not failing, even when the lines it shows contain errors.
- Use no markdown and no quotation marks.

Examples of the reply, which show the shape only: never reuse their words for another terminal:
Prompt "rotate the webhook signing keys for billing" gives:
{"title":"${exampleTitles[0]}"}
Prompt "dodaj walidację formularza rejestracji" gives:
{"title":"${exampleTitles[1]}"}
Prompt "sprawdź, dlaczego testy się wywalają" gives:
{"title":"${exampleTitles[2]}"}
A shell running tail -f /var/log/nginx/access.log gives:
{"title":"${exampleTitles[3]}"}`

/** The schema for `response_format`, which keeps the reply to the title. */
export const schema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string", minLength: 3, maxLength: titleCharacters },
  },
} as const

export const responseFormat = {
  type: "json_schema",
  json_schema: { name: "terminal_title", strict: true, schema },
} as const

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
}

const head = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
const tail = (text: string, limit: number): string =>
  text.length <= limit ? text : `…${text.slice(text.length - limit + 1).trimStart()}`

const fact = (name: string, value: string | null): string[] =>
  value === null || value.trim() === "" ? [] : [`${name}: ${value.trim()}`]

const previous = (digest: Digest): string[] =>
  digest.previous === null
    ? []
    : ["", `Previous title (keep it unless the work clearly changed): ${digest.previous.title}`]

/** The chat that asks the model to label `digest`; the digest should already be redacted. */
export const messages = (digest: Digest): Message[] => {
  const lines: string[] = []
  if (digest.kind === "agent") {
    lines.push(`Terminal: a ${digest.harness} agent session`)
    lines.push(...fact("Project", digest.project), ...fact("Folder", digest.folder))
    lines.push(...fact("Git branch", digest.branch), ...fact("Plan", digest.plan))
    if (digest.folders.length > 0) lines.push(`Writes mostly in: ${digest.folders.join(", ")}`)
    const asked = digest.prompts.filter((prompt) => prompt.trim() !== "")
    const current = asked.at(-1)
    const earlier = asked.slice(0, -1).slice(-budget.earlierCount)
    if (earlier.length > 0) {
      lines.push("", "Earlier prompts from the person (background only, oldest first):")
      for (const prompt of earlier) lines.push(`- ${head(prompt.trim(), budget.earlier)}`)
    }
    if (digest.reply !== null && digest.reply.trim() !== "") {
      lines.push("", "The agent's latest reply, its end:", tail(digest.reply.trim(), budget.reply))
    }
    if (digest.summary !== null && digest.summary.trim() !== "")
      lines.push(
        "",
        "The agent's own summary of its work (written with full context; trust it):",
        head(digest.summary.trim(), budget.summary),
      )
    lines.push(...previous(digest))
    const summarized = digest.summary !== null && digest.summary.trim() !== ""
    // With no prompt at all, as when an agent's own summary drives the title, there is no
    // current prompt to point at.
    if (current !== undefined) {
      lines.push("", "CURRENT prompt from the person (label this, in its language):")
      lines.push(head(current.trim(), budget.current))
    }
    lines.push(
      "",
      summarized
        ? "Write the title in the language of the agent's summary above."
        : "Write the title in the language of the CURRENT prompt above.",
    )
  } else {
    lines.push("Terminal: a plain shell")
    lines.push(...fact("Project", digest.project), ...fact("Folder", digest.folder))
    lines.push(...fact("Running", digest.command))
    const screen = digest.screen.slice(-budget.rows).map((row) => head(row, budget.row))
    // A full-screen program's screen is not shown, only what it runs.
    if (screen.length > 0)
      lines.push("", "What the screen shows now (oldest row first):", ...screen)
    else lines.push("", "The screen is not shown; title this terminal by what it runs.")
    lines.push(...previous(digest))
    lines.push("", "Title this terminal as it is now.")
  }
  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ]
}
