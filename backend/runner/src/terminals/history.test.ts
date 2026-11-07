import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentName, HistoryChange, TerminalSummary } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it } from "../test.js"
import type { ClosedRecord, ListedClosed } from "../workspaces/closed.js"
import {
  ClosedTerminals,
  type HistoryHost,
  type HistoryRecords,
  type HistoryTimes,
  type Plan,
} from "./history.js"
import type { Record } from "./record.js"
import type { SavedTerminal } from "./saved-terminals.js"
import { unnamed } from "./titles.js"

const folder = mkdtempSync(join(tmpdir(), "novadeck-history-"))
afterEach(() => vi.restoreAllMocks())
process.on("exit", () => rmSync(folder, { recursive: true, force: true }))

const day = 24 * 60 * 60 * 1000

/** The store's closed rows and handles, in memory. */
const memory = () => {
  const rows = new Map<string, ClosedRecord>()
  const given = new Set<string>()
  const records: HistoryRecords = {
    insertClosed: (row) => void rows.set(row.id, row),
    closed: (projectId) =>
      [...rows.values()]
        .filter((row) => row.projectId === projectId)
        .toSorted((a, b) => b.closedAt - a.closedAt)
        .map(({ transcript: _transcript, ...rest }) => rest) as ListedClosed[],
    closedTerminal: (id) => rows.get(id),
    removeClosed: (id) => rows.delete(id),
    pruneClosed: (before) => {
      const old = [...rows.values()].filter((row) => row.closedAt < before).map((row) => row.id)
      for (const id of old) rows.delete(id)
      return old
    },
    adoptHandle: (sessionId, handle) => {
      const key = `${sessionId}/${handle}`
      if (given.has(key)) return false
      given.add(key)
      return true
    },
  }
  return { rows, given, records }
}

const row = (changes: Partial<ClosedRecord> = {}): ClosedRecord => ({
  id: "old-1",
  projectId: "p1",
  sessionId: "s1",
  handle: "moth",
  naming: unnamed,
  agent: null,
  lastProgram: null,
  command: null,
  cwd: folder,
  agents: {},
  interruptions: [],
  transcript: null,
  closedAt: Date.now(),
  closedBy: null,
  ...changes,
})

const agentRow = (agent: AgentName = "claude", changes: Partial<ClosedRecord> = {}) =>
  row({
    agent,
    agents: { [agent]: { sessionId: "conv-0001", seq: 5, cwd: folder } },
    ...changes,
  })

const live = (changes: Partial<Record> = {}, summary: Partial<Record["summary"]> = {}): Record =>
  ({
    summary: {
      id: "t-1",
      sessionId: "s1",
      handle: "moth",
      lastProgram: null,
      command: null,
      cwd: folder,
      ready: null,
      restorable: true,
      busy: false,
      ...summary,
    },
    naming: unnamed,
    agents: {},
    bound: null,
    interruptions: undefined,
    ran: true,
    restoring: undefined,
    expecting: null,
    terminal: {},
    ...changes,
  }) as unknown as Record

const bound = (agent: AgentName, sessionId: string): Record["bound"] =>
  ({ binding: { agent, sessionId, instance: null }, activity: {}, telemetry: null }) as never

type Setup = {
  history: ClosedTerminals
  store: ReturnType<typeof memory>
  host: { [name in keyof HistoryHost]: ReturnType<typeof vi.fn> } & { records: HistoryRecords }
  said: string[]
  released: string[]
  archived: { record: Record; write: (sealed: string) => void; settled: () => void }[]
}

const setup = (
  over: Partial<{ [name in keyof HistoryHost]: unknown }> = {},
  times: Partial<HistoryTimes> = {},
): Setup => {
  const store = memory()
  const said: string[] = []
  const released: string[] = []
  const archived: Setup["archived"] = []
  const host = {
    records: store.records,
    projects: vi.fn<() => string[]>(() => ["p1", "p2"]),
    projectOf: vi.fn<(sessionId: string) => string>((sessionId: string) =>
      sessionId === "s2" ? "p1" : "p1",
    ),
    going: vi.fn<() => boolean>(() => false),
    stopping: vi.fn<() => boolean>(() => false),
    install: vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({ env: {}, home: folder, platform: process.platform, plugin: "" }),
    ),
    connected: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
    holder: vi.fn<() => string | undefined>(() => undefined),
    terminalsIn: vi.fn<() => readonly { handle: string; ledBy: string | null }[]>(() => []),
    drawHandle: vi.fn<() => string>(() => "fox"),
    releaseClaim: vi.fn<(id: string) => void>((id: string) => void released.push(id)),
    archive: vi.fn<(record: Record, write: (sealed: string) => void, settled: () => void) => void>(
      (record: Record, write: (sealed: string) => void, settled: () => void) =>
        void archived.push({ record, write, settled }),
    ),
    transcriptOf: vi.fn<() => undefined>(() => undefined),
    restoredHandle: vi.fn<() => string | undefined>(() => undefined),
    restoredAs: vi.fn<() => TerminalSummary | undefined>(() => undefined),
    ran: vi.fn<() => boolean>(() => true),
    announce: vi.fn<(record: Record) => void>(),
    say: vi.fn<(record: Record, text: string) => void>(
      (_record: Record, text: string) => void said.push(text),
    ),
    ...over,
  } as unknown as Setup["host"]
  const history = new ClosedTerminals(host as unknown as HistoryHost, {
    checkMs: 200,
    restoreMs: 60,
    pruneMs: 3_600_000,
    ...times,
  })
  return { history, store, host, said, released, archived }
}

