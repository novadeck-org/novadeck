import { Skip } from "./skip.ts"

// One question to a model through OpenRouter, for the scripts that write with one: the
// release notes (scripts/release-notes) and the nightly report's writeup (scripts/nightly).
// What each asks, and what it makes of the answer, is its own.

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

export const endpoint = "https://openrouter.ai/api/v1/chat/completions"
const referer = "https://github.com/novadeck-org/novadeck"

/** What a caller asks: its instructions, its input, and the JSON its answer must be. */
export type Question = {
  /** Names the caller to OpenRouter (`X-Title`). */
  readonly title: string
  readonly system: string
  readonly user: string
  /** The answer's JSON schema, as `withoutBounds` leaves it, and a name for it. */
  readonly schema: { readonly name: string; readonly json: unknown }
  /** The most the model may write. */
  readonly maxTokens: number
}

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
  } catch {
    // Not the parser's message: it quotes a piece of the answer, and a run's log mustn't hold
    // what the model wrote (the stats' digest writes about people's notes). The answer stays
    // on the Skip, for a dry run to show.
    throw new Skip("The answer was not JSON", raw)
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
 * retry: a caller that gets no answer goes on without one, and a retry would add a second
 * timeout to the wait. Throws `Skip` for any error or an answer that can't be used; the rest
 * is in the message.
 */
export const ask = async (client: Client, question: Question): Promise<Answer> => {
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
        "X-Title": question.title,
      }),
      body: JSON.stringify({
        model: client.model,
        max_tokens: question.maxTokens,
        // Usage arrives once, in the stream's last chunk, with nothing to ask for.
        stream: true,
        messages: [
          { role: "system", content: question.system },
          { role: "user", content: question.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: question.schema.name, strict: true, schema: question.schema.json },
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
