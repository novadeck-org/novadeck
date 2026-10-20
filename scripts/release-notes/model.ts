import { readFileSync } from "node:fs"
import { join } from "node:path"

import { z } from "zod"

import { noteArea, noteAreas } from "../../contract/protocol/src/release-notes.ts"
import { type Item } from "./items.ts"
import { Skip } from "./skip.ts"

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

/**
 * Everything the call needs from outside, so a test hands in a fake `fetch`: the key (none
 * means no call), the model to ask and how long to wait.
 */
export type Client = {
  readonly fetch: typeof fetch
  readonly apiKey: string | undefined
  readonly model: string
  /** Milliseconds for the whole call, answer included. */
  readonly timeout: number
}

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

export const endpoint = "https://openrouter.ai/api/v1/chat/completions"
const referer = "https://github.com/novadeck-org/novadeck"

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

// The schema the answer is held to, from the same zod that reads it back. OpenRouter passes it
// to the provider, whose strict mode takes no `$schema` and no bounds on numbers.
export const withoutBounds = (schema: unknown): unknown =>
  Array.isArray(schema)
    ? schema.map(withoutBounds)
    : schema && typeof schema === "object"
      ? Object.fromEntries(
          Object.entries(schema)
            .filter(([key]) => !["$schema", "minimum", "maximum"].includes(key))
            .map(([key, value]) => [
              key,
              // The names under `properties` are the answer's own, whatever they are called.
              key === "properties" && value && typeof value === "object"
                ? Object.fromEntries(
                    Object.entries(value).map(([name, property]) => [
                      name,
                      withoutBounds(property),
                    ]),
                  )
                : withoutBounds(value),
            ]),
        )
      : schema
export const responseSchema = withoutBounds(z.toJSONSchema(modelOutput))

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

export type Answer = { text: string; outputTokens: number; model: string }

const textOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The message of an OpenRouter error object, `{ code, message }`, when that is what this is. */
const messageOf = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") return undefined
  const { code, message } = error as { code?: unknown; message?: unknown }
  // The text of a credit error says how much is left on the key, and logs are public.
  if (code === 402) return "not enough credit on the key (402)"
  return `${typeof code === "number" ? `${code}: ` : ""}${typeof message === "string" ? message : "an error"}`
}

// A piece of the answer: a stream's chunk, or the whole of a body that wasn't streamed.
type Chunk = {
  error?: unknown
  model?: unknown
  choices?: {
    finish_reason?: unknown
    error?: unknown
    delta?: { content?: unknown }
    message?: { content?: unknown }
  }[]
  usage?: { completion_tokens?: unknown }
}

const parseChunk = (raw: string): Chunk => {
  try {
    return JSON.parse(raw) as Chunk
  } catch (error) {
    throw new Skip(`The answer was not JSON: ${textOf(error)}`)
  }
}

/**
 * The text of the answer from what the body held: the `data:` lines of a stream, where
 * lines that start with `:` are comments (OpenRouter's keep-alives) and `[DONE]` ends it, or
 * a plain JSON body. Throws `Skip` for an error anywhere in it.
 */
const read = (text: string, fallbackModel: string): Answer => {
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line && line !== "[DONE]")
  const chunks = (data.length > 0 ? data : [text]).map(parseChunk)
  let content = ""
  let finish: unknown
  let model = fallbackModel
  let outputTokens = 0
  let sawChoice = false
  for (const chunk of chunks) {
    // An error can come in a 200 once the status was sent, or in the middle of a stream.
    const failure = messageOf(chunk?.error)
    if (failure) throw new Skip(`OpenRouter returned an error: ${failure}`)
    if (typeof chunk?.model === "string") model = chunk.model
    if (typeof chunk?.usage?.completion_tokens === "number")
      outputTokens = chunk.usage.completion_tokens
    const choice = chunk?.choices?.[0]
    if (!choice) continue
    sawChoice = true
    const choiceFailure = messageOf(choice.error)
    if (choiceFailure) throw new Skip(`The model failed: ${choiceFailure}`)
    const piece = choice.delta?.content ?? choice.message?.content
    if (typeof piece === "string") content += piece
    if (choice.finish_reason !== null && choice.finish_reason !== undefined)
      finish = choice.finish_reason
  }
  if (!sawChoice) throw new Skip("The answer had no choices")
  // `stop` is the one normal end; `length`, `content_filter`, `error` and the rest are not.
  if (finish !== "stop")
    throw new Skip(`The model stopped with finish_reason ${String(finish ?? null)}`)
  if (!content.trim()) throw new Skip("The answer had no text")
  return { text: content, outputTokens, model }
}

/**
 * Asks the model through OpenRouter, once, and returns the text of its answer, which the
 * caller parses and checks. The answer is streamed, because a long one would outlast the
 * body timeout of Node's `fetch` (5 minutes between chunks, and OpenRouter's keep-alive
 * comments are chunks); the timeout stays the wall-clock bound of the whole call. There is no
 * retry: a failed run keeps the release's body and the job can be run again, while a retry
 * would add a second timeout to the wait. Throws `Skip` for any error or answer that should
 * end in no notes; the rest is in the message.
 */
export const ask = async (
  client: Client,
  kind: "release" | "promote",
  version: string,
  items: readonly Item[],
): Promise<Answer> => {
  if (!client.apiKey) throw new Skip("No OPENROUTER_API_KEY")
  const key = client.apiKey
  // Nothing about the request may reach a message with the key in it.
  const redact = (text: string): string => text.replaceAll(key, "[key]")
  const signal = AbortSignal.timeout(client.timeout)
  const failed = (error: unknown): Skip =>
    signal.aborted
      ? new Skip(`The model did not answer within ${client.timeout / 1000} s`)
      : new Skip(`The request failed: ${redact(textOf(error))}`)
  let request: RequestInit
  try {
    request = {
      method: "POST",
      headers: new Headers({
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "Novadeck release notes",
      }),
      body: JSON.stringify({
        model: client.model,
        max_tokens: maxTokens[kind],
        // Usage arrives once, in the stream's last chunk, with nothing to ask for.
        stream: true,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userMessage(kind, version, items) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "release_notes", strict: true, schema: responseSchema },
        },
        // Only a provider that honours `response_format` may take the request. No `reasoning`
        // is sent: with this flag a model without that parameter would be left with no provider.
        provider: { require_parameters: true },
      }),
      signal,
    }
  } catch {
    // The error would name the header value, which is the key.
    throw new Skip("The request could not be built")
  }
  let response: Response
  try {
    response = await client.fetch(endpoint, request)
  } catch (error) {
    throw failed(error)
  }
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw failed(error)
  }
  if (response.status === 402) throw new Skip("OpenRouter: not enough credit on the key (402)")
  if (!response.ok) {
    let failure: string | undefined
    try {
      failure = messageOf((JSON.parse(text) as Chunk).error)
    } catch {
      // Not JSON: the status says what there is to say.
    }
    throw new Skip(`OpenRouter answered HTTP ${response.status}${failure ? ` (${failure})` : ""}`)
  }
  return read(text, client.model)
}

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
