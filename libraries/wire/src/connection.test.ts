import { oc, type } from "@orpc/contract"
import { implement, ORPCError } from "@orpc/server"
import { RPCHandler } from "@orpc/server/message-port"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import type { Channel, MessagePortLike } from "./channel.js"
import { connect, Watched, type ConnectOptions, type HandshakeInput } from "./connection.js"
import { wireErrors } from "./errors.js"
import { fakeChannel, memoryPorts } from "./testing.js"
import { messagePort } from "./transport.js"

const contract = {
  hello: oc
    .errors(wireErrors)
    .input(type<{ clientId: string; token?: string }>())
    .output(type<{ epoch: string }>()),
  echo: oc.input(type<string>()).output(type<string>()),
}

type Server = {
  epoch: string
  // What the next handshakes answer, in turn; once spent, they answer with the epoch.
  refusals: (() => never)[]
  // Holds every handshake back, as a server that never answers.
  silent: boolean
  seen: Omit<HandshakeInput, "signal">[]
  ports: MessagePortLike[]
  // How many of its ports have closed.
  closed: number
}

// A server for the test contract, reached over a fresh in-memory port each connection.
const serve = (): Server & { transport: ConnectOptions<typeof contract>["transport"] } => {
  const server: Server = {
    epoch: "e1",
    refusals: [],
    silent: false,
    seen: [],
    ports: [],
    closed: 0,
  }
  const api = implement(contract)
  const router = api.router({
    hello: api.hello.handler(({ input }) => {
      server.seen.push(input)
      if (server.silent) return new Promise<never>(() => {})
      server.refusals.shift()?.()
      return { epoch: server.epoch }
    }),
    echo: api.echo.handler(({ input }) => input),
  })
  const transport = messagePort(() => {
    const [end, client] = memoryPorts()
    server.ports.push(end)
    end.addEventListener("close", () => (server.closed += 1))
    new RPCHandler(router).upgrade(end, { context: {} })
    return Promise.resolve(client)
  })
  return Object.assign(server, { transport })
}

// Drops the connection from the server's side, as a restart or a network failure does.
const drop = (server: Server) => server.ports.at(-1)!.close()

const open = async (
  server: Server & { transport: ConnectOptions<typeof contract>["transport"] },
  options: Partial<ConnectOptions<typeof contract>> = {},
) => {
  const wire = await connect({
    contract,
    transport: server.transport,
    handshake: (client, { clientId, token, signal }) =>
      client.hello({ clientId, ...(token !== undefined && { token }) }, { signal }),
    retryDelay: () => 0,
    ...options,
  })
  onTestFinished(() => wire.close())
  return wire
}

const until = async (wire: Awaited<ReturnType<typeof open>>, state: string) => {
  while (wire.status.value.state !== state)
    // eslint-disable-next-line no-await-in-loop -- Each change in turn.
    await wire.status.next()
}

const refusal = (code: keyof typeof wireErrors | "WORKSPACE_TOO_NEW") => () => {
  throw new ORPCError(code)
}

