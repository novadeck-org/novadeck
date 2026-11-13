import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { MessageChannel } from "node:worker_threads"

import { maxUploadBytes, type TerminalEvent } from "@novadeck/protocol"
import {
  connectRunner,
  type AttachedTerminal,
  type CompanionWatchItem,
  type Runner,
  type TerminalWatchItem,
} from "@novadeck/runner-client"
import { command } from "@novadeck/terminal/testing"
import { type Channel } from "@novadeck/wire"
import { messagePort, websocket, type Transport, type WireStatus } from "@novadeck/wire/client"
import { servePort } from "@novadeck/wire/server"
import { vi } from "vitest"

import { createRunner } from "./index.js"
import { startServer, type ServerOptions } from "./server.js"
import { handleWords } from "./terminals/handles.js"
import { describe, expect, it } from "./test.js"
import { ptyOptions } from "./testing/pty.js"
import type { Resources } from "./testing/resources.js"
import { WorkspaceStore } from "./workspaces/store.js"

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
    // The list's order, not each session's shuffle, so tests know the handles given.
    terminals: { ...ptyOptions, handleOrder: () => handleWords, ...options.terminals },
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
  const runner = createRunner({ terminals: { ...ptyOptions, handleOrder: () => handleWords } })
  resources.defer(() => runner.close())
  const connect = async () => {
    const { port1, port2 } = new MessageChannel()
    const dispose = servePort(runner.sessions, port1)
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
  const seen: WireStatus["state"][] = []
  const watching = (async () => {
    for await (const status of runner.watch()) seen.push(status.state)
  })()
  const until = async (state: WireStatus["state"]) => {
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
    expect(runner.status).toEqual({ state: "connected", epoch: expect.any(String) })
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
      name: "WireError",
      code: "UNAUTHORIZED",
    })
    const runner = await app.connect()
    await expect(runner.terminals.attach(crypto.randomUUID())).rejects.toMatchObject({
      name: "WireError",
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
    // Should the test end early, its read ends with the terminal: that is not a second failure.
    writing.catch(() => {})
    // One write, so the controller sends nothing while it reads: the tight budget that cuts
    // the viewer off can cut it off too on a loaded runner, and a controller being resynchronized
    // has no control until it reattaches (a write then fails CONTROL_REQUIRED).
    const lines = Array.from({ length: 20 }, (_, index) => `LINE_${index}_${"x".repeat(200)}`)
    await print(terminal, [...lines, "SLOW_DONE"].join("\r\n"))
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
    expect(project).toEqual({
      id: ids.project,
      name: "Home",
      cwd: await realpath(homedir()),
      pinned: false,
    })
    await expect(
      runner.projects.create({ id: ids.project, name: "Again", cwd: app.directory }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    const created = await runner.sessions.create({
      id: ids.session,
      projectId: project.id,
      name: "A",
    })
    expect(created).toEqual({
      id: ids.session,
      projectId: project.id,
      name: "A",
      state: null,
      visitedAt: null,
    })
    await expect(
      runner.sessions.create({ id: ids.session, projectId: project.id, name: "B" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    await expect(
      runner.sessions.save({
        sessionId: created.id,
        state: '{"layout":"split"}',
        visitedAt: 5,
      }),
    ).resolves.toBeUndefined()
    await expect(runner.sessions.list({ projectId: project.id })).resolves.toEqual([
      { ...created, state: '{"layout":"split"}', visitedAt: 5 },
    ])
    await expect(
      runner.sessions.save({ sessionId: crypto.randomUUID(), state: "{}", visitedAt: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })

    const terminal = { id: crypto.randomUUID(), sessionId: created.id, cols: 80, rows: 24 }
    await expect(runner.terminals.create(terminal)).resolves.toMatchObject({ id: terminal.id })
    await expect(runner.terminals.create(terminal)).rejects.toMatchObject({ code: "CONFLICT" })
  })
})

describe("runner client terminal closing", () => {
  it("closes terminals without attaching, whoever controls them", async ({ resources }) => {
    const app = await deployed(resources)
    const creator = await app.connect()
    const other = await app.connect()
    const { id: sessionId } = await session(creator, app.directory)
    const held = await creator.terminals.create(shell(sessionId))
    const left = await creator.terminals.create(shell(sessionId))
    // Its creator controls it; another connection closes it all the same, for good.
    await other.terminals.close(held.id)
    await expect(creator.terminals.list({ sessionId })).resolves.toEqual([
      expect.objectContaining({ id: left.id }),
    ])
    await creator.terminals.close(left.id)
    await expect(other.terminals.list({ sessionId })).resolves.toEqual([])
    await expect(other.terminals.close(left.id)).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })
})

describe("runner client busy terminals", () => {
  it.skipIf(process.platform === "win32")(
    "names a shell with a background job, and not an idle one",
    async ({ resources }) => {
      const app = await deployed(resources, {
        terminals: { shell: "/bin/sh", shellArgs: [], env: { PATH: process.env.PATH ?? "" } },
      })
      const client = await app.connect()
      const { id: sessionId } = await session(client, app.directory)
      await client.terminals.create(shell(sessionId))
      const job = await client.terminals.create(shell(sessionId))
      const typing = await client.terminals.attach(job.id, { mode: "control" })
      const screen = view(typing, resources)
      await screen.next()
      await typing.write("sleep 30 &\n")
      await vi.waitFor(
        async () => expect(await client.terminals.busy()).toEqual({ busy: [job.id], unknown: [] }),
        {
          timeout: 5_000,
        },
      )
      await expect(client.terminals.busy({ fresh: true })).resolves.toEqual({
        busy: [job.id],
        unknown: [],
      })
    },
  )
})

/** What the workspace database at `path` still holds of each table, by the column given. */
const rows = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const all = (sql: string) =>
      (database.prepare(sql).all() as { value: string }[]).map(({ value }) => value).toSorted()
    return {
      projects: all("SELECT id AS value FROM projects"),
      sessions: all("SELECT id AS value FROM sessions"),
      terminals: all("SELECT id AS value FROM terminals"),
      handles: all("SELECT DISTINCT project_id AS value FROM project_handles"),
      messages: all("SELECT project_id AS value FROM messages"),
      threads: all("SELECT project_id AS value FROM message_threads"),
    }
  } finally {
    database.close()
  }
}

describe("runner client project removal", () => {
  it("takes its companion items and undocked windows along, telling watchers", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId, projectId } = await session(client, app.directory)
    const terminal = await client.terminals.create(shell(sessionId))
    const directory = await realpath(app.directory)
    await writeFile(join(directory, "a.md"), "# A\n")
    await writeFile(join(directory, "b.md"), "# B\n")
    const watch = client.companions.watch()
    resources.defer(async () => {
      await watch.return?.()
    })
    const seen: CompanionWatchItem[] = []
    const until = async (predicate: (change: CompanionWatchItem) => boolean) => {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
        const result = await watch.next()
        if (result.done) throw new Error(`Watch ended; seen=${JSON.stringify(seen)}`)
        seen.push(result.value)
        if (predicate(result.value)) return result.value
      }
    }
    await until((change) => change.type === "synced")
    const onBar = await client.companions.attach({ terminalId: terminal.id, path: "a.md" })
    const inWindow = await client.companions.attach({ terminalId: terminal.id, path: "b.md" })
    const windowId = crypto.randomUUID()
    await client.companions.undock(inWindow.id, windowId)
    const content = client.companions.content(inWindow.id)
    await expect(content.next()).resolves.toMatchObject({ value: { state: "ready" } })
    const ending = content.next()

    await client.projects.remove({ projectId })
    const gone = (change: CompanionWatchItem) =>
      (change.type === "itemRemoved" && change.itemId === inWindow.id) ||
      (change.type === "windowRemoved" && change.windowId === windowId)
    await until(gone)
    await until(gone)
    expect(seen).toContainEqual({ type: "itemRemoved", itemId: onBar.id, sessionId })
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    await expect(client.companions.list({ sessionId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("closes the project's terminals, running or kept, and forgets everything it kept", async ({
    resources,
  }) => {
    const directory = await temporary(resources)
    const database = join(directory, "workspace.sqlite")
    // A project an earlier runner left a terminal and agents' messages in, beside another.
    const earlier = new WorkspaceStore(database)
    const ids = { removed: crypto.randomUUID(), kept: crypto.randomUUID() }
    const sessions = { removed: crypto.randomUUID(), kept: crypto.randomUUID() }
    for (const project of ["removed", "kept"] as const) {
      // eslint-disable-next-line no-await-in-loop -- Each project before its session.
      await earlier.createProject({ id: ids[project], name: project, cwd: directory })
      earlier.createSession({ id: sessions[project], projectId: ids[project], name: project })
      earlier.saveThread({
        id: `t-${project}`,
        projectId: ids[project],
        between: ["a", "b"],
        hops: 1,
        heldFrom: null,
        heldFor: null,
        lastAt: Date.now(),
        stoppedAt: null,
      })
      earlier.saveMessage({
        id: `m-${project}`,
        projectId: ids[project],
        thread: `t-${project}`,
        hop: 1,
        from: { kind: "agent", terminalId: "a", handle: "moth", agent: null, sessionId: null },
        to: { terminalId: "b", handle: "fox", agent: "codex", sessionId: null },
        text: "Hello",
        sentAt: Date.now(),
        state: "delivered",
        deliveredAt: Date.now(),
        notified: false,
        stopped: false,
        fromLead: false,
        toLead: false,
      })
    }
    const saved = crypto.randomUUID()
    earlier.saveTerminal({
      id: saved,
      sessionId: sessions.removed,
      cwd: directory,
      agents: {},
      promptedAt: null,
      handle: earlier.giveHandle(sessions.removed),
      naming: { person: null, opener: null, murmur: null, own: null, summary: null },
      openedBy: null,
      ledBy: null,
      command: null,
      lastProgram: null,
      work: null,
    })
    earlier.close()

    const app = await deployed(resources, { database })
    const client = await app.connect()
    // Another window holds control of the running terminal; removing closes it anyway.
    const other = await app.connect()
    const running = await other.terminals.create(shell(sessions.removed))
    const elsewhere = await client.terminals.create(shell(sessions.kept))
    const watch = changes(client, resources)
    await watch.synced()
    await client.projects.remove({ projectId: ids.removed })
    const removed = new Set<string>()
    while (removed.size < 2) {
      // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
      const change = await watch.until((item) => item.type === "removed")
      if (change.type === "removed") removed.add(change.terminalId)
    }
    expect(removed).toEqual(new Set([running.id, saved]))

    await expect(client.projects.list()).resolves.toEqual([
      { id: ids.kept, name: "kept", cwd: await realpath(directory), pinned: false },
    ])
    for (const call of [
      () => client.projects.remove({ projectId: ids.removed }),
      () => client.projects.remove({ projectId: crypto.randomUUID() }),
      () => client.sessions.list({ projectId: ids.removed }),
      () => client.terminals.list({ sessionId: sessions.removed }),
      () => client.terminals.create(shell(sessions.removed)),
    ])
      // eslint-disable-next-line no-await-in-loop -- One call at a time.
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(client.terminals.list({ sessionId: sessions.kept })).resolves.toEqual([
      expect.objectContaining({ id: elsewhere.id }),
    ])
    expect(rows(database)).toEqual({
      projects: [ids.kept],
      sessions: [sessions.kept],
      terminals: [elsewhere.id],
      handles: [ids.kept],
      messages: [ids.kept],
      threads: [ids.kept],
    })
  })

  it.skipIf(process.platform === "win32")(
    "leaves the project out of listings and refuses sessions in it while it goes",
    async ({ resources }) => {
      // A shell that ignores a hangup holds the removal open for about a second, once it
      // says it does.
      const app = await deployed(resources, {
        terminals: { shell: "/bin/sh", shellArgs: ["-c", "trap '' HUP; echo ready; exec cat"] },
      })
      const client = await app.connect()
      const { id: sessionId, projectId } = await session(client, app.directory)
      const terminal = await client.terminals.create(shell(sessionId))
      await view(await client.terminals.attach(terminal.id), resources).until("ready")
      const removing = client.projects.remove({ projectId })
      // Asked once the removal began, long before its shell is gone.
      await expect(client.projects.list()).resolves.toEqual([])
      await expect(
        client.sessions.create({ id: crypto.randomUUID(), projectId, name: "Late" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await removing
    },
  )

  it("closes terminals created as it begins, refusing new ones, and shares a second call", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId, projectId } = await session(client, app.directory)
    const watch = changes(client, resources)
    await watch.synced()
    const creating = client.terminals.create(shell(sessionId))
    const removing = client.projects.remove({ projectId })
    const again = client.projects.remove({ projectId })
    const refused = expect(
      client.sessions.create({ id: crypto.randomUUID(), projectId, name: "Late" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    const created = await creating
    await expect(Promise.all([removing, again])).resolves.toEqual([undefined, undefined])
    await refused
    await watch.until((change) => change.type === "removed" && change.terminalId === created.id)
    expect(rows(join(app.directory, "workspace.sqlite"))).toMatchObject({
      projects: [],
      sessions: [],
      terminals: [],
      handles: [],
    })
  })
})

describe("runner client session management", () => {
  it("lists sessions as arranged, newest first, ignoring ids the project lacks", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const project = await client.projects.create({
      id: crypto.randomUUID(),
      name: "P",
      cwd: app.directory,
    })
    const other = await client.projects.create({
      id: crypto.randomUUID(),
      name: "Other",
      cwd: app.directory,
    })
    const foreign = await client.sessions.create({
      id: crypto.randomUUID(),
      projectId: other.id,
      name: "Foreign",
    })
    const names = async () =>
      (await client.sessions.list({ projectId: project.id })).map(({ name }) => name)
    const [a, b, c] = ["A", "B", "C"].map((name) => ({ id: crypto.randomUUID(), name }))
    for (const { id, name } of [a!, b!, c!])
      // eslint-disable-next-line no-await-in-loop -- Created in order.
      await client.sessions.create({ id, projectId: project.id, name })
    // Each new session comes first.
    expect(await names()).toEqual(["C", "B", "A"])

    await client.sessions.arrange({
      projectId: project.id,
      order: [a!.id, foreign.id, crypto.randomUUID(), c!.id, a!.id],
    })
    // B was left out and follows; the foreign session stays in its own project.
    expect(await names()).toEqual(["A", "C", "B"])
    await expect(client.sessions.list({ projectId: other.id })).resolves.toMatchObject([
      { id: foreign.id },
    ])

    const d = { id: crypto.randomUUID(), projectId: project.id, name: "D" }
    await client.sessions.create(d)
    expect(await names()).toEqual(["D", "A", "C", "B"])
    await expect(
      client.sessions.arrange({ projectId: crypto.randomUUID(), order: [] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("closes a session's terminals, running or kept, into History, and restores one beside it", async ({
    resources,
  }) => {
    const directory = await temporary(resources)
    const database = join(directory, "workspace.sqlite")
    const earlier = new WorkspaceStore(database)
    const ids = { project: crypto.randomUUID(), going: crypto.randomUUID() }
    const staying = crypto.randomUUID()
    await earlier.createProject({ id: ids.project, name: "P", cwd: directory })
    earlier.createSession({ id: staying, projectId: ids.project, name: "Staying" })
    earlier.createSession({ id: ids.going, projectId: ids.project, name: "Going" })
    const saved = crypto.randomUUID()
    earlier.saveTerminal({
      id: saved,
      sessionId: ids.going,
      cwd: directory,
      agents: {},
      promptedAt: null,
      handle: earlier.giveHandle(ids.going),
      naming: { person: null, opener: null, murmur: null, own: null, summary: null },
      openedBy: null,
      ledBy: null,
      command: null,
      lastProgram: null,
      work: null,
      ran: true,
    })
    earlier.close()

    const app = await deployed(resources, { database })
    const client = await app.connect()
    // Another window holds control of the running terminal; removing closes it anyway.
    const other = await app.connect()
    const running = await other.terminals.create(shell(ids.going))
    const attached = await other.terminals.attach(running.id)
    const screen = view(attached, resources)
    await print(attached, "echo started")
    await screen.until("started")
    const elsewhere = await client.terminals.create(shell(staying))
    const watch = changes(client, resources)
    await watch.synced()

    await client.sessions.remove({ sessionId: ids.going })
    const removed = new Set<string>()
    while (removed.size < 2) {
      // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
      const change = await watch.until((item) => item.type === "removed")
      if (change.type === "removed") removed.add(change.terminalId)
    }
    expect(removed).toEqual(new Set([running.id, saved]))

    await expect(client.sessions.list({ projectId: ids.project })).resolves.toMatchObject([
      { id: staying },
    ])
    await expect(client.terminals.list({ sessionId: ids.going })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(client.terminals.create(shell(ids.going))).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(client.terminals.list({ sessionId: staying })).resolves.toEqual([
      expect.objectContaining({ id: elsewhere.id }),
    ])
    expect(rows(database)).toMatchObject({
      sessions: [staying],
      terminals: [elsewhere.id],
      handles: [ids.project],
    })
    // Both stay in History, to restore into the session that remains.
    const history = await client.history.list({ projectId: ids.project })
    expect(history.map(({ id }) => id).toSorted()).toEqual([running.id, saved].toSorted())
    const restored = await client.terminals.create({ ...shell(staying), closed: saved })
    expect(restored.sessionId).toBe(staying)
  })

  it("refuses to remove a project's last session or one it lacks", async ({ resources }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId, projectId } = await session(client, app.directory)
    await expect(client.sessions.remove({ sessionId })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(client.sessions.remove({ sessionId: crypto.randomUUID() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(client.sessions.list({ projectId })).resolves.toMatchObject([{ id: sessionId }])
  })

  it.skipIf(process.platform === "win32")(
    "shares a second removal and refuses terminals in the session while it goes",
    async ({ resources }) => {
      // A shell that ignores a hangup holds the removal open for about a second, once it
      // says it does.
      const app = await deployed(resources, {
        terminals: { shell: "/bin/sh", shellArgs: ["-c", "trap '' HUP; echo ready; exec cat"] },
      })
      const client = await app.connect()
      const { id: sessionId, projectId } = await session(client, app.directory)
      const kept = await client.sessions.create({
        id: crypto.randomUUID(),
        projectId,
        name: "Kept",
      })
      const terminal = await client.terminals.create(shell(sessionId))
      await view(await client.terminals.attach(terminal.id), resources).until("ready")
      const removing = client.sessions.remove({ sessionId })
      const again = client.sessions.remove({ sessionId })
      // Asked once the removal began, long before its shell is gone.
      await expect(client.terminals.create(shell(sessionId))).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
      await expect(client.sessions.list({ projectId })).resolves.toMatchObject([{ id: kept.id }])
      await expect(Promise.all([removing, again])).resolves.toEqual([undefined, undefined])
    },
  )
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
        coverage: null,
        prompts: [],
        box: null,
      },
    })
    // No agent runs there, so no actor has a transcript.
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

describe("runner client companion items", () => {
  it("attaches, undocks, renames, moves and closes items, as its watch reports", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId } = await session(client, app.directory)
    const first = await client.terminals.create(shell(sessionId))
    const second = await client.terminals.create(shell(sessionId))
    const directory = await realpath(app.directory)
    await writeFile(join(directory, "notes.md"), "# Notes\n")
    const watch = client.companions.watch()
    resources.defer(async () => {
      await watch.return?.()
    })
    const seen: CompanionWatchItem[] = []
    const until = async (predicate: (change: CompanionWatchItem) => boolean) => {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
        const result = await watch.next()
        if (result.done) throw new Error(`Watch ended; seen=${JSON.stringify(seen)}`)
        seen.push(result.value)
        if (predicate(result.value)) return result.value
      }
    }
    await until((change) => change.type === "synced")
    expect(seen).toEqual([{ type: "reset" }, { type: "synced" }])

    const item = await client.companions.attach({ terminalId: first.id, path: "notes.md" })
    expect(item).toMatchObject({
      sessionId,
      holder: { terminalId: first.id },
      kind: "file",
      name: "notes.md",
      path: join(directory, "notes.md"),
      by: "person",
      from: { terminalId: first.id, handle: "moth" },
      version: 1,
    })
    await expect(
      client.companions.attach({ terminalId: first.id, path: "." }),
    ).rejects.toMatchObject({ code: "INVALID_FILE" })
    await expect(
      client.companions.attach({ terminalId: crypto.randomUUID(), path: "notes.md" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    const content = client.companions.content(item.id)
    await expect(content.next()).resolves.toMatchObject({
      value: { state: "ready", content: { kind: "file", lines: ["# Notes"], total: 1 } },
    })
    // A file is no change, and an unknown item is none either.
    await expect(
      client.companions.changeFile({ itemId: item.id, path: "a.ts", layers: ["uncommitted"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      client.companions.changeFile({
        itemId: crypto.randomUUID(),
        path: "a.ts",
        layers: ["uncommitted"],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })

    const windowId = crypto.randomUUID()
    await expect(client.companions.undock(item.id, windowId)).resolves.toEqual({
      id: windowId,
      sessionId,
      home: "undocked",
      itemId: item.id,
      title: "notes.md",
      titleSource: { kind: "default" },
    })
    await client.companions.renameWindow(windowId, "Notes")
    await expect(client.companions.list({ sessionId })).resolves.toMatchObject({
      items: [{ id: item.id, holder: { windowId } }],
      windows: [{ id: windowId, title: "Notes", titleSource: { kind: "person" } }],
    })
    await client.companions.resetWindowTitle(windowId)
    await expect(client.companions.renameWindow(crypto.randomUUID(), "x")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })

    // Docked on the other terminal's bar, its window goes.
    await expect(client.companions.move(item.id, second.id)).resolves.toMatchObject({
      holder: { terminalId: second.id },
    })
    await expect(client.companions.list({ sessionId })).resolves.toMatchObject({
      items: [{ id: item.id, holder: { terminalId: second.id } }],
      windows: [],
    })
    await until((change) => change.type === "windowRemoved")

    const ending = content.next()
    await client.companions.close(item.id)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    await until((change) => change.type === "itemRemoved")
    await expect(client.companions.list({ sessionId })).resolves.toEqual({ items: [], windows: [] })
    await expect(client.companions.list({ sessionId: crypto.randomUUID() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(client.companions.move(item.id, first.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("runner client project window", () => {
  it("opens one file at a time in a session's project window, which stays there", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId } = await session(client, app.directory)
    const terminal = await client.terminals.create(shell(sessionId))
    const directory = await realpath(app.directory)
    await writeFile(join(directory, "one.md"), "# One\n")
    await writeFile(join(directory, "two.md"), "# Two\n")
    const windowId = crypto.randomUUID()

    const opened = await client.companions.openInProject({ sessionId, path: "one.md", windowId })
    expect(opened.item).toMatchObject({
      holder: { windowId },
      name: "one.md",
      path: join(directory, "one.md"),
      by: "person",
      from: null,
      version: 1,
    })
    expect(opened.window).toEqual({
      id: windowId,
      sessionId,
      home: "project",
      itemId: opened.item.id,
      title: "one.md",
      titleSource: { kind: "default" },
    })
    const content = client.companions.content(opened.item.id)
    await expect(content.next()).resolves.toMatchObject({
      value: { state: "ready", content: { lines: ["# One"] } },
    })

    // Another file re-points the same item and window.
    const again = await client.companions.openInProject({
      sessionId,
      path: join(directory, "two.md"),
      windowId: crypto.randomUUID(),
    })
    expect(again).toMatchObject({
      item: { id: opened.item.id, name: "two.md", version: 2 },
      window: { id: windowId, title: "two.md" },
    })
    await expect(content.next()).resolves.toMatchObject({
      value: { state: "ready", content: { lines: ["# Two"] } },
    })

    await expect(client.companions.move(opened.item.id, terminal.id)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(
      client.companions.undock(opened.item.id, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      client.companions.openInProject({
        sessionId: crypto.randomUUID(),
        path: "one.md",
        windowId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      client.companions.openInProject({ sessionId, path: ".", windowId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "INVALID_FILE" })

    const ending = content.next()
    await client.companions.close(opened.item.id)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    await expect(client.companions.list({ sessionId })).resolves.toEqual({ items: [], windows: [] })
  })
})

describe("runner client messages", () => {
  it("lists and watches Inbox entries, rejects a stale answer, and reads tells through the authenticated API", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    await expect(client.inbox.list()).resolves.toEqual([])
    const stream = client.inbox.watch()
    await expect(stream.next()).resolves.toEqual({ done: false, value: [] })
    await expect(
      client.inbox.answer(crypto.randomUUID(), { type: "reply", option: null, text: "Go" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(client.inbox.read([crypto.randomUUID()])).resolves.toBeUndefined()
    await stream.return?.()
  })
  it("lists a terminal's messages, and keeps the pause across runner restarts", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId } = await session(client, app.directory)
    const terminal = await client.terminals.create(shell(sessionId))
    await expect(client.messages.list(terminal.id)).resolves.toEqual({
      terminalId: terminal.id,
      handle: "moth",
      delivery: "unbound",
      waits: null,
      waitsSince: null,
      paused: false,
      threads: [],
    })
    await client.messages.pause(true)
    await expect(client.messages.list(terminal.id)).resolves.toMatchObject({ paused: true })
    await expect(client.messages.release("t-unknown")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(client.messages.list(crypto.randomUUID())).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
    await client.terminals.close(terminal.id)
    // A runner on the same workspace keeps the pause.
    const later = await deployed(resources, { database: join(app.directory, "workspace.sqlite") })
    const again = await later.connect()
    const restored = await again.terminals.create(shell(sessionId))
    await expect(again.messages.list(restored.id)).resolves.toMatchObject({
      handle: "fox",
      paused: true,
    })
  })
})

describe("runner client message watch", () => {
  it("follows a terminal's messages and the pause, and ends once the terminal is gone", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId } = await session(client, app.directory)
    const terminal = await client.terminals.create(shell(sessionId))
    const watch = client.messages.watch(terminal.id)
    await expect(watch.next()).resolves.toEqual({
      done: false,
      value: {
        terminalId: terminal.id,
        handle: "moth",
        delivery: "unbound",
        waits: null,
        waitsSince: null,
        paused: false,
        threads: [],
      },
    })
    await client.messages.pause(true)
    await expect(watch.next()).resolves.toMatchObject({ value: { paused: true } })
    await client.messages.pause(false)
    await expect(watch.next()).resolves.toMatchObject({ value: { paused: false } })
    const ending = watch.next()
    await client.terminals.close(terminal.id)
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    await expect(client.messages.watch(crypto.randomUUID()).next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })
})

describe("runner client terminal requests", () => {
  it("follows agents' requests until the client closes, and refuses what it can't start", async ({
    resources,
  }) => {
    const app = await deployed(resources)
    const client = await app.connect()
    const { id: sessionId } = await session(client, app.directory)
    const requests = client.terminals.requests()
    const waiting = requests.next()
    // Nothing waits for an answer nobody was asked for.
    await expect(
      client.terminals.answerRequest({ requestId: crypto.randomUUID(), reason: "No." }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    // These shells start without Novadeck's integration, so they run no command.
    await expect(
      client.terminals.create({ ...shell(sessionId), command: "echo hi" }),
    ).rejects.toMatchObject({ code: "SPAWN_FAILED" })
    await expect(
      client.terminals.create({ ...shell(sessionId), command: "echo hi", restore: true }),
    ).rejects.toThrow()
    await expect(
      client.terminals.create({ ...shell(sessionId), command: "echo hi\necho bye" }),
    ).rejects.toThrow()
    await expect(client.terminals.list({ sessionId })).resolves.toEqual([])
    await client.close()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
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

describe("runner client uploads", () => {
  it("saves a file larger than a message where the runner keeps uploads, in parts", async ({
    resources,
  }) => {
    const uploads = join(await temporary(resources), "uploads")
    const app = await deployed(resources, { uploads })
    const runner = await app.connect()
    const { id: sessionId } = await session(runner, app.directory)
    const created = await runner.terminals.create(shell(sessionId))
    // Several parts over WebSocket, past a single message's limit.
    const data = Uint8Array.from({ length: 600 * 1024 + 7 }, (_, at) => (at * 31) % 256)
    const path = await runner.terminals.upload(created.id, { name: "screen shot.png", data })
    expect(path.startsWith(join(uploads, ""))).toBe(true)
    expect(path.endsWith("screen shot.png")).toBe(true)
    expect(new Uint8Array(await readFile(path))).toEqual(data)
    await expect(
      runner.terminals.upload(crypto.randomUUID(), { name: "x.png", data }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    await expect(
      runner.terminals.upload(created.id, {
        name: "huge.bin",
        data: new Uint8Array(maxUploadBytes + 1),
      }),
    ).rejects.toMatchObject({ name: "WireError", code: "UPLOAD_TOO_LARGE" })
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
    // Its shell ended with the old runner; the fresh sync lists it as kept, with none.
    await watch.synced()
    expect(watch.seen).toEqual([
      { type: "reset" },
      {
        type: "changed",
        terminal: expect.objectContaining({ title: "Terminal", started: false, run: 0 }),
      },
      { type: "synced" },
    ])

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
    await expect(connectRunner(silent, { timeoutMs: 50 })).rejects.toMatchObject({
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
    await expect(
      client.sessions.save({ sessionId, state: "before", visitedAt: null }),
    ).resolves.toBeUndefined()
    const closing = app.runner.close()
    await expect(
      client.sessions.save({ sessionId, state: "after", visitedAt: null }),
    ).rejects.toMatchObject({
      code: "CLOSING",
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

describe("runner client works", () => {
  it("lists a tracked worktree with no owner even with agent worktrees off, and closes it on the person's say", async ({
    resources,
  }) => {
    const directory = await realpath(await temporary(resources))
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, encoding: "utf8" },
      )
    const repo = join(directory, "repo")
    const worktree = join(directory, "tree")
    git(directory, "init", "--quiet", "-b", "main", repo)
    await writeFile(join(repo, "a.txt"), "a\n")
    git(repo, "add", "-A")
    git(repo, "commit", "--quiet", "-m", "first")
    git(repo, "worktree", "add", "--quiet", "-b", "feat/x", worktree)
    // Unmerged, as cleanup removes an orphaned worktree main holds all of.
    await writeFile(join(worktree, "x.txt"), "x\n")
    git(worktree, "add", "-A")
    git(worktree, "commit", "--quiet", "-m", "work")
    // The runner of an earlier run left the table: an orphaned worktree of this project.
    const database = join(directory, "workspace.sqlite")
    const earlier = new WorkspaceStore(database)
    const projectId = crypto.randomUUID()
    await earlier.createProject({ id: projectId, name: "P", cwd: directory })
    earlier.insertWorktree({
      path: worktree,
      commonDir: join(repo, ".git"),
      branch: "feat/x",
      base: git(repo, "rev-parse", "HEAD").trim(),
      projectId,
      terminalId: null,
      adopted: false,
      branchMade: true,
      createdAt: 5,
    })
    earlier.close()
    const runner = createRunner({ database, terminals: { ...ptyOptions } })
    resources.defer(() => runner.close())
    const { port1, port2 } = new MessageChannel()
    resources.defer(servePort(runner.sessions, port1))
    const client = await connectRunner(messagePort(port2), fast)
    resources.defer(() => client.close())

    const watch = client.works.watch()
    resources.defer(() => void watch.return?.())
    const found = new Map<string, unknown>()
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Events arrive in order.
      const { value } = await watch.next()
      if (value?.type === "changed") found.set(value.work.root, value.work)
      if (value?.type === "synced") break
    }
    expect(found.get(worktree)).toMatchObject({
      root: worktree,
      terminalId: null,
      projectId,
      branch: "feat/x",
      working: false,
    })

    await writeFile(join(worktree, "new.txt"), "new\n")
    // Unforced it is not closed, and says what it holds for the person to confirm.
    expect(await client.works.close(worktree)).toEqual({
      closed: false,
      holds: expect.stringContaining("uncommitted"),
    })
    expect(existsSync(worktree)).toBe(true)
    await expect(client.works.close(join(directory, "nowhere"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const closed = await client.works.close(worktree, true)
    expect(closed).toMatchObject({ closed: true })
    expect(closed.closed && closed.kept).toMatch(/^refs\/novadeck\/kept\/feat-x-work-/)
    expect(existsSync(worktree)).toBe(false)
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Events arrive in order.
      const { value } = await watch.next()
      if (value?.type === "removed") {
        expect(value).toMatchObject({ root: worktree, projectId })
        break
      }
    }
  })
})

describe("runner client voice input", () => {
  it("carries why voice input is unavailable on the error", async ({ resources }) => {
    const app = await deployed(resources)
    const runner = await app.connect()

    await expect(
      runner.voice.record(crypto.randomUUID(), 0, new Uint8Array(2)),
    ).rejects.toMatchObject({
      code: "VOICE_UNAVAILABLE",
      data: { reason: "unavailable" },
    })
  })
})
