import { afterEach, describe, expect, it, vi } from "vitest"

import type { MessagePortLike } from "./channel.js"
import { WireError } from "./errors.js"
import { memoryPorts } from "./testing.js"
import { messagePort, websocket } from "./transport.js"

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
