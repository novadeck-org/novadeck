import { eventIterator, oc, type } from "@orpc/contract"
import { createRouterClient, implement, lazy, ORPCError, type AnyRouter } from "@orpc/server"
import { describe, expect, it, vi } from "vitest"

import { wireContract } from "./handshake.js"
import {
  createSessions,
  type Session,
  type SessionContext,
  type SessionsOptions,
} from "./sessions.js"

const contract = {
  ...wireContract,
  echo: oc.input(type<string>()).output(type<string>()),
  // Answers once `release` is called, holding its call meanwhile.
  held: oc.input(type<void>()).output(type<string>()),
  fail: oc.input(type<void>()).output(type<void>()),
  ticks: oc.input(type<void>()).output(eventIterator(type<number>())),
  // A stream made as it's asked for, not when it's first read.
  made: oc.input(type<void>()).output(eventIterator(type<number>())),
}

const protocolVersion = 7

class AppError extends Error {}

// A server of the test contract, and a client for each session, called in its context as a
// transport would.
const serve = (options: Partial<SessionsOptions> = {}) => {
  const held: (() => void)[] = []
  const started: string[] = []
  // How many of the streams `made` gave back were told they're done.
  const ended = { count: 0 }
  const { wire: _, ...app } = contract
  const api = implement(app).$context<SessionContext>()
  const sessions = createSessions({
    protocolVersion,
    router: api.router({
      echo: api.echo.handler(({ input }) => input),
      held: api.held.handler(
        () => new Promise<string>((resolve) => held.push(() => resolve("released"))),
      ),
      fail: api.fail.handler(() => {
        throw new AppError("Refused.")
      }),
      ticks: api.ticks.handler(async function* ({ context }) {
        started.push(context.session.id)
        for (let tick = 0; ; tick += 1) {
          if (tick === 2) throw new AppError("Stopped.")
          yield tick
          // eslint-disable-next-line no-await-in-loop -- One tick at a time, as a reader asks.
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }),
      made: api.made.handler(() => {
        const stream: AsyncIterableIterator<number> = {
          [Symbol.asyncIterator]: () => stream,
          next: () => Promise.resolve({ done: false, value: 1 }),
          return: () => {
            ended.count += 1
            return Promise.resolve({ done: true, value: undefined })
          },
        }
        return stream as unknown as AsyncIteratorObject<number, unknown, void>
      }),
    }),
    error: (error) =>
      error instanceof AppError
        ? new ORPCError("APP", { status: 409, message: error.message })
        : error,
    ...options,
  })
  const open = (transport: { maxCalls?: number; token?: string } = {}) => {
    const terminate = vi.fn<() => void>()
    const authenticated = vi.fn<() => void>()
    const session = sessions.open({
      verify: (token) => token === (transport.token ?? "secret"),
      terminate,
      authenticated,
      maxCalls: transport.maxCalls ?? 8,
    })
    const client = createRouterClient(sessions.router, { context: { session } }) as unknown as {
      wire: {
        handshake: (input: {
          protocolVersion: number
          token?: string
          clientId?: string
        }) => Promise<{ epoch: string; protocolVersion: number }>
      }
      echo: (input: string) => Promise<string>
      held: () => Promise<string>
      fail: () => Promise<void>
      ticks: () => Promise<AsyncIterator<number>>
      made: () => Promise<AsyncIterator<number>>
    }
    const handshake = (clientId?: string) =>
      client.wire.handshake({
        protocolVersion,
        token: "secret",
        ...(clientId !== undefined && { clientId }),
      })
    return { session, client, terminate, authenticated, handshake }
  }
  return { sessions, open, held, started, ended }
}

describe("createSessions", () => {
  it("serves a session only once its handshake proves it", async () => {
    const { sessions, open } = serve()
    const { session, client, authenticated, handshake } = open()
    await expect(client.echo("hi")).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 })
    await expect(client.wire.handshake({ protocolVersion, token: "wrong" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    await expect(client.echo("hi")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    expect(authenticated).not.toHaveBeenCalled()
    await expect(handshake()).resolves.toEqual({ epoch: sessions.epoch, protocolVersion })
    expect(session.authenticated).toBe(true)
    expect(authenticated).toHaveBeenCalledOnce()
    await expect(client.echo("hi")).resolves.toBe("hi")
  })

  it("refuses a client that speaks another protocol", async () => {
    const { open } = serve()
    const { client } = open()
    await expect(
      client.wire.handshake({ protocolVersion: protocolVersion + 1, token: "secret" }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_PROTOCOL", status: 409 })
    await expect(client.echo("hi")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("tells a client with a wrong token nothing about the protocol", async () => {
    const { open } = serve()
    const { client } = open()
    await expect(
      client.wire.handshake({ protocolVersion: protocolVersion + 1, token: "wrong" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("lets the app refuse a session that proved itself, with its own code", async () => {
    const admitted: Session[] = []
    const { open } = serve({
      admit: (session) => {
        admitted.push(session)
        throw new ORPCError("NOT_YET", { status: 409 })
      },
    })
    const { session, client, handshake } = open()
    await expect(client.wire.handshake({ protocolVersion, token: "wrong" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    expect(admitted).toEqual([])
    await expect(handshake()).rejects.toMatchObject({ code: "NOT_YET", status: 409 })
    expect(admitted).toEqual([session])
    expect(session.authenticated).toBe(false)
    await expect(client.echo("hi")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("names its epoch, a fresh one by default", () => {
    expect(serve({ epoch: "e1" }).sessions.epoch).toBe("e1")
    expect(serve().sessions.epoch).not.toBe(serve().sessions.epoch)
  })

  it("hands a client's state over from its older session, ending that one", async () => {
    const closed = vi.fn<(session: Session) => void>()
    const { open } = serve({ closed })
    const clientId = crypto.randomUUID()
    const old = open()
    await old.handshake(clientId)
    const ticks = await old.client.ticks()
    await ticks.next()
    const other = open()
    await other.handshake(crypto.randomUUID())
    const fresh = open()
    await fresh.handshake(clientId)
    expect(closed.mock.calls).toEqual([[old.session]])
    expect(old.session.closed).toBe(true)
    expect(old.terminate).toHaveBeenCalledOnce()
    expect(other.session.closed).toBe(false)
    expect(fresh.session.clientId).toBe(clientId)
    await expect(old.client.echo("hi")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    expect(await ticks.next()).toEqual({ done: true, value: undefined })
    await expect(fresh.client.echo("hi")).resolves.toBe("hi")
  })

  it("closes a session once, telling the app", async () => {
    const closed = vi.fn<(session: Session) => void>()
    const { sessions, open } = serve({ closed })
    const { session, client, handshake } = open()
    await handshake()
    sessions.close(session)
    sessions.close(session)
    expect(closed.mock.calls).toEqual([[session]])
    await expect(client.echo("hi")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(handshake()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("refuses a lazy router, which would hide the handshake", () => {
    expect(() =>
      createSessions({
        protocolVersion,
        // The types refuse one already; a caller that casts is refused here.
        router: lazy(async () => ({ default: {} })) as unknown as AnyRouter,
      }),
    ).toThrow("can't be lazy")
  })

  it("refuses an app router that serves the wire's procedures itself", () => {
    expect(() => createSessions({ protocolVersion, router: { wire: {} } })).toThrow(
      "can't serve the wire's procedures",
    )
  })

  it("limits the calls one session may have running", async () => {
    const { open, held } = serve()
    const { client, handshake } = open({ maxCalls: 2 })
    await handshake()
    const first = client.held()
    const second = client.held()
    await vi.waitFor(() => expect(held).toHaveLength(2))
    await expect(client.echo("hi")).rejects.toMatchObject({ code: "RESOURCE_LIMIT", status: 429 })
    held.shift()!()
    await expect(first).resolves.toBe("released")
    await expect(client.echo("hi")).resolves.toBe("hi")
    held.shift()!()
    await expect(second).resolves.toBe("released")
  })

  it("counts a stream as a call only until it's handed back, not while it runs", async () => {
    const { open } = serve()
    const { client, handshake } = open({ maxCalls: 1 })
    await handshake()
    const ticks = await client.ticks()
    expect(await ticks.next()).toEqual({ done: false, value: 0 })
    await expect(client.echo("hi")).resolves.toBe("hi")
    const more = await client.ticks()
    expect(await more.next()).toEqual({ done: false, value: 0 })
    await ticks.return?.()
    await more.return?.()
  })

  it("maps the app's failures, of calls and of streams", async () => {
    const { open } = serve()
    const { client, handshake } = open()
    await handshake()
    await expect(client.fail()).rejects.toMatchObject({
      code: "APP",
      status: 409,
      message: "Refused.",
    })
    const ticks = await client.ticks()
    expect(await ticks.next()).toEqual({ done: false, value: 0 })
    expect(await ticks.next()).toEqual({ done: false, value: 1 })
    await expect(ticks.next()).rejects.toMatchObject({ code: "APP", message: "Stopped." })
  })

  it("ends a stream once its session closes, and never starts one that closed first", async () => {
    const { sessions, open, started } = serve()
    const { session, client, handshake } = open()
    await handshake()
    const running = await client.ticks()
    expect(await running.next()).toEqual({ done: false, value: 0 })
    const late = await client.ticks()
    sessions.close(session)
    expect(await running.next()).toEqual({ done: true, value: undefined })
    expect(await late.next()).toEqual({ done: true, value: undefined })
    expect(started).toEqual([session.id])
  })

  it("tells a stream made for a session that closed first that it's done", async () => {
    const { sessions, open, ended } = serve()
    const { session, client, handshake } = open()
    await handshake()
    const made = await client.made()
    sessions.close(session)
    expect(await made.next()).toEqual({ done: true, value: undefined })
    expect(ended.count).toBe(1)
  })
})
