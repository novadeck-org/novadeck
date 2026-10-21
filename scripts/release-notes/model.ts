import { readFileSync } from "node:fs"
import { join } from "node:path"

import { z } from "zod"

import {
  highlightIcon,
  highlightIcons,
  noteArea,
  noteAreas,
} from "../../contract/protocol/src/release-notes.ts"
import { ask as askModel, withoutBounds, type Answer, type Client } from "../openrouter/ask.ts"
import { type Item } from "./items.ts"
import { Skip } from "./skip.ts"

export { endpoint, withoutBounds, type Answer, type Client } from "../openrouter/ask.ts"

/** What the model is asked to return: lines and the pull requests they come from. */
export const modelOutput = z.object({
  highlights: z.array(
    z.object({
      title: z.string(),
      line: z.string(),
      prs: z.array(z.number().int()),
      icon: highlightIcon,
    }),
  ),
  changes: z.array(z.object({ area: noteArea, line: z.string(), prs: z.array(z.number().int()) })),
})

// What is read back. The structured output holds the model to the areas, but a line in an area
// outside them is the check's to drop, and an icon outside the set the check's to replace, not
// reasons to throw the whole answer away.
const answer = z.object({
  highlights: z.array(
    z.object({
      title: z.string(),
      line: z.string(),
      prs: z.array(z.number().int()),
      icon: z.string().optional(),
    }),
  ),
  changes: z.array(
    z.object({ area: z.string(), line: z.string(), prs: z.array(z.number().int()) }),
  ),
})
export type ModelOutput = z.infer<typeof answer>

/**
 * The model a mode asks unless an environment variable says another: a cheap one for the many
 * prereleases (RELEASE_NOTES_PRERELEASE_MODEL), a strong one for the few promotions
 * (RELEASE_NOTES_PROMOTE_MODEL).
 */
export const defaultModels = {
  release: "deepseek/deepseek-v4-pro",
  promote: "anthropic/claude-opus-5.5",
} as const

/**
 * How long a mode waits for the model, a promotion having far more to read. The answer is
 * streamed, but this bounds the whole call, the last chunk included.
 */
export const timeouts = { release: 180_000, promote: 480_000 } as const

/**
 * The most a mode lets the model write. A build's answer is short, and some providers of the
 * cheaper models cap a completion at 16,384. The promotion's number is low on purpose:
 * OpenRouter holds the cost of the whole limit up front, before the model writes a word, and
 * that hold has to fit what is left on a key capped at a dollar with the prereleases' spend
 * already taken out. A real promotion's answer was under 5,000 tokens.
 */
export const maxTokens = { release: 16_000, promote: 16_000 } as const

export const clientFor = (
  mode: "release" | "promote",
  env: Readonly<Record<string, string | undefined>> = process.env,
): Client => ({
  fetch,
  apiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
  model:
    (mode === "release"
      ? env.RELEASE_NOTES_PRERELEASE_MODEL
      : env.RELEASE_NOTES_PROMOTE_MODEL
    )?.trim() || defaultModels[mode],
  timeout: timeouts[mode],
})

export const responseSchema = withoutBounds(z.toJSONSchema(modelOutput))

const prompt = readFileSync(join(import.meta.dirname, "prompt.md"), "utf8")

/** The instructions: prompt.md, which is plain prose to edit, and the areas and icons: code. */
export const systemPrompt = (): string =>
  `${prompt.trim()}\n\nAreas, spelled exactly so: ${noteAreas.join("; ")}.\n\n` +
  `Highlight icons, spelled exactly so: ${highlightIcons.join(", ")}.\n`

/** The items as the model reads them: one block each, led by the pull requests they close. */
export const userMessage = (kind: "release" | "promote", version: string, items: readonly Item[]) =>
  [
    `Mode: ${kind}. Version: ${version}.`,
    "",
    ...items.flatMap((item) => [
      `${item.prs.map((pr) => `#${pr}`).join(" ")} [${item.label}] ${item.line}`,
      ...(item.detail ? [`What: ${item.detail.replaceAll("\n", "\n  ")}`] : []),
      ...(item.reason ? [`Why: ${item.reason.replaceAll("\n", "\n  ")}`] : []),
      "",
    ]),
  ].join("\n")

/**
 * Asks the model for a mode's notes, once, through OpenRouter (scripts/openrouter), and
 * returns the text of its answer, which the caller parses and checks. Throws `Skip` for any
 * error or answer that should end in no notes: a failed run keeps the release's body, and
 * the job can be run again.
 */
export const ask = (
  client: Client,
  kind: "release" | "promote",
  version: string,
  items: readonly Item[],
): Promise<Answer> =>
  askModel(client, {
    title: "Novadeck release notes",
    system: systemPrompt(),
    user: userMessage(kind, version, items),
    schema: { name: "release_notes", json: responseSchema },
    maxTokens: maxTokens[kind],
  })

/** The text of an answer as `ModelOutput`, or a `Skip` saying where it broke. */
export const parseOutput = (text: string): ModelOutput => {
  let json: unknown
  try {
    // Some models wrap JSON in a code fence whatever they are told.
    json = JSON.parse(text.trim().replace(/^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/, "$1"))
  } catch {
    throw new Skip("The answer was not JSON", text)
  }
  const parsed = answer.safeParse(json)
  if (!parsed.success)
    throw new Skip(`The answer had the wrong shape: ${parsed.error.message}`, text)
  return parsed.data
}
