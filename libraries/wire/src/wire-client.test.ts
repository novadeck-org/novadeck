import { eventIterator, oc, type } from "@orpc/contract"
import { implement } from "@orpc/server"
import { RPCHandler } from "@orpc/server/message-port"
import { describe, expect, it, vi } from "vitest"

import { portChannel } from "./channel.js"
import { normalize, WireError, wireErrors } from "./errors.js"
import { fakeChannel, memoryPorts } from "./testing.js"
import { createWireClient } from "./wire-client.js"

// A contract of the wire's own, to test the client against with no app's server.
const contract = {
  echo: oc.errors(wireErrors).input(type<string>()).output(type<string>()),
  count: oc.input(type<number>()).output(eventIterator(type<number>())),
  hang: oc.input(type<void>()).output(type<void>()),
  refuse: oc.errors(wireErrors).input(type<void>()).output(type<void>()),
}

// Resolves once a call has reached the server, so a test can close the channel under it.
const serve = () => {
  let reached = () => {}
  const reachedServer = new Promise<void>((resolve) => {
    reached = resolve
  })
  const api = implement(contract)
  const router = api.router({
    echo: api.echo.handler(({ input }) => input),
    count: api.count.handler(async function* ({ input }) {
      for (let at = 1; at <= input; at += 1) yield at
      reached()
      await new Promise(() => {})
    }),
    hang: api.hang.handler(() => {
      reached()
      return new Promise<void>(() => {})
    }),
    refuse: api.refuse.handler(({ errors }) => {
      throw errors.RESOURCE_LIMIT({ message: "Too many calls." })
    }),
  })
  const [server, client] = memoryPorts()
  new RPCHandler(router).upgrade(server, { context: {} })
  const channel = portChannel(client)
  return { channel, server, client: createWireClient<typeof contract>(channel), reachedServer }
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("It resolved.")
    },
    (error: unknown) => normalize(error),
  )

describe("createWireClient", () => {
  it("calls a server's procedures over a channel", async () => {
    const { client } = serve()
    expect(await client.echo("ping")).toBe("ping")
  })

  it("streams a server's events", async () => {
    const { client } = serve()
    const events = await client.count(3)
    const seen: number[] = []
    for await (const event of events) {
      seen.push(event)
      if (seen.length === 3) break
    }
    expect(seen).toEqual([1, 2, 3])
  })

  it("reports a server's refusal with its code, as a wire error", async () => {
    const { client } = serve()
    expect(await failure(client.refuse())).toMatchObject({
      code: "RESOURCE_LIMIT",
      message: "Too many calls.",
    })
  })

  it("fails a call in flight as soon as the channel closes", async () => {
    const { client, server, reachedServer } = serve()
    const call = failure(client.hang())
    await reachedServer
    server.close()
    expect(await call).toMatchObject({ code: "DISCONNECTED" })
  })

  // oRPC fails a stream's pending read with an error of its own, not the close's reason;
  // a caller that needs the cause asks the channel whether it's still open.
  it("ends a stream as soon as the channel closes", async () => {
    const { channel, client, server, reachedServer } = serve()
    const events = await client.count(1)
    expect(await events.next()).toEqual({ done: false, value: 1 })
    await reachedServer
    const next = events.next()
    server.close()
    const error = await next.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(WireError)
    expect(channel.open).toBe(false)
  })

  it("fails a call on a closed channel without sending it", async () => {
    const fake = fakeChannel()
    const client = createWireClient<typeof contract>(fake.channel)
    fake.drop()
    expect(await failure(client.echo("ping"))).toMatchObject({ code: "DISCONNECTED" })
    expect(fake.sent).toEqual([])
  })

  it("fails a call whose signal has aborted without sending it", async () => {
    const fake = fakeChannel()
    const client = createWireClient<typeof contract>(fake.channel)
    const reason = new Error("Gave up.")
    await expect(client.echo("ping", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    expect(fake.sent).toEqual([])
  })

  it("fails calls and closes the channel when a send throws, rather than throwing out of oRPC", async () => {
    const fake = fakeChannel()
    const client = createWireClient<typeof contract>(fake.channel)
    fake.failSends(new Error("Broken pipe."))
    await expect(client.echo("ping")).rejects.toBeInstanceOf(Error)
    // The channel closes with the peer, so its owner replaces it.
    expect(fake.channel.open).toBe(false)
    expect(await failure(client.echo("ping"))).toMatchObject({ code: "DISCONNECTED" })
  })

  it("fails its calls on a message it can't read", async () => {
    const fake = fakeChannel()
    const client = createWireClient<typeof contract>(fake.channel)
    const call = client.echo("ping")
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    fake.receive("not a message")
    await expect(call).rejects.toBeInstanceOf(Error)
  })
})
