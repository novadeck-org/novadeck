import { readFileSync } from "node:fs"
import { join } from "node:path"

import type Anthropic from "@anthropic-ai/sdk"
import { APIError } from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import { z } from "zod"

import { noteArea, noteAreas } from "../../contract/protocol/src/release-notes.ts"
import { type Item } from "./items.ts"
import { Skip } from "./skip.ts"

export const model = "claude-opus-5-5"

/** What the model is asked to return: lines and the pull requests they come from. */
export const modelOutput = z.object({
  highlights: z.array(
    z.object({ title: z.string(), line: z.string(), prs: z.array(z.number().int()) }),
  ),
  changes: z.array(z.object({ area: noteArea, line: z.string(), prs: z.array(z.number().int()) })),
})

// What is read back. The structured output holds the model to the areas, but a line in an area
// outside them is the check's to drop, not a reason to throw the whole answer away.
const answer = z.object({
  highlights: modelOutput.shape.highlights,
  changes: z.array(
    z.object({ area: z.string(), line: z.string(), prs: z.array(z.number().int()) }),
  ),
})
export type ModelOutput = z.infer<typeof answer>

/** The one streaming call of the beta messages API this uses, so a test can hand in a fake. */
export type Client = {
  readonly beta: {
    readonly messages: {
      readonly stream: (params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) => {
        readonly finalMessage: () => Promise<Anthropic.Beta.Messages.BetaMessage>
      }
    }
  }
}

/**
 * How long a mode waits for the model, a promotion having far more to read. For a stream the
 * SDK's timeout bounds only the wait for the first byte, so the workflow step's own
 * `timeout-minutes` is what bounds the wall clock.
 */
export const timeouts = { release: 180_000, promote: 480_000 } as const

const prompt = readFileSync(join(import.meta.dirname, "prompt.md"), "utf8")

/** The instructions: prompt.md, which is plain prose to edit, and the areas, which are code. */
export const systemPrompt = (): string =>
  `${prompt.trim()}\n\nAreas, spelled exactly so: ${noteAreas.join("; ")}.\n`

/** The items as the model reads them: one block each, led by the pull requests they close. */
export const userMessage = (kind: "release" | "promote", version: string, items: readonly Item[]) =>
  [
    `Mode: ${kind}. Version: ${version}.`,
    "",
    ...items.flatMap((item) => [
      `${item.prs.map((pr) => `#${pr}`).join(" ")} [${item.label}] ${item.line}`,
      ...(item.detail ? [`What: ${item.detail.replaceAll("\n", "\n  ")}`] : []),
      "",
    ]),
  ].join("\n")

/**
 * Asks the model, and returns the text of its answer, which the caller parses and checks,
 * and the tokens it wrote. Streams, as a long answer would outlast a plain request. Throws
 * `Skip` for any error or answer that should end in no notes; the rest is in the message.
 */
export const ask = async (
  client: Client,
  kind: "release" | "promote",
  version: string,
  items: readonly Item[],
): Promise<{ text: string; outputTokens: number }> => {
  let response: Anthropic.Beta.Messages.BetaMessage
  try {
    response = await client.beta.messages
      .stream({
        model,
        max_tokens: 64_000,
        system: systemPrompt(),
        messages: [{ role: "user", content: userMessage(kind, version, items) }],
        // Thinking is adaptive and always on for this model, so it is left out.
        output_config: { effort: "medium", format: betaZodOutputFormat(modelOutput) },
        // A refusal re-runs on the server's default fallback model inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
      .finalMessage()
  } catch (error) {
    if (error instanceof APIError)
      throw new Skip(`The API answered ${error.status ?? "no status"}: ${error.message}`)
    throw new Skip(error instanceof Error ? error.message : String(error))
  }
  if (response.stop_reason === "refusal") throw new Skip("The model refused")
  if (response.stop_reason === "max_tokens") throw new Skip("The answer was cut off")
  const text = response.content.find((block) => block.type === "text")
  if (!text || text.type !== "text") throw new Skip("The answer had no text")
  return { text: text.text, outputTokens: response.usage.output_tokens }
}

/** The text of an answer as `ModelOutput`, or a `Skip` saying where it broke. */
export const parseOutput = (text: string): ModelOutput => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Skip("The answer was not JSON", text)
  }
  const parsed = answer.safeParse(json)
  if (!parsed.success)
    throw new Skip(`The answer had the wrong shape: ${parsed.error.message}`, text)
  return parsed.data
}
