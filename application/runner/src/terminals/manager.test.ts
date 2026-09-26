import type { TerminalEvent } from "@novadeck/protocol"
import headless from "@xterm/headless"

import { describe, expect, it as base } from "../test.js"
import { ptyOptions } from "../testing/pty.js"
import type { Resources } from "../testing/resources.js"
import { Terminals } from "./manager.js"

const cwd = process.cwd()
const { Terminal } = headless

/** Omits the transport marker that opens each attachment. */
const withoutMarker = async function* (stream: ReturnType<Terminals["attach"]>) {
  for await (const event of stream) if (event.type !== "attached") yield event
}

const fixture = (resources: Resources) => {
  const manager = (options: ConstructorParameters<typeof Terminals>[0] = {}) => {
    const instance = new Terminals({ shell: "/bin/sh", env: { PS1: "" }, ...options })
    resources.defer(() => instance.shutdown())
    return instance
  }
  /** The raw stream, which opens with the `attached` marker once control is established. */
  const open = (
    target: Terminals,
    id: string,
    owner: string,
    afterSequence?: number,
    mode: "control" | "observe" = "control",
  ) => {
    const controller = new AbortController()
    const stream = target.attach(
      { terminalId: id, mode, ...(afterSequence === undefined ? {} : { afterSequence }) },
      owner,
      controller.signal,
    )
    resources.defer(async () => {
      controller.abort()
      await stream.return(undefined)
    })
    return stream
  }
  const attach = (...args: Parameters<typeof open>) => withoutMarker(open(...args))
  return { manager, open, attach }
}

const it = base.extend<{ terminals: ReturnType<typeof fixture> }>({
  terminals: async ({ resources }, use) => {
    await use(fixture(resources))
  },
})

describe("terminal creation ownership", () => {
  it("does not grant control back to a client released while its creation is pending", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const creation = manager.create({ sessionId: "session", cwd, cols: 80, rows: 24 }, "creator")
    // create has registered its owner, but is still awaiting directory validation.
    manager.release("creator")
    const terminal = await creation
    expect(() => manager.write({ terminalId: terminal.id, data: "" }, "creator")).toThrow(
      expect.objectContaining({ code: "CONTROL_REQUIRED" }),
    )
    const replacement = terminals.attach(manager, terminal.id, "replacement")
    expect((await replacement.next()).value).toMatchObject({ type: "snapshot", status: "running" })
    expect(() => manager.write({ terminalId: terminal.id, data: "" }, "replacement")).not.toThrow()
  })
})

/** Reads until `predicate` holds; `text` joins all screen data so far, across chunk splits. */
const until = async (
  manager: Terminals,
  stream: AsyncGenerator<TerminalEvent>,
  owner: string,
  predicate: (event: TerminalEvent, text: string) => boolean,
): Promise<TerminalEvent[]> => {
  const events: TerminalEvent[] = []
  let text = ""
  for await (const event of stream) {
    events.push(event)
    if (event.type === "output" || event.type === "snapshot") text += event.data
    manager.ack({ terminalId: event.terminalId, sequence: event.sequence }, owner)
    if (predicate(event, text)) return events
  }
  throw new Error("Terminal ended before the expected event.")
}

const untilPid = async (manager: Terminals, stream: AsyncGenerator<TerminalEvent>) => {
  const events = await until(manager, stream, "owner", (_event, text) => /PID=\d+\r?\n/.test(text))
  return events.map((event) => ("data" in event ? event.data : "")).join("")
}