describe("connect", () => {
  it("resolves after the handshake, connected in the epoch it names", async () => {
    const server = serve()
    const wire = await open(server)
    expect(wire.status.value).toEqual({ state: "connected", epoch: "e1" })
    expect(await wire.session().client.echo("ping")).toBe("ping")
    expect(wire.session().epoch).toBe("e1")
  })

  it("sends the transport's token, and one client id for every connection", async () => {
    const server = serve()
    const wire = await open(server, { transport: { ...server.transport, token: "secret" } })
    drop(server)
    await until(wire, "reconnecting")
    await until(wire, "connected")
    expect(server.seen).toHaveLength(2)
    expect(server.seen[0]).toEqual({ clientId: expect.any(String), token: "secret" })
    expect(server.seen[1]).toEqual(server.seen[0])
  })

  it("reconnects after a drop, in the server's new epoch", async () => {
    const server = serve()
    const wire = await open(server)
    const states = wire.status.watch()
    expect((await states.next()).value).toEqual({ state: "connected", epoch: "e1" })
    server.epoch = "e2"
    drop(server)
    expect((await states.next()).value).toMatchObject({
      state: "reconnecting",
      error: { code: "DISCONNECTED" },
    })
    await until(wire, "connected")
    expect(wire.status.value).toEqual({ state: "connected", epoch: "e2" })
    expect(await wire.session().client.echo("again")).toBe("again")
  })

  it("refuses calls while it reconnects, rather than queueing them", async () => {
    const server = serve()
    const wire = await open(server, { retryDelay: () => 60_000 })
    drop(server)
    await until(wire, "reconnecting")
    expect(() => wire.session()).toThrow(expect.objectContaining({ code: "DISCONNECTED" }))
  })

  it("backs off between failed attempts, and keeps trying", async () => {
    const server = serve()
    const delays: number[] = []
    const wire = await open(server, {
      retryDelay: (attempt) => {
        delays.push(attempt)
        return 0
      },
    })
    server.refusals.push(refusal("RESOURCE_LIMIT"), refusal("RESOURCE_LIMIT"))
    drop(server)
    await until(wire, "reconnecting")
    await until(wire, "connected")
    expect(delays).toEqual([0, 1, 2])
  })

  it("waits for a live session through a reconnection", async () => {
    const server = serve()
    const wire = await open(server)
    drop(server)
    await until(wire, "reconnecting")
    server.epoch = "e2"
    expect((await wire.ready())?.epoch).toBe("e2")
  })

  it("closes for good on a fatal code of the wire's own", async () => {
    const server = serve()
    const wire = await open(server)
    server.refusals.push(refusal("UNAUTHORIZED"))
    drop(server)
    await until(wire, "closed")
    expect(wire.status.value).toMatchObject({ state: "closed", error: { code: "UNAUTHORIZED" } })
    await expect(wire.ready()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    expect(() => wire.session()).toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }))
  })

  it("closes for good on a code the app names fatal", async () => {
    const server = serve()
    const wire = await open(server, { fatal: (code) => code === "WORKSPACE_TOO_NEW" })
    server.refusals.push(refusal("WORKSPACE_TOO_NEW"))
    drop(server)
    await until(wire, "closed")
    expect(wire.status.value).toMatchObject({ error: { code: "WORKSPACE_TOO_NEW" } })
  })

  it("closes for good once a single port is spent", async () => {
    const [end, client] = memoryPorts()
    const api = implement(contract)
    const router = api.router({
      hello: api.hello.handler(() => ({ epoch: "e1" })),
      echo: api.echo.handler(({ input }) => input),
    })
    new RPCHandler(router).upgrade(end, { context: {} })
    const wire = await open({ ...serve(), transport: messagePort(client) })
    end.close()
    await until(wire, "closed")
    expect(wire.status.value).toMatchObject({ error: { code: "CLOSED" } })
  })

  it("fails the first connection with the handshake's refusal", async () => {
    const server = serve()
    server.refusals.push(refusal("INCOMPATIBLE_PROTOCOL"))
    await expect(open(server)).rejects.toMatchObject({ code: "INCOMPATIBLE_PROTOCOL" })
  })

  it("gives up on a handshake that never answers", async () => {
    const server = serve()
    server.silent = true
    await expect(open(server, { timeoutMs: 20 })).rejects.toMatchObject({ code: "DISCONNECTED" })
    // The channel it gave up on is closed, not left open.
    expect(server.closed).toBe(1)
  })

  it("stops the first connection when its signal aborts", async () => {
    const server = serve()
    server.silent = true
    const abort = new AbortController()
    const opening = open(server, { signal: abort.signal })
    const reason = new Error("Gave up.")
    await vi.waitFor(() => expect(server.seen).toHaveLength(1))
    abort.abort(reason)
    await expect(opening).rejects.toBe(reason)
  })

  it("stays cancelled when a handshake that ignores its signal answers late", async () => {
    const server = serve()
    let answer: (() => void) | undefined
    const abort = new AbortController()
    const opening = open(server, {
      signal: abort.signal,
      handshake: () =>
        new Promise((resolve) => {
          answer = () => resolve({ epoch: "late" })
        }),
    })
    await vi.waitFor(() => expect(answer).toBeDefined())
    const reason = new Error("Gave up.")
    abort.abort(reason)
    answer?.()
    await expect(opening).rejects.toBe(reason)
    expect(server.closed).toBe(1)
  })

  it("closes on request, ending its session and every watch", async () => {
    const server = serve()
    const wire = await open(server)
    const states = wire.status.watch()
    await states.next()
    const session = wire.session()
    wire.close()
    expect(wire.status.value).toEqual({ state: "closed" })
    expect(session.channel.open).toBe(false)
    expect((await states.next()).value).toEqual({ state: "closed" })
    expect(await states.next()).toEqual({ done: true, value: undefined })
    expect(await wire.ready()).toBeUndefined()
  })

  it("stops reconnecting once closed", async () => {
    const server = serve()
    const wire = await open(server, { retryDelay: () => 10 })
    drop(server)
    await until(wire, "reconnecting")
    wire.close()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(server.seen).toHaveLength(1)
    expect(wire.status.value).toEqual({ state: "closed" })
  })

  it("replaces a channel that can no longer send", async () => {
    const fake = fakeChannel()
    let connections = 0
    let first: Channel | undefined
    const server = serve()
    const wire = await open(server, {
      transport: {
        connect: async (signal) => {
          connections += 1
          if (connections > 1) return fake.channel
          first = await server.transport.connect(signal)
          return first
        },
      },
    })
    // The first channel's port breaks: every send throws.
    const send = vi.spyOn(first!, "send").mockImplementation(() => {
      throw new Error("Broken pipe.")
    })
    await expect(wire.session().client.echo("ping")).rejects.toBeInstanceOf(Error)
    expect(send).toHaveBeenCalled()
    expect(first!.open).toBe(false)
    await until(wire, "reconnecting")
    await vi.waitFor(() => expect(connections).toBe(2))
  })
})

describe("Watched", () => {
  it("yields the latest value, coalescing quick changes, and ends after a final one", async () => {
    const watched = new Watched(0, (value) => value < 0)
    const values = watched.watch()
    expect((await values.next()).value).toBe(0)
    watched.set(1)
    watched.set(2)
    expect((await values.next()).value).toBe(2)
    watched.set(-1)
    expect((await values.next()).value).toBe(-1)
    expect((await values.next()).done).toBe(true)
  })

  it("ends a pending wait on return()", async () => {
    const watched = new Watched(0, () => false)
    const values = watched.watch()
    await values.next()
    const pending = values.next()
    await values.return?.()
    expect(await pending).toEqual({ done: true, value: undefined })
  })
})
