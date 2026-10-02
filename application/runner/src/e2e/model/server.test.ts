import { connect } from "node:net"

import { z } from "zod"

import { describe, expect, it as base } from "../../test.js"
import type { Dialect } from "./dialect.js"
import { gate } from "./script.js"
import { startFakeModel, type FakeModel } from "./server.js"

// A dialect that takes every request to /chat as a call of its body's text, and answers
// with the reply's text, and the headers it was given.
const echo: Dialect = {
  api: "anthropic",
  matches: (request) => request.path.startsWith("/chat"),
  handle: async (request, reply) => {
    if (request.path.startsWith("/chat/unserved")) return { status: 404, headers: {}, body: "" }
    const answer = await reply({
      api: "anthropic",
      model: "m",
      system: "",
      turns: [{ role: "user", text: request.body }],
      tools: [],
      side: false,
    })
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: [JSON.stringify({ text: answer.text, headers: request.headers })],
    }
  },
}

// A dialect that fails on every request to /broken, as one that misreads a harness would.
const broken: Dialect = {
  api: "anthropic",
  matches: (request) => request.path.startsWith("/broken"),
  handle: async (request) => {
    if (request.path.startsWith("/broken/parse"))
      z.object({ messages: z.array(z.string()) }).parse({ messages: [1] })
    if (request.path.startsWith("/broken/json")) JSON.parse(request.body)
    throw new Error("no messages in this request\nwith a second line")
  },
}

const it = base.extend<{ model: FakeModel }>({
  model: async ({ resources }, use) => {
    const model = await startFakeModel({
      dialects: [echo, broken],
      rules: [() => ({ text: "first" })],
    })
    resources.defer(() => model.close())
    await use(model)
  },
})

