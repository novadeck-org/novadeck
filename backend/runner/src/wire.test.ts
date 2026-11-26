import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { createScreen } from "@novadeck/emulator/headless"
import {
  compatibility,
  maxPreferences,
  type contract,
  type TerminalEvent,
  type WireClient,
} from "@novadeck/protocol"
import { command, ptyTrace } from "@novadeck/terminal/testing"
import { socketChannel } from "@novadeck/wire"
import { createWireClient } from "@novadeck/wire/client"
import { WebSocket as NodeWebSocket } from "ws"

import { startServer, type ServerOptions } from "./server.js"
import { describe, expect, it } from "./test.js"
import { ptyOptions } from "./testing/pty.js"
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
    const client = createWireClient<typeof contract>(socketChannel(socket))
    if (authenticate)
      await client.wire.handshake({ protocolVersion: compatibility.revision, token })
    return { client, socket, disconnect }
  }

  const setup = async (client: WireClient) => {
    const project = await client.projects.create({
      id: randomUUID(),
      name: "API workspace",
      cwd: directory,
    })
    const session = await client.sessions.create({
      id: randomUUID(),
      projectId: project.id,
      name: "Session",
    })
    return { project, session }
  }

  return { server, url, directory, connect, setup }
}

/** Input for an 80x24 terminal with a fresh id. */
const shell = (sessionId: string) => ({ id: randomUUID(), sessionId, cols: 80, rows: 24 })

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
  const terminal = createScreen({ cols, rows, scrollback: 1000 })
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

  it("a workspace a newer Novadeck wrote, told to clients that prove themselves", async ({
    resources,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "novadeck-newer-"))
    resources.defer(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, "workspace.sqlite")
    const future = new DatabaseSync(path)
    future.exec("PRAGMA user_version = 99")
    future.close()
    const app = await fixture(resources, { database: path })
    const { client } = await app.connect(false)
    await expect(
      client.wire.handshake({ protocolVersion: compatibility.revision, token: "wrong" }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    await expect(
      client.wire.handshake({ protocolVersion: compatibility.oldestClient - 1, token }),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_PROTOCOL" })
    await expect(
      client.wire.handshake({ protocolVersion: compatibility.revision, token }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_TOO_NEW",
    })
    await expect(client.projects.list()).rejects.toBeDefined()
  })

  it("a workspace an earlier build wrote, set aside for a new one", async ({ resources }) => {
    const directory = await mkdtemp(join(tmpdir(), "novadeck-earlier-"))
    resources.defer(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, "workspace.sqlite")
    const old = new DatabaseSync(path)
    old.exec(
      "CREATE TABLE projects (id TEXT); INSERT INTO projects VALUES ('kept'); PRAGMA user_version = 1",
    )
    old.close()
    const app = await fixture(resources, { database: path })
    const { client } = await app.connect()
    await expect(client.projects.list()).resolves.toEqual([])
    const [aside, ...more] = (await readdir(directory)).filter((name) => name.includes(".earlier-"))
    expect(more).toEqual([])
    const kept = new DatabaseSync(join(directory, aside!))
    try {
      expect(kept.prepare("SELECT id FROM projects").all()).toEqual([{ id: "kept" }])
    } finally {
      kept.close()
    }
  })
})

