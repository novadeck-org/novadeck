import { EventEmitter } from "node:events"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Electron's main and renderer modules, as far as the broker and the relay use them.
const electron = vi.hoisted(() => ({
  main: undefined as unknown as EventEmitter,
  renderer: undefined as unknown as EventEmitter & { sent: [string, unknown][] },
  channels: [] as { port1: { close: () => void }; port2: { close: () => void } }[],
}))

vi.mock("electron", () => {
  const port = () => ({ close: vi.fn<() => void>() })
  electron.main = new EventEmitter()
  electron.renderer = Object.assign(new EventEmitter(), { sent: [] as [string, unknown][] })
  return {
    ipcMain: electron.main,
    MessageChannelMain: class {
      readonly port1 = port()
      readonly port2 = port()
      constructor() {
        electron.channels.push(this)
      }
    },
    ipcRenderer: Object.assign(electron.renderer, {
      send: (channel: string, value: unknown) => electron.renderer.sent.push([channel, value]),
    }),
  }
})

const { brokerPorts, relayPorts } = await import("./electron.js")

const asking = (allowed = true) => {
  const sender = { postMessage: vi.fn<(channel: string, id: unknown, ports: unknown[]) => void>() }
  return { event: { sender, allowed }, sender }
}

beforeEach(() => {
  electron.channels.length = 0
  electron.main.removeAllListeners()
  electron.renderer.removeAllListeners()
  electron.renderer.sent.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("brokerPorts", () => {
  const broker = (deliver = vi.fn<(port: unknown) => boolean>(() => true)) => {
    const stop = brokerPorts({
      channel: "service-port",
      allow: (event) => (event as unknown as { allowed: boolean }).allowed,
      deliver: deliver as never,
    })
    return { stop, deliver }
  }

  it("gives the service one end of a new channel, and the page the other under its id", () => {
    const { deliver } = broker()
    const { event, sender } = asking()
    electron.main.emit("service-port", event, "request-1")
    const [channel] = electron.channels
    expect(deliver).toHaveBeenCalledWith(channel!.port1)
    expect(sender.postMessage).toHaveBeenCalledWith("service-port", "request-1", [channel!.port2])
  })

  it("ignores a request it doesn't allow, or one without an id", () => {
    const { deliver } = broker()
    electron.main.emit("service-port", asking(false).event, "request-1")
    electron.main.emit("service-port", asking().event, 7)
    expect(electron.channels).toEqual([])
    expect(deliver).not.toHaveBeenCalled()
  })

  it("closes both ends when there's no service to deliver to", () => {
    broker(vi.fn<(port: unknown) => boolean>(() => false))
    const { event, sender } = asking()
    electron.main.emit("service-port", event, "request-1")
    const [channel] = electron.channels
    expect(channel!.port1.close).toHaveBeenCalled()
    expect(channel!.port2.close).toHaveBeenCalled()
    expect(sender.postMessage).not.toHaveBeenCalled()
  })

  it("stops answering once stopped", () => {
    const { stop, deliver } = broker()
    stop()
    electron.main.emit("service-port", asking().event, "request-1")
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe("relayPorts", () => {
  it("asks the main process for a port under the page's id", () => {
    const request = relayPorts({ channel: "service-port", message: "page-port" })
    request("request-1")
    request(7 as unknown as string)
    expect(electron.renderer.sent).toEqual([["service-port", "request-1"]])
  })

  it("hands each port the main process sends to the page, as a window message", () => {
    const posted = vi.fn<(message: unknown, origin: string, transfer: unknown[]) => void>()
    vi.stubGlobal("window", { postMessage: posted })
    relayPorts({ channel: "service-port", message: "page-port" })
    const port = { close: () => {} }
    electron.renderer.emit("service-port", { ports: [port] }, "request-1")
    expect(posted).toHaveBeenCalledWith({ type: "page-port", id: "request-1" }, "*", [port])
  })
})