describe.skipIf(process.platform === "win32")("terminal manager", () => {
  it("restores a running shell screen and replays ordered events after a cursor", async ({
    terminals,
  }) => {
    const manager = terminals.manager()
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "first",
    )
    const first = terminals.attach(manager, terminal.id, "first")
    const initial = await first.next()
    expect(initial.value).toMatchObject({ type: "snapshot", sequence: 0, status: "running" })
    manager.ack({ terminalId: terminal.id, sequence: initial.value!.sequence }, "first")
    manager.write(
      { terminalId: terminal.id, data: "printf '\\033[31mCOLOR\\033[0m\\n'\n" },
      "first",
    )
    const events = await until(manager, first, "first", (_event, text) =>
      text.includes("\u001b[31mCOLOR"),
    )
    const cursor = events.at(-1)!.sequence
    expect(
      events.every(
        (event, index) => index === 0 || event.sequence === events[index - 1]!.sequence + 1,
      ),
    ).toBe(true)

    const observer = terminals.attach(manager, terminal.id, "observer", undefined, "observe")
    const snapshot = (await observer.next()).value!
    expect(snapshot.type).toBe("snapshot")
    if (snapshot.type !== "snapshot") throw new Error("Expected snapshot")
    const restored = new Terminal({
      cols: snapshot.cols,
      rows: snapshot.rows,
      allowProposedApi: true,
    })
    try {
      await new Promise<void>((resolve) => restored.write(snapshot.data, resolve))
      const content = Array.from({ length: restored.buffer.active.length }, (_, index) =>
        restored.buffer.active.getLine(index)?.translateToString(),
      ).join("\n")
      expect(content).toContain("COLOR")
    } finally {
      restored.dispose()
    }
    await observer.return(undefined)

    // until() closes its iterator and releases control; reclaim it independently.
    const continuation = terminals.open(manager, terminal.id, "second", cursor)
    // The marker confirms control before any input is accepted.
    expect((await continuation.next()).value).toMatchObject({ type: "attached", mode: "control" })
    manager.resize({ terminalId: terminal.id, cols: 100, rows: 30 }, "second")
    // Output still in flight when the cursor was taken is replayed first, in order.
    const resumed = await until(
      manager,
      withoutMarker(continuation),
      "second",
      (event) => event.type === "resized",
    )
    expect(resumed.map((event) => event.sequence)).toEqual(
      resumed.map((_event, index) => cursor + 1 + index),
    )
    expect(resumed.at(-1)).toMatchObject({ type: "resized", cols: 100, rows: 30 })
    await continuation.return(undefined)
    const replay = terminals.attach(manager, terminal.id, "third", cursor)
    const replayed: TerminalEvent[] = []
    while (replayed.length < resumed.length) {
      // eslint-disable-next-line no-await-in-loop -- Replay is read in order.
      replayed.push((await replay.next()).value!)
    }
    expect(replayed).toEqual(resumed)
    expect(manager.get(terminal.id).status).toBe("running")
  })

  it("releases control on cancellation and denies observers input, resize, and close", async ({
    terminals,
    resources,
  }) => {
    const manager = terminals.manager()
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "controller",
    )
    const signal = new AbortController()
    const controller = manager.attach({ terminalId: terminal.id }, "controller", signal.signal)
    resources.defer(async () => {
      signal.abort()
      await controller.return(undefined)
    })
    expect((await controller.next()).value).toMatchObject({ type: "attached", mode: "control" })
    expect((await controller.next()).value).toMatchObject({ type: "snapshot" })
    const observer = terminals.attach(manager, terminal.id, "observer", undefined, "observe")
    await observer.next()
    expect(() => manager.write({ terminalId: terminal.id, data: "input" }, "observer")).toThrow(
      expect.objectContaining({ code: "CONTROL_REQUIRED" }),
    )
    expect(() =>
      manager.resize({ terminalId: terminal.id, cols: 40, rows: 10 }, "observer"),
    ).toThrow(expect.objectContaining({ code: "CONTROL_REQUIRED" }))
    await expect(manager.close({ terminalId: terminal.id }, "observer")).rejects.toMatchObject({
      code: "CONTROL_REQUIRED",
    })
    const pending = controller.next()
    signal.abort()
    expect((await pending).done).toBe(true)
    const replacement = terminals.attach(manager, terminal.id, "replacement")
    expect((await replacement.next()).value).toMatchObject({ type: "snapshot", status: "running" })
    expect(manager.get(terminal.id).status).toBe("running")
  })

  it("emits natural exit after parsed output and evicts exited records at capacity", async ({
    terminals,
  }) => {
    const manager = terminals.manager({
      shellArgs: ["-c", "printf 'FINAL\\n'; exit 7"],
      maxTerminals: 1,
    })
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const stream = terminals.attach(manager, terminal.id, "owner")
    const events = await until(manager, stream, "owner", (event) => event.type === "exited")
    expect(events.at(-1)).toMatchObject({ type: "exited", exitCode: 7 })
    expect(
      events
        .slice(0, -1)
        .some(
          (event) =>
            (event.type === "output" || event.type === "snapshot") && event.data.includes("FINAL"),
        ),
    ).toBe(true)
    const next = await manager.create({ sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    expect(next.id).not.toBe(terminal.id)
    expect(() => manager.get(terminal.id)).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
  })

  it("uses a snapshot when retained history no longer covers the cursor", async ({ terminals }) => {
    const manager = terminals.manager({ historyBytes: 1 })
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const first = terminals.attach(manager, terminal.id, "owner")
    await first.next()
    manager.write({ terminalId: terminal.id, data: "printf 'HISTORY\\n'\n" }, "owner")
    await until(manager, first, "owner", (_event, text) => text.includes("HISTORY\r\n"))
    const reconnect = terminals.attach(manager, terminal.id, "other", 0)
    expect((await reconnect.next()).value).toMatchObject({
      type: "snapshot",
      data: expect.stringContaining("HISTORY"),
    })
  })

  it("fails a slow subscription while preserving its shell", async ({ terminals }) => {
    const manager = terminals.manager({ subscriberBytes: 1024, ackWindowBytes: 256 })
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const stream = terminals.attach(manager, terminal.id, "owner")
    const snapshot = (await stream.next()).value!
    manager.ack({ terminalId: terminal.id, sequence: snapshot.sequence }, "owner")
    // Resize events pass through the same queue and force the bounded queue to overflow.
    for (let index = 0; index < 20; index += 1)
      manager.resize({ terminalId: terminal.id, cols: 80 + index, rows: 24 }, "owner")
    const barrier = terminals.attach(manager, terminal.id, "barrier", undefined, "observe")
    await barrier.next()
    await barrier.return(undefined)
    await expect(stream.next()).rejects.toMatchObject({ code: "SLOW_CONSUMER" })
    expect(manager.get(terminal.id).status).toBe("running")
    const replacement = terminals.attach(manager, terminal.id, "replacement")
    expect((await replacement.next()).value).toMatchObject({ type: "snapshot", status: "running" })
  })

  it("reports an undersized snapshot allowance without retaining control or killing the shell", async ({
    terminals,
  }) => {
    const manager = terminals.manager({ snapshotBytes: 1 })
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const stream = terminals.attach(manager, terminal.id, "owner")
    await expect(stream.next()).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" })
    expect(() => manager.write({ terminalId: terminal.id, data: "" }, "owner")).toThrow(
      expect.objectContaining({ code: "CONTROL_REQUIRED" }),
    )
    expect(manager.get(terminal.id).status).toBe("running")
  })

  it("returns clean creation errors without consuming terminal capacity", async ({ terminals }) => {
    const manager = terminals.manager({ maxTerminals: 1 })
    await expect(
      manager.create(
        { sessionId: "session", cwd: "/novadeck/missing/directory", cols: 80, rows: 24 },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY" })
    expect(manager.list()).toEqual([])
    await manager.create({ sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    await expect(
      manager.create({ sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" })
    const invalid = terminals.manager({ shell: "/novadeck/missing/shell" })
    await expect(
      invalid.create({ sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "SPAWN_FAILED" })
    expect(invalid.list()).toEqual([])
  })

  it("rejects duplicate attachments without releasing the current controller", async ({
    terminals,
  }) => {
    const manager = terminals.manager()
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const current = terminals.attach(manager, terminal.id, "owner")
    await current.next()
    const duplicate = terminals.attach(manager, terminal.id, "owner")
    await expect(duplicate.next()).rejects.toMatchObject({ code: "ALREADY_ATTACHED" })
    expect(() => manager.write({ terminalId: terminal.id, data: "" }, "owner")).not.toThrow()
    const competing = terminals.attach(manager, terminal.id, "other")
    await expect(competing.next()).rejects.toMatchObject({ code: "CONTROL_IN_USE" })
  })

  it("never reacquires control after a disconnected or pre-cancelled attachment", async ({
    terminals,
  }) => {
    const manager = terminals.manager()
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const pending = terminals.attach(manager, terminal.id, "owner").next()
    manager.release("owner")
    expect((await pending).done).toBe(true)
    const replacement = terminals.attach(manager, terminal.id, "replacement")
    await replacement.next()
    await replacement.return(undefined)
    const signal = new AbortController()
    signal.abort()
    const cancelled = manager.attach({ terminalId: terminal.id }, "cancelled", signal.signal)
    expect((await cancelled.next()).done).toBe(true)
    const control = terminals.attach(manager, terminal.id, "final")
    expect((await control.next()).value).toMatchObject({ type: "snapshot", status: "running" })
  })

  it("drains a large final output before reporting exit", async ({ terminals }) => {
    const manager = terminals.manager({
      shellArgs: ["-c", "printf '%1048576s' X; printf END; exit 4"],
    })
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const stream = terminals.attach(manager, terminal.id, "owner")
    const events = await until(manager, stream, "owner", (event) => event.type === "exited")
    const output = events
      .filter((event) => event.type === "output")
      .map((event) => event.data)
      .join("")
    expect(output).toHaveLength(1048579)
    expect(output.endsWith("XEND")).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "exited", exitCode: 4 })
  })

  it("closes shells that ignore SIGHUP and kills live PTYs during shutdown", async ({
    terminals,
  }) => {
    const manager = terminals.manager({
      shellArgs: ["-c", "trap '' HUP; printf 'PID=%s\\n' $$; exec cat"],
    })
    const terminal = await manager.create(
      { sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const stream = terminals.attach(manager, terminal.id, "owner")
    const pid = Number(/PID=(\d+)\r?\n/.exec(await untilPid(manager, stream))![1])
    const control = terminals.attach(manager, terminal.id, "control")
    await control.next()
    await manager.close({ terminalId: terminal.id }, "control")
    expect(manager.get(terminal.id)).toMatchObject({ status: "exited", exitCode: null })
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    const second = await manager.create({ sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    const secondStream = terminals.attach(manager, second.id, "owner")
    const secondPid = Number(/PID=(\d+)\r?\n/.exec(await untilPid(manager, secondStream))![1])
    await manager.shutdown()
    expect(() => process.kill(secondPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    await expect(
      manager.create({ sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "RUNTIME_CLOSING" })
  })
})
