import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import type { TerminalChange, TerminalEvent } from "@novadeck/protocol"
import headless from "@xterm/headless"
import { vi } from "vitest"

import { describe, expect, it as base } from "../test.js"
import { command, ptyOptions } from "../testing/pty.js"
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
  /** A `watch` stream read until a change matches, collecting everything it read. */
  const watch = (target: Terminals, owner: string) => {
    const controller = new AbortController()
    const stream = target.watch(owner, controller.signal)
    resources.defer(async () => {
      controller.abort()
      await stream.return(undefined)
    })
    const seen: TerminalChange[] = []
    const until = async (predicate: (change: TerminalChange) => boolean) => {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
        const result = await stream.next()
        if (result.done) throw new Error(`Watch ended; seen=${JSON.stringify(seen)}`)
        seen.push(result.value)
        if (predicate(result.value)) return result.value
      }
    }
    return { stream, controller, seen, until }
  }
  return { manager, open, attach, watch }
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
    const creation = manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    // create has registered its owner, but is still awaiting directory validation.
    manager.release("creator")
    const terminal = await creation
    expect(() => manager.write({ terminalId: terminal.id, data: "" }, "creator")).toThrow(
      expect.objectContaining({ code: "CONTROL_REQUIRED" }),
    )
    const replacement = terminals.attach(manager, terminal.id, "replacement")
    expect((await replacement.next()).value).toMatchObject({ type: "snapshot", exit: null })
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

/** Like `until`, but leaves the stream and its control open for later reads. */
const read = async (
  manager: Terminals,
  stream: AsyncGenerator<TerminalEvent>,
  owner: string,
  predicate: (event: TerminalEvent, text: string) => boolean,
): Promise<TerminalEvent[]> => {
  const events: TerminalEvent[] = []
  let text = ""
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- Events are read in order.
    const result = await stream.next()
    if (result.done) throw new Error("Terminal ended before the expected event.")
    const event = result.value
    events.push(event)
    if (event.type === "output" || event.type === "snapshot") text += event.data
    manager.ack({ terminalId: event.terminalId, sequence: event.sequence }, owner)
    if (predicate(event, text)) return events
  }
}

const untilPid = async (manager: Terminals, stream: AsyncGenerator<TerminalEvent>) => {
  const events = await until(manager, stream, "owner", (_event, text) => /PID=\d+\r?\n/.test(text))
  return events.map((event) => ("data" in event ? event.data : "")).join("")
}

/**
 * A process's state as one letter (`S`, `T` when stopped, `Z`…), or "gone": from /proc on
 * Linux, from `ps` on macOS, which has no /proc and fails for a process that has gone.
 */
