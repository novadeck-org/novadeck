import { eventIterator, oc, type } from "@orpc/contract"
import { implement } from "@orpc/server"
import { RPCHandler } from "@orpc/server/message-port"
import { afterEach, describe, expect, it, vi } from "vitest"

import { portChannel, type MessagePortLike } from "./channel.js"
import { createWireClient, messagePort, websocket } from "./client.js"
import { normalize, WireError, wireErrors } from "./errors.js"
import { fakeChannel, memoryPorts } from "./testing.js"

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

  it("fails calls whose send throws, rather than throwing out of oRPC", async () => {
    const fake = fakeChannel()
    const client = createWireClient<typeof contract>(fake.channel)
    fake.failSends(new Error("Broken pipe."))
    await expect(client.echo("ping")).rejects.toBeInstanceOf(Error)
    await expect(client.echo("ping")).rejects.toBeInstanceOf(Error)
    // The peer is closed, but the channel isn't: nothing tells its owner to replace it.
    expect(fake.channel.open).toBe(true)
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

describe("messagePort", () => {
  it("connects once over a single port", async () => {
    const [port] = memoryPorts()
    const transport = messagePort(port)
    expect(transport.token).toBeUndefined()
    const channel = await transport.connect(new AbortController().signal)
    expect(channel.open).toBe(true)
    await expect(transport.connect(new AbortController().signal)).rejects.toMatchObject({
      code: "CLOSED",
    })
  })

  it("asks for a fresh port on each connection", async () => {
    const ask = vi.fn<(signal: AbortSignal) => Promise<MessagePortLike>>(() =>
      Promise.resolve(memoryPorts()[0]),
    )
    const transport = messagePort(ask)
    const signal = new AbortController().signal
    await transport.connect(signal)
    await transport.connect(signal)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask).toHaveBeenCalledWith(signal)
  })
})

describe("websocket", () => {
  type Listener = () => void
  const sockets: FakeWebSocket[] = []
  class FakeWebSocket {
    readyState = 0
    binaryType = "blob"
    readonly listeners: Record<string, Listener[]> = {}
    // As a real socket, its close event comes on a later task.
    readonly close = vi.fn<() => void>(() => void setTimeout(() => this.emit("close")))
    constructor(readonly url: string | URL) {
      sockets.push(this)
    }
    send() {}
    addEventListener(kind: string, listener: Listener) {
      ;(this.listeners[kind] ??= []).push(listener)
    }
    emit(kind: string) {
      if (kind === "open") this.readyState = 1
      if (kind === "close") this.readyState = 3
      for (const listener of this.listeners[kind] ?? []) listener()
    }
  }

  afterEach(() => {
    sockets.length = 0
    vi.unstubAllGlobals()
  })

  it("connects once the socket opens, keeping the token out of the URL", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket)
    const transport = websocket("ws://127.0.0.1:1/rpc", { token: "secret" })
    expect(transport.token).toBe("secret")
    const connecting = transport.connect(new AbortController().signal)
    sockets[0]!.emit("open")
    const channel = await connecting
    expect(channel.open).toBe(true)
    expect(String(sockets[0]!.url)).toBe("ws://127.0.0.1:1/rpc")
  })

  it("carries no token when it has none", () => {
    expect(websocket("ws://127.0.0.1:1/rpc").token).toBeUndefined()
  })

  it("fails as DISCONNECTED when the socket closes before it opens", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket)
    const connecting = websocket("ws://127.0.0.1:1/rpc").connect(new AbortController().signal)
    sockets[0]!.emit("close")
    await expect(connecting).rejects.toBeInstanceOf(WireError)
    await expect(connecting).rejects.toMatchObject({ code: "DISCONNECTED" })
  })

  it("closes the socket and fails with the reason when the signal aborts", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket)
    const abort = new AbortController()
    const connecting = websocket("ws://127.0.0.1:1/rpc").connect(abort.signal)
    const reason = new Error("Timed out.")
    abort.abort(reason)
    await expect(connecting).rejects.toBe(reason)
    expect(sockets[0]!.close).toHaveBeenCalled()
  })
})
