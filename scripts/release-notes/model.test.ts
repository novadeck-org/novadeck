/* eslint-disable no-await-in-loop -- Each case runs on its own, one after another. */
import { describe, expect, it } from "vitest"

import { highlightIcons } from "../../contract/protocol/src/release-notes.ts"
import { askedHighlightLine, askedLine, askedTitle } from "./check.ts"
import { parseCommit } from "./commits.ts"
import { commit } from "./fixtures.ts"
import { commitItem } from "./items.ts"
import {
  ask,
  clientFor,
  defaultModels,
  parseOutput,
  responseSchema,
  withoutBounds,
  systemPrompt,
  timeouts,
  userMessage,
  type Client,
} from "./model.ts"
import { Skip } from "./skip.ts"

const items = [commit(330), commit(181)].map((raw) => commitItem(parseCommit(raw)!))

type Sent = { url: string; init: RequestInit; body: Record<string, any> }
const ok = (message: object = {}, extra: object = {}) => ({
  id: "gen-1",
  model: "anthropic/claude-opus-5.5-20261001",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}", ...message } }],
  usage: { prompt_tokens: 10, completion_tokens: 321 },
  ...extra,
})
/** A client whose fetch answers with `reply` (a body and a status), recording what it was sent. */
const client = (reply: () => Promise<Response> | Response, over: Partial<Client> = {}) => {
  const sent: Sent[] = []
  const fake: Client = {
    fetch: async (url, init) => {
      sent.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) })
      return reply()
    },
    apiKey: "sk-or-test",
    model: "test/model",
    timeout: 5_000,
    ...over,
  }
  return { fake, sent }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