const processState = (pid: number): string => {
  try {
    if (process.platform !== "linux") {
      const stat = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      return stat.trim()[0] ?? "gone"
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "gone"
  } catch {
    return "gone"
  }
}

describe.skipIf(process.platform === "win32")("terminal manager", () => {
  it("restores a running shell screen and replays ordered events after a cursor", async ({
    terminals,
  }) => {
    const manager = terminals.manager()
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "first",
    )
    const first = terminals.attach(manager, terminal.id, "first")
    const initial = await first.next()
    expect(initial.value).toMatchObject({ type: "snapshot", sequence: 0, exit: null })
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
    expect(manager.get(terminal.id).exit).toBeNull()
  })

  it("releases control on cancellation and denies observers input, resize, and close", async ({
    terminals,
    resources,
  }) => {
    const manager = terminals.manager()
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
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
      code: "CONTROL_IN_USE",
    })
    const pending = controller.next()
    signal.abort()
    expect((await pending).done).toBe(true)
    const replacement = terminals.attach(manager, terminal.id, "replacement")
    expect((await replacement.next()).value).toMatchObject({ type: "snapshot", exit: null })
    expect(manager.get(terminal.id).exit).toBeNull()
  })

  it("emits natural exit after parsed output and evicts exited records at capacity", async ({
    terminals,
  }) => {
    const manager = terminals.manager({
      shellArgs: ["-c", "printf 'FINAL\\n'; exit 7"],
      maxTerminals: 1,
    })
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const stream = terminals.attach(manager, terminal.id, "owner")
    const events = await until(manager, stream, "owner", (event) => event.type === "exited")
    expect(events.at(-1)).toMatchObject({ type: "exited", exit: { code: 7 } })
    expect(
      events
        .slice(0, -1)
        .some(
          (event) =>
            (event.type === "output" || event.type === "snapshot") && event.data.includes("FINAL"),
        ),
    ).toBe(true)
    const next = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    expect(next.id).not.toBe(terminal.id)
    expect(() => manager.get(terminal.id)).toThrow(
      expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
    )
  })

  it("uses a snapshot when retained history no longer covers the cursor", async ({ terminals }) => {
    const manager = terminals.manager({ historyBytes: 1 })
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
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
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
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
    expect(manager.get(terminal.id).exit).toBeNull()
    const replacement = terminals.attach(manager, terminal.id, "replacement")
    expect((await replacement.next()).value).toMatchObject({ type: "snapshot", exit: null })
  })

  it("reports an undersized snapshot allowance without retaining control or killing the shell", async ({
    terminals,
  }) => {
    const manager = terminals.manager({ snapshotBytes: 1 })
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const stream = terminals.attach(manager, terminal.id, "owner")
    await expect(stream.next()).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" })
    expect(() => manager.write({ terminalId: terminal.id, data: "" }, "owner")).toThrow(
      expect.objectContaining({ code: "CONTROL_REQUIRED" }),
    )
    expect(manager.get(terminal.id).exit).toBeNull()
  })

  it("returns clean creation errors without consuming terminal capacity", async ({ terminals }) => {
    const manager = terminals.manager({ maxTerminals: 1 })
    await expect(
      manager.create(
        {
          id: randomUUID(),
          sessionId: "session",
          cwd: "/novadeck/missing/directory",
          cols: 80,
          rows: 24,
        },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "INVALID_DIRECTORY" })
    expect(manager.list()).toEqual([])
    await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    await expect(
      manager.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "TERMINAL_LIMIT" })
    const invalid = terminals.manager({ shell: "/novadeck/missing/shell" })
    await expect(
      invalid.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "SPAWN_FAILED" })
    expect(invalid.list()).toEqual([])
  })

  it("rejects duplicate attachments without releasing the current controller", async ({
    terminals,
  }) => {
    const manager = terminals.manager()
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
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
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
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
    expect((await control.next()).value).toMatchObject({ type: "snapshot", exit: null })
  })

  it("drains a large final output before reporting exit", async ({ terminals }) => {
    const manager = terminals.manager({
      shellArgs: ["-c", "printf '%1048576s' X; printf END; exit 4"],
    })
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
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
    expect(events.at(-1)).toMatchObject({ type: "exited", exit: { code: 4 } })
  })

  it("closes shells that ignore SIGHUP and kills live PTYs during shutdown", async ({
    terminals,
  }) => {
    const manager = terminals.manager({
      shellArgs: ["-c", "trap '' HUP; printf 'PID=%s\\n' $$; exec cat"],
    })
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const stream = terminals.attach(manager, terminal.id, "owner")
    const pid = Number(/PID=(\d+)\r?\n/.exec(await untilPid(manager, stream))![1])
    const control = terminals.attach(manager, terminal.id, "control")
    await control.next()
    await manager.close({ terminalId: terminal.id }, "control")
    expect(manager.list()).toEqual([])
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    const second = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "owner",
    )
    const secondStream = terminals.attach(manager, second.id, "owner")
    const secondPid = Number(/PID=(\d+)\r?\n/.exec(await untilPid(manager, secondStream))![1])
    await manager.shutdown()
    expect(() => process.kill(secondPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    await expect(
      manager.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "RUNTIME_CLOSING" })
  })

  // bash takes the terminal back as it hangs up, so a TUI still restoring the terminal is
  // stopped by SIGTTIN or SIGTTOU, and may be orphaned stopped. Only some of these
  // programs are each time, so two dozen run at once: unless the runner resumes them, at
  // least one was left stopped in each of 20 runs on Linux.
  it.skipIf(!["linux", "darwin"].includes(process.platform) || !existsSync("/bin/bash"))(
    "never leaves a program stopped that restores the terminal as it is hung up",
    async ({ terminals, resources }) => {
      const directory = mkdtempSync(join(tmpdir(), "novadeck-hangup-"))
      resources.defer(() => rmSync(directory, { recursive: true, force: true }))
      const tui = join(directory, "tui.mjs")
      // Threads, as a TUI's runtime has, make the stop take long enough to outlast bash.
      writeFileSync(
        tui,
        `import { Worker } from "node:worker_threads"
for (let i = 0; i < 8; i++) new Worker("setInterval(() => {}, 1000)", { eval: true }).unref()
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on("error", () => {})
process.stdout.on("error", () => {})
process.stdout.write("TUI=" + process.pid + "\\n")
process.on("SIGHUP", () => {
  const end = Date.now() + 60
  const toggle = () => {
    try {
      process.stdin.setRawMode(false)
      process.stdin.setRawMode(true)
    } catch {}
    if (Date.now() < end) return setImmediate(toggle)
    process.exit(0)
  }
  toggle()
})
`,
      )
      const manager = terminals.manager({
        shell: "/bin/bash",
        shellArgs: ["--norc", "--noprofile", "-i"],
        // macOS's bash would otherwise open by recommending zsh.
        env: {
          PS1: "$ ",
          PATH: "/usr/bin:/bin",
          HOME: directory,
          BASH_SILENCE_DEPRECATION_WARNING: "1",
        },
      })
      const pids = await Promise.all(
        Array.from({ length: 24 }, async () => {
          const terminal = await manager.create(
            { id: randomUUID(), sessionId: "session", cwd: directory, cols: 80, rows: 24 },
            "owner",
          )
          const stream = terminals.attach(manager, terminal.id, "owner")
          await read(manager, stream, "owner", (_event, text) => text.includes("$ "))
          manager.write(
            { terminalId: terminal.id, data: `'${process.execPath}' '${tui}'\r` },
            "owner",
          )
          let pid = 0
          await read(manager, stream, "owner", (_event, text) => {
            pid = Number(/TUI=(\d+)\r?\n/.exec(text)?.[1] ?? 0)
            return pid > 0
          })
          return pid
        }),
      )
      resources.defer(() => {
        for (const pid of pids.filter((one) => processState(one) !== "gone"))
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            // Gone meanwhile.
          }
      })

      await manager.shutdown()

      // A program resumed finishes exiting within moments; a stopped one never does.
      await vi.waitFor(
        () =>
          expect(pids.map(processState).filter((one) => one !== "gone" && one !== "Z")).toEqual([]),
        { timeout: 3_000, interval: 50 },
      )
    },
  )
})