/** Answers what a harness's files say of a conversation. */
const conversationIs = (answer: "found" | "gone" | "unknown") => {
  for (const agent of ["claude", "codex", "agy"] as const)
    vi.spyOn(harnesses[agent], "conversations").mockReturnValue({
      conversation: () => Promise.resolve(answer),
    })
}

/** Follows the watch, collecting changes after `synced`. */
const follow = async (history: ClosedTerminals) => {
  const controller = new AbortController()
  const stream = history.watch("owner", controller.signal)
  const initial: HistoryChange[] = []
  const later: HistoryChange[] = []
  void (async () => {
    let synced = false
    for await (const change of stream) {
      if (change.type === "synced") synced = true
      else (synced ? later : initial).push(change)
    }
  })()
  await vi.waitFor(() => expect(stream).toBeDefined())
  await new Promise((resolve) => setTimeout(resolve, 20))
  return { initial, later, stop: () => controller.abort() }
}

const summary = { id: "new-1" } as TerminalSummary

/** Restores `row` as `new-1`, handing the plan to `after`. */
const restoring = async (
  setupped: Setup,
  record: Record,
  { resumes = true, rowId = "old-1", opened = true, shownBy = Promise.resolve() } = {},
): Promise<{ plan: Plan }> => {
  let made: Plan | undefined
  await setupped.history.restore({ id: "new-1", sessionId: "s1", closed: rowId }, (plan) => {
    made = plan
    plan.identity("s1")
    plan.started(record, resumes, opened, shownBy)
    return Promise.resolve(summary)
  })
  return { plan: made! }
}

beforeEach(() => conversationIs("found"))

