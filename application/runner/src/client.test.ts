import { mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
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
  type TerminalWatchItem,
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
  return { directory, runner, connect }
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

/** Input for an 80x24 terminal with a fresh id. */
const shell = (sessionId: string) => ({ id: crypto.randomUUID(), sessionId, cols: 80, rows: 24 })

const session = async (runner: Runner, cwd: string) => {
  const project = await runner.projects.create({ id: crypto.randomUUID(), name: "Client", cwd })
  return runner.sessions.create({ id: crypto.randomUUID(), projectId: project.id, name: "Session" })
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

/** Reads `terminals.watch()` until a change matches, collecting everything it read. */
const changes = (runner: Runner, resources: Resources) => {
  const stream = runner.terminals.watch()
  resources.defer(async () => {
    await stream.return?.()
  })
  const seen: TerminalWatchItem[] = []
  const until = async (predicate: (change: TerminalWatchItem) => boolean) => {
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
      const result = await stream.next()
      if (result.done) throw new Error(`Watch ended; seen=${JSON.stringify(seen)}`)
      seen.push(result.value)
      if (predicate(result.value)) return result.value
    }
  }
  const synced = () => until((change) => change.type === "synced")
  return { stream, seen, until, synced }
}

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
    const created = await runner.terminals.create(shell(sessionId))
    await expect(runner.terminals.list({ sessionId })).resolves.toEqual([created])

    const terminal = await runner.terminals.attach(created.id)
    expect(terminal).toMatchObject({ id: created.id, mode: "control" })
    const screen = view(terminal, resources)
    expect(await screen.next()).toMatchObject({ type: "snapshot", exit: null })
    await screen.until("PTY_READY")
    await print(terminal, "HELLO_RUNNER")
    await screen.until("HELLO_RUNNER")
    await terminal.resize({ cols: 100, rows: 30 })
    await terminal.write(command({ type: "exit", code: 3 }))
    const rest: TerminalEvent[] = []
    for await (const event of terminal) rest.push(event)
    expect(rest).toContainEqual(expect.objectContaining({ type: "resized", cols: 100, rows: 30 }))
    expect(rest.at(-1)).toMatchObject({ type: "exited", exit: { code: 3 } })
    await expect(terminal.write("ignored")).rejects.toMatchObject({ code: "TERMINAL_EXITED" })
    // Closing an exited terminal needs no attachment and forgets it.
    await runner.terminals.close(created.id)
    await expect(runner.terminals.list({ sessionId })).resolves.toEqual([])
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
      runner.projects.create({
        id: crypto.randomUUID(),
        name: "Missing",
        cwd: join(app.directory, "missing"),
      }),
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
    const created = await runner.terminals.create(shell(sessionId))
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
    const created = await runner.terminals.create(shell(sessionId))
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
    const created = await runner.terminals.create(shell(sessionId))
    const terminal = await runner.terminals.attach(created.id)
    await view(terminal, resources).until("PTY_READY")
    const pending = terminal.next()
    await runner.close()
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
    expect(runner.status).toEqual({ state: "closed" })
    await expect(runner.projects.list()).rejects.toMatchObject({ code: "CLOSED" })
    const again = await app.connect()
    await expect(again.terminals.list({ sessionId })).resolves.toEqual([
      expect.objectContaining({ id: created.id, exit: null }),
    ])
  })
})

