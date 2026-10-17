import { describe, expect, it, vi } from "vitest"

import { portChannel, socketChannel, type MessagePortLike, type WebSocketLike } from "./channel.js"

type Listeners = Record<string, ((event?: unknown) => void)[]>

const fakeSocket = () => {
  const listeners: Listeners = {}
  const socket = {
    readyState: 1,
    binaryType: "blob",
    send: vi.fn<(data: string | Uint8Array<ArrayBuffer>) => void>(),
    close: vi.fn<() => void>(),
    addEventListener: (type: string, listener: (event?: unknown) => void) => {
      ;(listeners[type] ??= []).push(listener)
    },
  }
  const emit = (type: string, event?: unknown) => {
    for (const listener of listeners[type] ?? []) listener(event)
  }
  return { socket: socket as typeof socket & WebSocketLike, emit }
}

const fakePort = () => {
  const listeners: Listeners = {}
  const port = {
    postMessage: vi.fn<(message: unknown) => void>(),
    start: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
    addEventListener: (type: string, listener: (event?: unknown) => void) => {
      ;(listeners[type] ??= []).push(listener)
    },
  }
  const emit = (type: string, event?: unknown) => {
    for (const listener of listeners[type] ?? []) listener(event)
  }
  return { port: port as typeof port & MessagePortLike, emit }
}

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false
  void promise.then(() => (done = true))
  await new Promise((resolve) => setTimeout(resolve))
  return done
}

describe("socketChannel", () => {
  it("receives binary messages as array buffers", () => {
    const { socket } = fakeSocket()
    socketChannel(socket)
    expect(socket.binaryType).toBe("arraybuffer")
  })

  it("is open while its socket is", () => {
    const { socket } = fakeSocket()
    const channel = socketChannel(socket)
    expect(channel.open).toBe(true)
    socket.readyState = 2
    expect(channel.open).toBe(false)
  })

  it("sends on its socket and hands on what the socket receives", () => {
    const { socket, emit } = fakeSocket()
    const channel = socketChannel(socket)
    const received: unknown[] = []
    channel.listen((data) => received.push(data))
    channel.send("ping")
    emit("message", { data: "pong" })
    expect(socket.send).toHaveBeenCalledWith("ping")
    expect(received).toEqual(["pong"])
  })

  it("closes when its socket closes", async () => {
    const { socket, emit } = fakeSocket()
    const channel = socketChannel(socket)
    expect(await settled(channel.closed)).toBe(false)
    emit("close")
    expect(await settled(channel.closed)).toBe(true)
  })

  it("counts as closed at once when closed here, before the socket's close event", async () => {
    const { socket } = fakeSocket()
    const channel = socketChannel(socket)
    channel.close()
    expect(socket.close).toHaveBeenCalled()
    expect(await settled(channel.closed)).toBe(true)
  })
})

describe("portChannel", () => {
  it("starts its port once it listens", () => {
    const { port, emit } = fakePort()
    const channel = portChannel(port)
    expect(port.start).not.toHaveBeenCalled()
    const received: unknown[] = []
    channel.listen((data) => received.push(data))
    expect(port.start).toHaveBeenCalled()
    emit("message", { data: "pong" })
    expect(received).toEqual(["pong"])
  })

  it("posts what it sends", () => {
    const { port } = fakePort()
    portChannel(port).send("ping")
    expect(port.postMessage).toHaveBeenCalledWith("ping")
  })

  it("closes when the far end closes the port", async () => {
    const { port, emit } = fakePort()
    const channel = portChannel(port)
    expect(channel.open).toBe(true)
    emit("close")
    expect(channel.open).toBe(false)
    expect(await settled(channel.closed)).toBe(true)
  })

  it("closes at once when closed here, as a port only tells its peer", async () => {
    const { port } = fakePort()
    const channel = portChannel(port)
    channel.close()
    expect(port.close).toHaveBeenCalled()
    expect(channel.open).toBe(false)
    expect(await settled(channel.closed)).toBe(true)
  })
})