/** The fixture child before it renames itself or is sampled; Windows reports none. */
const child = process.platform === "win32" ? null : { name: basename(process.execPath), argv: null }
const changed =
  (id: string) =>
  (change: TerminalChange): change is Extract<TerminalChange, { type: "changed" }> =>
    change.type === "changed" && change.terminal.id === id

describe("terminal watching", () => {
  it("reports every terminal, then synced, then creation, exit and eviction", async ({
    terminals,
  }) => {
    const manager = terminals.manager({ ...ptyOptions, maxTerminals: 2 })
    const existing = await manager.create(
      { id: randomUUID(), sessionId: "one", cwd, cols: 80, rows: 24 },
      "owner",
    )
    expect(existing.process).toEqual(child)
    const watch = terminals.watch(manager, "watcher")
    await watch.until((change) => change.type === "synced")
    expect(watch.seen).toEqual([{ type: "changed", terminal: existing }, { type: "synced" }])

    const id = randomUUID()
    const created = await manager.create({ id, sessionId: "two", cwd, cols: 80, rows: 24 }, "owner")
    expect(created).toMatchObject({ id, sessionId: "two", exit: null })
    await watch.until(changed(id))
    manager.write({ terminalId: id, data: command({ type: "exit", code: 5 }) }, "owner")
    expect(
      await watch.until((change) => changed(id)(change) && change.terminal.exit !== null),
    ).toEqual({
      type: "changed",
      terminal: {
        ...manager.get(id),
        exit: { code: 5, signal: null, ranMs: expect.any(Number) },
        process: null,
      },
    })

    // A retained exited record keeps its id taken, even when eviction could free it.
    await expect(
      manager.create({ id, sessionId: "two", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      manager.create({ id: existing.id, sessionId: "two", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    const replacement = await manager.create(
      { id: randomUUID(), sessionId: "two", cwd, cols: 80, rows: 24 },
      "owner",
    )
    expect(await watch.until((change) => change.type === "removed")).toEqual({
      type: "removed",
      terminalId: id,
      sessionId: "two",
    })
    await watch.until(changed(replacement.id))
  })

  it.skipIf(process.platform !== "linux")(
    "reports the foreground process as it changes",
    async ({ terminals }) => {
      const manager = terminals.manager({ ...ptyOptions, processPollMs: 10 })
      const terminal = await manager.create(
        { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
        "owner",
      )
      const watch = terminals.watch(manager, "watcher")
      await watch.until((change) => change.type === "synced")
      manager.write(
        { terminalId: terminal.id, data: command({ type: "title", value: "novadeck-probe" }) },
        "owner",
      )
      await watch.until(
        (change) => change.type === "changed" && change.terminal.process?.name === "novadeck-probe",
      )
      expect(manager.get(terminal.id).process?.name).toBe("novadeck-probe")
    },
  )

  it.skipIf(process.platform !== "linux")(
    "reports the foreground group leader's command line, never a background job's",
    async ({ terminals, resources }) => {
      const directory = mkdtempSync(join(tmpdir(), "novadeck-foreground-"))
      resources.defer(() => rmSync(directory, { recursive: true, force: true }))
      const script = join(directory, "agent")
      writeFileSync(script, "setInterval(() => {}, 1000)\n")

      const manager = terminals.manager({ processPollMs: 20 })
      const terminal = await manager.create(
        { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
        "owner",
      )
      const send = (data: string) => manager.write({ terminalId: terminal.id, data }, "owner")
      const current = () => manager.get(terminal.id).process
      const sampled = { timeout: 5_000, interval: 20 }
      const node = { name: basename(process.execPath), argv: [process.execPath, script, "--yes"] }

      send(`'${process.execPath}' '${script}' --yes\r`)
      await vi.waitFor(() => expect(current()).toEqual(node), sampled)
      send("\u0003")
      await vi.waitFor(() => expect(current()?.name).toBe("sh"), sampled)

      // A background job never speaks for the terminal while another command holds the
      // foreground process group.
      send(`'${process.execPath}' '${script}' & sleep 1\r`)
      await vi.waitFor(
        () => expect(current()).toEqual({ name: "sleep", argv: ["sleep", "1"] }),
        sampled,
      )
      await vi.waitFor(() => expect(current()?.name).toBe("sh"), sampled)
      send("kill $!\r")

      // exec keeps the shell's PID and process group; the new name reads the new command line.
      send(`exec '${process.execPath}' '${script}' --yes\r`)
      await vi.waitFor(() => expect(current()).toEqual(node), sampled)
      send("\u0003")
      await vi.waitFor(() => expect(manager.get(terminal.id).exit).not.toBeNull(), sampled)
    },
  )

  it("ends streams when their owner is released, the signal aborts, or the runner stops", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const released = terminals.watch(manager, "released")
    const aborted = terminals.watch(manager, "aborted")
    const stopped = terminals.watch(manager, "stopped")
    for (const watch of [released, aborted, stopped]) {
      // eslint-disable-next-line no-await-in-loop -- Each stream starts in turn.
      await watch.until((change) => change.type === "synced")
    }
    const pending = [released, aborted, stopped].map((watch) => watch.stream.next())
    manager.release("released")
    aborted.controller.abort()
    await expect(pending[0]).resolves.toMatchObject({ done: true })
    await expect(pending[1]).resolves.toMatchObject({ done: true })
    await manager.shutdown()
    await expect(pending[2]).resolves.toMatchObject({ done: true })
    await expect(manager.watch("late").next()).rejects.toMatchObject({ code: "RUNTIME_CLOSING" })
  })
})

describe("terminal closing", () => {
  it("forgets a closed terminal after its viewers read the exit, but retains unrequested exits", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const create = () =>
      manager.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    const closed = await create()
    const ended = await create()
    const watch = terminals.watch(manager, "watcher")
    await watch.until((change) => change.type === "synced")
    const observer = terminals.attach(manager, closed.id, "observer", undefined, "observe")
    await observer.next()

    await manager.close({ terminalId: closed.id }, "owner")
    expect(await watch.until((change) => change.type === "removed")).toEqual({
      type: "removed",
      terminalId: closed.id,
      sessionId: "session",
    })
    expect(manager.list().map((terminal) => terminal.id)).toEqual([ended.id])
    // Its id stays taken while the observer is still attached.
    await expect(
      manager.create({ id: closed.id, sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    // The observer still drains and acknowledges its stream through the exit.
    const events = await until(manager, observer, "observer", (event) => event.type === "exited")
    expect(events.at(-1)).toMatchObject({ type: "exited" })
    await expect(manager.close({ terminalId: closed.id }, "owner")).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
    await expect(terminals.attach(manager, closed.id, "late").next()).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })

    manager.write({ terminalId: ended.id, data: command({ type: "exit", code: 2 }) }, "owner")
    await watch.until((change) => changed(ended.id)(change) && change.terminal.exit !== null)
    expect(manager.get(ended.id)).toMatchObject({ exit: { code: 2 } })
  })

  it("lets any connection close a terminal nobody controls, but not another's", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const create = () =>
      manager.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    const released = await create()
    const held = await create()
    const controller = terminals.attach(manager, held.id, "owner")
    await controller.next()
    manager.release("owner")
    await manager.close({ terminalId: released.id }, "other")
    expect(manager.list().map((terminal) => terminal.id)).toEqual([held.id])
    const retaken = terminals.attach(manager, held.id, "holder")
    await retaken.next()
    await expect(manager.close({ terminalId: held.id }, "other")).rejects.toMatchObject({
      code: "CONTROL_IN_USE",
    })
    await expect(manager.close({ terminalId: randomUUID() }, "other")).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })
})

describe("terminal restart", () => {
  it("starts a fresh shell in the same exited terminal and grants the caller control", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const id = randomUUID()
    await expect(
      manager.create({ id, sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    ).resolves.toMatchObject({ run: 1 })
    const watch = terminals.watch(manager, "watcher")
    await expect(
      manager.restart({ terminalId: id, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    const first = terminals.attach(manager, id, "owner")
    await read(manager, first, "owner", (_event, text) => text.includes("PTY_READY"))
    manager.write(
      { terminalId: id, data: command({ type: "write", data: "FIRST_RUN\r\n" }) },
      "owner",
    )
    manager.write({ terminalId: id, data: command({ type: "exit", code: 3 }) }, "owner")
    const exited = await read(manager, first, "owner", (event) => event.type === "exited")
    const exit = exited.at(-1)!
    const cursor = exit.sequence
    expect(exit).toMatchObject({
      type: "exited",
      exit: { code: 3, signal: null, ranMs: expect.any(Number) },
    })
    expect(manager.get(id)).toMatchObject({ exit: { code: 3 }, process: null })
    await expect(
      manager.restart({ terminalId: id, cols: 100, rows: 30 }, "restarter"),
    ).rejects.toMatchObject({ code: "CONTROL_IN_USE" })
    // Ending the finished attachment releases control, so anyone may restart it.
    await first.return(undefined)

    await expect(
      manager.restart({ terminalId: id, cols: 100, rows: 30 }, "restarter"),
    ).resolves.toMatchObject({ id, cols: 100, rows: 30, exit: null, run: 2 })
    // Reports about the first run carry `run: 1`, so a client can tell them apart.
    expect(
      await watch.until((change) => changed(id)(change) && change.terminal.exit === null),
    ).toMatchObject({ terminal: { run: 2 } })
    expect(manager.list()).toEqual([expect.objectContaining({ id, run: 2 })])
    expect(() => manager.write({ terminalId: id, data: "" }, "restarter")).not.toThrow()
    // A cursor from the previous run gets the new screen, not a replay onto the old one.
    const second = terminals.attach(manager, id, "restarter", cursor)
    const snapshot = (await second.next()).value!
    expect(snapshot).toMatchObject({ type: "snapshot", exit: null })
    expect(snapshot.sequence).toBeGreaterThan(cursor)
    const text = await until(manager, second, "restarter", (_event, all) =>
      all.includes("PTY_READY"),
    )
    expect(text.map((event) => ("data" in event ? event.data : "")).join("")).not.toContain(
      "FIRST_RUN",
    )
    await expect(
      manager.restart({ terminalId: randomUUID(), cols: 80, rows: 24 }, "restarter"),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })

  it.skipIf(process.platform === "win32")(
    "reports the ending signal, and stays exited when its shell cannot start again",
    async ({ terminals, resources }) => {
      const directory = mkdtempSync(join(tmpdir(), "novadeck-restart-"))
      resources.defer(() => rmSync(directory, { recursive: true, force: true }))
      // Removing this link later makes the shell impossible to start again.
      const shell = join(directory, "shell")
      symlinkSync("/bin/sh", shell)
      const manager = terminals.manager({
        shell,
        shellArgs: ["-c", "printf 'PID=%s\\n' $$; exec cat"],
      })
      const id = randomUUID()
      await manager.create({ id, sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
      const stream = terminals.attach(manager, id, "owner")
      let pid = 0
      await read(manager, stream, "owner", (_event, text) => {
        pid = Number(/PID=(\d+)\r?\n/.exec(text)?.[1] ?? 0)
        return pid > 0
      })
      process.kill(pid, "SIGKILL")
      const events = await read(manager, stream, "owner", (event) => event.type === "exited")
      expect(events.at(-1)).toMatchObject({ exit: { code: null, signal: "SIGKILL" } })
      rmSync(shell)
      await expect(
        manager.restart({ terminalId: id, cols: 80, rows: 24 }, "owner"),
      ).rejects.toMatchObject({ code: "SPAWN_FAILED" })
      expect(manager.get(id)).toMatchObject({ exit: { signal: "SIGKILL" } })
    },
  )
})

describe.skipIf(process.platform === "win32")("terminal environment", () => {
  it("starts shells from the runner's environment unless given another, never with its token", async ({
    terminals,
    resources,
  }) => {
    vi.stubEnv("NOVADECK_RUNNER_ONLY", "runner")
    resources.defer(() => {
      vi.unstubAllEnvs()
    })
    const shown = async (manager: Terminals) => {
      const terminal = await manager.create(
        { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
        "owner",
      )
      const stream = terminals.attach(manager, terminal.id, "owner")
      await stream.next()
      manager.write(
        {
          terminalId: terminal.id,
          data: 'printf \'[%s|%s|%s]\\n\' "$NOVADECK_RUNNER_ONLY" "$OWN" "$NOVADECK_TOKEN"\n',
        },
        "owner",
      )
      const events = await until(manager, stream, "owner", (_event, text) =>
        /\[\w*\|\w*\|[\w-]*\]\r\n/.test(text),
      )
      return events.map((event) => ("data" in event ? event.data : "")).join("")
    }

    expect(await shown(terminals.manager({ env: { PS1: "", OWN: "own" } }))).toContain(
      "[runner|own|]",
    )
    expect(
      await shown(
        terminals.manager({
          baseEnv: { PATH: process.env.PATH, NOVADECK_TOKEN: "runner-token" },
          env: { PS1: "", OWN: "own" },
        }),
      ),
    ).toContain("[|own|]")
  })
})

describe.skipIf(process.platform === "win32")("terminal limits", () => {
  it("runs any number of terminals but retains only the newest exited records", async ({
    terminals,
  }) => {
    const running = terminals.manager()
    const many = Array.from({ length: 33 }, () =>
      running.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    )
    await expect(Promise.all(many)).resolves.toHaveLength(33)

    const retaining = terminals.manager({ shellArgs: ["-c", "exit 0"], maxRetained: 2 })
    const watch = terminals.watch(retaining, "watcher")
    await watch.until((change) => change.type === "synced")
    const ids = Array.from({ length: 4 }, () => randomUUID())
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop -- Creation order decides which records are oldest.
      await retaining.create({ id, sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
      // eslint-disable-next-line no-await-in-loop -- Each shell exits before the next starts.
      await watch.until((change) => changed(id)(change) && change.terminal.exit !== null)
    }
    await watch.until((change) => change.type === "removed" && change.terminalId === ids[1])
    expect(retaining.list().map((terminal) => terminal.id)).toEqual(ids.slice(2))
    expect(watch.seen.filter((change) => change.type === "removed")).toEqual(
      ids.slice(0, 2).map((terminalId) => ({ type: "removed", terminalId, sessionId: "session" })),
    )
  })

  it("evicts the terminals that exited first, whatever their creation order", async ({
    terminals,
  }) => {
    const manager = terminals.manager({ maxRetained: 1 })
    const watch = terminals.watch(manager, "watcher")
    await watch.until((change) => change.type === "synced")
    const ids = Array.from({ length: 3 }, () => randomUUID())
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop -- Creation order is part of the scenario.
      await manager.create({ id, sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    }
    // The newest terminal exits first and the oldest last.
    for (const id of ids.toReversed()) {
      manager.write({ terminalId: id, data: "exit 0\n" }, "owner")
      // eslint-disable-next-line no-await-in-loop -- Each exit completes before the next.
      await watch.until((change) => changed(id)(change) && change.terminal.exit !== null)
    }
    await watch.until((change) => change.type === "removed" && change.terminalId === ids[1])
    expect(manager.list().map((terminal) => terminal.id)).toEqual([ids[0]])
  })
})

const createIn = (manager: Terminals) =>
  manager.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")

// The message watches the manager still holds for the terminal.
const readers = (manager: Terminals, terminalId: string) =>
  (manager as unknown as { mail: Map<string, Set<unknown>> }).mail.get(terminalId)?.size ?? 0

describe.skipIf(process.platform === "win32")("terminal message watches", () => {
  it("lets go of each reader that stops, by return or by its signal", async ({ terminals }) => {
    const manager = terminals.manager()
    const { id } = await createIn(manager)
    const returned = manager.watchMessages(id)
    const controller = new AbortController()
    const aborted = manager.watchMessages(id, controller.signal)
    await returned.next()
    await aborted.next()
    expect(readers(manager, id)).toBe(2)
    await returned.return(undefined)
    expect(readers(manager, id)).toBe(1)
    const ending = aborted.next()
    controller.abort()
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    expect(readers(manager, id)).toBe(0)
  })

  it("ends when the runner lets the terminal go, and never starts for one it doesn't hold", async ({
    terminals,
  }) => {
    const manager = terminals.manager({ shellArgs: ["-c", "exit 0"], maxRetained: 1 })
    const changes = terminals.watch(manager, "watcher")
    await changes.until((change) => change.type === "synced")
    const first = await createIn(manager)
    const watch = manager.watchMessages(first.id)
    await expect(watch.next()).resolves.toMatchObject({ value: { terminalId: first.id } })
    // A second exited terminal pushes the first out, once the first has exited: the one
    // that exited first goes, and a loaded machine can end the second shell first.
    await changes.until((change) => changed(first.id)(change) && change.terminal.exit !== null)
    await createIn(manager)
    await expect(watch.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(manager.watchMessages(first.id).next()).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })

  it("ends as the runner shuts down, and refuses new ones", async ({ terminals }) => {
    const manager = terminals.manager()
    const { id } = await createIn(manager)
    const watch = manager.watchMessages(id)
    await watch.next()
    const ending = watch.next()
    await manager.shutdown()
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
    await expect(manager.watchMessages(id).next()).rejects.toMatchObject({
      code: "RUNTIME_CLOSING",
    })
  })
})