describe("runner client workspace", () => {
  it("rejects taken ids, defaults the project directory and stores session state", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const runner = await app.connect()
    const ids = { project: crypto.randomUUID(), session: crypto.randomUUID() }
    const project = await runner.projects.create({ id: ids.project, name: "Home" })
    expect(project).toEqual({ id: ids.project, name: "Home", cwd: await realpath(homedir()) })
    await expect(
      runner.projects.create({ id: ids.project, name: "Again", cwd: app.directory }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    const created = await runner.sessions.create({
      id: ids.session,
      projectId: project.id,
      name: "A",
    })
    expect(created).toEqual({ id: ids.session, projectId: project.id, name: "A", state: null })
    await expect(
      runner.sessions.create({ id: ids.session, projectId: project.id, name: "B" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    await expect(
      runner.sessions.save({ sessionId: created.id, state: '{"layout":"split"}' }),
    ).resolves.toBeUndefined()
    await expect(runner.sessions.list({ projectId: project.id })).resolves.toEqual([
      { ...created, state: '{"layout":"split"}' },
    ])
    await expect(
      runner.sessions.save({ sessionId: crypto.randomUUID(), state: "{}" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })

    const terminal = { id: crypto.randomUUID(), sessionId: created.id, cols: 80, rows: 24 }
    await expect(runner.terminals.create(terminal)).resolves.toMatchObject({ id: terminal.id })
    await expect(runner.terminals.create(terminal)).rejects.toMatchObject({ code: "CONFLICT" })
  })
})

describe("runner client terminal closing", () => {
  it("closes terminals without attaching, unless another connection controls them", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const creator = await app.connect()
    const other = await app.connect()
    const { id: sessionId } = await session(creator, app.directory)
    const held = await creator.terminals.create(shell(sessionId))
    const left = await creator.terminals.create(shell(sessionId))
    await expect(other.terminals.close(held.id)).rejects.toMatchObject({ code: "CONTROL_IN_USE" })
    await creator.terminals.close(held.id)
    await expect(creator.terminals.list({ sessionId })).resolves.toEqual([
      expect.objectContaining({ id: left.id }),
    ])
    // Once its creator has gone, nobody controls the terminal and anyone may close it.
    await creator.close()
    // The runner releases control when it notices the disconnection.
    let closed = false
    while (!closed) {
      // eslint-disable-next-line no-await-in-loop -- Retry until the release lands.
      closed = await other.terminals.close(left.id).then(
        () => true,
        async (error: unknown) => {
          expect(error).toMatchObject({ code: "CONTROL_IN_USE" })
          await new Promise((resolve) => setTimeout(resolve, 10))
          return false
        },
      )
    }
    await expect(other.terminals.list({ sessionId })).resolves.toEqual([])
    await expect(other.terminals.close(left.id)).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })
})

describe("runner client agent detail", () => {
  it("follows a terminal's agent, and ends once the terminal is gone", async ({ resources }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId } = await session(client, app.directory)
    const terminal = await client.terminals.create(shell(sessionId))
    const details = client.agents.detail(terminal.id)
    await expect(details.next()).resolves.toEqual({
      done: false,
      value: {
        terminalId: terminal.id,
        agent: null,
        sessionId: null,
        activity: null,
        telemetry: null,
        actors: [],
        requests: [],
        plans: [],
        coverage: null,
      },
    })
    // No agent runs there, so no actor has a transcript or a plan.
    await expect(client.agents.plan(terminal.id, "x".repeat(16)).next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
    await expect(client.agents.transcript(terminal.id, "x".repeat(16)).next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
    const ending = details.next()
    await client.terminals.close(terminal.id)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    await expect(client.agents.detail(crypto.randomUUID()).next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })
})

describe("runner client shown artifacts", () => {
  it("follows what a terminal's agents showed, and ends once the terminal is gone", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId } = await session(client, app.directory)
    const terminal = await client.terminals.create(shell(sessionId))
    const shown = client.agents.shown(terminal.id)
    await expect(shown.next()).resolves.toEqual({
      done: false,
      value: { terminalId: terminal.id, shown: [] },
    })
    await expect(client.agents.artifact(terminal.id, "nothing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const ending = shown.next()
    await client.terminals.close(terminal.id)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    await expect(client.agents.artifact(terminal.id, "nothing")).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })
})

describe("runner client agent detail across reconnections", () => {
  it("resubscribes after a reconnection and a half-open link", async ({ resources }) => {
    const app = await deployed(resources)
    const link = interruptible(websocket(app.url, { token }))
    const runner = await app.connect(link.transport)
    const status = statuses(runner)
    const { id: sessionId } = await session(runner, app.directory)
    const terminal = await runner.terminals.create(shell(sessionId))
    const details = runner.agents.detail(terminal.id)
    expect((await details.next()).value).toMatchObject({ terminalId: terminal.id })
    link.interrupt()
    await status.until("reconnecting")
    const after = details.next()
    link.resume()
    await status.until("connected")
    expect((await after).value).toMatchObject({ terminalId: terminal.id })
    link.halfOpen()
    await status.until("reconnecting")
    const again = details.next()
    link.resume()
    await status.until("connected")
    expect((await again).value).toMatchObject({ terminalId: terminal.id })
    const ending = details.next()
    await runner.terminals.close(terminal.id)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
  })

  it("keeps following a terminal across its exit and restart", async ({ resources }) => {
    const app = await deployed(resources)
    const runner = await app.connect()
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create(shell(sessionId))
    const details = runner.agents.detail(created.id)
    await details.next()
    const terminal = await runner.terminals.attach(created.id)
    const screen = view(terminal, resources)
    await screen.until("PTY_READY")
    await terminal.write(command({ type: "exit", code: 0 }))
    await changes(runner, resources).until(
      (change) =>
        change.type === "changed" &&
        change.terminal.id === created.id &&
        change.terminal.exit !== null,
    )
    await runner.terminals.restart(created.id, { cols: 80, rows: 24 })
    let settled = false
    const ending = details.next()
    void ending.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(settled).toBe(false)
    await runner.terminals.close(created.id)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
  })
})

describe("runner client terminal restart", () => {
  it("restarts an exited terminal in place and attaches to its new screen", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const runner = await app.connect()
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create(shell(sessionId))
    const size = { cols: 90, rows: 20 }
    await expect(runner.terminals.restart(created.id, size)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    const first = await runner.terminals.attach(created.id)
    const screen = view(first, resources)
    await screen.until("PTY_READY")
    await first.write(command({ type: "exit", code: 4 }))
    for await (const event of first) {
      if (event.type === "exited") expect(event.exit).toMatchObject({ code: 4, signal: null })
    }

    await expect(runner.terminals.restart(created.id, size)).resolves.toMatchObject({
      id: created.id,
      exit: null,
      ...size,
    })
    const again = await runner.terminals.attach(created.id)
    const next = view(again, resources)
    expect(await next.next()).toMatchObject({ type: "snapshot", exit: null, ...size })
    await next.until("PTY_READY")
    await print(again, "SECOND_RUN")
    await next.until("SECOND_RUN")
    await expect(runner.terminals.restart(crypto.randomUUID(), size)).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })
})

describe("runner client terminal watch", () => {
  it("resynchronizes after a reconnection with every terminal, then synced", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const link = interruptible(websocket(app.url, { token }))
    const runner = await app.connect(link.transport)
    const status = statuses(runner)
    const { id: sessionId } = await session(runner, app.directory)
    const watch = changes(runner, resources)
    await watch.synced()
    expect(watch.seen).toEqual([{ type: "reset" }, { type: "synced" }])
    const first = await runner.terminals.create(shell(sessionId))
    await watch.until((change) => change.type === "changed" && change.terminal.id === first.id)

    link.interrupt()
    await status.until("reconnecting")
    // Created by another client during the gap, so only the fresh sync can report it.
    const other = await app.connect()
    const second = await other.terminals.create(shell(sessionId))
    link.resume()
    watch.seen.length = 0
    await watch.synced()
    // `reset` opens the fresh sequence, so a consumer knows to start its set over.
    expect(watch.seen).toEqual([
      { type: "reset" },
      { type: "changed", terminal: expect.objectContaining({ id: first.id }) },
      { type: "changed", terminal: expect.objectContaining({ id: second.id }) },
      { type: "synced" },
    ])

    const pending = watch.stream.next()
    await watch.stream.return?.()
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
  })

  it.skipIf(process.platform === "win32")(
    "keeps retrying on a live link while the runner refuses for too many calls",
    async ({ resources }) => {
      // Shells that ignore a hangup hold each close in flight for about a second.
      const app = await deployed(resources, {
        terminals: { shell: "/bin/sh", shellArgs: ["-c", "trap '' HUP; exec cat"] },
      })
      const runner = await app.connect()
      const { id: sessionId } = await session(runner, app.directory)
      const busy = []
      for (let index = 0; index < 32; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- Creation stays under the call limit.
        busy.push(await runner.terminals.create(shell(sessionId)))
      }
      const closing = Promise.all(busy.map((terminal) => runner.terminals.close(terminal.id)))
      await expect(runner.projects.list()).rejects.toMatchObject({ code: "RESOURCE_LIMIT" })

      const watch = changes(runner, resources)
      await watch.synced()
      // The refused attempts yield nothing; the one subscription that lands opens with `reset`.
      expect(watch.seen[0]).toEqual({ type: "reset" })
      expect(watch.seen.filter((change) => change.type === "reset")).toHaveLength(1)
      await closing
      const later = await runner.terminals.create(shell(sessionId))
      await watch.until((change) => change.type === "changed" && change.terminal.id === later.id)
    },
  )

  it("starts over after a runner restart and ends when the client closes", async ({
    resources,
  }) => {
    const directory = await temporary(resources)
    const database = join(directory, "workspace.sqlite")
    const start = async () => {
      const server = await startServer({ port: 0, token, database, terminals: ptyOptions })
      resources.defer(() => server.close())
      return { server, url: `${server.origin.replace(/^http/, "ws")}/api/rpc` }
    }
    let current = await start()
    const runner = await connectRunner(
      { token, connect: (signal) => websocket(current.url, { token }).connect(signal) },
      fast,
    )
    resources.defer(() => runner.close())
    const status = statuses(runner)
    const { id: sessionId } = await session(runner, directory)
    await runner.terminals.create(shell(sessionId))
    const watch = changes(runner, resources)
    await watch.synced()
    expect(watch.seen).toEqual([
      { type: "reset" },
      { type: "changed", terminal: expect.anything() },
      { type: "synced" },
    ])

    await current.server.close()
    await status.until("reconnecting")
    current = await start()
    watch.seen.length = 0
    // The terminal ended with the old runner; the fresh sync omits it.
    await watch.synced()
    expect(watch.seen).toEqual([{ type: "reset" }, { type: "synced" }])

    const pending = watch.stream.next()
    await runner.close()
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
  })
})

describe("runner client resilience", () => {
  it("reclaims control after a disconnection only the client noticed", async ({ resources }) => {
    const app = await deployed(resources)
    const link = interruptible(websocket(app.url, { token }))
    const runner = await app.connect(link.transport)
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create(shell(sessionId))
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
    const created = await runner.terminals.create(shell(sessionId))
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
    const created = await client.terminals.create(shell(sessionId))
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

  it("lets the trusted desktop client burst beyond a WebSocket client's call limit", async ({
    resources,
  }) => {
    const app = await bundled(resources)
    const { client } = await app.connect()
    const created = await Promise.all(
      Array.from({ length: 64 }, () =>
        client.projects.create({ id: crypto.randomUUID(), name: "Burst", cwd: app.directory }),
      ),
    )
    expect(created).toHaveLength(64)
  })

  it("refuses session saves once the runner starts shutting down", async ({ resources }) => {
    const app = await bundled(resources)
    const { client } = await app.connect()
    const { id: sessionId } = await session(client, app.directory)
    // A running shell keeps shutdown busy while it ends, as the desktop app's do.
    await client.terminals.create(shell(sessionId))
    await expect(client.sessions.save({ sessionId, state: "before" })).resolves.toBeUndefined()
    const closing = app.runner.close()
    await expect(client.sessions.save({ sessionId, state: "after" })).rejects.toMatchObject({
      code: "RUNTIME_CLOSING",
    })
    await closing
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
