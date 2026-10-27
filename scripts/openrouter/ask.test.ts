import { context, describe, expect, it } from "../test"
import { ask, type Client } from "./ask"
import { Skip } from "./skip"

// The helper's own behaviour: what it makes of an answer that can't be read.

const answering = (body: string): Client => ({
  fetch: (async () => new Response(body, { status: 200 })) as typeof fetch,
  apiKey: "test-key",
  model: "test/model",
  timeout: 1_000,
})

const question = {
  title: "test",
  system: "Answer.",
  user: "A question.",
  schema: { name: "test", json: { type: "object" } },
  maxTokens: 10,
}

describe("ask", () => {
  context("when an answer isn't JSON", () => {
    it("says so without quoting a piece of it, and keeps it on the Skip for a dry run", async () => {
      const said = "data: it crashes when I open Grid\n\n"
      const failure = await ask(answering(said), question).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(Skip)
      expect((failure as Skip).message).toBe("The answer was not JSON")
      expect((failure as Skip).raw).toContain("it crashes when I open Gr")
    })
  })
})