const chat = async (model: FakeModel, text: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${model.url}/chat`, { method: "POST", body: text, headers })
  return { status: response.status, body: await response.text() }
}

// Sends one raw request, as a proxy client would, and returns the status line.
const raw = (model: FakeModel, request: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(Number(new URL(model.url).port), "127.0.0.1")
    let answer = ""
    socket.on("error", reject)
    socket.on("data", (chunk) => (answer += chunk.toString()))
    socket.on("close", () => resolve(answer.split("\r\n")[0] ?? ""))
    socket.write(request)
  })

describe("startFakeModel", () => {
  it("answers a call through its dialect and records it", async ({ model }) => {
    const { status, body } = await chat(model, "hello")

    expect(status).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ text: "first" })
    expect(model.calls.map((call) => call.turns)).toEqual([[{ role: "user", text: "hello" }]])
  })

  it("asks rules added later first", async ({ model }) => {
    model.use((call) => (call.turns[0]?.text === "special" ? { text: "second" } : undefined))

    expect(JSON.parse((await chat(model, "special")).body).text).toBe("second")
    expect(JSON.parse((await chat(model, "plain")).body).text).toBe("first")
  })

  it("waits for a call made before or after it is asked for", async ({ model }) => {
    await chat(model, "early")
    const late = model.waitFor((call) => call.turns[0]?.text === "late")

    expect((await model.waitFor((call) => call.turns[0]?.text === "early")).turns).toHaveLength(1)
    await chat(model, "late")
    expect((await late).turns[0]).toEqual({ role: "user", text: "late" })
    await expect(model.waitFor(() => false, { timeoutMs: 50 })).rejects.toThrow(
      /No matching model call/,
    )
  })

  it("waits only for calls made from a mark on, when given one", async ({ model }) => {
    await chat(model, "same")
    const mark = model.mark()
    const next = model.waitFor((call) => call.turns[0]?.text === "same", { after: mark })
    await chat(model, "other")
    await chat(model, "same")

    expect(mark).toBe(1)
    expect(await next).toBe(model.calls[2])
    await expect(
      model.waitFor((call) => call.turns[0]?.text === "other", { after: 3, timeoutMs: 50 }),
    ).rejects.toThrow(/No matching model call from call 4 on/)
  })

  it("holds a reply a rule waits on, with the call already seen, until the gate opens", async ({
    model,
  }) => {
    const held = gate()
    model.use(async (call) => {
      if (call.turns[0]?.text !== "hold") return undefined
      await held.opened
      return { text: "released" }
    })
    let answered = false
    const response = chat(model, "hold").then((result) => {
      answered = true
      return result
    })

    const call = await model.waitFor((one) => one.turns[0]?.text === "hold")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(answered).toBe(false)
    expect(model.calls).toEqual([call])
    held.open()
    expect(JSON.parse((await response).body).text).toBe("released")
  })

  it("accepts its own credential, alone or as a bearer token, and passes on no credential", async ({
    model,
  }) => {
    const keyed = await chat(model, "a", { "x-api-key": model.credential })
    const bearer = await chat(model, "b", { authorization: `Bearer ${model.credential}` })

    expect([keyed.status, bearer.status]).toEqual([200, 200])
    expect(JSON.parse(keyed.body).headers).not.toHaveProperty("x-api-key")
    expect(JSON.parse(bearer.body).headers).not.toHaveProperty("authorization")
    expect(model.foreign).toBe(0)
  })

  it("refuses and counts any other credential, never keeping it", async ({ model }) => {
    const refused = [
      await chat(model, "a", { "x-api-key": "sk-real-one" }),
      await chat(model, "b", { authorization: "Bearer real-token" }),
      await chat(model, "c", { "x-goog-api-key": "real" }),
    ]

    expect(refused.map((one) => one.status)).toEqual([401, 401, 401])
    expect(model.foreign).toBe(3)
    expect(model.calls).toEqual([])
    expect(JSON.stringify([model.strays, refused])).not.toMatch(/real/)
  })

  it("takes a `key` query parameter as a credential, and refuses any but its own", async ({
    model,
  }) => {
    const own = await fetch(`${model.url}/chat?key=${model.credential}`, {
      method: "POST",
      body: "a",
    })
    const other = await fetch(`${model.url}/chat?key=real-key`, { method: "POST", body: "b" })

    expect([own.status, other.status]).toEqual([200, 401])
    expect(model.foreign).toBe(1)
    expect(model.calls).toHaveLength(1)
  })

  it("passes on a credential header left empty, or holding an auth scheme alone", async ({
    model,
  }) => {
    const empty = await chat(model, "a", { "x-api-key": "", authorization: "" })
    const scheme = await chat(model, "b", { authorization: "Bearer " })

    expect([empty.status, scheme.status]).toEqual([200, 200])
    expect(model.foreign).toBe(0)
  })

  it("refuses a tunnel through it, recording only its host", async ({ model }) => {
    const status = await raw(
      model,
      "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n",
    )

    expect(status).toBe("HTTP/1.1 403 Forbidden")
    expect(model.strays).toEqual(["CONNECT api.anthropic.com"])
  })

  it("refuses a request for another server, recording only its host", async ({ model }) => {
    const status = await raw(
      model,
      "GET http://example.com/secret?key=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
    )

    expect(status).toBe("HTTP/1.1 403 Forbidden")
    expect(model.strays).toEqual(["GET example.com"])
  })

  it("records the host of a request for another server that carried a foreign credential", async ({
    model,
  }) => {
    const status = await raw(
      model,
      "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nAuthorization: Bearer real-token\r\nConnection: close\r\n\r\n",
    )

    expect(status).toBe("HTTP/1.1 403 Forbidden")
    expect(model.strays).toEqual(["GET example.com"])
    expect(model.foreign).toBe(1)
  })

  it("records a dialect's failure by its request's method and path and its message's first line", async ({
    model,
  }) => {
    const response = await fetch(`${model.url}/broken?key=${model.credential}`, {
      method: "POST",
      body: "a secret body",
    })

    expect(response.status).toBe(500)
    expect(model.errors).toEqual(["POST /broken: no messages in this request"])
  })

  it("records a dialect's failure to parse by its first issue's path and message", async ({
    model,
  }) => {
    const response = await fetch(`${model.url}/broken/parse`, { method: "POST", body: "{}" })

    expect(response.status).toBe(500)
    expect(model.errors).toEqual([
      "POST /broken/parse: messages.0: Invalid input: expected string, received number",
    ])
  })

  it("records a body that isn't JSON without quoting it", async ({ model }) => {
    const response = await fetch(`${model.url}/broken/json`, {
      method: "POST",
      body: "grant_type=refresh_token&refresh_token=abcdef",
    })

    expect(response.status).toBe(500)
    expect(model.errors).toEqual(["POST /broken/json: the body is not JSON"])
    expect(await response.text()).not.toContain("grant_type")
  })

  it("records a request its dialect doesn't serve as a stray", async ({ model }) => {
    const response = await fetch(`${model.url}/chat/unserved?page=1`)

    expect(response.status).toBe(404)
    expect(model.strays).toEqual(["GET /chat/unserved"])
  })

  it("records a request no dialect answers by its path, without its query", async ({ model }) => {
    const response = await fetch(`${model.url}/v1/unknown?page=1`)

    expect(response.status).toBe(404)
    expect(model.strays).toEqual(["GET /v1/unknown"])
  })
})
