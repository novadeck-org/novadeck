import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { oc, type } from "@orpc/contract"
import { implement } from "@orpc/server"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { WebSocket, type ClientOptions } from "ws"

import { socketChannel } from "./channel.js"
import { connect } from "./connection.js"
import { wireContract } from "./handshake.js"
import {
  createSessions,
  type Session,
  type SessionContext,
  type SessionsOptions,
} from "./sessions.js"
import { websocket } from "./transport.js"
import { serveWebSocket, type WebSocketOptions } from "./websocket.js"
import { createWireClient } from "./wire-client.js"

const contract = {
  ...wireContract,
  echo: oc.input(type<string>()).output(type<string>()),
}

const protocolVersion = 1
const token = "wire-tests-only-not-a-production-credential"

// Serves the test contract's sessions on a fresh HTTP server, at /rpc.
const serve = async (
  options: Partial<WebSocketOptions> = {},
  sessionOptions: Partial<SessionsOptions> = {},
) => {
  const { wire: _, ...app } = contract
  const api = implement(app).$context<SessionContext>()
  const sessions = createSessions({
    protocolVersion,
    router: api.router({ echo: api.echo.handler(({ input }) => input) }),
    ...sessionOptions,
  })
  const sockets = serveWebSocket(sessions, {
    path: "/rpc",
    ...(options.verify === undefined && { token }),
    origins: ["https://trusted.test"],
    maxPayloadBytes: 1024 * 1024,
    sendBudgetBytes: 1024 * 1024,
    ...options,
  })
  const server = createServer()
  server.on("upgrade", sockets.upgrade)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  onTestFinished(async () => {
    await sockets.close()
    server.close()
  })
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`
  return { sessions, sockets, url }
}

// A raw socket's client, without the handshake.
const raw = async (url: string, options: ClientOptions = {}) => {
  const socket = new WebSocket(url, options)
  onTestFinished(() => socket.terminate())
  await once(socket, "open", { signal: AbortSignal.timeout(5_000) })
  return { socket, client: createWireClient<typeof contract>(socketChannel(socket)) }
}

const refusal = async (url: string, options: ClientOptions = {}) => {
  const socket = new WebSocket(url, options)
  onTestFinished(() => socket.terminate())
  const [error] = (await once(socket, "error")) as [Error]
  return error.message
}

describe("serveWebSocket", () => {
  it("serves a client that proves its token in the handshake", async () => {
    const { url, sessions } = await serve()
    const wire = await connect({
      contract,
      transport: websocket(url, { token }),
      protocolVersion,
      retryDelay: () => 0,
    })
    onTestFinished(() => wire.close())
    expect(wire.status.value).toEqual({ state: "connected", epoch: sessions.epoch })
    await expect(wire.session().client.echo("hi")).resolves.toBe("hi")
  })

  it("refuses a wrong token, and calls before the handshake", async () => {
    const { url } = await serve()
    const { client } = await raw(url)
    await expect(client.echo("hi")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(client.wire.handshake({ protocolVersion, token: "wrong" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    await expect(client.echo("hi")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await client.wire.handshake({ protocolVersion, token })
    await expect(client.echo("hi")).resolves.toBe("hi")
  })

  it("lets `verify` decide in place of a token", async () => {
    const { url } = await serve({ verify: (given) => given === "pass" })
    const { client } = await raw(url)
    await expect(client.wire.handshake({ protocolVersion, token })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    await client.wire.handshake({ protocolVersion, token: "pass" })
    await expect(client.echo("hi")).resolves.toBe("hi")
  })

  it("refuses tokens too short or too long, and a server with neither token nor verify", () => {
    const sessions = createSessions({ protocolVersion, router: {} })
    const base = { path: "/rpc", origins: [], maxPayloadBytes: 1, sendBudgetBytes: 1 }
    expect(() => serveWebSocket(sessions, { ...base, token: "short" })).toThrow(
      "between 32 and 512",
    )
    expect(() => serveWebSocket(sessions, { ...base, token: "x".repeat(513) })).toThrow(
      "between 32 and 512",
    )
    expect(() => serveWebSocket(sessions, base)).toThrow("token or verify")
    expect(() => serveWebSocket(sessions, { ...base, token, verify: () => true })).toThrow(
      "not both",
    )
    expect(() => serveWebSocket(sessions, { ...base, token, sendBudgetBytes: Number.NaN })).toThrow(
      "sendBudgetBytes",
    )
  })

  it("refuses other paths and browser origins it doesn't allow", async () => {
    const { url } = await serve()
    expect(await refusal(url.replace("/rpc", "/other"))).toContain("404")
    expect(await refusal(url, { origin: "https://untrusted.test" })).toContain("403")
    await raw(url, { origin: "https://trusted.test" })
  })

  it("counts unauthenticated sockets against its connections", async () => {
    const { url } = await serve({ maxConnections: 1 })
    await raw(url)
    expect(await refusal(url)).toContain("429")
  })

  // The authentication deadline on a fake clock, so a slow machine's handshake still comes in
  // time: only the server's timeouts are faked, and its sockets run as ever.
  const authMs = 10_000
  const onFakeClock = () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    onTestFinished(() => void vi.useRealTimers())
  }

  it("closes a socket that doesn't authenticate in time", async () => {
    onFakeClock()
    const { url } = await serve({ authMs })
    const { socket } = await raw(url)
    const closed = once(socket, "close")
    await vi.advanceTimersByTimeAsync(authMs)
    const [code] = (await closed) as [number]
    expect(code).toBe(1008)
  })

  it("keeps a socket that authenticated in time", async () => {
    onFakeClock()
    const { url } = await serve({ authMs })
    const { client } = await raw(url)
    await client.wire.handshake({ protocolVersion, token })
    await vi.advanceTimersByTimeAsync(authMs)
    await expect(client.echo("hi")).resolves.toBe("hi")
  })

  it("releases a session when its peer closes", async () => {
    const closed = vi.fn<(session: Session) => void>()
    const { url } = await serve({}, { closed })
    const { socket, client } = await raw(url)
    await client.wire.handshake({ protocolVersion, token })
    const ended = once(socket, "close")
    socket.close()
    await ended
    expect(closed).toHaveBeenCalledOnce()
  })

  it("releases the session of a connection that drops without a close", async () => {
    const closed = vi.fn<(session: Session) => void>()
    const { url } = await serve({}, { closed })
    const { socket, client } = await raw(url)
    await client.wire.handshake({ protocolVersion, token })
    // Ends the TCP connection without a close frame, as a lost network does.
    socket.terminate()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
  })

  it("drops a peer that stops answering pings, releasing its session", async () => {
    const closed = vi.fn<(session: Session) => void>()
    // On a fake clock, so the handshake comes before the first ping however slow the machine.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    onTestFinished(() => void vi.useRealTimers())
    const heartbeatMs = 10_000
    const { url } = await serve({ heartbeatMs }, { closed })
    const { socket, client } = await raw(url, { autoPong: false })
    await client.wire.handshake({ protocolVersion, token })
    const ended = once(socket, "close")
    // A ping unanswered by the next one drops the peer.
    await vi.advanceTimersByTimeAsync(heartbeatMs * 2)
    await ended
    expect(closed).toHaveBeenCalledOnce()
  })

  it("cuts off a socket whose unsent bytes outgrow its send budget", async () => {
    const closed = vi.fn<(session: Session) => void>()
    const { url } = await serve({ sendBudgetBytes: 1024 }, { closed })
    const { socket, client } = await raw(url)
    await client.wire.handshake({ protocolVersion, token })
    void client.echo("x".repeat(4096)).catch(() => {})
    await once(socket, "close")
    expect(closed).toHaveBeenCalledOnce()
  })

  it("ends every socket on close, and refuses new ones", async () => {
    const { url, sockets } = await serve()
    const { socket } = await raw(url)
    const ended = once(socket, "close")
    await sockets.close()
    await ended
    expect(await refusal(url)).toContain("503")
  })
})