describe("devices with credentials of their own", () => {
  it("lets two devices in beside the owner, and revoking one ends it alone, telling it why", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const owner = await app.connect()
    const laptop = await owner.client.devices.mint({ name: "Laptop" })
    const phone = await owner.client.devices.mint({ name: "Phone" })
    const asDevice = async (credential: string) => {
      const connected = await app.connect(false)
      const proved = await connected.client.wire.handshake({
        protocolVersion: compatibility.revision,
        token: credential,
      })
      return { ...connected, proved }
    }
    const first = await asDevice(laptop.credential)
    const second = await asDevice(phone.credential)
    // Each is told which device it is; the owner's answer names none.
    expect(first.proved).toMatchObject({ device: { id: laptop.device.id, name: "Laptop" } })
    expect(second.proved).toMatchObject({ device: { id: phone.device.id, name: "Phone" } })
    await expect(
      (await app.connect(false)).client.wire.handshake({
        protocolVersion: compatibility.revision,
        token,
      }),
    ).resolves.not.toHaveProperty("device")
    await expect(owner.client.devices.list()).resolves.toEqual([
      expect.objectContaining({ id: laptop.device.id, connected: true }),
      expect.objectContaining({ id: phone.device.id, connected: true }),
    ])
    // A device may not add one, and its connection goes on.
    await expect(first.client.devices.mint({ name: "Tablet" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(first.client.projects.list()).resolves.toEqual([])

    const closed = once(first.socket, "close")
    await owner.client.devices.revoke({ id: laptop.device.id })
    await closed
    // Its next handshake says it was revoked, which a client tells apart from a wrong token.
    const again = await app.connect(false)
    await expect(
      again.client.wire.handshake({
        protocolVersion: compatibility.revision,
        token: laptop.credential,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", data: { reason: "revoked" } })
    await expect(
      (await app.connect(false)).client.wire.handshake({
        protocolVersion: compatibility.revision,
        token: `${laptop.credential.slice(0, -1)}${laptop.credential.endsWith("A") ? "B" : "A"}`,
      }),
    ).rejects.toSatisfy(
      (error: { code?: string; data?: unknown }) =>
        error.code === "UNAUTHORIZED" && error.data === undefined,
    )
    // The other device goes on.
    await expect(second.client.projects.list()).resolves.toEqual([])
    // A device may sign itself out: it is answered, then its connection ends.
    const own = once(second.socket, "close")
    await expect(second.client.devices.revoke({ id: phone.device.id })).resolves.toBeUndefined()
    await own
    // The owner goes on, and can let a device in again with a new credential.
    const tablet = await owner.client.devices.mint({ name: "Tablet" })
    const third = await asDevice(tablet.credential)
    await expect(third.client.projects.list()).resolves.toEqual([])
    await expect(owner.client.devices.list()).resolves.toEqual([
      expect.objectContaining({ id: tablet.device.id, connected: true }),
    ])
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
    await client.sessions.save({ sessionId: session.id, state: '{"panes":[]}', visitedAt: null })
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
      // The rename and the save each raised its revision.
      { ...session, name: "Renamed session", state: '{"panes":[]}', revision: 2 },
    ])
    await expect(connection.client.terminals.list({ sessionId: session.id })).resolves.toEqual([])
  })

  it("serves a newer UI, dropping a field this runner doesn't know", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { project } = await app.setup(client)
    // As a UI of a later revision sends it, with a field this one never had.
    const rename = { projectId: project.id, name: "From a newer UI", colour: "teal" }
    await expect(client.projects.rename(rename as never)).resolves.toBeDefined()
    await expect(client.projects.list()).resolves.toEqual([{ ...project, name: "From a newer UI" }])
    // What it knows is still checked as strictly as ever.
    await expect(
      client.projects.rename({ projectId: project.id, name: "", colour: "teal" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })

  it("shares a session's state between two clients, each seeing the other's change", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const a = await app.connect()
    const b = await app.connect()
    const { session } = await app.setup(a.client)
    const changes = await b.client.sessions.watch()
    const first = await changes.next()
    expect(first.value).toMatchObject({ type: "revisions" })
    const { revision } = await a.client.sessions.change({
      sessionId: session.id,
      writer: "a",
      base: 0,
      patch: { unset: [], set: [{ path: ["state", "order"], value: ["t1"] }] },
    })
    expect(revision).toBe(1)
    expect((await changes.next()).value).toMatchObject({
      type: "changed",
      session: { id: session.id, revision: 1, state: '{"state":{"order":["t1"]}}' },
      writer: "a",
      base: 0,
    })
    // B's own change, made on what A wrote, keeps A's.
    await b.client.sessions.change({
      sessionId: session.id,
      writer: "b",
      base: 1,
      patch: { unset: [], set: [{ path: ["state", "bars", "t1"], value: { open: true } }] },
    })
    await expect(a.client.sessions.list({ projectId: session.projectId })).resolves.toEqual([
      expect.objectContaining({
        revision: 2,
        state: '{"state":{"order":["t1"],"bars":{"t1":{"open":true}}}}',
      }),
    ])
    await changes.return?.(undefined)
  })

  it("tells every client of the projects and sessions another makes, arranges and removes", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const a = await app.connect()
    const b = await app.connect()
    const { project, session } = await app.setup(a.client)
    const projects = await b.client.projects.watch()
    const listed = async () => {
      const { value } = await projects.next()
      return (value as { projects: { id: string; pinned: boolean }[] }).projects.map(
        ({ id, pinned }) => [id, pinned],
      )
    }
    expect(await listed()).toEqual([[project.id, false]])
    const sessions = await b.client.sessions.watch()
    expect((await sessions.next()).value).toMatchObject({ type: "revisions" })
    // The next change of each kind, past those it isn't; every kind it told, as a client of
    // revision 4 reads them.
    const told = new Set<string>()
    const next = async (type: string) => {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
        const { value } = await sessions.next()
        told.add((value as { type: string }).type)
        if ((value as { type: string }).type === type) return value
      }
    }

    const other = await a.client.projects.create({
      id: randomUUID(),
      name: "Other",
      cwd: app.directory,
    })
    expect(await listed()).toEqual([
      [project.id, false],
      [other.id, false],
    ])
    await a.client.projects.arrange({ order: [other.id, project.id], pinned: [other.id] })
    expect(await listed()).toEqual([
      [other.id, true],
      [project.id, false],
    ])

    const second = await a.client.sessions.create({
      id: randomUUID(),
      projectId: project.id,
      name: "Second",
    })
    expect(await next("changed")).toMatchObject({ session: { id: second.id } })
    await a.client.sessions.arrange({ projectId: project.id, order: [session.id, second.id] })
    expect((await projects.next()).value).toEqual({
      type: "arranged",
      projectId: project.id,
      order: [session.id, second.id],
    })

    // A project removed takes its sessions with it, and each client hears of each.
    await a.client.projects.remove({ projectId: project.id })
    const gone = [await next("removed"), await next("removed")]
    expect(gone.map((each) => (each as { sessionId: string }).sessionId).toSorted()).toEqual(
      [session.id, second.id].toSorted(),
    )
    expect(await listed()).toEqual([[other.id, true]])
    // The sessions' feed told only what revision 4 knows, the order on the projects' feed.
    expect([...told].toSorted()).toEqual(["changed", "removed"])
    await projects.return?.(undefined)
    await sessions.return?.(undefined)
  })

  it("keeps the person's preferences, key by key, and tells every client of each change", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const a = await app.connect()
    const b = await app.connect()
    const changes = await b.client.preferences.watch()
    expect((await changes.next()).value).toEqual({ values: {}, revision: 0, writer: null })
    await expect(
      a.client.preferences.set({ key: "appearance", value: '{"theme":"dusk"}', writer: "a" }),
    ).resolves.toEqual({ revision: 1 })
    expect((await changes.next()).value).toEqual({
      values: { appearance: '{"theme":"dusk"}' },
      revision: 1,
      writer: "a",
    })
    // Each key on its own: B's change of another keeps A's.
    await b.client.preferences.set({ key: "chat-view", value: "true", writer: "b" })
    await a.client.preferences.set({ key: "appearance", value: null, writer: "a" })
    await expect(a.client.preferences.get()).resolves.toEqual({
      values: { "chat-view": "true" },
      revision: 3,
      writer: null,
    })
    // What a key or a value may be, and how many keys.
    await expect(
      a.client.preferences.set({ key: "Bad key", value: "1", writer: "a" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    for (let index = 1; index < maxPreferences; index += 1)
      // eslint-disable-next-line no-await-in-loop -- One key after another, to the limit.
      await a.client.preferences.set({ key: `key-${index}`, value: "1", writer: "a" })
    await expect(
      a.client.preferences.set({ key: "one-more", value: "1", writer: "a" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    // A key kept already still changes at the limit.
    await expect(
      a.client.preferences.set({ key: "chat-view", value: "false", writer: "a" }),
    ).resolves.toMatchObject({ revision: expect.any(Number) })
    await changes.return?.(undefined)
  })

  it("tells every client of a change to the runner's settings", async ({ resources }) => {
    const app = await fixture(resources)
    const a = await app.connect()
    const b = await app.connect()
    const settings = await b.client.settings.watch()
    expect((await settings.next()).value).toMatchObject({ agentMode: "herd", agentModes: false })
    await a.client.settings.set({ agentModes: true, agentMode: "solo" })
    expect((await settings.next()).value).toMatchObject({ agentMode: "solo", agentModes: true })
    await settings.return?.(undefined)
  })

  it("offers no Nova switch where the runner has no shell files to start it from", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const settings = await client.settings.get()
    expect(settings).not.toHaveProperty("bundledPi")
    expect(settings).not.toHaveProperty("bundledPiFetch")
  })

  it("starts and stops Novadeck's own pi's fetch with its switch, telling where it stands", async ({
    resources,
  }) => {
    // Archives from an empty folder: the fetch fails at once, as a release that can't be had.
    const empty = await mkdtemp(join(tmpdir(), "novadeck-no-release-"))
    // On Windows the runner may still be rewriting its shell files (Codex's capture) as it
    // closes, or a scanner may hold one just written: removal waits them out.
    resources.defer(() =>
      rm(empty, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    )
    const before = process.env.NOVADECK_BUNDLED_PI_SOURCE
    process.env.NOVADECK_BUNDLED_PI_SOURCE = empty
    resources.defer(() => {
      if (before === undefined) delete process.env.NOVADECK_BUNDLED_PI_SOURCE
      else process.env.NOVADECK_BUNDLED_PI_SOURCE = before
    })
    const app = await fixture(resources, { shell: join(empty, "shell") })
    const { client } = await app.connect()
    expect(await client.settings.get()).toMatchObject({
      bundledPi: false,
      bundledPiFetch: { state: "off" },
    })
    const settings = await client.settings.watch()
    await settings.next()

    await client.settings.set({ bundledPi: true })
    // The changes in turn, until the fetch stands as `state`.
    const fetchOf = async (state: string) => {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- Each change in turn, until it stands so.
        const { value } = await settings.next()
        const fetch = (value as { bundledPiFetch?: { state: string } }).bundledPiFetch
        if (fetch?.state === state) return { value, fetch }
      }
    }
    const failed = await fetchOf("failed")
    expect(failed.value).toMatchObject({ bundledPi: true })
    expect(failed.fetch).toMatchObject({ state: "failed", error: expect.any(String) })

    await client.settings.set({ bundledPi: false })
    expect((await fetchOf("off")).value).toMatchObject({ bundledPi: false })
    await settings.return?.(undefined)
  })

  it("starts Novadeck's own pi's fetch for the tour while its switch is off, telling where it stands", async ({
    resources,
  }) => {
    // Archives from an empty folder: the fetch fails at once, as a release that can't be had.
    const empty = await mkdtemp(join(tmpdir(), "novadeck-no-release-"))
    // On Windows the runner may still be rewriting its shell files as it closes: removal waits.
    resources.defer(() =>
      rm(empty, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    )
    const before = process.env.NOVADECK_BUNDLED_PI_SOURCE
    process.env.NOVADECK_BUNDLED_PI_SOURCE = empty
    resources.defer(() => {
      if (before === undefined) delete process.env.NOVADECK_BUNDLED_PI_SOURCE
      else process.env.NOVADECK_BUNDLED_PI_SOURCE = before
    })
    const app = await fixture(resources, { shell: join(empty, "shell") })
    const { client } = await app.connect()
    const settings = await client.settings.watch()
    expect((await settings.next()).value).toMatchObject({
      bundledPi: false,
      bundledPiFetch: { state: "off" },
    })
    await client.tour.fetch()
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Each change in turn, until it failed.
      const { value } = await settings.next()
      const fetch = (value as { bundledPiFetch?: { state: string } }).bundledPiFetch
      if (fetch?.state === "failed") {
        // The switch stays off; the tour's download says where it stands all the same.
        expect(value).toMatchObject({ bundledPi: false })
        break
      }
    }
    await settings.return?.(undefined)
    // A runner without shell files can't start Novadeck's pi: the tour's ask is refused.
    const bare = await fixture(resources)
    const other = await bare.connect()
    await expect(other.client.tour.fetch()).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("reports Murmur's Experimental switch, off until turned on", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    expect(await client.settings.get()).toMatchObject({ murmur: false })
    await client.settings.set({ murmur: true })
    expect(await client.settings.get()).toMatchObject({ murmur: true })
  })

  it("lists a project's folders, and refuses what is not one of them", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    // The server's own files share the fixture's directory, so the project gets a folder of its own.
    const cwd = join(app.directory, "project")
    await mkdir(join(cwd, "src"), { recursive: true })
    await mkdir(join(cwd, ".git"))
    await writeFile(join(cwd, "src", "index.ts"), "")
    await writeFile(join(cwd, "notes.md"), "")
    const project = await client.projects.create({ id: randomUUID(), name: "Folders", cwd })
    await expect(client.projects.folder({ projectId: project.id, folder: "" })).resolves.toEqual({
      entries: [
        { name: "src", folder: true, ignored: false },
        { name: "notes.md", folder: false, ignored: false },
      ],
      truncated: false,
    })
    await expect(
      client.projects.folder({ projectId: project.id, folder: "src" }),
    ).resolves.toMatchObject({ entries: [{ name: "index.ts", folder: false }] })
    await Promise.all(
      ["..", "/etc", "missing", "notes.md"].map((folder) =>
        expect(client.projects.folder({ projectId: project.id, folder })).rejects.toMatchObject({
          code: "INVALID_DIRECTORY",
        }),
      ),
    )
    await expect(
      client.projects.folder({ projectId: randomUUID(), folder: "" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      client.projects.folder({ projectId: project.id, folder: "x".repeat(5000) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })

  it("payload, directory and workspace relationship validation", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    await expect(
      client.projects.create({ id: randomUUID(), name: " ", cwd: app.directory }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(
      client.projects.create({
        id: randomUUID(),
        name: "Missing",
        cwd: join(app.directory, "missing"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY" })
    await expect(
      client.sessions.create({ id: randomUUID(), projectId: randomUUID(), name: "Missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    const { session } = await app.setup(client)
    await expect(
      client.terminals.create({ id: randomUUID(), sessionId: session.id, cols: 0, rows: 24 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      client.terminals.create({ id: randomUUID(), sessionId: randomUUID(), cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      client.terminals.resize({ terminalId: randomUUID(), cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })
})

describe("terminal watch API", () => {
  it("reports terminals created on other connections until it disconnects", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const watcher = await app.connect()
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const stream = await watcher.client.terminals.watch()
    expect((await stream.next()).value).toEqual({ type: "synced" })
    const terminal = await client.terminals.create(shell(session.id))
    expect((await stream.next()).value).toEqual({ type: "changed", terminal })
    const pending = stream.next()
    await watcher.disconnect()
    await expect(pending).rejects.toThrow()
  })
})

describe("terminal move API", () => {
  it("moves a running terminal to another session of its project, and watchers hear of it", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { project, session } = await app.setup(client)
    const other = await client.sessions.create({
      id: randomUUID(),
      projectId: project.id,
      name: "B",
    })
    const terminal = await client.terminals.create(shell(session.id))
    const stream = await client.terminals.watch()
    // The terminal itself, then the sync that ends the first listing.
    expect((await stream.next()).value).toMatchObject({ type: "changed" })
    expect((await stream.next()).value).toEqual({ type: "synced" })
    const moved = await client.terminals.move({
      terminalId: terminal.id,
      to: { sessionId: other.id },
    })
    expect(moved).toEqual({
      sessionId: other.id,
      moved: [{ terminalId: terminal.id, handle: terminal.handle, was: terminal.handle }],
      left: null,
    })
    const heard = await stream.next()
    expect(heard.value).toMatchObject({
      type: "changed",
      terminal: { id: terminal.id, sessionId: other.id },
    })
    expect((await client.terminals.list({ sessionId: session.id })).map(({ id }) => id)).toEqual([])
    expect((await client.terminals.list({ sessionId: other.id })).map(({ id }) => id)).toEqual([
      terminal.id,
    ])
    await expect(
      client.terminals.move({ terminalId: terminal.id, to: { sessionId: other.id } }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      client.terminals.move({ terminalId: randomUUID(), to: { sessionId: other.id } }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    await expect(
      client.terminals.move({ terminalId: terminal.id, to: { sessionId: randomUUID() } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("terminal title API", () => {
  it("renames a terminal as the person's, then hands its title back to Novadeck", async ({
    resources,
  }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create(shell(session.id))
    expect(terminal).toMatchObject({ title: "Terminal", titleSource: { kind: "default" } })
    await client.terminals.rename({ terminalId: terminal.id, title: "API" })
    const titled = async () =>
      (await client.terminals.list({ sessionId: session.id })).find(({ id }) => id === terminal.id)
    await expect(titled()).resolves.toMatchObject({
      title: "API",
      titleSource: { kind: "person" },
    })
    await client.terminals.resetTitle({ terminalId: terminal.id })
    await expect(titled()).resolves.toMatchObject({
      title: "Terminal",
      titleSource: { kind: "default" },
    })
    await expect(client.terminals.resetTitle({ terminalId: randomUUID() })).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })
})

describe("PTY lifecycle API", () => {
  it("Ctrl-C interruption and subsequent input", async ({ resources }) => {
    const app = await fixture(resources, {
      terminals: { shell: process.execPath, shellArgs: ["--interactive"] },
    })
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create(shell(session.id))
    const output = await reader(resources, client, terminal.id)
    await output.next()
    await client.terminals.write({
      terminalId: terminal.id,
      data: 'console.log("BUSY_" + "STARTED"); while (true) {}\r',
    })
    await output.untilText("BUSY_STARTED")
    await client.terminals.write({ terminalId: terminal.id, data: "\u0003" })
    // The REPL reports the interruption, then redraws its prompt. Input typed before that
    // can be lost on Windows, so wait for the redrawn prompt.
    const redrawn = () => {
      const at = output.text().indexOf("ERR_SCRIPT_EXECUTION_INTERRUPTED")
      return at >= 0 && output.text().slice(at).includes("0J> ")
    }
    if (!redrawn()) await output.until(redrawn, "prompt redrawn after the interruption")
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
    const terminal = await client.terminals.create(shell(session.id))
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
    const terminal = await client.terminals.create(shell(session.id))
    const output = await reader(resources, client, terminal.id)
    expect(await output.next()).toMatchObject({
      type: "snapshot",
      exit: null,
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
      expect.objectContaining({ id: terminal.id, exit: null, cols: 132, rows: 43 }),
    ])
    await client.terminals.write({
      terminalId: terminal.id,
      data: command({ type: "exit", code: 7 }),
    })
    expect(await output.until((event) => event.type === "exited")).toMatchObject({
      exit: { code: 7 },
    })
    await expect(client.terminals.list({ sessionId: session.id })).resolves.toEqual([
      expect.objectContaining({ exit: expect.objectContaining({ code: 7 }) }),
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
    const first = await client.terminals.create(shell(session.id))
    await expect(client.terminals.create(shell(session.id))).rejects.toMatchObject({
      code: "TERMINAL_LIMIT",
    })
    await client.terminals.close({ terminalId: first.id })
    const second = await client.terminals.create(shell(session.id))
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
        id: randomUUID(),
        sessionId: session.id,
        cwd: "relative/path",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY" })
    await expect(client.terminals.create(shell(session.id))).rejects.toMatchObject({
      code: "SPAWN_FAILED",
    })
    await expect(client.terminals.list({ sessionId: session.id })).resolves.toEqual([])
  })
})

describe("terminal attachment and recovery API", () => {
  it("recognizes an output checkpoint split across acknowledged events", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create(shell(session.id))
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
    const client = createWireClient<typeof contract>(socketChannel(socket))
    await client.wire.handshake({ protocolVersion: compatibility.revision, token })
    // Flush the request onto TCP, then drop the connection without a close frame.
    // The server may either reject the request or finish creation after release.
    const originalSend = socket.send.bind(socket)
    socket.send = ((data: Parameters<NodeWebSocket["send"]>[0]) => {
      originalSend(data, () => socket.terminate())
    }) as NodeWebSocket["send"]
    const created = client.terminals.create(shell(session.id))
    await expect(created).rejects.toThrow("The connection is closed")
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
    const terminal = await creator.client.terminals.create(shell(session.id))
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
    const terminal = await owner.client.terminals.create(shell(session.id))
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
    expect(snapshot).toMatchObject({ type: "snapshot", exit: { code: 9 } })
    expect(restored.text()).toContain("FINAL_QUEUED_OUTPUT")
    await expect(observer.client.projects.list()).resolves.toHaveLength(1)
  })

  it("quiet terminal responsiveness during unattached noisy output", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const noisy = await client.terminals.create(shell(session.id))
    const quiet = await client.terminals.create(shell(session.id))
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
        id: randomUUID(),
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
      id: randomUUID(),
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
    const terminal = await client.terminals.create(shell(session.id))
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
    const terminal = await client.terminals.create(shell(session.id))
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
      expect.objectContaining({ exit: null }),
    ])
  })

  it("request rejection and stream cancellation after socket closure", async ({ resources }) => {
    const app = await fixture(resources)
    const { client, disconnect } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create(shell(session.id))
    const output = await reader(resources, client, terminal.id)
    await output.untilText("PTY_READY")
    await disconnect()
    output.detach()
    await expect(client.projects.list()).rejects.toThrow("The connection is closed")
  })

  it("process survival and replay after the saved cursor", async ({ resources }) => {
    const app = await fixture(resources)
    const owner = await app.connect()
    const { session } = await app.setup(owner.client)
    const terminal = await owner.client.terminals.create(shell(session.id))
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
      expect.objectContaining({ id: terminal.id, exit: null }),
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
    const terminal = await client.terminals.create({
      id: randomUUID(),
      sessionId: session.id,
      cols: 100,
      rows: 30,
    })
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
    expect(snapshot).toMatchObject({ type: "snapshot", exit: null })
    if (snapshot.type !== "snapshot") throw new Error("Expected restored screen")
    expect(snapshot.data).toContain("SNAPSHOT_READY")
    expect(snapshot.sequence).toBeGreaterThan(0)
  })

  it("exclusive control and release on disconnect", async ({ resources }) => {
    const app = await fixture(resources)
    const owner = await app.connect()
    const observer = await app.connect()
    const { session } = await app.setup(owner.client)
    const terminal = await owner.client.terminals.create(shell(session.id))
    await expect(
      observer.client.terminals.write({ terminalId: terminal.id, data: "bad" }),
    ).rejects.toMatchObject({ code: "CONTROL_REQUIRED" })
    await expect(
      observer.client.terminals.resize({ terminalId: terminal.id, cols: 100, rows: 30 }),
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
    const terminal = await client.terminals.create(shell(session.id))
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

describe("agents API", () => {
  it("says why a prompt conflicts as the error's data", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()
    const { session } = await app.setup(client)
    const terminal = await client.terminals.create(shell(session.id))

    await expect(
      client.agents.prompt({ terminalId: terminal.id, text: "hello" }),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "no-agent" } })
  })
})

describe("voice input API", () => {
  it("says why voice input is unavailable as the error's data", async ({ resources }) => {
    const app = await fixture(resources)
    const { client } = await app.connect()

    await expect(
      client.voice.record({ clipId: randomUUID(), offset: 0, data: "" }),
    ).rejects.toMatchObject({ code: "VOICE_UNAVAILABLE", data: { reason: "unavailable" } })
  })
})

describe("control of a terminal between clients", () => {
  type Control = { type: "control"; terminalId: string; holder: "you" | "other" | "none" }
  const control = (terminalId: string, holder: Control["holder"]): Control => ({
    type: "control",
    terminalId,
    holder,
  })

  /** A client's `terminals.controls` stream, read an item at a time. */
  const following = async (resources: Resources, client: WireClient) => {
    const controller = new AbortController()
    resources.defer(async () => controller.abort())
    const stream = await client.terminals.controls(undefined, { signal: controller.signal })
    const next = async (): Promise<Control> => {
      const result = await Promise.race([
        stream.next(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("No control item in 10 s")), 10_000).unref(),
        ),
      ])
      if (result.done) throw new Error("The controls ended")
      return result.value as Control
    }
    return { next }
  }

  /** A terminal whose creator has gone, so that attaching as control takes it at once. */
  const open = async (resources: Resources) => {
    const app = await fixture(resources)
    const creator = await app.connect()
    const { project, session } = await app.setup(creator.client)
    const terminal = await creator.client.terminals.create(shell(session.id))
    await creator.disconnect()
    return { app, project, terminal }
  }

  it("moves to a client that takes it, the earlier one observing with its writes refused", async ({
    resources,
  }) => {
    const { app, terminal } = await open(resources)
    const first = await app.connect()
    const second = await app.connect()
    const viewing = await reader(resources, first.client, terminal.id)
    await viewing.untilText("PTY_READY")
    const watching = await reader(resources, second.client, terminal.id, { mode: "observe" })
    await watching.next()
    const firstFeed = await following(resources, first.client)
    const secondFeed = await following(resources, second.client)
    expect(await firstFeed.next()).toEqual(control(terminal.id, "you"))
    expect(await secondFeed.next()).toEqual(control(terminal.id, "other"))

    await second.client.terminals.take({ terminalId: terminal.id })
    expect(await firstFeed.next()).toEqual(control(terminal.id, "other"))
    expect(await secondFeed.next()).toEqual(control(terminal.id, "you"))
    await expect(
      first.client.terminals.write({ terminalId: terminal.id, data: "denied" }),
    ).rejects.toMatchObject({ code: "CONTROL_REQUIRED" })
    await print(second.client, terminal.id, "TAKEN_", "OVER")
    // The earlier controller still reads.
    await viewing.untilText("TAKEN_OVER")
  })

  it("is refused for a controller that wrote lately, until it has been idle", async ({
    resources,
  }) => {
    const { app, terminal } = await open(resources)
    const first = await app.connect()
    const second = await app.connect()
    const viewing = await reader(resources, first.client, terminal.id)
    await viewing.untilText("PTY_READY")
    await reader(resources, second.client, terminal.id, { mode: "observe" }).then((each) =>
      each.next(),
    )
    await (await following(resources, first.client)).next()
    await (await following(resources, second.client)).next()
    await print(first.client, terminal.id, "BUSY_", "TYPING")
    await expect(
      second.client.terminals.take({ terminalId: terminal.id, ifIdleMs: 60_000 }),
    ).rejects.toMatchObject({ code: "CONTROL_BUSY" })
    await new Promise((resolve) => setTimeout(resolve, 60))
    await second.client.terminals.take({ terminalId: terminal.id, ifIdleMs: 30 })
    await print(second.client, terminal.id, "IDLE_", "TAKEN")
  })

  it("is refused for a controller that doesn't follow controls, and for a client not attached", async ({
    resources,
  }) => {
    const { app, terminal } = await open(resources)
    const old = await app.connect()
    const newer = await app.connect()
    const stranger = await app.connect()
    const viewing = await reader(resources, old.client, terminal.id)
    await viewing.untilText("PTY_READY")
    await reader(resources, newer.client, terminal.id, { mode: "observe" }).then((each) =>
      each.next(),
    )
    await (await following(resources, newer.client)).next()
    await expect(newer.client.terminals.take({ terminalId: terminal.id })).rejects.toMatchObject({
      code: "CONTROL_IN_USE",
    })
    await expect(stranger.client.terminals.take({ terminalId: terminal.id })).rejects.toMatchObject(
      { code: "CONFLICT" },
    )
    await expect(newer.client.terminals.take({ terminalId: randomUUID() })).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
    await print(old.client, terminal.id, "STILL_", "OLD")
  })

  it("tells a client who controls, as each attachment starts and as control moves", async ({
    resources,
  }) => {
    const { app, terminal } = await open(resources)
    const client = await app.connect()
    const other = await app.connect()
    const feed = await following(resources, client.client)
    // Following before attaching: each attachment is told as it starts.
    const watching = await reader(resources, client.client, terminal.id, { mode: "observe" })
    await watching.next()
    expect(await feed.next()).toEqual(control(terminal.id, "none"))
    await other.client.terminals.attach({ terminalId: terminal.id }).then((stream) => stream.next())
    expect(await feed.next()).toEqual(control(terminal.id, "other"))
    // `other` follows too, so it could learn it lost control.
    await (await following(resources, other.client)).next()
    await client.client.terminals.take({ terminalId: terminal.id })
    expect(await feed.next()).toEqual(control(terminal.id, "you"))
  })

  describe("let go of", () => {
    /** `first` controls; `older` and `used` observe and follow, `used` being the one in use. */
    const trio = async (resources: Resources) => {
      const { app, project, terminal } = await open(resources)
      const first = await app.connect()
      const older = await app.connect()
      const used = await app.connect()
      const viewing = await reader(resources, first.client, terminal.id)
      await viewing.untilText("PTY_READY")
      const olderReader = await reader(resources, older.client, terminal.id, { mode: "observe" })
      await olderReader.next()
      await reader(resources, used.client, terminal.id, { mode: "observe" }).then((each) =>
        each.next(),
      )
      const feeds = {
        first: await following(resources, first.client),
        older: await following(resources, older.client),
        used: await following(resources, used.client),
      }
      await Promise.all(Object.values(feeds).map((feed) => feed.next()))
      // The person uses `used`, which reported later than `older` by use, not by attaching.
      await used.client.terminals.showing({ projectId: project.id })
      await older.client.terminals.showing({ projectId: project.id })
      await used.client.terminals.showing({ projectId: project.id })
      await older.client.terminals.showing({ projectId: project.id })
      await used.client.terminals.active({ terminalId: terminal.id })
      return { terminal, first, older, used, viewing, feeds }
    }

    it("on detaching, goes to the most recently used following observer, which can type at once", async ({
      resources,
    }) => {
      const { terminal, older, used, viewing, feeds } = await trio(resources)
      await viewing.stream.return()
      expect(await feeds.used.next()).toEqual(control(terminal.id, "you"))
      expect(await feeds.older.next()).toEqual(control(terminal.id, "other"))
      await print(used.client, terminal.id, "HANDED_", "DETACH")
      await expect(
        older.client.terminals.write({ terminalId: terminal.id, data: "denied" }),
      ).rejects.toMatchObject({ code: "CONTROL_REQUIRED" })
    })

    it("is not changed by a client saying it uses no terminal, as a window losing focus does", async ({
      resources,
    }) => {
      const { terminal, older, used, viewing, feeds } = await trio(resources)
      await older.client.terminals.active({ terminalId: null })
      await viewing.stream.return()
      expect(await feeds.used.next()).toEqual(control(terminal.id, "you"))
      expect(await feeds.older.next()).toEqual(control(terminal.id, "other"))
      await print(used.client, terminal.id, "HANDED_", "BLUR")
    })

    it("on disconnecting, goes the same way", async ({ resources }) => {
      const { terminal, first, used, feeds } = await trio(resources)
      await first.disconnect()
      expect(await feeds.used.next()).toEqual(control(terminal.id, "you"))
      expect(await feeds.older.next()).toEqual(control(terminal.id, "other"))
      await print(used.client, terminal.id, "HANDED_", "CLOSE")
    })
  })
})