describe("keeping a terminal as it closes", () => {
  it("writes a row from the record in memory, without the turn the session was in", () => {
    const { history, store } = setup()
    const record = live({
      agents: { claude: { sessionId: "c1", seq: 3, turn: "running", cwd: "/w" } },
      bound: bound("claude", "c1"),
    })
    history.closing(record, "fox")
    const kept = store.rows.get("t-1")!
    expect(kept).toMatchObject({
      projectId: "p1",
      sessionId: "s1",
      handle: "moth",
      agent: "claude",
      closedBy: "fox",
      transcript: null,
    })
    expect(kept.agents.claude).toEqual({ sessionId: "c1", seq: 3, cwd: "/w" })
  })

  it("keeps nothing of a terminal nothing ran in, and something of one that did", () => {
    const { history, store } = setup()
    history.closing(live({ ran: false }), null)
    expect(store.rows.size).toBe(0)
    history.closing(live({ ran: false, agents: { codex: { sessionId: "c", seq: 1 } } }), null)
    expect(store.rows.size).toBe(1)
    history.closing(live({ ran: true }, { id: "t-2" }), null)
    expect(store.rows.has("t-2")).toBe(true)
  })

  it("keeps an agent that exited, or closed before it bound, resumable by its latest report", async () => {
    const { history, store } = setup()
    // Ctrl-C twice: the session reported, then nothing is bound.
    const exited = live({ agents: { claude: { sessionId: "c1", seq: 3, cwd: folder } } })
    history.closing(exited, null)
    expect(store.rows.get("t-1")).toMatchObject({ agent: "claude" })
    expect((await history.list("p1"))[0]!.availability).toEqual({ state: "ready" })
    // Two agents reported: the later one is the row's.
    const both = live(
      {
        agents: {
          claude: { sessionId: "c1", seq: 3 },
          codex: { sessionId: "x1", seq: 8 },
        },
      },
      { id: "t-2" },
    )
    history.closing(both, null)
    expect(store.rows.get("t-2")).toMatchObject({ agent: "codex" })
    const plan = await new Promise<Plan>(
      (resolve) =>
        void history.restore({ id: "n", sessionId: "s1", closed: "t-2" }, (made) => {
          resolve(made)
          return Promise.resolve(summary)
        }),
    )
    expect(plan.resume).toBe("codex")
  })

  it("keeps a saved terminal whose agent exited by its latest report too", () => {
    const { history, store } = setup()
    history.closingSaved(
      {
        id: "k-1",
        sessionId: "s1",
        handle: "fox",
        naming: unnamed,
        openedBy: null,
        ledBy: null,
        command: null,
        lastProgram: "bash",
        work: null,
        cwd: "/w",
        agents: { codex: { sessionId: "x", seq: 1 } },
        promptedAt: null,
        interruptions: [],
        transcript: "v1.sealed",
        savedAt: 1,
      },
      null,
    )
    expect(store.rows.get("k-1")).toMatchObject({ agent: "codex", transcript: null })
  })

  it("keeps one row for one conversation: the older row of the same session goes", async () => {
    const { history, store } = setup()
    store.rows.set("old-1", agentRow("claude", { closedAt: 1 }))
    const watching = await follow(history)
    // Closed again with the session bound, as a restore the row was not removed for leaves it.
    history.closing(
      live({
        bound: bound("claude", "conv-0001"),
        agents: { claude: { sessionId: "conv-0001", seq: 6, cwd: folder } },
      }),
      null,
    )
    expect([...store.rows.keys()]).toEqual(["t-1"])
    await vi.waitFor(() =>
      expect(watching.later).toContainEqual({ type: "removed", id: "old-1", projectId: "p1" }),
    )
    watching.stop()
    // Another conversation's row stays.
    store.rows.set(
      "other",
      agentRow("claude", { id: "other", agents: { claude: { sessionId: "zzz", seq: 1 } } }),
    )
    history.closing(live({ bound: bound("claude", "conv-0001") }, { id: "t-3" }), null)
    expect(store.rows.has("other")).toBe(true)
  })

  it("adds no plain row for a restore that did not open, whose row stands", () => {
    const { history, store } = setup()
    store.rows.set("old-1", agentRow())
    history.closing(live({ restoredFrom: "old-1", ran: true, agents: {} }), null)
    expect([...store.rows.keys()]).toEqual(["old-1"])
    // A plain row restored from is not an agent's: the new terminal is kept as any.
    store.rows.set("plain", row({ id: "plain" }))
    history.closing(live({ restoredFrom: "plain" }, { id: "t-2" }), null)
    expect(store.rows.has("t-2")).toBe(true)
  })

  it("can't restore a plain row until its screen is written or given up", async () => {
    const { history, store, archived } = setup()
    history.closing(live(), null)
    expect((await history.list("p1"))[0]!.availability).toEqual({ state: "restoring" })
    await expect(
      history.restore({ id: "n", sessionId: "s1", closed: "t-1" }, () => Promise.resolve(summary)),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    const watching = await follow(history)
    archived[0]!.write("v1.sealed")
    archived[0]!.settled()
    await vi.waitFor(() =>
      expect(watching.later).toContainEqual(
        expect.objectContaining({
          type: "changed",
          closed: expect.objectContaining({ availability: { state: "ready" } }),
        }),
      ),
    )
    expect(store.rows.get("t-1")?.transcript).toBe("v1.sealed")
    watching.stop()
  })

  it("does not leave a row restoring when keeping its screen throws", async () => {
    const { history, store } = setup({
      archive: () => {
        throw new Error("redactor")
      },
    })
    history.closing(live(), null)
    expect(store.rows.has("t-1")).toBe(true)
    expect((await history.list("p1"))[0]!.availability).toEqual({ state: "ready" })
  })

  it("loses neither row when writing the new one fails", () => {
    const { history, store } = setup()
    store.rows.set("old-1", agentRow())
    store.records.insertClosed = () => {
      throw new Error("disk")
    }
    history.closing(
      live({
        bound: bound("claude", "conv-0001"),
        agents: { claude: { sessionId: "conv-0001", seq: 6, cwd: folder } },
      }),
      null,
    )
    expect(store.rows.has("old-1")).toBe(true)
  })

  it("keeps nothing while its project is going", () => {
    const { history, store } = setup({ going: () => true })
    history.closing(live(), null)
    expect(store.rows.size).toBe(0)
  })

  it("keeps a plain terminal's last output, and an agent's none", () => {
    const { history, store, archived } = setup()
    history.closing(live(), null)
    expect(archived).toHaveLength(1)
    archived[0]!.write("sealed-text")
    expect(store.rows.get("t-1")?.transcript).toBe("sealed-text")
    history.closing(live({ bound: bound("claude", "c1") }, { id: "t-2" }), null)
    expect(archived).toHaveLength(1)
  })

  it("does not bring a row back by writing its output after it is gone", () => {
    const { history, store, archived } = setup()
    history.closing(live(), null)
    store.rows.delete("t-1")
    archived[0]!.write("late")
    expect(store.rows.size).toBe(0)
  })

  it("keeps a terminal that was only saved, with its sealed transcript", () => {
    const { history, store } = setup({ ran: () => true })
    const saved: SavedTerminal = {
      id: "k-1",
      sessionId: "s1",
      handle: "fox",
      naming: unnamed,
      openedBy: null,
      ledBy: null,
      command: null,
      lastProgram: null,
      work: null,
      cwd: "/w",
      agents: {},
      promptedAt: null,
      interruptions: [],
      transcript: "v1.sealed",
      savedAt: 1,
    }
    history.closingSaved(saved, null)
    expect(store.rows.get("k-1")).toMatchObject({ agent: null, transcript: "v1.sealed" })
    const idle = setup({ ran: () => false })
    idle.history.closingSaved(saved, null)
    expect(idle.store.rows.size).toBe(0)
    const agent = setup()
    agent.history.closingSaved(
      { ...saved, lastProgram: "codex", agents: { codex: { sessionId: "x", seq: 1 } } },
      null,
    )
    expect(agent.store.rows.get("k-1")).toMatchObject({ agent: "codex", transcript: null })
  })

  it("never lets a failure stop the close", () => {
    const { history, store } = setup()
    store.records.insertClosed = () => {
      throw new Error("disk")
    }
    expect(() => history.closing(live(), null)).not.toThrow()
  })
})

describe("pruning and watching", () => {
  it("deletes rows older than 30 days and tells watchers", async () => {
    const { history, store } = setup()
    store.rows.set("old", row({ id: "old", closedAt: Date.now() - 31 * day }))
    store.rows.set("new", row({ id: "new", closedAt: Date.now() - day }))
    const watching = await follow(history)
    expect(watching.initial.map((c) => (c.type === "changed" ? c.closed.id : ""))).toContain("new")
    history.prune()
    await vi.waitFor(() =>
      expect(watching.later).toContainEqual({ type: "removed", id: "old", projectId: "p1" }),
    )
    expect([...store.rows.keys()]).toEqual(["new"])
    watching.stop()
  })

  it("prunes as it starts", () => {
    const store = memory()
    store.rows.set("old", row({ id: "old", closedAt: Date.now() - 31 * day }))
    const { host } = setup()
    ;(host as { records: HistoryRecords }).records = store.records
    const history = new ClosedTerminals(host as unknown as HistoryHost)
    history.close()
    expect(store.rows.size).toBe(0)
  })

  it("tells watchers of a row as it closes", async () => {
    const { history } = setup()
    const watching = await follow(history)
    history.closing(live(), null)
    await vi.waitFor(() => expect(watching.later).toHaveLength(1))
    expect(watching.later[0]).toMatchObject({ type: "changed", closed: { id: "t-1" } })
    watching.stop()
  })
})

describe("a closed terminal's claims", () => {
  it("tell watchers of its row again once they are given back", async () => {
    const { history } = setup()
    history.closing(live(), null)
    const watching = await follow(history)
    history.released("t-1")
    await vi.waitFor(() => expect(watching.later).toHaveLength(1))
    expect(watching.later[0]).toMatchObject({ type: "changed", closed: { id: "t-1" } })
    history.released("unknown")
    watching.stop()
  })
})

describe("what a row can do now", () => {
  const state = async (closed: ClosedRecord, over: Parameters<typeof setup>[0] = {}) => {
    const { history, store } = setup(over)
    store.rows.set(closed.id, closed)
    return (await history.list("p1"))[0]!.availability
  }

  it("is ready for a plain terminal, and for an agent whose files are there", async () => {
    expect(await state(row())).toEqual({ state: "ready" })
    expect(await state(agentRow())).toEqual({ state: "ready" })
  })

  it("is gone with no session, with no conversation file, and with no folder", async () => {
    expect(await state(row({ agent: "claude" }))).toEqual({ state: "gone", reason: "conversation" })
    conversationIs("gone")
    expect(await state(agentRow())).toEqual({ state: "gone", reason: "conversation" })
    conversationIs("found")
    const missing = agentRow("claude", {
      agents: { claude: { sessionId: "c1", seq: 1, cwd: join(folder, "nowhere") } },
    })
    expect(await state(missing)).toEqual({ state: "gone", reason: "folder" })
  })

  it("stays ready where the files can't be told", async () => {
    conversationIs("unknown")
    expect(await state(agentRow())).toEqual({ state: "ready" })
    vi.spyOn(harnesses.claude, "conversations").mockReturnValue({
      conversation: () => new Promise(() => undefined),
    })
    expect(await state(agentRow())).toEqual({ state: "ready" })
    expect(await state(agentRow(), { install: () => Promise.resolve(undefined) })).toEqual({
      state: "ready",
    })
  })

  it("is disconnected for a harness not connected, and open where another terminal has it", async () => {
    expect(await state(agentRow("codex"), { connected: () => Promise.resolve(false) })).toEqual({
      state: "disconnected",
      agent: "codex",
    })
    expect(await state(agentRow(), { holder: () => "fox" })).toEqual({
      state: "open",
      handle: "fox",
    })
  })

  it("reads each agent's files once for a whole list", async () => {
    const scan = vi.fn<() => { conversation: () => Promise<"found"> }>(() => ({
      conversation: () => Promise.resolve("found" as const),
    }))
    vi.spyOn(harnesses.claude, "conversations").mockImplementation(scan)
    const { history, store } = setup()
    for (const id of ["a", "b", "c"]) store.rows.set(id, agentRow("claude", { id }))
    await history.list("p1")
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it("reads whether a harness is connected once for a whole list", async () => {
    const { history, store, host } = setup()
    for (const id of ["a", "b", "c"]) store.rows.set(id, agentRow("claude", { id }))
    await history.list("p1")
    expect(host.connected).toHaveBeenCalledTimes(1)
  })

  it("refuses a watch that began as the runner stopped, after its rows were read", async () => {
    const { history, store, host } = setup()
    store.rows.set("a", agentRow("claude", { id: "a" }))
    host.stopping.mockReturnValueOnce(false).mockReturnValue(true)
    await expect(history.watch("owner").next()).rejects.toMatchObject({ code: "CLOSING" })
  })

  it("passes the transcript the session reported to the check", async () => {
    const conversation = vi.fn<() => Promise<"found">>(() => Promise.resolve("found" as const))
    vi.spyOn(harnesses.claude, "conversations").mockReturnValue({ conversation })
    await state(
      agentRow("claude", {
        agents: { claude: { sessionId: "c1", seq: 1, cwd: folder, transcript: "/t/c1.jsonl" } },
      }),
    )
    expect(conversation).toHaveBeenCalledWith("c1", { transcript: "/t/c1.jsonl" })
  })

  it("judges a running terminal restorable by its session, its harness and its files", async () => {
    const { history } = setup()
    const record = live()
    history.judge(record)
    expect(record.summary.restorable).toBe(true)
    const starting = live({ expecting: "claude" })
    history.judge(starting)
    expect(starting.summary.restorable).toBe(false)
    const agent = live({ bound: bound("claude", "c1") }, { restorable: false })
    history.judge(agent)
    await vi.waitFor(() => expect(agent.summary.restorable).toBe(true))
  })

  it("reads an agent typed with no session as one, so closing it asks", () => {
    const { history } = setup()
    for (const name of ["codex", "agy", "claude"]) {
      const typed = live({}, { process: { name, argv: null } } as never)
      history.judge(typed)
      expect(typed.summary.restorable).toBe(false)
    }
    const back = live({}, { process: { name: "bash", argv: null } } as never)
    history.judge(back)
    expect(back.summary.restorable).toBe(true)
  })

  for (const agent of ["claude", "codex", "agy"] as const)
    it(`judges ${agent} not bound yet by the session it reported`, async () => {
      vi.spyOn(harnesses[agent], "conversation").mockResolvedValue("found")
      const { history } = setup()
      // Resumed or restored: its saved report stands, but no id has bound before its first prompt.
      const resumed = live(
        { expecting: agent, agents: { [agent]: { sessionId: "conv-1", seq: 4, cwd: folder } } },
        { restorable: false },
      )
      history.judge(resumed)
      await vi.waitFor(() => expect(resumed.summary.restorable).toBe(true))
      // Its conversation gone, it is not restorable, and closing would not keep a ready row.
      vi.spyOn(harnesses[agent], "conversation").mockResolvedValue("gone")
      const lost = live(
        { expecting: agent, agents: { [agent]: { sessionId: "conv-1", seq: 4, cwd: folder } } },
        { restorable: true },
      )
      history.judge(lost)
      await vi.waitFor(() => expect(lost.summary.restorable).toBe(false))
    })

  /** A running agent whose conversation file is not there, as it is before its first turn. */
  const turning = (now: "working" | "idle" | undefined, over: Partial<Record> = {}) =>
    live({ bound: bound("claude", "fresh"), ...over }, {
      restorable: false,
      activity: now && { state: now },
    } as never)

  it("does not read a session with no turn yet as gone, and judges it again when a turn ends", async () => {
    conversationIs("gone")
    vi.spyOn(harnesses.claude, "conversation").mockResolvedValue("gone")
    const { history } = setup()
    const record = turning("idle")
    history.judge(record)
    await vi.waitFor(() => expect(record.summary.restorable).toBe(true))
    // Its turn runs, then ends with the file still not there: gone is believed now.
    record.summary = { ...record.summary, activity: { state: "working" } } as never
    history.judge(record)
    expect(record.summary.restorable).toBe(true)
    record.summary = { ...record.summary, activity: { state: "idle" } } as never
    history.judge(record)
    await vi.waitFor(() => expect(record.summary.restorable).toBe(false))
    // And true again once the turn's file shows, at the next turn's end.
    vi.spyOn(harnesses.claude, "conversation").mockResolvedValue("found")
    record.summary = { ...record.summary, activity: { state: "working" } } as never
    history.judge(record)
    record.summary = { ...record.summary, activity: { state: "idle" } } as never
    history.judge(record)
    await vi.waitFor(() => expect(record.summary.restorable).toBe(true))
  })

  it("judges again on a connection change, and not again for the same state", async () => {
    const { history, host } = setup()
    const record = live({ bound: bound("claude", "c1") })
    history.judge(record)
    await vi.waitFor(() => expect(record.summary.restorable).toBe(true))
    host.connected.mockClear()
    history.judge(record)
    expect(host.connected).not.toHaveBeenCalled()
    host.connected.mockResolvedValue(false)
    history.judge(record, true)
    await vi.waitFor(() => expect(record.summary.restorable).toBe(false))
  })

  it("is judged again at bind, whatever the last session's verdict", async () => {
    conversationIs("gone")
    vi.spyOn(harnesses.claude, "conversation").mockImplementation((_install, session) =>
      Promise.resolve(session === "old" ? "gone" : "found"),
    )
    const { history } = setup()
    const record = live({ bound: bound("claude", "old"), restoredFrom: "x" })
    history.judge(record)
    await vi.waitFor(() => expect(record.summary.restorable).toBe(false))
    record.bound = bound("claude", "new")
    history.judge(record)
    await vi.waitFor(() => expect(record.summary.restorable).toBe(true))
  })
})

describe("restoring a row", () => {
  it("refuses an unknown row and another project's with NOT_FOUND", async () => {
    const { history, store } = setup()
    const start = () => Promise.resolve(summary)
    await expect(
      history.restore({ id: "new-1", sessionId: "s1", closed: "nope" }, start),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    store.rows.set("old-1", row({ projectId: "p2" }))
    await expect(
      history.restore({ id: "new-1", sessionId: "s1", closed: "old-1" }, start),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("refuses a row that can't be restored now with CONFLICT", async () => {
    conversationIs("gone")
    const { history, store } = setup()
    store.rows.set("old-1", agentRow())
    await expect(
      history.restore({ id: "new-1", sessionId: "s1", closed: "old-1" }, () =>
        Promise.resolve(summary),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect((await history.list("p1"))[0]!.availability.state).toBe("gone")
  })

  it("refuses a second restore of a row, and shows it restoring meanwhile", async () => {
    const { history, store } = setup()
    store.rows.set("old-1", row())
    let finish!: () => void
    const first = history.restore(
      { id: "new-1", sessionId: "s1", closed: "old-1" },
      () => new Promise<TerminalSummary>((resolve) => (finish = () => resolve(summary))),
    )
    await vi.waitFor(async () =>
      expect((await history.list("p1"))[0]!.availability).toEqual({ state: "restoring" }),
    )
    await expect(
      history.restore({ id: "new-2", sessionId: "s1", closed: "old-1" }, () =>
        Promise.resolve(summary),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    finish()
    await first
  })

  it("answers a repeated create with the terminal the first made", async () => {
    const { history, store } = setup()
    store.rows.set("old-1", row())
    let starts = 0
    const start = () => {
      starts += 1
      return new Promise<TerminalSummary>((resolve) => setTimeout(() => resolve(summary), 20))
    }
    const input = { id: "new-1", sessionId: "s1", closed: "old-1" }
    const [a, b] = await Promise.all([history.restore(input, start), history.restore(input, start)])
    expect(a).toBe(b)
    expect(starts).toBe(1)
  })

  it("answers a repeat after the row is gone with the terminal that is running", async () => {
    const running = { id: "new-1", handle: "moth" } as TerminalSummary
    const { history } = setup({ restoredAs: () => running })
    expect(
      await history.restore({ id: "new-1", sessionId: "s1", closed: "old-1" }, () =>
        Promise.reject(new Error("never")),
      ),
    ).toBe(running)
  })

  it("lets the row go again when the terminal could not start", async () => {
    const { history, store } = setup()
    store.rows.set("old-1", row())
    await expect(
      history.restore({ id: "new-1", sessionId: "s1", closed: "old-1" }, () =>
        Promise.reject(new Error("no shell")),
      ),
    ).rejects.toThrow("no shell")
    expect((await history.list("p1"))[0]!.availability.state).toBe("ready")
  })

  it("starts a plain terminal in its folder with its saved output, and its row leaves once that is saved", async () => {
    const saves: (() => void)[] = []
    const { history, store } = setup({
      saved: (_record: Record, done: () => void) => void saves.push(done),
    })
    store.rows.set("old-1", row({ transcript: "v1.text", lastProgram: "vim" }))
    const watching = await follow(history)
    const record = live()
    const { plan } = await restoring({ history, store } as Setup, record)
    expect(plan.saved).toMatchObject({ id: "old-1", transcript: "v1.text", cwd: folder })
    expect(plan.resume).toBeUndefined()
    expect(record.restoredFrom).toBe("old-1")
    // The output is on the new terminal's screen only: the row stands until it is saved there.
    await vi.waitFor(() => expect(saves).toHaveLength(1))
    expect(store.rows.size).toBe(1)
    saves[0]!()
    expect(store.rows.size).toBe(0)
    await vi.waitFor(() =>
      expect(watching.later).toContainEqual({ type: "removed", id: "old-1", projectId: "p1" }),
    )
    watching.stop()
  })

  it("waits for the replay before asking for the new terminal's screen", async () => {
    let shown!: () => void
    const saves: (() => void)[] = []
    const s = setup({ saved: (_record: Record, done: () => void) => void saves.push(done) })
    s.store.rows.set("old-1", row({ transcript: "v1.text" }))
    await restoring(s, live(), { shownBy: new Promise<void>((resolve) => (shown = resolve)) })
    expect(saves).toHaveLength(0)
    shown()
    await vi.waitFor(() => expect(saves).toHaveLength(1))
  })

  it("lets the row go with the screen of a new terminal closed before its own was saved", async () => {
    const s = setup({ saved: vi.fn<() => void>() })
    s.store.rows.set("old-1", row({ transcript: "v1.text" }))
    const record = live()
    await restoring(s, record)
    s.history.closing(record, null)
    expect(s.store.rows.has("old-1")).toBe(true)
    s.archived[0]!.write("v1.sealed")
    expect([...s.store.rows.keys()]).toEqual(["t-1"])
  })

  it("keeps a plain row whose saved output did not open, and the terminal beside it", async () => {
    const { history, store } = setup()
    store.rows.set("old-1", row({ transcript: "v1.sealed" }))
    const record = live()
    let beside: string | undefined
    const s = setup({ restoredHandle: () => beside })
    s.store.rows.set("old-1", row({ transcript: "v1.sealed" }))
    await restoring(s, record, { opened: false })
    beside = "moth"
    expect(s.store.rows.has("old-1")).toBe(true)
    // The terminal beside it is where a click goes, not another restore.
    expect((await s.history.list("p1"))[0]!.availability).toEqual({ state: "open", handle: "moth" })
    expect((await history.list("p1"))[0]!.availability).toEqual({ state: "ready" })
    // A row with no output has nothing to lose.
    store.rows.set("old-2", row({ id: "old-2" }))
    await restoring({ history, store } as Setup, live(), { opened: false, rowId: "old-2" })
    expect(store.rows.has("old-2")).toBe(false)
  })

  it("resumes an agent with the highest seq, in the session's own folder", async () => {
    const { history, store } = setup()
    store.rows.set(
      "old-1",
      row({
        agent: "codex",
        cwd: "/shell",
        lastProgram: "claude",
        agents: {
          claude: { sessionId: "claude-01", seq: 2 },
          codex: { sessionId: "codex-001", seq: 9, cwd: folder },
        },
      }),
    )
    const record = live()
    const { plan } = await restoring({ history, store } as Setup, record)
    expect(plan.resume).toBe("codex")
    expect(plan.saved.cwd).toBe(folder)
    expect(record.restoring).toMatchObject({ agent: "codex", session: "codex-001" })
  })
})

describe("confirming an agent's restore", () => {
  const begin = async (agent: AgentName = "claude", over: Parameters<typeof setup>[0] = {}) => {
    const s = setup(over)
    s.store.rows.set("old-1", agentRow(agent))
    const record = live({}, { id: "new-1" })
    await restoring(s, record)
    return { ...s, record }
  }

  it("removes the row when the session binds as claimed, and emits it", async () => {
    const { history, store, record } = await begin()
    const watching = await follow(history)
    expect(store.rows.has("old-1")).toBe(true)
    record.bound = bound("claude", "conv-0001")
    history.observe(record)
    expect(store.rows.size).toBe(0)
    expect(record.restoring).toBeUndefined()
    await vi.waitFor(() =>
      expect(watching.later).toContainEqual({ type: "removed", id: "old-1", projectId: "p1" }),
    )
    watching.stop()
  })

  it("takes Codex's ready prompt as the sign", async () => {
    const { history, store, record } = await begin("codex")
    history.observe(record)
    expect(store.rows.size).toBe(1)
    record.summary = { ...record.summary, ready: { since: 1 } } as never
    history.observe(record)
    expect(store.rows.size).toBe(0)
  })

  it("keeps the row, gives the claim back and says why when the prompt returns first", async () => {
    const { history, store, record, said, released } = await begin()
    conversationIs("gone")
    history.prompted(record)
    expect(store.rows.has("old-1")).toBe(true)
    expect(released).toEqual(["new-1"])
    await vi.waitFor(() => expect(said).toHaveLength(1))
    expect(said[0]).toMatch(/Claude Code was running here, but wasn't resumed/)
    expect((await history.list("p1"))[0]!.availability).toEqual({
      state: "gone",
      reason: "conversation",
    })
  })

  it("says the conversation didn't open when the files still hold it", async () => {
    const { history, record, said } = await begin()
    history.prompted(record)
    await vi.waitFor(() => expect(said[0]).toMatch(/conversation didn't open/))
  })

  it("treats a different id from Antigravity as a failure", async () => {
    const { history, store, record, released } = await begin("agy")
    record.bound = bound("agy", "another-conversation")
    history.observe(record)
    expect(store.rows.has("old-1")).toBe(true)
    expect(released).toEqual(["new-1"])
    expect(record.restoring).toBeUndefined()
  })

  it("treats typing that cancels the startup as a failure, without a note", async () => {
    const { history, store, record, said, released } = await begin()
    history.cancelled(record)
    expect(released).toEqual(["new-1"])
    expect(store.rows.has("old-1")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(said).toEqual([])
  })

  it("treats a shell that can't run the resume as a failure", async () => {
    const s = setup()
    s.store.rows.set("old-1", agentRow())
    const record = live()
    await restoring(s, record, { resumes: false })
    expect(s.released).toEqual(["t-1"])
    // The terminal's creation says why; the History does not say it twice.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(s.said).toEqual([])
  })

  it("stops showing the row as restoring after a wait, and keeps the restore pending", async () => {
    const { history, record, released } = await begin()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(record.restoring).toBeDefined()
    expect(released).toEqual([])
    expect((await history.list("p1"))[0]!.availability.state).toBe("ready")
  })

  it("still removes the row when the session binds after the wait", async () => {
    const { history, store, record } = await begin()
    await new Promise((resolve) => setTimeout(resolve, 100))
    record.bound = bound("claude", "conv-0001")
    history.observe(record)
    expect(store.rows.size).toBe(0)
    expect(record.restoring).toBeUndefined()
  })

  it("still gives the claim back when the prompt returns after the wait", async () => {
    const { history, store, record, released } = await begin()
    await new Promise((resolve) => setTimeout(resolve, 100))
    history.prompted(record)
    expect(released).toEqual(["new-1"])
    expect(store.rows.has("old-1")).toBe(true)
  })

  it("is settled by a close during the restore: worked if bound, else the row stays", async () => {
    const a = await begin()
    a.record.bound = bound("claude", "conv-0001")
    a.history.closing(a.record, null)
    expect(a.store.rows.has("old-1")).toBe(false)
    const b = await begin()
    b.history.closing(b.record, null)
    expect(b.store.rows.has("old-1")).toBe(true)
    expect(b.record.restoring).toBeUndefined()
  })
})

describe("the handle of a restored terminal", () => {
  const handleOf = async (
    closed: ClosedRecord,
    sessionId: string,
    over: Parameters<typeof setup>[0] = {},
  ) => {
    const s = setup(over)
    s.store.rows.set(closed.id, closed)
    let handle = ""
    await s.history.restore({ id: "new-1", sessionId, closed: closed.id }, (plan) => {
      handle = plan.identity(sessionId).handle
      return Promise.resolve(summary)
    })
    return handle
  }

  it("is kept in its own session when no terminal there has it", async () => {
    expect(await handleOf(row(), "s1")).toBe("moth")
  })

  it("is drawn anew where a terminal in the session has it", async () => {
    const terminalsIn = () => [{ handle: "moth", ledBy: null }]
    expect(await handleOf(row(), "s1", { terminalsIn })).toBe("fox")
  })

  it("is drawn anew where a terminal there is led under it, so no lead is regained by name", async () => {
    const terminalsIn = () => [{ handle: "owl", ledBy: "moth" }]
    expect(await handleOf(row(), "s1", { terminalsIn })).toBe("fox")
  })

  it("is recorded in another session unless that session gave it already", async () => {
    const s = setup()
    s.store.rows.set("old-1", row({ sessionId: "s9" }))
    let handle = ""
    await s.history.restore({ id: "new-1", sessionId: "s1", closed: "old-1" }, (plan) => {
      handle = plan.identity("s1").handle
      return Promise.resolve(summary)
    })
    expect(handle).toBe("moth")
    expect(s.store.given.has("s1/moth")).toBe(true)
    s.store.rows.set("old-2", row({ id: "old-2", sessionId: "s9" }))
    await s.history.restore({ id: "new-2", sessionId: "s1", closed: "old-2" }, (plan) => {
      handle = plan.identity("s1").handle
      return Promise.resolve(summary)
    })
    expect(handle).toBe("fox")
  })
})
