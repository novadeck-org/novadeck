import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageChannel } from "node:worker_threads"

import type { TerminalEvent } from "@novadeck/protocol"
import {
  connectRunner,
  messagePort,
  websocket,
  type AttachedTerminal,
  type Channel,
  type Runner,
  type RunnerStatus,
  type Transport,
} from "@novadeck/protocol/client"

import { createRunner, servePort } from "./index.js"
import { startServer, type ServerOptions } from "./server.js"
import { describe, expect, it } from "./test.js"
import { command, ptyOptions } from "./testing/pty.js"
import type { Resources } from "./testing/resources.js"

const token = "novadeck-client-tests-only-not-a-production-credential"
const fast = { retryDelay: () => 10 }

const temporary = async (resources: Resources) => {
  const directory = await mkdtemp(join(tmpdir(), "novadeck-client-"))
  resources.defer(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const deployed = async (resources: Resources, options: ServerOptions = {}) => {
  const directory = await temporary(resources)
  const server = await startServer({
    port: 0,
    token,
    database: join(directory, "workspace.sqlite"),
    ...options,
    terminals: { ...ptyOptions, ...options.terminals },
  })
  resources.defer(() => server.close())
  const url = `${server.origin.replace(/^http/, "ws")}/api/rpc`
  const connect = async (transport: Transport = websocket(url, { token })) => {
    const runner = await connectRunner(transport, fast)
    resources.defer(() => runner.close())
    return runner
  }
  return { url, directory, connect }
}

const bundled = async (resources: Resources) => {
  // Created first so it is removed last, after the runner ends shells running inside it.
  const directory = await temporary(resources)
  const runner = createRunner({ terminals: ptyOptions })
  resources.defer(() => runner.close())
  const connect = async () => {
    const { port1, port2 } = new MessageChannel()
    const dispose = servePort(runner, port1)
    resources.defer(dispose)
    const client = await connectRunner(messagePort(port2), fast)
    resources.defer(() => client.close())
    return { client, dispose }
  }
  return { directory, connect }
}

/**
 * Holds reconnection attempts until resumed, so a test can act during the gap. A
 * half-open interruption fails the link only for the client; the runner sees nothing.
 */
const interruptible = (transport: Transport) => {
  const links: { channel: Channel; fail: () => void }[] = []
  let gate = Promise.resolve()
  let release: (() => void) | undefined
  const hold = () => {
    gate = new Promise((resolve) => {
      release = resolve
    })
  }
  return {
    transport: {
      ...(transport.token !== undefined && { token: transport.token }),
      async connect(signal: AbortSignal) {
        await gate
        const channel = await transport.connect(signal)
        let failed = false
        let fail: (() => void) | undefined
        const closed = Promise.race([
          channel.closed,
          new Promise<void>((resolve) => {
            fail = () => {
              failed = true
              resolve()
            }
          }),
        ])
        links.push({ channel, fail: () => fail?.() })
        return {
          get open() {
            return !failed && channel.open
          },
          send: (message) => channel.send(message),
          listen: (receive) => channel.listen(receive),
          closed,
          close: () => channel.close(),
        } satisfies Channel
      },
    } satisfies Transport,
    interrupt() {
      hold()
      links.at(-1)?.channel.close()
    },
    halfOpen() {
      hold()
      links.at(-1)?.fail()
    },
    resume: () => release?.(),
  }
}

const session = async (runner: Runner, cwd: string) => {
  const project = await runner.projects.create({ name: "Client", cwd })
  return runner.sessions.create({ projectId: project.id, name: "Session" })
}

/** Reads a terminal the way a renderer does: output appends and a snapshot replaces. */
const view = (terminal: AttachedTerminal, resources: Resources) => {
  resources.defer(() => terminal.detach())
  const events: TerminalEvent[] = []
  let text = ""
  const next = async () => {
    const result = await terminal.next()
    if (result.done)
      throw new Error(`Terminal ended; text tail=${JSON.stringify(text.slice(-256))}`)
    events.push(result.value)
    if (result.value.type === "snapshot") text = result.value.data
    if (result.value.type === "output") text += result.value.data
    return result.value
  }
  const until = async (value: string) => {
    while (!text.includes(value)) {
      // eslint-disable-next-line no-await-in-loop -- Consume ordered events until the checkpoint.
      await next()
    }
  }
  return { next, until, events, text: () => text }
}

const print = (terminal: AttachedTerminal, value: string) =>
  terminal.write(command({ type: "write", data: `${value}\r\n` }))

const statuses = (runner: Runner) => {
  const seen: RunnerStatus["state"][] = []
  const watching = (async () => {
    for await (const status of runner.watch()) seen.push(status.state)
  })()
  const until = async (state: RunnerStatus["state"]) => {
    while (runner.status.state !== state) {
      // eslint-disable-next-line no-await-in-loop -- Poll the observable status.
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  return { seen, until, watching }
}

describe("runner client over WebSocket", () => {
  it("creates, attaches, writes, resizes and finishes iteration when the shell exits", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const runner = await app.connect()
    expect(runner.status).toEqual({ state: "connected", runnerId: expect.any(String) })
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create({ sessionId, cols: 80, rows: 24 })
    await expect(runner.terminals.list({ sessionId })).resolves.toEqual([created])

    const terminal = await runner.terminals.attach(created.id)
    expect(terminal).toMatchObject({ id: created.id, mode: "control" })
    const screen = view(terminal, resources)
    expect(await screen.next()).toMatchObject({ type: "snapshot", status: "running" })
    await screen.until("PTY_READY")
    await print(terminal, "HELLO_RUNNER")
    await screen.until("HELLO_RUNNER")
    await terminal.resize({ cols: 100, rows: 30 })
    await terminal.write(command({ type: "exit", code: 3 }))
    const rest: TerminalEvent[] = []
    for await (const event of terminal) rest.push(event)
    expect(rest).toContainEqual(expect.objectContaining({ type: "resized", cols: 100, rows: 30 }))
    expect(rest.at(-1)).toMatchObject({ type: "exited", exitCode: 3 })
    await expect(terminal.write("ignored")).rejects.toMatchObject({ code: "TERMINAL_EXITED" })
    await expect(terminal.close()).resolves.toBeUndefined()
  })

  it("rejects a wrong token and unknown terminals with typed errors", async ({ resources }) => {
    const app = await deployed(resources)
    await expect(connectRunner(websocket(app.url, { token: "wrong" }))).rejects.toMatchObject({
      name: "RunnerError",
      code: "UNAUTHORIZED",
    })
    const runner = await app.connect()
    await expect(runner.terminals.attach(crypto.randomUUID())).rejects.toMatchObject({
      name: "RunnerError",
      code: "TERMINAL_NOT_FOUND",
    })
    await expect(
      runner.projects.create({ name: "Missing", cwd: join(app.directory, "missing") }),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY" })
  })

  it("resumes an attachment after reconnection without losing or repeating output", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const link = interruptible(websocket(app.url, { token }))
    const runner = await app.connect(link.transport)
    const status = statuses(runner)
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create({ sessionId, cols: 80, rows: 24 })
    const terminal = await runner.terminals.attach(created.id)
    const screen = view(terminal, resources)
    await screen.until("PTY_READY")
    await print(terminal, "BEFORE_GAP")
    await screen.until("BEFORE_GAP")

    link.interrupt()
    await status.until("reconnecting")
    await expect(terminal.write("lost")).rejects.toMatchObject({ code: "DISCONNECTED" })
    await expect(runner.projects.list()).rejects.toMatchObject({ code: "DISCONNECTED" })
    // Another client takes control during the gap; its output must be replayed.
    const other = await app.connect()
    const borrowed = await other.terminals.attach(created.id)
    await print(borrowed, "DURING_GAP")
    await view(borrowed, resources).until("DURING_GAP")
    await borrowed.detach()
    await other.close()

    link.resume()
    await screen.until("DURING_GAP")
    await print(terminal, "AFTER_GAP")
    await screen.until("AFTER_GAP")
    for (const marker of ["BEFORE_GAP", "DURING_GAP", "AFTER_GAP"]) {
      expect(screen.text().split(marker)).toHaveLength(2)
    }
    expect(screen.events.filter((event) => event.type === "snapshot")).toHaveLength(1)
    const sequences = screen.events.map((event) => event.sequence)
    expect(sequences).toEqual(sequences.toSorted((a, b) => a - b))
    expect(new Set(sequences).size).toBe(sequences.length)

    await runner.close()
    await status.watching
    expect(status.seen).toEqual(["connected", "reconnecting", "connected", "closed"])
  })

  it("resynchronizes a slow viewer with a fresh snapshot instead of failing", async ({
    resources,
  }) => {
    const app = await deployed(resources, {
      terminals: { subscriberBytes: 2 * 1024, ackWindowBytes: 1024 },
    })
    const runner = await app.connect()
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create({ sessionId, cols: 80, rows: 24 })
    const terminal = await runner.terminals.attach(created.id)
    const writer = view(terminal, resources)
    await writer.until("PTY_READY")
    const viewer = await (await app.connect()).terminals.attach(created.id, { mode: "observe" })
    expect(viewer.mode).toBe("observe")
    await expect(viewer.write("denied")).rejects.toMatchObject({ code: "CONTROL_REQUIRED" })
    const slow = view(viewer, resources)
    await slow.next()
    // The controller keeps reading; the viewer stops, so it acknowledges nothing.
    const writing = writer.until("SLOW_DONE")
    for (let index = 0; index < 20; index++) {
      // eslint-disable-next-line no-await-in-loop -- Produce ordered output beyond the viewer budget.
      await print(terminal, `LINE_${index}_${"x".repeat(200)}`)
    }
    await print(terminal, "SLOW_DONE")
    await writing
    await slow.until("SLOW_DONE")
    expect(slow.events.filter((event) => event.type === "snapshot").length).toBeGreaterThan(1)
  })

  it("finishes attached iteration when the client closes, leaving the shell running", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const runner = await app.connect()
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create({ sessionId, cols: 80, rows: 24 })
    const terminal = await runner.terminals.attach(created.id)
    await view(terminal, resources).until("PTY_READY")
    const pending = terminal.next()
    await runner.close()
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
    expect(runner.status).toEqual({ state: "closed" })
    await expect(runner.projects.list()).rejects.toMatchObject({ code: "CLOSED" })
    const again = await app.connect()
    await expect(again.terminals.list({ sessionId })).resolves.toEqual([
      expect.objectContaining({ id: created.id, status: "running" }),
    ])
  })
})

describe("runner client resilience", () => {
  it("reclaims control after a disconnection only the client noticed", async ({ resources }) => {
    const app = await deployed(resources)
    const link = interruptible(websocket(app.url, { token }))
    const runner = await app.connect(link.transport)
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create({ sessionId, cols: 80, rows: 24 })
    const terminal = await runner.terminals.attach(created.id)
    const screen = view(terminal, resources)
    await screen.until("PTY_READY")
    // The runner still believes the old connection holds control.
    link.halfOpen()
    link.resume()
    const reading = screen.until("AFTER_TAKEOVER")
    let written = false
    while (!written) {
      // eslint-disable-next-line no-await-in-loop -- Input fails until the attachment resumes.
      written = await print(terminal, "AFTER_TAKEOVER").then(
        () => true,
        async (error: unknown) => {
          expect(error).toMatchObject({ code: "DISCONNECTED" })
          await new Promise((resolve) => setTimeout(resolve, 10))
          return false
        },
      )
    }
    await reading
  })

  it("detaching during a reattachment releases control", async ({ resources }) => {
    const app = await deployed(resources)
    const link = interruptible(websocket(app.url, { token }))
    const runner = await app.connect(link.transport)
    const status = statuses(runner)
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create({ sessionId, cols: 80, rows: 24 })
    const terminal = await runner.terminals.attach(created.id)
    await terminal.next()
    link.interrupt()
    await status.until("reconnecting")
    const pending = terminal.next()
    await terminal.detach()
    link.resume()
    await status.until("connected")
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
    const other = await app.connect()
    const taken = await other.terminals.attach(created.id)
    expect(taken.mode).toBe("control")
  })

  it("gives up on an unanswered handshake and honours cancellation", async ({ resources }) => {
    const { port1, port2 } = new MessageChannel()
    resources.defer(() => port1.close())
    const silent = messagePort(port2)
    await expect(connectRunner(silent, { timeout: 50 })).rejects.toMatchObject({
      code: "DISCONNECTED",
    })
    const cancel = new AbortController()
    const unanswered = new MessageChannel()
    resources.defer(() => unanswered.port1.close())
    const connecting = connectRunner(messagePort(unanswered.port2), {
      signal: cancel.signal,
    })
    cancel.abort(new Error("Unmounted"))
    await expect(connecting).rejects.toThrow("Unmounted")
  })

  it("stops watching status immediately when the consumer leaves", async ({ resources }) => {
    const app = await deployed(resources)
    const runner = await app.connect()
    const watching = runner.watch()
    expect(await watching.next()).toMatchObject({ value: { state: "connected" } })
    const pending = watching.next()
    await watching.return?.()
    await expect(pending).resolves.toMatchObject({ done: true })
  })
})

describe("runner client over MessagePort", () => {
  it("serves a trusted client without a token and releases control when the port closes", async ({
    resources,
  }) => {
    const app = await bundled(resources)
    const { client } = await app.connect()
    const { id: sessionId } = await session(client, app.directory)
    const created = await client.terminals.create({ sessionId, cols: 80, rows: 24 })
    const terminal = await client.terminals.attach(created.id)
    const screen = view(terminal, resources)
    await screen.until("PTY_READY")
    await print(terminal, "OVER_PORT")
    await screen.until("OVER_PORT")
    await client.close()

    const { client: next } = await app.connect()
    const replacement = await next.terminals.attach(created.id)
    const restored = view(replacement, resources)
    expect(await restored.next()).toMatchObject({ type: "snapshot" })
    expect(restored.text()).toContain("OVER_PORT")
    await print(replacement, "NEW_OWNER")
    await restored.until("NEW_OWNER")
  })

  it("closes with CLOSED when a single port ends, since it cannot reconnect", async ({
    resources,
  }) => {
    const app = await bundled(resources)
    const { client, dispose } = await app.connect()
    const status = statuses(client)
    dispose()
    await status.watching
    expect(client.status).toMatchObject({ state: "closed", error: { code: "CLOSED" } })
  })
})
