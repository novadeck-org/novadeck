import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { MessagePortLike } from "./channel.js"
import { hostTransport } from "./page.js"
import { memoryPorts } from "./testing.js"

type Listener = (event: {
  readonly data: unknown
  readonly source: unknown
  readonly ports: readonly MessagePortLike[]
}) => void

// The page's window: its message listeners, and what its host answers with.
const listeners = new Set<Listener>()
const answer = (data: unknown, port: MessagePortLike, source: unknown = globalThis) => {
  for (const listener of listeners) listener({ data, source, ports: [port] })
}

beforeEach(() => {
  vi.stubGlobal("addEventListener", (_type: string, listener: Listener) => listeners.add(listener))
  vi.stubGlobal("removeEventListener", (_type: string, listener: Listener) =>
    listeners.delete(listener),
  )
})

afterEach(() => {
  listeners.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const transport = (request: (id: string) => void) =>
  hostTransport({ request, message: "page-port", lateAnswerMs: 60_000 })

describe("hostTransport", () => {
  it("connects over the port its host answers its request with", async () => {
    const asked: string[] = []
    const connecting = transport((id) => asked.push(id)).connect(new AbortController().signal)
    const [port] = memoryPorts()
    answer({ type: "page-port", id: "another" }, memoryPorts()[0])
    answer({ type: "page-port", id: asked[0] }, port, {})
    answer({ type: "page-port", id: asked[0] }, port)
    const channel = await connecting
    expect(channel.open).toBe(true)
    expect(listeners.size).toBe(0)
  })

  it("asks again, under a new id, for each connection", async () => {
    const asked: string[] = []
    const host = transport((id) => {
      asked.push(id)
      queueMicrotask(() => answer({ type: "page-port", id }, memoryPorts()[0]))
    })
    await host.connect(new AbortController().signal)
    await host.connect(new AbortController().signal)
    expect(asked).toHaveLength(2)
    expect(asked[0]).not.toBe(asked[1])
  })

  it("fails with the request's error when there's no host to ask", async () => {
    const missing = new Error("No host.")
    const connecting = transport(() => {
      throw missing
    }).connect(new AbortController().signal)
    await expect(connecting).rejects.toBe(missing)
    expect(listeners.size).toBe(0)
  })

  it("closes a port that answers a request it gave up on, until lateAnswerMs", async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const abort = new AbortController()
    const connecting = transport((id) => asked.push(id)).connect(abort.signal)
    const reason = new Error("Gave up.")
    abort.abort(reason)
    await expect(connecting).rejects.toBe(reason)
    const [late, far] = memoryPorts()
    const closed = vi.fn<() => void>()
    far.addEventListener("close", closed)
    answer({ type: "page-port", id: asked[0] }, late)
    expect(closed).toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(listeners.size).toBe(0)
  })

  it("stops listening for a late answer after lateAnswerMs", async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const connecting = transport(() => {}).connect(abort.signal)
    abort.abort(new Error("Gave up."))
    await expect(connecting).rejects.toThrow("Gave up.")
    expect(listeners.size).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(listeners.size).toBe(0)
  })
})