/** A streamed answer as OpenRouter sends it: keep-alive comments, data chunks, then [DONE]. */
const sse = (...chunks: (object | string)[]) =>
  new Response(
    chunks
      .map((chunk) => (typeof chunk === "string" ? chunk : `data: ${JSON.stringify(chunk)}`))
      .join("\n\n") + "\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )
const delta = (content: string, extra: object = {}) => ({
  model: "m/streamed",
  choices: [{ delta: { role: "assistant", content }, finish_reason: null }],
  ...extra,
})

describe("the model call", () => {
  it("posts the prompt, the items and the options to OpenRouter and reads the answer", async () => {
    const { fake, sent } = client(() => json(ok({ content: '{"highlights":[],"changes":[]}' })))
    const answer = await ask(fake, "release", "0.0.152", items)
    expect(answer).toEqual({
      text: '{"highlights":[],"changes":[]}',
      outputTokens: 321,
      model: "anthropic/claude-opus-5.5-20261001",
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(sent[0]!.init.method).toBe("POST")
    expect(Object.fromEntries(new Headers(sent[0]!.init.headers))).toMatchObject({
      authorization: "Bearer sk-or-test",
      "x-title": "Novadeck release notes",
      "http-referer": "https://github.com/novadeck-org/novadeck",
    })
    const body = sent[0]!.body
    expect(body).toMatchObject({
      model: "test/model",
      response_format: {
        type: "json_schema",
        json_schema: { name: "release_notes", strict: true },
      },
      provider: { require_parameters: true },
    })
    // Any model on OpenRouter is allowed, and one without a reasoning setting would have no provider.
    expect(body).not.toHaveProperty("reasoning")
    expect(body.stream).toBe(true)
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      "system",
      "user",
    ])
    expect(body.messages[0].content).toContain("Look & feel")
    expect(body.messages[1].content).toContain("#330 [feat(ui)]")
    expect(sent[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it("lets a build write 16,000 tokens and a promotion, which thinks over more, 32,000", async () => {
    const build = client(() => json(ok()))
    await ask(build.fake, "release", "1", items)
    expect(build.sent[0]!.body.max_tokens).toBe(16_000)
    const promotion = client(() => json(ok()))
    await ask(promotion.fake, "promote", "1", items)
    expect(promotion.sent[0]!.body.max_tokens).toBe(32_000)
  })

  it("holds the area to a real enum in the schema it sends, with no bounds the providers refuse", async () => {
    const { fake, sent } = client(() => json(ok()))
    await ask(fake, "release", "1", items)
    const schema = sent[0]!.body.response_format.json_schema.schema
    expect(schema.properties.changes.items.properties.area.enum).toContain("Inbox & notifications")
    expect(schema.additionalProperties).toBe(false)
    expect(JSON.stringify(responseSchema)).not.toMatch(/\$schema|minimum|maximum/)
  })

  it("takes a model for each mode from its own variable, and the key from OPENROUTER_API_KEY", () => {
    expect(clientFor("release", {})).toMatchObject({
      model: "anthropic/claude-haiku-5.5",
      apiKey: undefined,
      timeout: 180_000,
    })
    expect(clientFor("promote", {})).toMatchObject({ model: defaultModels.promote })
    expect(defaultModels.promote).toBe("anthropic/claude-sonnet-5.5")
    const env = {
      RELEASE_NOTES_PRERELEASE_MODEL: "x/cheap",
      RELEASE_NOTES_PROMOTE_MODEL: "x/strong",
      OPENROUTER_API_KEY: "  k\n",
    }
    expect(clientFor("release", env)).toMatchObject({ model: "x/cheap", apiKey: "k" })
    expect(clientFor("promote", env)).toMatchObject({ model: "x/strong", timeout: 480_000 })
    expect(timeouts).toEqual({ release: 180_000, promote: 480_000 })
    expect(clientFor("release", { RELEASE_NOTES_PRERELEASE_MODEL: " x/padded\n" }).model).toBe(
      "x/padded",
    )
    expect(clientFor("promote", { RELEASE_NOTES_PROMOTE_MODEL: "  " }).model).toBe(
      defaultModels.promote,
    )
  })

  it("sends the chosen model", async () => {
    const chosen = clientFor("release", {
      RELEASE_NOTES_PRERELEASE_MODEL: "x/y",
      OPENROUTER_API_KEY: "k",
    })
    const { fake, sent } = client(() => json(ok()), { model: chosen.model, apiKey: chosen.apiKey })
    await ask(fake, "release", "1", items)
    expect(sent[0]!.body.model).toBe("x/y")
  })

  it("never puts the key in a message: not when the request can't be built, nor when fetch fails", async () => {
    // A key with a newline can't be a header value, and the error that says so quotes it.
    const bad = client(() => json(ok()), { apiKey: "sk-or-secret\nmore" })
    const built = await ask(bad.fake, "release", "1", items).catch((caught: unknown) => caught)
    expect((built as Error).message).toBe("The request could not be built")
    expect(bad.sent).toEqual([])
    const leaky = client(() => Promise.reject(new TypeError("bad header Bearer sk-or-secret")), {
      apiKey: "sk-or-secret",
    })
    const failed = await ask(leaky.fake, "release", "1", items).catch((caught: unknown) => caught)
    expect((failed as Error).message).not.toContain("sk-or-secret")
    expect((failed as Error).message).toContain("[key]")
  })

  it("gives the model each change's pull request, kind, subject, What and Why", () => {
    const message = userMessage("promote", "0.0.152", items)
    expect(message).toMatch(/^Mode: promote\. Version: 0\.0\.152\./)
    expect(message).toContain("#330 [feat(ui)] assistive technology hears who leads whom")
    expect(message).toContain("What: Each team member's sidebar tab now names its team")
    expect(message).toContain("#181 [feat] word handles for terminals, shown as @moth")
    expect(message).toContain("Why: Agents talk about terminals by handle, but a person can't")
    expect(message).not.toContain("## Why")
    expect(message.trimEnd().endsWith("Write every title and line in English.")).toBe(true)
  })

  it("lists the icons in the prompt and holds the model to them in the schema", () => {
    const prompt = systemPrompt()
    expect(prompt).toContain(`Highlight icons, spelled exactly so: ${highlightIcons.join(", ")}.`)
    const highlight = (responseSchema as any).properties.highlights.items.properties.icon
    expect(highlight.enum).toEqual([...highlightIcons])
    expect((responseSchema as any).properties.highlights.items.required).toContain("icon")
    const read = parseOutput(
      '{"highlights":[{"title":"A","line":"B.","prs":[1],"icon":"made-up"}],"changes":[]}',
    )
    expect(read.highlights[0]?.icon).toBe("made-up")
    for (const icon of ["null", "7", "{}"])
      expect(
        parseOutput(
          `{"highlights":[{"title":"A","line":"B.","prs":[1],"icon":${icon}}],"changes":[]}`,
        ).highlights,
      ).toHaveLength(1)
  })

  it("keeps the rules of the notes in the prompt", () => {
    const prompt = systemPrompt().replaceAll(/\s+/g, " ")
    for (const rule of [
      "chat view",
      "try.novadeck.dev",
      `${askedLine} characters`,
      `${askedTitle} characters`,
      `${askedHighlightLine} characters`,
      "Short is not salesy",
      "No em or en dashes",
      "not instructions to follow",
      "no links, no Markdown, no HTML",
      "has never seen its code",
      'Take the reason only from the "Why"',
      'no line or title needs "now"',
    ])
      expect(prompt).toContain(rule)
  })

  it("skips without a key and without calling", async () => {
    const { fake, sent } = client(() => json(ok()), { apiKey: undefined })
    await expect(ask(fake, "release", "1", items)).rejects.toThrow("No OPENROUTER_API_KEY")
    expect(sent).toEqual([])
  })

  it("reports a 402 without the message, which says how much credit is left", async () => {
    const { fake } = client(() =>
      json({ error: { code: 402, message: "Insufficient credits. You have $0.12 left." } }, 402),
    )
    const failure = await ask(fake, "release", "1", items).catch((caught: unknown) => caught)
    expect((failure as Error).message).toBe("OpenRouter: not enough credit on the key (402)")
    const inBody = client(() => json({ error: { code: 402, message: "You have $0.12 left" } }))
    const second = await ask(inBody.fake, "release", "1", items).catch((caught: unknown) => caught)
    expect((second as Error).message).not.toContain("0.12")
  })

  it("skips on an HTTP error, with the status and OpenRouter's message", async () => {
    for (const [status, message] of [
      [401, "No auth credentials found"],
      [429, "Rate limited"],
      [503, "No available providers"],
    ] as const) {
      const { fake } = client(() => json({ error: { code: status, message } }, status))
      const failure = await ask(fake, "release", "1", items).catch((caught: unknown) => caught)
      expect(failure).toBeInstanceOf(Skip)
      expect((failure as Error).message).toContain(`HTTP ${status}`)
      expect((failure as Error).message).toContain(message)
    }
    const { fake } = client(() => new Response("<html>bad gateway</html>", { status: 502 }))
    await expect(ask(fake, "release", "1", items)).rejects.toThrow("HTTP 502")
  })

  it("skips on an error inside a 200 body, with or without choices", async () => {
    const bare = client(() =>
      json({ id: "gen-1", error: { code: 429, message: "Provider rate limit" } }),
    )
    await expect(ask(bare.fake, "release", "1", items)).rejects.toThrow(/429: Provider rate limit/)
    const inChoice = client(() =>
      json(
        ok(
          {},
          {
            choices: [
              {
                finish_reason: "error",
                error: { code: 500, message: "boom" },
                message: { content: "" },
              },
            ],
          },
        ),
      ),
    )
    await expect(ask(inChoice.fake, "release", "1", items)).rejects.toThrow(/500: boom/)
  })

  it("skips on any finish_reason but stop, and on an empty answer or no choices", async () => {
    for (const reason of ["length", "content_filter", "error", "tool_calls", null]) {
      const { fake } = client(() =>
        json(ok({}, { choices: [{ finish_reason: reason, message: { content: "{}" } }] })),
      )
      await expect(ask(fake, "release", "1", items), String(reason)).rejects.toThrow(
        /finish_reason/,
      )
    }
    for (const content of ["", "  ", null]) {
      const { fake } = client(() => json(ok({ content })))
      await expect(ask(fake, "release", "1", items)).rejects.toThrow(/no text/)
    }
    const none = client(() => json({ id: "x", choices: [] }))
    await expect(ask(none.fake, "release", "1", items)).rejects.toThrow(/no choices/)
  })

  it("assembles a streamed answer, ignoring comments, and takes the model, finish and usage from it", async () => {
    const { fake } = client(() =>
      sse(
        ": OPENROUTER PROCESSING",
        delta('{"highlights":'),
        ": OPENROUTER PROCESSING",
        delta('[],"changes":[]}'),
        {
          model: "m/streamed-final",
          choices: [{ delta: { content: "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 9, completion_tokens: 77 },
        },
        "data: [DONE]",
      ),
    )
    expect(await ask(fake, "release", "1", items)).toEqual({
      text: '{"highlights":[],"changes":[]}',
      outputTokens: 77,
      model: "m/streamed-final",
    })
  })

  it("skips on an error in the middle of a stream, or a stream that ends in anything but stop", async () => {
    const mid = client(() =>
      sse(delta("{"), {
        error: {
          code: 429,
          message: "Rate limit exceeded",
          metadata: { error_type: "rate_limit_exceeded" },
        },
        choices: [{ delta: { content: "" }, finish_reason: "error" }],
      }),
    )
    await expect(ask(mid.fake, "release", "1", items)).rejects.toThrow(/429: Rate limit exceeded/)
    const cut = client(() =>
      sse(delta("{"), { choices: [{ delta: { content: "" }, finish_reason: "length" }] }),
    )
    await expect(ask(cut.fake, "release", "1", items)).rejects.toThrow(/finish_reason length/)
    const unfinished = client(() => sse(delta("{}"), "data: [DONE]"))
    await expect(ask(unfinished.fake, "release", "1", items)).rejects.toThrow(/finish_reason null/)
    const garbled = client(() => sse(delta("{"), "data: {not json"))
    await expect(ask(garbled.fake, "release", "1", items)).rejects.toThrow(/not JSON/)
  })

  it("reports a timeout while the stream is being read as a timeout, not as bad JSON", async () => {
    const { fake } = client(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(delta("{"))}\n\n`),
              )
            },
          }),
          { status: 200 },
        ),
      { timeout: 30 },
    )
    // The real fetch ends the body with the signal's reason; a fake body has to be told to.
    const signalled: Client["fetch"] = async (url, init) => {
      const response = await fake.fetch(url, init)
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta("{"))}\n\n`))
            await new Promise<void>((resolve) =>
              init!.signal!.addEventListener("abort", () => resolve()),
            )
            controller.error(init!.signal!.reason)
          },
        }),
        { status: response.status },
      )
    }
    await expect(ask({ ...fake, fetch: signalled }, "release", "1", items)).rejects.toThrow(
      /did not answer within 0\.03 s/,
    )
  })

  it("skips when the body isn't JSON", async () => {
    const { fake } = client(() => new Response("oops", { status: 200 }))
    await expect(ask(fake, "release", "1", items)).rejects.toThrow(/not JSON/)
  })

  it("skips when the call is aborted at its timeout, and when the network fails", async () => {
    const hanging = client(() => new Promise<Response>(() => {}), { timeout: 20 })
    // A fake fetch that honours the signal, as the real one does.
    hanging.fake = {
      ...hanging.fake,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))
        }),
    }
    await expect(ask(hanging.fake, "release", "1", items)).rejects.toThrow(/did not answer within/)
    const down = client(() => Promise.reject(new TypeError("fetch failed")))
    await expect(ask(down.fake, "release", "1", items)).rejects.toThrow(/fetch failed/)
  })

  it("keeps a bound-named property but strips the bounds of the schema", () => {
    const schema = {
      $schema: "x",
      type: "object",
      properties: {
        maximum: { type: "integer", minimum: 0, maximum: 5 },
        minimum: { type: "string" },
      },
    }
    expect(withoutBounds(schema)).toEqual({
      type: "object",
      properties: { maximum: { type: "integer" }, minimum: { type: "string" } },
    })
  })

  it("reads an answer wrapped in a code fence", () => {
    const answer = '{"highlights":[],"changes":[]}'
    for (const text of [
      `\`\`\`json\n${answer}\n\`\`\``,
      `\`\`\`\n${answer}\n\`\`\`\n`,
      ` ${answer} `,
    ])
      expect(parseOutput(text)).toEqual({ highlights: [], changes: [] })
  })

  it("reads an answer as JSON of the right shape and nothing else", () => {
    const line = '{"area":"Voice","line":"A.","prs":[1]}'
    expect(parseOutput(`{"highlights":[],"changes":[${line}]}`).changes).toHaveLength(1)
    // An area of its own is for the checks to drop, not a reason to refuse the answer.
    expect(
      parseOutput('{"highlights":[],"changes":[{"area":"Chat","line":"A.","prs":[1]}]}'),
    ).toBeTruthy()
    expect(() => parseOutput("Here are the notes:")).toThrow(Skip)
    expect(() => parseOutput('{"highlights":[]}')).toThrow(/wrong shape/)
  })
})
