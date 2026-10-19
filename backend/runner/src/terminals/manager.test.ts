import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { createScreen } from "@novadeck/emulator/headless"
import type { ActivityEvent } from "@novadeck/harness-core/events"
import { screen as screenWith } from "@novadeck/harness-core/testing/screens"
import type { TerminalChange, TerminalEvent } from "@novadeck/protocol"
import type { ProcessTrees } from "@novadeck/terminal/pty"
import { command, nativeStandIn, ptyTrace } from "@novadeck/terminal/testing"
import { type HoldBudget, InputQueue } from "@novadeck/tui-input"
import { vi } from "vitest"

import {
  escapeScreenMs,
  escapeVerdictMs,
  started as fresh,
  type Activity,
} from "../harnesses/activity.js"
import { limitGraceMs } from "../harnesses/telemetry.js"
import { describe, expect, it as base } from "../test.js"
import { ptyOptions } from "../testing/pty.js"
import type { Resources } from "../testing/resources.js"
import { WorkspaceStore } from "../workspaces/store.js"
import { Terminals } from "./manager.js"

const cwd = process.cwd()

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

describe("holding the person's input", () => {
  it("lasts as long as the caller asked, past the doorbell's 8 s cap on the resizes", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    type Hold = { holding: () => boolean; release: () => void; settle: () => void }
    const hold = (
      manager as unknown as {
        holdInput: (
          id: string,
          budget: { inputMs: number; sizeMs: number },
          options?: object,
        ) => Hold
      }
    ).holdInput(terminal.id, { inputMs: 60_000, sizeMs: 70_000 }, { deferKeys: true })
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      // Timers armed before the clock was faked still run on real time: arm anew.
      hold.settle()
      const again = (
        manager as unknown as {
          holdInput: (
            id: string,
            budget: { inputMs: number; sizeMs: number },
            options?: object,
          ) => Hold
        }
      ).holdInput(terminal.id, { inputMs: 60_000, sizeMs: 70_000 }, { deferKeys: true })
      vi.advanceTimersByTime(9_000)
      expect(again.holding()).toBe(true)
      vi.advanceTimersByTime(61_000)
      expect(again.holding()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Every line the fixture children traced in this test process.
const traced = (): string[] => ptyTrace(Number.MAX_SAFE_INTEGER).split("\n")

describe("an answer's hold of the person's input", () => {
  it("never replays the mouse's wheel and motion reports it held, once released", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    // The TUI asks for the mouse, as Claude Code and Codex do while a dialog shows.
    manager.write(
      { terminalId: terminal.id, data: command({ type: "write", data: "\x1b[?1003h\x1b[?1006h" }) },
      "creator",
    )
    // Until the screen shows it asked, however long a busy machine's child takes: only
    // then is the wheel's report one the TUI asked for, rather than typed text.
    const { screen } = (
      manager as unknown as {
        records: Map<string, { terminal: { screen: { modes: { mouseTrackingMode: string } } } }>
      }
    ).records.get(terminal.id)!.terminal
    await vi.waitFor(() => expect(screen.modes.mouseTrackingMode).toBe("any"), {
      timeout: 5_000,
    })
    // An answer's hold, as the queue gives it: its keys deferred until delivered.
    const hold = (
      manager as unknown as {
        holdInput: (id: string, budget: HoldBudget) => { release: () => void; settle: () => void }
      }
    ).holdInput(terminal.id, { inputMs: 5_000, sizeMs: 5_000, deferred: true })
    // What the children traced from here on, however much a busy machine traced before.
    const mark = traced().length
    const since = (): string => traced().slice(mark).join("\n")
    // A length no other write of this test has: the child traces lengths.
    const wheel = "\x1b[<64;123;456M"
    manager.write({ terminalId: terminal.id, data: wheel }, "creator")
    manager.write({ terminalId: terminal.id, data: "k" }, "creator")
    hold.release()
    hold.settle()
    // The key went once released; the wheel report, held before it, never did.
    await vi.waitFor(() => expect(since()).toContain("received 1 chars"), { timeout: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    // Neither alone nor with the key.
    expect(since()).not.toContain(`received ${wheel.length} chars`)
    expect(since()).not.toContain(`received ${wheel.length + 1} chars`)
  })
})

describe("answers and the prompts after them", () => {
  it("keeps a chat prompt behind an answer's follow-up words, which go first, though the answered request is still pending", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    const inside = manager as unknown as {
      inputs: InputQueue
      answers: { answer: () => Promise<void> }
      prompts: {
        host: { admit: (id: string) => unknown }
        give: (entry: unknown, id: string, text: string) => Promise<void>
        promptIn: (entry: unknown, id: string, text: string) => Promise<void>
      }
      records: Map<string, { binding: unknown; activity: unknown }>
    }
    const record = inside.records.get(terminal.id)!
    // The agent waits on a request, which the answer's keys take.
    record.binding = { agent: "claude" }
    const waiting = { state: "idle", pending: [{}], plans: [], background: null }
    record.activity = waiting
    const order: string[] = []
    // What the paste does is not under test: it admits as the real prompt does, and takes its time.
    inside.prompts.give = async (_entry, id, text) => {
      inside.prompts.host.admit(id)
      order.push(`start ${text}`)
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push(`end ${text}`)
    }
    inside.answers = {
      answer: () =>
        inside.inputs.run(terminal.id, async (entry) => {
          await new Promise((resolve) => setTimeout(resolve, 60))
          // The dialog took the answer; the hook that ends its request is a moment behind.
          record.activity = { ...waiting, pending: [] }
          await inside.prompts.promptIn(entry, terminal.id, "the person's words")
        }),
    }
    const answer = manager.answer({
      terminalId: terminal.id,
      request: "r",
      answer: { type: "choice", dialog: "d", option: "1" },
    })
    // A message from the chat box, sent while the answer is under way.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const chat = manager.prompt({ terminalId: terminal.id, text: "chat message" })
    await Promise.all([answer, chat])
    expect(order).toEqual([
      "start the person's words",
      "end the person's words",
      "start chat message",
      "end chat message",
    ])
  })
})

describe("terminal prompts", () => {
  it("refuse a plain shell, which runs no agent, writing nothing to it", async ({ terminals }) => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    await expect(manager.prompt({ terminalId: terminal.id, text: "Hello" })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(manager.interrupt({ terminalId: terminal.id })).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("refuse a terminal that does not exist", async ({ terminals }) => {
    const manager = terminals.manager(ptyOptions)
    await expect(manager.prompt({ terminalId: randomUUID(), text: "Hello" })).rejects.toMatchObject(
      { code: "TERMINAL_NOT_FOUND" },
    )
    await expect(manager.interrupt({ terminalId: randomUUID() })).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })
})

describe("terminal interrupts", () => {
  type Inside = {
    records: Map<
      string,
      {
        binding: unknown
        activity: unknown
        terminal: { pty: { write: (data: string) => void }; resizedAt: number }
      }
    >
  }
  /** A shell made to look as if its agent were in the given state, and what is written to it. */
  const agent = async (
    terminals: ReturnType<typeof fixture>,
    state: "working" | "idle",
  ): Promise<{
    manager: Terminals
    id: string
    writes: string[]
    record: Inside["records"] extends Map<string, infer R> ? R : never
  }> => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    const record = (manager as unknown as Inside).records.get(terminal.id)
    if (!record) throw new Error("No record")
    record.binding = { agent: "claude" }
    record.activity = { state, pending: [], plans: [], background: null }
    const writes: string[] = []
    // The manager's writes, not the terminal's own replies to the screen's queries.
    const pty = { ...record.terminal.pty, write: (data: string) => void writes.push(data) }
    record.terminal = Object.create(record.terminal, {
      pty: { value: pty },
      type: { value: (data: string) => pty.write(data) },
    })
    return { manager, id: terminal.id, writes, record }
  }

  it("hands the resizes a lapsed hold left held to the next hold, and applies them once it settles", async ({
    terminals,
  }) => {
    const { manager, id, record } = await agent(terminals, "idle")
    const inside = manager as unknown as {
      holdInput: (
        id: string,
        budget: { inputMs: number; sizeMs: number },
      ) => {
        release: () => void
        settle: () => void
        holding: () => boolean
      }
    }
    const budget = { inputMs: 1_000, sizeMs: 2_000 }
    const first = inside.holdInput(id, budget)
    // Another hold is refused while this one holds the input.
    expect(inside.holdInput(id, budget).holding()).toBe(false)
    // The window's resize waits for the hold.
    manager.resize({ terminalId: id, cols: 100, rows: 30 }, "creator")
    first.release()
    const second = inside.holdInput(id, budget)
    expect(second.holding()).toBe(true)
    // The first's late settle changes nothing: the second holds them now.
    first.settle()
    // A size applies at once to the pty, before its screen: none did.
    expect(record.terminal.resizedAt).toBe(0)
    second.settle()
    await vi.waitFor(() => expect(manager.get(id)).toMatchObject({ cols: 100, rows: 30 }))
  })

  it("keeps the resizes of a hold taken over waiting for the deadline of the hold before, past an early settle", async ({
    terminals,
  }) => {
    const { manager, id, record } = await agent(terminals, "idle")
    const inside = manager as unknown as {
      holdInput: (
        id: string,
        budget: { inputMs: number; sizeMs: number },
      ) => {
        release: () => void
        settle: () => void
        settleAfter: (ms: number) => void
      }
    }
    const budget = { inputMs: 5_000, sizeMs: 10_000 }
    const first = inside.holdInput(id, budget)
    manager.resize({ terminalId: id, cols: 100, rows: 30 }, "creator")
    // The prompt's Enter is out: its resizes are to wait 200 ms more.
    first.settleAfter(200)
    // The next entry fails at once and settles: the resizes are not let go by it.
    const second = inside.holdInput(id, budget)
    second.settle()
    // A size applies at once to the pty, before its screen: none did, its deadline ahead.
    expect(record.terminal.resizedAt).toBe(0)
    await vi.waitFor(() => expect(manager.get(id)).toMatchObject({ cols: 100, rows: 30 }))
  })

  it("sends nothing while the agent is idle, even asked twice at once", async ({ terminals }) => {
    const { manager, id, writes } = await agent(terminals, "idle")
    await Promise.all([
      manager.interrupt({ terminalId: id }),
      manager.interrupt({ terminalId: id }),
    ])
    expect(writes).toEqual([])
  })

  it("presses one Escape for two interrupts of one turn", async ({ terminals }) => {
    const { manager, id, writes, record } = await agent(terminals, "working")
    const write = record.terminal.pty.write
    // The turn ends as the harness takes the Escape.
    record.terminal.pty.write = (data) => {
      write(data)
      record.activity = { state: "idle", pending: [], plans: [], background: null }
    }
    await Promise.all([
      manager.interrupt({ terminalId: id }),
      manager.interrupt({ terminalId: id }),
    ])
    expect(writes).toEqual(["\x1b"])
  })

  it("does not press a second Escape while the hooks still say the turn works", async ({
    terminals,
  }) => {
    const { manager, id, writes } = await agent(terminals, "working")
    // Its activity is still working a moment after Escape, as a late hook may leave it.
    await manager.interrupt({ terminalId: id })
    const second = manager.interrupt({ terminalId: id })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(writes).toEqual(["\x1b"])
    await second
  })

  // A scripted POSIX shell plays the agent.
  it.skipIf(process.platform === "win32")(
    "fails closed, saying so, where an Escape puts the queued message back and the box won't clear",
    async ({ terminals }) => {
      // A Claude Code lookalike: its box shows the queued-messages hint while empty, takes one
      // byte, then holds text no key clears.
      const rule = "────────────────────────────────────────"
      const script = [
        "stty raw -echo",
        `printf '\\033[10;1H${rule}\\033[11;1H❯\\302\\240\\033[2mPress up to edit queued messages\\033[22m\\033[12;1H${rule}\\033[11;3H'`,
        "dd bs=1 count=1 >/dev/null 2>&1",
        "printf '\\033[11;1H\\033[K❯\\302\\240Stuck words\\033[11;15H'",
        "sleep 30",
      ].join("; ")
      const manager = terminals.manager({
        shell: "/bin/sh",
        shellArgs: ["-c", script],
        interrupts: { restoreMs: 600, restoreCalmMs: 150 },
      })
      const terminal = await manager.create(
        { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
        "creator",
      )
      const record = (manager as unknown as Inside).records.get(terminal.id)
      if (!record) throw new Error("No record")
      record.binding = { agent: "claude" }
      record.activity = { state: "working", pending: [], plans: [], background: null }
      await new Promise((resolve) => setTimeout(resolve, 500))
      await expect(manager.interrupt({ terminalId: terminal.id })).rejects.toMatchObject({
        code: "BOX_NOT_CLEARED",
      })
    },
  )

  // A scripted POSIX shell plays the agent.
  it.skipIf(process.platform === "win32")(
    "gives back the queued words an Escape put in the box, once the keys cleared it",
    async ({ terminals }) => {
      const rule = "────────────────────────────────────────"
      const script = [
        "stty raw -echo",
        `printf '\\033[10;1H${rule}\\033[11;1H❯\\302\\240\\033[2mPress up to edit queued messages\\033[22m\\033[12;1H${rule}\\033[11;3H'`,
        "dd bs=1 count=1 >/dev/null 2>&1",
        "printf '\\033[11;1H\\033[K❯\\302\\240Queued words\\033[11;15H'",
        "dd bs=1 count=2 >/dev/null 2>&1",
        "printf '\\033[11;1H\\033[K❯\\302\\240\\033[11;3H'",
        "sleep 30",
      ].join("; ")
      const manager = terminals.manager({
        shell: "/bin/sh",
        shellArgs: ["-c", script],
        interrupts: { restoreMs: 1_500, restoreCalmMs: 150 },
      })
      const terminal = await manager.create(
        { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
        "creator",
      )
      const record = (manager as unknown as Inside).records.get(terminal.id)
      if (!record) throw new Error("No record")
      record.binding = { agent: "claude" }
      record.activity = { state: "working", pending: [], plans: [], background: null }
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await manager.interrupt({ terminalId: terminal.id })).toEqual({
        returned: "Queued words",
      })
    },
  )

  it("waits for the entries ahead of it in the terminal's input queue before pressing Escape", async ({
    terminals,
  }) => {
    const { manager, id, writes } = await agent(terminals, "working")
    const inside = manager as unknown as {
      inputs: { run: (id: string, work: () => Promise<unknown>) => Promise<unknown> }
    }
    // A prompt's paste, an answer with its words or a ring, whose keys no Escape may cut into.
    const ahead = inside.inputs.run(id, () => new Promise((resolve) => setTimeout(resolve, 400)))
    const done = manager.interrupt({ terminalId: id })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(writes).toEqual([])
    await ahead
    await done
    expect(writes).toEqual(["\x1b"])
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
    const restored = createScreen({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 1000 })
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
    await manager.close({ terminalId: terminal.id })
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
    ).rejects.toMatchObject({ code: "CLOSING" })
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
    await expect(manager.watch("late").next()).rejects.toMatchObject({ code: "CLOSING" })
  })
})

/** Whether a process is still running. */
const isRunning = (id: number): boolean => {
  try {
    process.kill(id, 0)
    return true
  } catch {
    return false
  }
}

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

    await manager.close({ terminalId: closed.id })
    expect(await watch.until((change) => change.type === "removed")).toEqual({
      type: "removed",
      terminalId: closed.id,
      sessionId: "session",
    })
    expect(manager.list().map((terminal) => terminal.id)).toEqual([ended.id])
    // Closed for good: its id never starts a terminal again.
    await expect(
      manager.create({ id: closed.id, sessionId: "session", cwd, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    // The observer still drains and acknowledges its stream through the exit.
    const events = await until(manager, observer, "observer", (event) => event.type === "exited")
    expect(events.at(-1)).toMatchObject({ type: "exited" })
    await expect(manager.close({ terminalId: closed.id })).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
    await expect(terminals.attach(manager, closed.id, "late").next()).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })

    manager.write({ terminalId: ended.id, data: command({ type: "exit", code: 2 }) }, "owner")
    await watch.until((change) => changed(ended.id)(change) && change.terminal.exit !== null)
    expect(manager.get(ended.id)).toMatchObject({ exit: { code: 2 } })
  })

  it.runIf(process.platform === "win32")(
    "ends on Windows the programs a closed terminal's shell started",
    async ({ terminals, onTestFinished }) => {
      const manager = terminals.manager(ptyOptions)
      const terminal = await manager.create(
        { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
        "owner",
      )
      const stream = terminals.attach(manager, terminal.id, "owner")
      await read(manager, stream, "owner", (_event, text) => text.includes("PTY_READY"))
      manager.write({ terminalId: terminal.id, data: command({ type: "spawn" }) }, "owner")
      let text = ""
      await read(manager, stream, "owner", (event) => {
        if (event.type === "output") text += event.data
        return /STARTED_PID=\d+\r?\n/.test(text)
      })
      const started = Number(/STARTED_PID=(\d+)\r?\n/.exec(text)?.[1])
      onTestFinished(() => {
        if (isRunning(started)) process.kill(started)
      })
      expect(isRunning(started)).toBe(true)

      await manager.close({ terminalId: terminal.id })
      await vi.waitFor(() => expect(isRunning(started)).toBe(false), { timeout: 15_000 })
    },
  )

  it("lets any connection close a terminal, whoever controls it", async ({ terminals }) => {
    const manager = terminals.manager(ptyOptions)
    const create = () =>
      manager.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    const released = await create()
    const held = await create()
    const controller = terminals.attach(manager, held.id, "owner")
    await controller.next()
    manager.release("owner")
    await manager.close({ terminalId: released.id })
    expect(manager.list().map((terminal) => terminal.id)).toEqual([held.id])
    // Another window controls it: closing it here still ends it, as it is gone here.
    const retaken = terminals.attach(manager, held.id, "holder")
    await retaken.next()
    await manager.close({ terminalId: held.id })
    expect(manager.list()).toEqual([])
    await expect(manager.close({ terminalId: randomUUID() })).rejects.toMatchObject({
      code: "TERMINAL_NOT_FOUND",
    })
  })
})

describe("a terminal in Windows' ConPTY", () => {
  // A stand-in ConPTY and process trees, on any platform: the pty ends as on Windows.
  const conpty = (terminals: ReturnType<typeof fixture>) => {
    const standIn = nativeStandIn({ conpty: true })
    const treeReads: unknown[] = []
    const trees: ProcessTrees = {
      read: async (root) => {
        treeReads.push(root)
        standIn.calls.push("read tree")
        return []
      },
      end: async () => {},
    }
    // A shell that is a real program on every system, as the manager checks it is before the
    // stand-in runs in its place.
    const manager = terminals.manager({
      shell: process.execPath,
      pty: { native: standIn.spawn, platform: "win32", trees },
    })
    const create = () =>
      manager.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    return { standIn, treeReads, manager, create }
  }

  it("closes one that hasn't drawn, its id still unknown, as ended once its kill waits", async ({
    terminals,
  }) => {
    const { standIn, treeReads, manager, create } = conpty(terminals)
    const terminal = await create()
    await manager.close({ terminalId: terminal.id })
    // Nothing is ended by an id ConPTY doesn't know yet: its own queued kill ends it later.
    expect(treeReads).toEqual([])
    expect(standIn.calls.filter((call) => call.startsWith("kill"))).toEqual(["kill"])
    expect(manager.list()).toEqual([])
  })

  it("reads a drawn one's tree before its kill, which ends the shell before its code is known", async ({
    terminals,
  }) => {
    const { standIn, treeReads, manager, create } = conpty(terminals)
    const terminal = await create()
    standIn.draw("C:\\> ")
    const observer = terminals.attach(manager, terminal.id, "observer", undefined, "observe")
    await observer.next()
    await manager.close({ terminalId: terminal.id })
    const events = await until(manager, observer, "observer", (event) => event.type === "exited")
    // Above any pid a host gives, so nothing real is read or ended by it.
    expect(treeReads).toEqual([2 ** 30])
    const ending = standIn.calls.filter((call) => call === "read tree" || call.startsWith("kill"))
    expect(ending).toEqual(["read tree", "kill"])
    expect(events.at(-1)).toMatchObject({ type: "exited", exit: { code: null, signal: null } })
  })

  it("keeps the exit it reported first, without a code, though the code comes after", async ({
    terminals,
  }) => {
    const { standIn, manager, create } = conpty(terminals)
    const terminal = await create()
    standIn.draw("C:\\> ")
    const watch = terminals.watch(manager, "watcher")
    await watch.until((change) => change.type === "synced")
    standIn.exit(undefined)
    standIn.exit(3)
    await watch.until((change) => changed(terminal.id)(change) && change.terminal.exit !== null)
    expect(manager.get(terminal.id)).toMatchObject({ exit: { code: null, signal: null } })
  })

  // Rule 10's measure (architecture/performance.md): a draw sends its output as one event
  // per 4,096 characters, and output read while a draw waits joins it.
  it("sends a draw's output as an event per 4,096 characters, reads joined", async ({
    terminals,
  }) => {
    const { standIn, manager, create } = conpty(terminals)
    const terminal = await create()
    const stream = terminals.attach(manager, terminal.id, "owner")
    await read(manager, stream, "owner", (event) => event.type === "snapshot")
    // The length of each output event, until `total` characters have come.
    const outputs = async (total: number) => {
      const events = await read(manager, stream, "owner", (_event, text) => text.length >= total)
      return events.flatMap((event) => (event.type === "output" ? [event.data.length] : []))
    }
    standIn.draw("a".repeat(10_000))
    expect(await outputs(10_000)).toEqual([4096, 4096, 1808])
    standIn.draw("b".repeat(4096))
    expect(await outputs(4096)).toEqual([4096])
    // Three reads in one draw: one event, not one a read.
    standIn.draw("c".repeat(1000))
    standIn.draw("c".repeat(1000))
    standIn.draw("c".repeat(1000))
    expect(await outputs(3000)).toEqual([3000])
    // Chunked as one: not 3,000 a read.
    standIn.draw("d".repeat(3000))
    standIn.draw("d".repeat(3000))
    standIn.draw("d".repeat(3000))
    expect(await outputs(9000)).toEqual([4096, 4096, 808])
  })
})

describe("a terminal's summary", () => {
  it("tells its size, exit and run as its host has them, wherever it's read", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const watch = terminals.watch(manager, "watcher")
    const id = randomUUID()
    await manager.create({ id, sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    await watch.until((change) => change.type === "synced")
    const agree = () => {
      const got = manager.get(id)
      expect(manager.list().find((terminal) => terminal.id === id)).toEqual(got)
      return got
    }
    manager.resize({ terminalId: id, cols: 100, rows: 30 }, "owner")
    await watch.until((change) => changed(id)(change) && change.terminal.cols === 100)
    expect(agree()).toMatchObject({ cols: 100, rows: 30, exit: null, run: 1 })
    manager.write({ terminalId: id, data: command({ type: "exit", code: 4 }) }, "owner")
    await watch.until((change) => changed(id)(change) && change.terminal.exit !== null)
    expect(agree()).toMatchObject({ cols: 100, rows: 30, exit: { code: 4 }, run: 1 })
    const restarted = await manager.restart({ terminalId: id, cols: 90, rows: 20 }, "owner")
    expect(restarted).toMatchObject({ cols: 90, rows: 20, exit: null, run: 2 })
    expect(agree()).toEqual(restarted)
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

describe("project closing", () => {
  it("lets no restart under way start a shell again in a terminal it closes", async ({
    terminals,
  }) => {
    // The restart waits on whether its agent is connected until the test lets it go on.
    let ask: (() => void) | undefined
    let answer: ((connected: boolean) => void) | undefined
    const asked = new Promise<void>((resolve) => (ask = resolve))
    const manager = terminals.manager({
      ...ptyOptions,
      connected: () => {
        ask?.()
        return new Promise((resolve) => (answer = resolve))
      },
    })
    const id = randomUUID()
    await manager.create({ id, sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    const stream = terminals.attach(manager, id, "owner")
    await read(manager, stream, "owner", (_event, text) => text.includes("PTY_READY"))
    manager.write({ terminalId: id, data: command({ type: "exit", code: 0 }) }, "owner")
    await read(manager, stream, "owner", (event) => event.type === "exited")
    const restarting = manager.restart(
      { terminalId: id, cols: 80, rows: 24, resume: "claude" },
      "owner",
    )
    await asked
    answer?.(false)
    const closing = manager.closeProject("project", ["session"])
    await expect(restarting).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    await closing
    expect(manager.list("session")).toEqual([])
    await expect(
      manager.restart({ terminalId: id, cols: 80, rows: 24 }, "owner"),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
  })

  it("starts no terminal in a closed project's sessions, unless the project stays", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    await manager.closeProject("project", ["session"])
    const create = () =>
      manager.create({ id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 }, "owner")
    await expect(create()).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    // Its removal failed after the close: terminals start in it again.
    manager.projectKept(["session"])
    await expect(create()).resolves.toMatchObject({ sessionId: "session" })
  })
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

  it.runIf(process.platform === "darwin")(
    "gives a shell on macOS a UTF-8 LANG where the runner has no locale, as an app opened from the Dock has none",
    async ({ terminals }) => {
      // sh with no startup files: a developer's own rc can't set LANG for it.
      const manager = terminals.manager({
        shell: "/bin/sh",
        shellArgs: [],
        baseEnv: { PATH: process.env.PATH },
        env: { PS1: "", ENV: "" },
      })
      const terminal = await manager.create(
        { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
        "owner",
      )
      const stream = terminals.attach(manager, terminal.id, "owner")
      await stream.next()
      manager.write({ terminalId: terminal.id, data: "printf '[%s]\\n' \"$LANG\"\n" }, "owner")
      const events = await until(manager, stream, "owner", (_event, text) =>
        /\[[^\]\r\n]*\]\r\n/.test(text),
      )
      const printed = events.map((event) => ("data" in event ? event.data : "")).join("")

      expect(printed).toMatch(/\[[a-z]{2,3}_[A-Z]{2}\.UTF-8\]/)
    },
  )
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
  (manager as unknown as { streams: { mail: Map<string, Set<unknown>> } }).streams.mail.get(
    terminalId,
  )?.size ?? 0

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
      code: "CLOSING",
    })
  })
})

describe("a turn the person's Escape ended", () => {
  type Inside = {
    records: Map<string, { binding: unknown; activity: Activity | null }>
    applyFact: (record: unknown, fact: ActivityEvent) => boolean
    escaped: (record: unknown) => void
    messaging: { escaped: (id: string, binding: unknown) => ActivityEvent | undefined }
  }

  it("reads completed once the window passes with a Stop told since, else interrupted", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    const inside = manager as unknown as Inside
    const record = inside.records.get(terminal.id)!
    const binding = { agent: "claude", sessionId: "s", instance: null } as const
    record.binding = binding
    const tell = (fact: object) => {
      const event = { ...binding, ...fact } as ActivityEvent
      inside.applyFact(record, event)
      return event
    }
    const lastTurn = () => record.activity && record.activity.lastTurn
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      for (const stop of [true, false]) {
        record.activity = fresh(0)
        tell({ type: "turn-started", cause: "prompt", startedAt: 10 })
        // Delivery tells the Escape once, as the manager asks after the person's key.
        const escaped = { ...binding, type: "turn-escaped", startedAt: 20 } as ActivityEvent
        inside.messaging.escaped = () => escaped
        inside.escaped(record)
        if (stop) tell({ type: "turn-ended", outcome: "completed", startedAt: 25, reply: "Done." })
        vi.advanceTimersByTime(escapeVerdictMs - 1)
        expect(lastTurn()).toMatchObject({ outcome: "interrupted" })
        vi.advanceTimersByTime(1)
        expect(lastTurn()).toMatchObject(
          stop ? { outcome: "completed", reply: "Done." } : { outcome: "interrupted" },
        )
      }
    } finally {
      vi.useRealTimers()
    }
  })

  // Each case can wait out the whole window, and a timeout would leave the platform stubbed.
  it("reads completed with no Stop, on Windows, where Antigravity's transcript holds the reply and its screen shows no interruption", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    const inside = manager as unknown as Inside & { screenOf: (id: string) => Promise<unknown> }
    const record = inside.records.get(terminal.id)! as {
      transcript: string | null
      verdict?: unknown
    } & (typeof inside.records extends Map<string, infer R> ? R : never)
    const binding = { agent: "agy", sessionId: "s", instance: null } as const
    record.binding = binding
    const directory = mkdtempSync(join(tmpdir(), "novadeck-escape-"))
    const asked = JSON.stringify({
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "Hold on",
    })
    const answered = JSON.stringify({
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "Too late.",
    })
    // Antigravity's screen after the turn: its reply, maybe its word that the Escape
    // stopped it, then its box; or no box at all, as mid-redraw.
    const rule = "─".repeat(60)
    const shown = (word: boolean) => {
      const rows = [
        "> Hold on",
        "",
        "  Too late.",
        ...(word ? ["", "  ⎿  Interrupted · What should Antigravity CLI do instead?"] : []),
        rule,
        "> ",
        rule,
      ]
      return screenWith({ rows, cursor: { row: rows.length - 2, column: 2 } })
    }
    // As the probe captured them: the transcript's two steps, and the screen's rows.
    const cutOff = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content: "<USER_REQUEST>\nCheck the folder\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-10-11T17:09:15Z",
        content: "Let me check the folder.",
      }),
    ]
    const cutOffRows = [
      rule,
      "> Check the folder",
      "",
      "  Let me check the folder.",
      "⢿  Generating...",
      "",
      "  ⎿  Interrupted · What should Antigravity CLI do instead?",
      rule,
      ">",
      rule,
      "? for shortcuts",
    ]
    const cutOffScreen = screenWith({ rows: cutOffRows, cursor: { row: 8, column: 2 } })
    const unreadable = screenWith({ rows: ["$ "] })
    const cases = [
      ["the reply, shown alone", [asked, answered], shown(false), "completed"],
      ["the reply, with the interruption", [asked, answered], shown(true), "interrupted"],
      // The word drawn after the reply, as a loaded machine may.
      [
        "the reply, then the interruption",
        [asked, answered],
        [shown(false), shown(true)],
        "interrupted",
      ],
      // A read mid-redraw tells nothing: the reads after it do.
      [
        "the reply, after an unreadable read",
        [asked, answered],
        [unreadable, shown(false)],
        "completed",
      ],
      [
        "the reply, with no read after the window that tells",
        [asked, answered],
        [shown(false), unreadable],
        "interrupted",
      ],
      [
        "the reply, with no box to read",
        [asked, answered],
        screenWith({ rows: ["$ "] }),
        "interrupted",
      ],
      ["no reply since the prompt", [answered, asked], shown(false), "interrupted"],
      // An Escape between a response's words and the tool call after them: Antigravity
      // records the words alone as the response, then draws its interruption (probed
      // 2026-10-11, 1.2.14, the call streamed 1.5 s after the words, every run).
      ["the words before a call the Escape cut off", cutOff, cutOffScreen, "interrupted"],
    ] as const
    // The wait for the screen runs on Windows only.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      for (const [what, lines, screen, outcome] of cases) {
        record.transcript = join(directory, `${randomUUID()}.jsonl`)
        writeFileSync(record.transcript, `${lines.join("\n")}\n`)
        // One screen a read once the window has passed, the last for the rest; the first
        // for anything that looks before.
        const reads = [screen].flat()
        let reading = 0
        inside.screenOf = () =>
          Promise.resolve(reads[record.verdict ? 0 : Math.min(reading++, reads.length - 1)])
        record.activity = fresh(0, true, false)
        inside.applyFact(record, {
          ...binding,
          type: "turn-started",
          cause: "prompt",
          startedAt: 10,
        })
        inside.messaging.escaped = () => ({ ...binding, type: "turn-escaped", startedAt: 20 })
        inside.escaped(record)
        // eslint-disable-next-line no-await-in-loop -- Each case waits for its own verdict.
        await vi.waitFor(
          () => expect(record.activity?.lastTurn?.escaped?.settled ?? true).toBe(true),
          { timeout: escapeVerdictMs + escapeScreenMs + 2000 },
        )
        expect(record.activity?.lastTurn?.outcome, what).toBe(outcome)
      }
    } finally {
      Object.defineProperty(process, "platform", platform)
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("terminal naming", () => {
  // Sampling never announces a terminal while these read their watchers.
  const quiet = { ...ptyOptions, processPollMs: 3_600_000 }
  const create = (manager: Terminals, sessionId = "session") =>
    manager.create({ id: randomUUID(), sessionId, cwd, cols: 80, rows: 24 }, "owner")

  it("tells watchers of a rename even to the title the terminal already has", async ({
    terminals,
  }) => {
    const manager = terminals.manager(quiet)
    const { id } = await create(manager)
    const watch = terminals.watch(manager, "watcher")
    await watch.until((change) => change.type === "synced")
    manager.rename({ terminalId: id, title: "Build" })
    await watch.until((change) => changed(id)(change) && change.terminal.title === "Build")

    manager.rename({ terminalId: id, title: "Build" })
    // A terminal created after it, so the watch has a change to read either way.
    const after = await create(manager)
    await watch.until(changed(after.id))
    const renamed = watch.seen
      .filter(changed(id))
      .filter(({ terminal }) => terminal.title === "Build")
    expect(renamed).toHaveLength(2)
  })

  it("tells watchers when a terminal kept only as saved is renamed", async ({ terminals }) => {
    const store = new WorkspaceStore()
    try {
      const project = await store.createProject({ id: randomUUID(), name: "P", cwd })
      const { id: sessionId } = store.createSession({
        id: randomUUID(),
        projectId: project.id,
        name: "S",
      })
      const earlier = terminals.manager({ ...quiet, records: store })
      const { id } = await create(earlier, sessionId)
      await earlier.shutdown()
      // A later runner keeps the terminal only as saved: no shell runs it.
      const manager = terminals.manager({ ...quiet, records: store })
      const watch = terminals.watch(manager, "watcher")
      await watch.until((change) => change.type === "synced")

      manager.rename({ terminalId: id, title: "Kept" })
      // A terminal created after it, so the watch has a change to read either way.
      const after = await create(manager, sessionId)
      await watch.until(changed(after.id))
      expect(watch.seen.findLast(changed(id))?.terminal).toMatchObject({
        id,
        title: "Kept",
        started: false,
      })
    } finally {
      store.close()
    }
  })

  it("never gives a session's handle again without records, once its terminal closed", async ({
    terminals,
  }) => {
    const manager = terminals.manager(quiet)
    const first = await create(manager)
    await manager.close({ terminalId: first.id })
    const second = await create(manager)
    expect(second.handle).not.toBe(first.handle)
  })
})

describe("saving a terminal that was closed", () => {
  type Inside = {
    records: Map<string, unknown>
    saves: { save: (record: unknown, transcript: boolean) => void }
  }
  const stored = async () => {
    const store = new WorkspaceStore()
    const project = await store.createProject({ id: randomUUID(), name: "P", cwd })
    const session = store.createSession({ id: randomUUID(), projectId: project.id, name: "S" })
    return { store, sessionId: session.id }
  }

  it("does not bring its saved record back", async ({ terminals }) => {
    const { store, sessionId } = await stored()
    try {
      const manager = terminals.manager({ ...ptyOptions, records: store })
      const { id } = await manager.create(
        { id: randomUUID(), sessionId, cwd, cols: 80, rows: 24 },
        "creator",
      )
      const inside = manager as unknown as Inside
      // An agent's report suspended at an await when the person closes the terminal saves
      // the record it held once it resumes.
      const record = inside.records.get(id)
      expect(store.terminal(id)).toBeDefined()

      await manager.close({ terminalId: id })
      expect(store.terminal(id)).toBeUndefined()
      inside.saves.save(record, false)
      inside.saves.save(record, true)

      expect(store.terminal(id)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it("forgets one closed as the runner stops, before its shell has ended", async ({
    terminals,
  }) => {
    const { store, sessionId } = await stored()
    try {
      const manager = terminals.manager({ ...ptyOptions, records: store })
      const { id } = await manager.create(
        { id: randomUUID(), sessionId, cwd, cols: 80, rows: 24 },
        "creator",
      )
      // A shell that ignores the hangup ends only at the forced kill, a second later.
      const stream = terminals.attach(manager, id, "creator")
      manager.write({ terminalId: id, data: command({ type: "ignoreHangup" }) }, "creator")
      await until(manager, stream, "creator", (_event, text) => text.includes("HANGUP_IGNORED"))

      const closing = manager.close({ terminalId: id })
      // Forgotten as the close begins, before the shell has ended.
      expect(store.terminal(id)).toBeUndefined()
      // The app quits meanwhile: the runner's last save must not keep it.
      await manager.shutdown()
      await closing

      expect(store.terminal(id)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it("does not restore one closed while its restore was under way", async ({ terminals }) => {
    const { store, sessionId } = await stored()
    try {
      const first = terminals.manager({ ...ptyOptions, records: store })
      const { id } = await first.create(
        { id: randomUUID(), sessionId, cwd, cols: 80, rows: 24 },
        "creator",
      )
      await first.shutdown()
      expect(store.terminal(id)).toBeDefined()

      // The next runner keeps it only as saved, until a window restores it.
      const manager = terminals.manager({ ...ptyOptions, records: store })
      const restoring = manager.create(
        { id, sessionId, cwd, cols: 80, rows: 24, restore: true },
        "creator",
      )
      await manager.close({ terminalId: id })

      await expect(restoring).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
      expect(store.terminal(id)).toBeUndefined()
      expect(manager.list()).toEqual([])
    } finally {
      store.close()
    }
  })

  it("starts or attaches nothing to one closed while its shell still ends", async ({
    terminals,
  }) => {
    const { store, sessionId } = await stored()
    try {
      const manager = terminals.manager({ ...ptyOptions, records: store })
      const { id } = await manager.create(
        { id: randomUUID(), sessionId, cwd, cols: 80, rows: 24 },
        "creator",
      )
      const stream = terminals.attach(manager, id, "creator")
      manager.write({ terminalId: id, data: command({ type: "ignoreHangup" }) }, "creator")
      await until(manager, stream, "creator", (_event, text) => text.includes("HANGUP_IGNORED"))

      const closing = manager.close({ terminalId: id })
      // Another window, back from away, restores it or attaches to it meanwhile.
      await expect(
        manager.create({ id, sessionId, cwd, cols: 80, rows: 24, restore: true }, "other"),
      ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
      await expect(terminals.attach(manager, id, "other").next()).rejects.toMatchObject({
        code: "TERMINAL_NOT_FOUND",
      })
      await closing

      expect(store.terminal(id)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it("does not start one closed before its restore, though nothing of it was saved", async ({
    terminals,
  }) => {
    const { store, sessionId } = await stored()
    try {
      const manager = terminals.manager({ ...ptyOptions, records: store })
      // A window restores a terminal the runner has no record of, as after a runner
      // restart, and the person closes it meanwhile.
      const id = randomUUID()
      const restoring = manager.create(
        { id, sessionId, cwd, cols: 80, rows: 24, restore: true },
        "creator",
      )
      await expect(manager.close({ terminalId: id })).rejects.toMatchObject({
        code: "TERMINAL_NOT_FOUND",
      })

      await expect(restoring).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
      expect(store.terminal(id)).toBeUndefined()
      expect(manager.list()).toEqual([])
    } finally {
      store.close()
    }
  })

  it("still saves one only let go of, which stays saved until closed", async ({ terminals }) => {
    const { store, sessionId } = await stored()
    try {
      const manager = terminals.manager({ ...ptyOptions, maxRetained: 1, records: store })
      const watch = terminals.watch(manager, "watcher")
      await watch.until((change) => change.type === "synced")
      const inside = manager as unknown as Inside
      const ids = [randomUUID(), randomUUID()] as const
      const records: unknown[] = []
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop -- The older one must exit first.
        await manager.create({ id, sessionId, cwd, cols: 80, rows: 24 }, "creator")
        records.push(inside.records.get(id))
        manager.write({ terminalId: id, data: "exit 0\n" }, "creator")
        // eslint-disable-next-line no-await-in-loop -- Each exit completes before the next.
        await watch.until((change) => changed(id)(change) && change.terminal.exit !== null)
      }
      // The second exit lets the first go, kept saved.
      await vi.waitFor(() => expect(inside.records.has(ids[0])).toBe(false))
      expect(inside.records.has(ids[1])).toBe(true)
      expect(store.terminal(ids[0])).toBeDefined()

      // A report suspended while it was let go saves once it resumes.
      store.removeTerminal(ids[0])
      inside.saves.save(records[0], false)

      expect(store.terminal(ids[0])).toBeDefined()
    } finally {
      store.close()
    }
  })
})

describe("a usage limit a turn ran into", () => {
  type Inside = {
    records: Map<
      string,
      { binding: unknown; activity: Activity | null; summary: { activity: unknown } }
    >
    applyFact: (record: unknown, fact: ActivityEvent) => boolean
  }

  it("latches the window its records show used up, as the turn ends or once it is idle, and keeps it", async ({
    terminals,
  }) => {
    const manager = terminals.manager(ptyOptions)
    const terminal = await manager.create(
      { id: randomUUID(), sessionId: "session", cwd, cols: 80, rows: 24 },
      "creator",
    )
    const inside = manager as unknown as Inside
    const record = inside.records.get(terminal.id)!
    const binding = { agent: "claude", sessionId: "s", instance: null } as const
    record.binding = binding
    const tell = (fact: object) =>
      inside.applyFact(record, { ...binding, ...fact } as ActivityEvent)
    const lastTurn = () => record.activity?.lastTurn
    const usage = (used: number, startedAt: number) =>
      tell({
        type: "telemetry-observed",
        limits: [{ minutes: 300, used, resetsAt: 900_000 }],
        startedAt,
      })

    // The window is used up before the turn ends.
    record.activity = fresh(0)
    usage(1, 5)
    tell({ type: "turn-started", cause: "prompt", startedAt: 10 })
    tell({
      type: "turn-ended",
      outcome: "failed",
      startedAt: 20,
      error: "Limit reached",
      limited: true,
    })
    expect(lastTurn()).toMatchObject({
      error: "Limit reached",
      limit: { minutes: 300, resetsAt: 900_000 },
    })

    // Without its harness's word, a window used up is no limit the turn ran into, as when
    // another model's bucket fills beside it.
    record.activity = fresh(0)
    usage(0.5, 25)
    tell({ type: "turn-started", cause: "prompt", startedAt: 30 })
    tell({ type: "turn-ended", outcome: "failed", startedAt: 40 })
    usage(1, 50)
    expect(lastTurn()?.limit).toBeUndefined()

    // With it, the window latches and stays latched when the records move on.
    record.activity = fresh(0)
    usage(1, 55)
    tell({ type: "turn-started", cause: "prompt", startedAt: 60 })
    tell({ type: "turn-ended", outcome: "failed", startedAt: 65, limited: true })
    expect(lastTurn()?.limit).toEqual({ minutes: 300, resetsAt: 900_000 })
    usage(0.1, 70)
    expect(lastTurn()?.limit).toEqual({ minutes: 300, resetsAt: 900_000 })
    tell({ type: "turn-started", cause: "prompt", startedAt: 75 })
    expect(lastTurn()).toBeNull()

    // A latch picked as the most used gives way to a window then seen used up, within the grace.
    record.activity = fresh(0)
    usage(0.9, 100)
    tell({ type: "turn-started", cause: "prompt", startedAt: 101 })
    tell({ type: "turn-ended", outcome: "failed", startedAt: 105, limited: true })
    expect(lastTurn()?.limit).toEqual({ minutes: 300, resetsAt: 900_000 })
    tell({
      type: "telemetry-observed",
      limits: [
        { minutes: 300, used: 0.9, resetsAt: 900_000 },
        { minutes: 10_080, used: 1, resetsAt: 990_000 },
      ],
      startedAt: 110,
    })
    expect(lastTurn()?.limit).toEqual({ minutes: 10_080, resetsAt: 990_000 })
    usage(1, 120)
    expect(lastTurn()?.limit).toEqual({ minutes: 10_080, resetsAt: 990_000 })

    // A window that fills long after a turn is the person's, not the turn's.
    record.activity = fresh(0)
    tell({ type: "turn-started", cause: "prompt", startedAt: 200 })
    tell({ type: "turn-ended", outcome: "failed", startedAt: 205 })
    usage(1, 205 + limitGraceMs + 1)
    expect(lastTurn()?.limit).toBeUndefined()
  })
})
