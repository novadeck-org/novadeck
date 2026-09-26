import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { protocolVersion, type TerminalEvent, type WireClient } from "@novadeck/protocol"
import { createWireClient, socketChannel } from "@novadeck/protocol/wire"
import headless from "@xterm/headless"
import { WebSocket as NodeWebSocket } from "ws"

import { startServer, type ServerOptions } from "./server.js"
import { describe, expect, it } from "./test.js"
import { command, ptyOptions, ptyTrace } from "./testing/pty.js"
import type { Resources } from "./testing/resources.js"

const token = "novadeck-api-tests-only-not-a-production-credential"
const fixture = async (resources: Resources, options: ServerOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "novadeck-api-"))
  resources.defer(() => rm(directory, { recursive: true, force: true }))
  const server = await startServer({
    port: 0,
    token,
    database: join(directory, "workspace.sqlite"),
    ...options,
    terminals: {
      ...ptyOptions,
      ...options.terminals,
    },
  })
  resources.defer(() => server.close())
  const url = `${server.origin.replace(/^http/, "ws")}/api/rpc`

  const connect = async (authenticate = true) => {
    const socket = new NodeWebSocket(url)
    socket.binaryType = "arraybuffer"
    const disconnect = async () => {
      if (socket.readyState === NodeWebSocket.CLOSED) return
      const timeout = setTimeout(() => socket.terminate(), 2_000)
      timeout.unref()
      const closed = once(socket, "close")
      if (socket.readyState === NodeWebSocket.CONNECTING) socket.terminate()
      else socket.close()
      try {
        await closed
      } finally {
        clearTimeout(timeout)
      }
    }
    resources.defer(disconnect)
    await once(socket, "open", { signal: AbortSignal.timeout(5_000) })
    const client = createWireClient(socketChannel(socket))
    if (authenticate) await client.runner.handshake({ protocolVersion, token })
    return { client, socket, disconnect }
  }

  const setup = async (client: WireClient) => {
    const project = await client.projects.create({ name: "API workspace", cwd: directory })
    const session = await client.sessions.create({ projectId: project.id, name: "Session" })
    return { project, session }
  }

  return { server, url, directory, connect, setup }
}

const reader = async (
  resources: Resources,
  client: WireClient,
  terminalId: string,
  options: { afterSequence?: number; mode?: "control" | "observe" } = {},
) => {
  const controller = new AbortController()
  resources.defer(async () => {
    controller.abort()
  })
  const stream = await client.terminals.attach(
    { terminalId, ...options },
    { signal: controller.signal },
  )
  const events: TerminalEvent[] = []
  let text = ""
  let attached = false
  const next = async (checkpoint = "next terminal event") => {
    const timeout = setTimeout(() => {
      const last = events.at(-1)
      controller.abort(
        new Error(
          `Terminal ${terminalId} timed out waiting for ${checkpoint}; ` +
            `last event=${last?.type ?? "none"}, sequence=${last?.sequence ?? "none"}; ` +
            `text tail=${JSON.stringify(text.slice(-512))}; ` +
            `child trace:\n${ptyTrace()}`,
        ),
      )
    }, 10_000)
    timeout.unref()
    try {
      if (!attached) {
        // Every attachment opens with a marker outside the sequenced event stream.
        expect((await stream.next()).value).toEqual({
          type: "attached",
          terminalId,
          mode: options.mode ?? "control",
        })
        attached = true
      }
      const result = await stream.next()
      controller.signal.throwIfAborted()
      if (result.done) throw new Error("Terminal stream ended before the expected event")
      const event = result.value as TerminalEvent
      events.push(event)
      if (event.type === "snapshot") text = event.data
      if (event.type === "output") text += event.data
      await client.terminals.ack({ terminalId, sequence: event.sequence })
      return event
    } catch (error) {
      controller.signal.throwIfAborted()
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
  const until = async (
    predicate: (event: TerminalEvent) => boolean,
    checkpoint = predicate.toString(),
  ) => {
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- Consume ordered terminal events until the assertion checkpoint.
      const event = await next(checkpoint)
      if (predicate(event)) return event
    }
  }
  return {
    next,
    until,
    events,
    text: () => text,
    untilText: (value: string) => {
      if (text.includes(value)) return Promise.resolve(events.at(-1)!)
      // Check each new chunk once, retaining only enough overlap for a marker
      // split across events. Rescanning megabytes of history per chunk is quadratic.
      let tail = value.length > 1 ? text.slice(1 - value.length) : ""
      return until((event) => {
        if (event.type !== "output" && event.type !== "snapshot") return false
        const data = event.type === "snapshot" ? event.data : tail + event.data
        const found = data.includes(value)
        tail = value.length > 1 ? data.slice(1 - value.length) : ""
        return found
      }, JSON.stringify(value))
    },
    detach: () => controller.abort(),
    stream,
  }
}

const print = (client: WireClient, terminalId: string, first: string, second: string) =>
  client.terminals.write({
    terminalId,
    data: command({ type: "write", data: `${first}${second}\r\n` }),
  })

const screen = (resources: Resources, cols: number, rows: number) => {
  const terminal = new headless.Terminal({ cols, rows, allowProposedApi: true })
  resources.defer(() => terminal.dispose())
  const apply = async (event: TerminalEvent) => {
    if (event.type === "resized" || event.type === "snapshot") {
      terminal.resize(event.cols, event.rows)
    }
    if (event.type === "snapshot") terminal.reset()
    if (event.type === "output" || event.type === "snapshot") {
      await new Promise<void>((resolve) => terminal.write(event.data, resolve))
    }
  }
  const state = () => {
    const buffer = terminal.buffer.active
    return {
      type: buffer.type,
      cols: terminal.cols,
      rows: terminal.rows,
      cursor: [buffer.cursorX, buffer.cursorY],
      cells: Array.from({ length: terminal.rows }, (_, y) => {
        const line = buffer.getLine(buffer.baseY + y)
        return Array.from({ length: terminal.cols }, (_cell, x) => {
          const cell = line?.getCell(x)
          return (
            cell && [
              cell.getChars(),
              cell.getWidth(),
              cell.getFgColorMode(),
              cell.getFgColor(),
              cell.getBgColorMode(),
              cell.getBgColor(),
              cell.isBold(),
              cell.isItalic(),
              cell.isUnderline(),
              cell.isInverse(),
            ]
          )
        })
      }),
    }
  }
  return { apply, state }
}

const applyEvents = async (target: ReturnType<typeof screen>, events: TerminalEvent[]) => {
  for (const event of events) {
    // eslint-disable-next-line no-await-in-loop -- xterm must parse events in transport order.
    await target.apply(event)
  }
}

describe("WebSocket authentication and protocol", () => {
  it("disabled terminal API without a configured credential", async ({ resources }) => {
    const server = await startServer({ port: 0 })
    resources.defer(() => server.close())
    const response = await fetch(`${server.origin}/api/rpc`)
    expect(response.status).toBe(404)
    await expect(fetch(`${server.origin}/api/status`)).resolves.toMatchObject({ ok: true })
  })

  it("unauthenticated operations and invalid credentials", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect(false)
    await expect(client.projects.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(
      client.runner.handshake({ protocolVersion, token: "wrong" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(
      client.sessions.create({ projectId: randomUUID(), name: "denied" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    const info = await client.runner.handshake({ protocolVersion, token })
    expect(info).toMatchObject({
      protocolVersion,
      capabilities: expect.arrayContaining(["terminal-replay", "terminal-ack"]),
    })
    expect(info.runnerId).toEqual(expect.any(String))
    await expect(client.projects.list()).resolves.toEqual([])
  })

  it("protocol compatibility and failed handshake authentication", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect(false)
    await expect(client.runner.handshake({ protocolVersion: 99, token })).rejects.toMatchObject({
      code: "INCOMPATIBLE_PROTOCOL",
    })
    await expect(client.projects.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("WebSocket browser origin validation", async ({ resources }) => {
    const app = await fixture(resources, { origins: ["https://trusted.novadeck.test"] })
    const denied = new NodeWebSocket(app.url, { origin: "https://untrusted.novadeck.test" })
    resources.defer(() => denied.terminate())
    const failure = await new Promise<Error>((resolve) => denied.once("error", resolve))
    expect(failure.message).toContain("403")
    const accepted = new NodeWebSocket(app.url, { origin: "https://trusted.novadeck.test" })
    resources.defer(() => accepted.terminate())
    await once(accepted, "open", { signal: AbortSignal.timeout(5_000) })
    const closed = once(accepted, "close")
    accepted.close()
    await closed
  })

  it("connection limits include unauthenticated clients", async ({ resources }) => {
    const app = await fixture(resources, { maxConnections: 1 })
    await app.connect(false)
    const denied = new NodeWebSocket(app.url)
    resources.defer(() => denied.terminate())
    const failure = await new Promise<Error>((resolve) => denied.once("error", resolve))
    expect(failure.message).toContain("429")
  })

  it("heartbeat disconnection of unresponsive peers", async ({ resources }) => {
    const app = await fixture(resources, { heartbeatMs: 50 })
    const silent = new NodeWebSocket(app.url, { autoPong: false })
    resources.defer(() => silent.terminate())
    const closed = once(silent, "close")
    await once(silent, "open", { signal: AbortSignal.timeout(5_000) })
    await closed
    expect(silent.readyState).toBe(NodeWebSocket.CLOSED)
    const { client } = await app.connect()
    await expect(client.projects.list()).resolves.toEqual([])
  })
})

describe("workspace metadata API", () => {
  it("project and session creation, listing, renaming and restart persistence", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const { client, disconnect } = await app.connect()
    const { project, session } = await app.setup(client)
    await client.projects.rename({ projectId: project.id, name: "Renamed project" })
    await client.sessions.rename({ sessionId: session.id, name: "Renamed session" })
    await disconnect()
    await app.server.close()
    const restarted = await fixture(resources, {
      database: join(app.directory, "workspace.sqlite"),
    })
    const connection = await restarted.connect()
    await expect(connection.client.projects.list()).resolves.toEqual([
      { ...project, name: "Renamed project" },
    ])
    await expect(connection.client.sessions.list({ projectId: project.id })).resolves.toEqual([
      { ...session, name: "Renamed session" },
    ])
    await expect(connection.client.terminals.list({ sessionId: session.id })).resolves.toEqual([])
  })

  it("payload, directory and workspace relationship validation", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    await expect(client.projects.create({ name: " ", cwd: app.directory })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(
      client.projects.create({ name: "Missing", cwd: join(app.directory, "missing") }),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY" })
    await expect(
      client.sessions.create({ projectId: randomUUID(), name: "Missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    const { session } = await app.setup(client)
    await expect(
      client.terminals.create({ sessionId: session.id, cols: 0, rows: 24 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      client.terminals.create({ sessionId: randomUUID(), cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      client.terminals.resize({ terminalId: randomUUID(), cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })
})

describe("PTY lifecycle API", () => {
  it("Ctrl-C interruption and subsequent input", async ({ resources }) => {
    const app = await fixture(resources, {
      terminals: { shell: process.execPath, shellArgs: ["--interactive"] },
    })
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const output = await reader(resources, client, terminal.id)
    await output.next()
    await client.terminals.write({
      terminalId: terminal.id,
      data: 'console.log("BUSY_" + "STARTED"); while (true) {}\r',
    })
    await output.untilText("BUSY_STARTED")
    await client.terminals.write({ terminalId: terminal.id, data: "\u0003" })
    await client.terminals.write({
      terminalId: terminal.id,
      data: 'console.log("INTERRUPT_" + "RECOVERED")\r',
    })
    await output.untilText("INTERRUPT_RECOVERED")
  })

  it("server shutdown closes attached shells and connections", async ({ resources }) => {
    const app = await fixture(resources)
    const { client, socket } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const output = await reader(resources, client, terminal.id)
    await output.untilText("PTY_READY")
    await client.terminals.write({
      terminalId: terminal.id,
      data: command({ type: "info" }),
    })
    await output.untilText("CHILD_PID=")
    const pid = Number(/CHILD_PID=(\d+);/.exec(output.text())?.[1])
    expect(pid).toBeGreaterThan(0)
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    )
    await app.server.close()
    await closed
    await app.server.close()
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it("PTY input, output, dimensions and exit status", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const output = await reader(resources, client, terminal.id)
    expect(await output.next()).toMatchObject({
      type: "snapshot",
      status: "running",
      cols: 80,
      rows: 24,
    })
    await output.untilText("PTY_READY")
    await print(client, terminal.id, "PTY_", "CONNECTED")
    await output.untilText("PTY_CONNECTED")
    await client.terminals.resize({ terminalId: terminal.id, cols: 132, rows: 43 })
    await output.until(
      (event) => event.type === "resized" && event.cols === 132 && event.rows === 43,
    )
    await client.terminals.write({
      terminalId: terminal.id,
      data: command({ type: "info", cols: 132, rows: 43 }),
    })
    await output.untilText("SIZE_132x43_TTY_true")
    await expect(client.terminals.list({ sessionId: session.id })).resolves.toEqual([
      expect.objectContaining({ id: terminal.id, status: "running", cols: 132, rows: 43 }),
    ])
    await client.terminals.write({
      terminalId: terminal.id,
      data: command({ type: "exit", code: 7 }),
    })
    expect(await output.until((event) => event.type === "exited")).toMatchObject({ exitCode: 7 })
    await expect(client.terminals.list({ sessionId: session.id })).resolves.toEqual([
      expect.objectContaining({ status: "exited", exitCode: 7 }),
    ])
    const sequences = output.events.map((event) => event.sequence)
    expect(sequences).toEqual([...new Set(sequences)].toSorted((a, b) => a - b))
  })

  it("shell closure and capacity reuse", async ({ resources }) => {
    const app = await fixture(resources, {
      terminals: {
        maxTerminals: 1,
      },
    })
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const first = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    await expect(
      client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" })
    await client.terminals.close({ terminalId: first.id })
    const second = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    expect(second.id).not.toBe(first.id)
    await client.terminals.close({ terminalId: second.id })
  })

  it("invalid directory and shell spawn failure cleanup", async ({ resources }) => {
    const app = await fixture(resources, {
      terminals: { shell: join(tmpdir(), `novadeck-missing-${randomUUID()}`) },
    })
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    await expect(
      client.terminals.create({
        sessionId: session.id,
        cwd: "relative/path",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY" })
    await expect(
      client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "SPAWN_FAILED" })
    await expect(client.terminals.list({ sessionId: session.id })).resolves.toEqual([])
  })
})

describe("terminal attachment and recovery API", () => {
  it("recognizes an output checkpoint split across acknowledged events", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const output = await reader(resources, client, terminal.id)
    await output.untilText("PTY_READY")
    await client.terminals.write({
      terminalId: terminal.id,
      data: command({ type: "write", data: "CROSS_EVENT_" }),
    })
    const first = await output.untilText("CROSS_EVENT_")
    await client.terminals.write({
      terminalId: terminal.id,
      data: command({ type: "write", data: "CHECKPOINT" }),
    })
    const completed = await output.untilText("CROSS_EVENT_CHECKPOINT")
    expect(completed.sequence).toBeGreaterThan(first.sequence)
    expect(await output.untilText("CROSS_EVENT_CHECKPOINT")).toEqual(completed)
  })

  it("API usability after connection loss during terminal creation", async ({ resources }) => {
    const app = await fixture(resources)
    const replacement = await app.connect()
    const { session } = await app.setup(replacement.client)
    const socket = new NodeWebSocket(app.url)
    socket.binaryType = "arraybuffer"
    resources.defer(() => socket.terminate())
    await once(socket, "open", { signal: AbortSignal.timeout(5_000) })
    const client = createWireClient(socketChannel(socket))
    await client.runner.handshake({ protocolVersion, token })
    // Flush the request onto TCP, then drop the connection without a close frame.
    // The server may either reject the request or finish creation after release.
    const originalSend = socket.send.bind(socket)
    socket.send = ((data: Parameters<NodeWebSocket["send"]>[0]) => {
      originalSend(data, () => socket.terminate())
    }) as NodeWebSocket["send"]
    const created = client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    await expect(created).rejects.toThrow("Runner connection is closed")
    // Delivery is ambiguous: the connection may close before creation starts.
    // Any already-visible record must be controllable by the replacement.
    // The manager suite covers release during an in-flight create directly.
    const terminals = await replacement.client.terminals.list({ sessionId: session.id })
    expect(terminals.length).toBeLessThanOrEqual(1)
    for (const terminal of terminals) {
      // eslint-disable-next-line no-await-in-loop -- Every orphaned create must permit acquisition.
      const attached = await reader(resources, replacement.client, terminal.id)
      // eslint-disable-next-line no-await-in-loop -- Wait for server-side ownership registration.
      await attached.next()
      // eslint-disable-next-line no-await-in-loop -- Verify the surviving process accepts input.
      await print(replacement.client, terminal.id, "ABRUPT_", "RECOVERED")
      // eslint-disable-next-line no-await-in-loop -- Consume the recovery checkpoint.
      await attached.untilText("ABRUPT_RECOVERED")
    }
  })

  it("exclusive control during concurrent acquisition", async ({ resources }) => {
    const app = await fixture(resources)
    const creator = await app.connect()
    const { session } = await app.setup(creator.client)
    const terminal = await creator.client.terminals.create({
      sessionId: session.id,
      cols: 80,
      rows: 24,
    })
    await creator.disconnect()
    const competitors = await Promise.all([app.connect(), app.connect()])
    const readers = await Promise.all(
      competitors.map(({ client }) => reader(resources, client, terminal.id)),
    )
    const results = await Promise.allSettled(readers.map((output) => output.next()))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const winner = results.findIndex((result) => result.status === "fulfilled")
    const loser = 1 - winner
    expect(results[loser]).toMatchObject({
      status: "rejected",
      reason: { code: "CONTROL_IN_USE" },
    })
    await expect(
      competitors[loser]!.client.terminals.write({ terminalId: terminal.id, data: "denied" }),
    ).rejects.toMatchObject({ code: "CONTROL_REQUIRED" })
    await readers[winner]!.untilText("PTY_READY")
    await print(competitors[winner]!.client, terminal.id, "RACE_", "WINNER")
    await readers[winner]!.untilText("RACE_WINNER")
  })

  it("attachment cancellation with queued output and exit", async ({ resources }) => {
    const app = await fixture(resources)
    const owner = await app.connect()
    const { session } = await app.setup(owner.client)
    const terminal = await owner.client.terminals.create({
      sessionId: session.id,
      cols: 80,
      rows: 24,
    })
    const continuous = await reader(resources, owner.client, terminal.id)
    await continuous.untilText("PTY_READY")
    const observer = await app.connect()
    const queued = await reader(resources, observer.client, terminal.id, { mode: "observe" })
    await queued.next()
    await owner.client.terminals.write({
      terminalId: terminal.id,
      data: command({ type: "exit", code: 9, data: "FINAL_QUEUED_OUTPUT\r\n" }),
    })
    await continuous.until((event) => event.type === "exited")
    await queued.stream.return()
    const restored = await reader(resources, observer.client, terminal.id, { mode: "observe" })
    const snapshot = await restored.next()
    expect(snapshot).toMatchObject({ type: "snapshot", status: "exited", exitCode: 9 })
    expect(restored.text()).toContain("FINAL_QUEUED_OUTPUT")
    await expect(observer.client.projects.list()).resolves.toHaveLength(1)
  })

  it("quiet terminal responsiveness during unattached noisy output", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const noisy = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const quiet = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const quietOutput = await reader(resources, client, quiet.id)
    await quietOutput.untilText("PTY_READY")
    const observer = await app.connect()
    const noisyOutput = await reader(resources, observer.client, noisy.id, { mode: "observe" })
    await noisyOutput.untilText("PTY_READY")
    await client.terminals.write({
      terminalId: noisy.id,
      data: command({ type: "startNoise" }),
    })
    await noisyOutput.untilText("NOISE_STARTED")
    await noisyOutput.stream.return()
    // The child continues producing output until the explicit stop command.
    // This reply must therefore arrive while the other PTY is still noisy.
    await print(client, quiet.id, "QUIET_", "RESPONSIVE")
    await quietOutput.untilText("QUIET_RESPONSIVE")
    await client.terminals.write({ terminalId: noisy.id, data: command({ type: "stopNoise" }) })
    const stopped = await reader(resources, observer.client, noisy.id, { mode: "observe" })
    await stopped.untilText("NOISE_STOPPED")
    await expect(client.terminals.list({ sessionId: session.id })).resolves.toHaveLength(2)
  })

  for (const recovery of ["replay", "snapshot"] as const) {
    it(`${recovery} restores screen attributes, cursor and alternate buffer`, async ({
      resources,
    }) => {
      const app = await fixture(resources, {
        terminals: { historyBytes: recovery === "snapshot" ? 128 : 1024 * 1024 },
      })
      const owner = await app.connect()
      const { session } = await app.setup(owner.client)
      const terminal = await owner.client.terminals.create({
        sessionId: session.id,
        cols: 40,
        rows: 12,
      })
      const continuous = await reader(resources, owner.client, terminal.id)
      await continuous.untilText("PTY_READY")
      const observer = await app.connect()
      const watched = await reader(resources, observer.client, terminal.id, { mode: "observe" })
      await watched.untilText("PTY_READY")
      await owner.client.terminals.write({
        terminalId: terminal.id,
        data: command({
          type: "write",
          data: "\u001b[2J\u001b[H\u001b[1;38;2;20;80;140m雪🙂 styled\u001b[0m\r\nBEFORE_CHECKPOINT",
        }),
      })
      const checkpoint = await watched.untilText("BEFORE_CHECKPOINT")
      await continuous.until((event) => event.sequence === checkpoint.sequence)
      const expected = screen(resources, 40, 12)
      const restored = screen(resources, 40, 12)
      await applyEvents(expected, continuous.events)
      await applyEvents(restored, watched.events)
      await observer.disconnect()
      await owner.client.terminals.resize({ terminalId: terminal.id, cols: 52, rows: 15 })
      await owner.client.terminals.write({
        terminalId: terminal.id,
        data: command({
          type: "write",
          data:
            "normal continuation".repeat(20) +
            "\u001b[?1049h\u001b[2J\u001b[H\u001b[3;4;38;2;90;60;30;48;2;12;34;56m界🙂 alternate\u001b[0m\u001b[5;7HAFTER_CHECKPOINT",
        }),
      })
      const after = await continuous.untilText("AFTER_CHECKPOINT")
      await applyEvents(
        expected,
        continuous.events.filter((event) => event.sequence > checkpoint.sequence),
      )
      const replacement = await app.connect()
      const resumed = await reader(resources, replacement.client, terminal.id, {
        mode: "observe",
        afterSequence: checkpoint.sequence,
      })
      await resumed.until((event) => event.sequence === after.sequence)
      expect(resumed.events[0]?.type === "snapshot").toBe(recovery === "snapshot")
      await applyEvents(restored, resumed.events)
      expect(restored.state()).toEqual(expected.state())
      expect(restored.state().type).toBe("alternate")
      await owner.client.terminals.write({
        terminalId: terminal.id,
        data: command({
          type: "write",
          data: "\u001b[?1049l\u001b[8;3H\u001b[32mCONTINUED_界🙂\u001b[0m",
        }),
      })
      const final = await continuous.untilText("CONTINUED_界🙂")
      await resumed.until((event) => event.sequence === final.sequence)
      await applyEvents(
        expected,
        continuous.events.filter((event) => event.sequence > after.sequence),
      )
      await applyEvents(
        restored,
        resumed.events.filter((event) => event.sequence > after.sequence),
      )
      expect(restored.state()).toEqual(expected.state())
      expect(restored.state().type).toBe("normal")
    })
  }

  it("large styled screen recovery beyond the output budget", async ({ resources }) => {
    const app = await fixture(resources)
    const owner = await app.connect()
    const { session } = await app.setup(owner.client)
    const terminal = await owner.client.terminals.create({
      sessionId: session.id,
      cols: 120,
      rows: 24,
    })
    const output = await reader(resources, owner.client, terminal.id)
    await output.untilText("PTY_READY")
    // Keep each produced batch within the ordinary viewer budget. Waiting for
    // its checkpoint also acknowledges all preceding events before the next
    // batch, including platforms that encode PTY rendering more verbosely.
    for (let batch = 0; batch < 16; batch++) {
      const checkpoint = `COLORED_BATCH_${batch}_READY`
      // eslint-disable-next-line no-await-in-loop -- Produce the next batch only after consumption ACKs.
      await owner.client.terminals.write({
        terminalId: terminal.id,
        data: command({ type: "styled", cols: 120, lines: 64, checkpoint }),
      })
      // eslint-disable-next-line no-await-in-loop -- Confirm and acknowledge each complete styled batch.
      await output.untilText(checkpoint)
    }
    await owner.disconnect()
    const replacement = await app.connect()
    const restored = await reader(resources, replacement.client, terminal.id)
    const snapshot = await restored.next()
    expect(snapshot.type).toBe("snapshot")
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(4 * 1024 * 1024)
    await print(replacement.client, terminal.id, "LARGE_SCREEN_", "RECOVERED")
    await restored.untilText("LARGE_SCREEN_RECOVERED")
  }, 15_000)

  it("attachment cancellation preserves shell and API usability", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const output = await reader(resources, client, terminal.id)
    await output.untilText("PTY_READY")
    await output.stream.return()
    const reattached = await reader(resources, client, terminal.id)
    await reattached.next()
    await print(client, terminal.id, "CANCEL_", "RECOVERED")
    await reattached.untilText("CANCEL_RECOVERED")
  })

  it("unacknowledged event limit and fresh attachment", async ({ resources }) => {
    const app = await fixture(resources, {
      terminals: { subscriberBytes: 2 * 1024, ackWindowBytes: 1024 },
    })
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const observer = await app.connect()
    const slow = await observer.client.terminals.attach({
      terminalId: terminal.id,
      mode: "observe",
    })
    await slow.next() // Deliberately withhold consumption ACKs.
    const failed = (async () => {
      // eslint-disable-next-line no-await-in-loop -- Exercise stream delivery without acknowledging consumption.
      while (!(await slow.next()).done) {
        /* Drain wire events without ACKs. */
      }
    })()
    const failure = expect(failed).rejects.toMatchObject({ code: "SLOW_CONSUMER" })
    // Resize events enter the same acknowledged queue as terminal output, but
    // cannot be coalesced by an OS renderer such as Windows ConPTY.
    for (let index = 0; index < 40; index++) {
      // eslint-disable-next-line no-await-in-loop -- Exercise real RPC events without acknowledging the observer.
      await client.terminals.resize({ terminalId: terminal.id, cols: 80 + (index % 2), rows: 24 })
    }
    await failure
    await print(client, terminal.id, "OVERFLOW_", "RECOVERED")
    const restored = await reader(resources, observer.client, terminal.id, { mode: "observe" })
    await restored.untilText("OVERFLOW_RECOVERED")
    await expect(client.terminals.list({ sessionId: session.id })).resolves.toEqual([
      expect.objectContaining({ status: "running" }),
    ])
  })

  it("request rejection and stream cancellation after socket closure", async ({ resources }) => {
    const app = await fixture(resources)
    const { client, disconnect } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const output = await reader(resources, client, terminal.id)
    await output.untilText("PTY_READY")
    await disconnect()
    output.detach()
    await expect(client.projects.list()).rejects.toThrow("Runner connection is closed")
  })

  it("process survival and replay after the saved cursor", async ({ resources }) => {
    const app = await fixture(resources)
    const owner = await app.connect()
    const { session } = await app.setup(owner.client)
    const terminal = await owner.client.terminals.create({
      sessionId: session.id,
      cols: 80,
      rows: 24,
    })
    const observer = await app.connect()
    const watched = await reader(resources, observer.client, terminal.id, { mode: "observe" })
    await watched.untilText("PTY_READY")
    await print(owner.client, terminal.id, "BEFORE_", "DISCONNECT")
    const checkpoint = await watched.untilText("BEFORE_DISCONNECT")
    await observer.disconnect()
    await print(owner.client, terminal.id, "AFTER_", "DISCONNECT")
    const reconnected = await app.connect()
    const resumed = await reader(resources, reconnected.client, terminal.id, {
      mode: "observe",
      afterSequence: checkpoint.sequence,
    })
    await resumed.untilText("AFTER_DISCONNECT")
    expect(
      resumed.events.every(
        (event) => event.type !== "snapshot" && event.sequence > checkpoint.sequence,
      ),
    ).toBe(true)
    await expect(owner.client.terminals.list({ sessionId: session.id })).resolves.toEqual([
      expect.objectContaining({ id: terminal.id, status: "running" }),
    ])
  })

  it("snapshot recovery after replay window expiry", async ({ resources }) => {
    const app = await fixture(resources, {
      terminals: {
        historyBytes: 128,
      },
    })
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create({ sessionId: session.id, cols: 100, rows: 30 })
    const output = await reader(resources, client, terminal.id)
    await output.untilText("PTY_READY")
    await client.terminals.write({
      terminalId: terminal.id,
      data: command({ type: "write", data: "x".repeat(5000) + "\r\nSNAPSHOT_READY\r\n" }),
    })
    await output.untilText("SNAPSHOT_READY")
    const observer = await app.connect()
    const restored = await reader(resources, observer.client, terminal.id, {
      mode: "observe",
      afterSequence: 0,
    })
    const snapshot = await restored.next()
    expect(snapshot).toMatchObject({ type: "snapshot", status: "running" })
    if (snapshot.type !== "snapshot") throw new Error("Expected restored screen")
    expect(snapshot.data).toContain("SNAPSHOT_READY")
    expect(snapshot.sequence).toBeGreaterThan(0)
  })

  it("exclusive control and release on disconnect", async ({ resources }) => {
    const app = await fixture(resources)
    const owner = await app.connect()
    const observer = await app.connect()
    const { session } = await app.setup(owner.client)
    const terminal = await owner.client.terminals.create({
      sessionId: session.id,
      cols: 80,
      rows: 24,
    })
    await expect(
      observer.client.terminals.write({ terminalId: terminal.id, data: "bad" }),
    ).rejects.toMatchObject({ code: "CONTROL_REQUIRED" })
    await expect(
      observer.client.terminals.resize({ terminalId: terminal.id, cols: 100, rows: 30 }),
    ).rejects.toMatchObject({ code: "CONTROL_REQUIRED" })
    await expect(
      observer.client.terminals.close({ terminalId: terminal.id }),
    ).rejects.toMatchObject({ code: "CONTROL_REQUIRED" })
    const blocked = await reader(resources, observer.client, terminal.id)
    await expect(blocked.next()).rejects.toMatchObject({ code: "CONTROL_IN_USE" })
    await owner.disconnect()
    const acquired = await reader(resources, observer.client, terminal.id)
    await acquired.next()
    await print(observer.client, terminal.id, "CONTROL_", "TRANSFERRED")
    await acquired.untilText("CONTROL_TRANSFERRED")
  })

  it("invalid and stale acknowledgements preserve shell usability", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create({ sessionId: session.id, cols: 80, rows: 24 })
    const output = await reader(resources, client, terminal.id)
    await output.untilText("PTY_READY")
    await expect(
      client.terminals.ack({ terminalId: terminal.id, sequence: Number.MAX_SAFE_INTEGER }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" })
    await print(client, terminal.id, "ACK_", "VALIDATION")
    await output.untilText("ACK_VALIDATION")
    await client.terminals.ack({ terminalId: terminal.id, sequence: 0 })
    await client.terminals.ack({ terminalId: terminal.id, sequence: 0 })
    await print(client, terminal.id, "STALE_ACK_", "RECOVERED")
    await output.untilText("STALE_ACK_RECOVERED")
  })
})
