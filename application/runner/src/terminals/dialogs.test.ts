import type { AgentName } from "@novadeck/protocol"

import type { DialogAdapter, ScreenRequest } from "../harnesses/dialogs.js"
import { describe, expect, it } from "../test.js"
import { fakeAdapter, FakeTui } from "../testing/dialogs.js"
import { Dialogs, rawText, type Waiting } from "./dialogs.js"

const request = (ref: string, command: string): Waiting => ({
  ref,
  actor: null,
  facts: { kind: "permission", tool: "Bash", input: { command }, cwd: null },
  subject: command,
  screen: false,
  askedAt: 0,
})

/** A terminal whose agent waits on `requests`, its screen the fake TUI's. */
const terminal = (
  options: {
    adapter?: DialogAdapter | false
    requests?: Waiting[]
    raw?: { still: number; age: number }
  } = {},
) => {
  const tui = new FakeTui()
  const state = { requests: options.requests ?? [request("r1", "ls")] }
  const told: string[] = []
  const asked: ScreenRequest[] = []
  const cleared: string[] = []
  let adapter = options.adapter === false ? undefined : (options.adapter ?? fakeAdapter())
  const dialogs = new Dialogs(
    {
      pending: () => ({ agent: "claude" as AgentName, requests: state.requests }),
      adapter: () => adapter,
      screen: () => Promise.resolve(tui.screen()),
      ask: (_terminal, each) => {
        asked.push(each)
        state.requests = [
          ...state.requests,
          {
            ref: "screen",
            actor: null,
            facts: { ...each, cwd: null },
            subject: each.subject,
            screen: true,
            askedAt: Date.now(),
          },
        ]
        dialogs.changed("t")
      },
      clear: (_terminal, ref) => {
        cleared.push(ref)
        state.requests = state.requests.filter((each) => each.ref !== ref)
      },
      changed: () => told.push(JSON.stringify([...dialogs.view("t")])),
    },
    {
      throttleMs: 5,
      settleMs: 40,
      rawStillMs: options.raw?.still ?? 40,
      rawAgeMs: options.raw?.age ?? 40,
    },
  )
  return {
    tui,
    dialogs,
    state,
    told,
    asked,
    cleared,
    use: (next: DialogAdapter) => (adapter = next),
  }
}

const until = async (check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !check(); tries += 1)
    // eslint-disable-next-line no-await-in-loop -- Polled in turn.
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

describe("each request's dialog", () => {
  it("is what the adapter read as soon as it shows", async () => {
    const { dialogs } = terminal()
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    expect(dialogs.shown("t", "r1")).toMatchObject({ type: "choices", title: "ls" })
  })

  it("carries the fingerprint of what was read, and none is answerable where two requests read", async () => {
    const one = terminal()
    one.dialogs.changed("t")
    await until(() => one.dialogs.shown("t", "r1") !== null)
    expect(one.dialogs.shown("t", "r1")).toMatchObject({ type: "choices", id: expect.any(String) })

    // The same command from two places: one screen reads for both, so it is neither's.
    const other = { ...request("r2", "ls"), facts: { ...request("r2", "ls").facts, cwd: "/else" } }
    const two = terminal({ requests: [request("r1", "ls"), other] })
    two.dialogs.changed("t")
    await until(() => two.dialogs.shown("t", "r1") !== null)
    expect(two.dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
    expect(two.dialogs.shown("t", "r2")).toMatchObject({ type: "raw", reason: "unrecognized" })

    // A subagent asking the very same is not the root's twin: whose dialog it is can't be told.
    const sub = { ...request("r2", "ls"), actor: "subagent-1" }
    const agents = terminal({ requests: [request("r1", "ls"), sub] })
    agents.dialogs.changed("t")
    await until(() => agents.dialogs.shown("t", "r2") !== null)
    expect(agents.dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
    expect(agents.dialogs.shown("t", "r2")).toMatchObject({ type: "raw", reason: "unrecognized" })

    // Twins, asking the very same, show the one dialog on each: it is either's to answer.
    const twins = terminal({ requests: [request("r1", "ls"), request("r2", "ls")] })
    twins.dialogs.changed("t")
    await until(() => twins.dialogs.shown("t", "r2") !== null)
    expect(twins.dialogs.shown("t", "r1")).toMatchObject({ type: "choices" })
    expect(twins.dialogs.shown("t", "r2")).toEqual(twins.dialogs.shown("t", "r1"))
  })

  it("is raw, with the screen's text, once the screen is still and nothing reads", async () => {
    const { tui, dialogs } = terminal()
    tui.state = "other"
    dialogs.changed("t")
    // Not yet: the screen may still be drawing the dialog.
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(dialogs.shown("t", "r1")).toBeNull()
    await until(() => dialogs.shown("t", "r1") !== null)
    expect(dialogs.shown("t", "r1")).toEqual({
      type: "raw",
      text: "transcript 0\nFAKE ELSEWHERE\nnothing to answer here",
      reason: "unrecognized",
    })
  })

  it("is not raw while a harness has yet to draw its dialog: the request is new, the screen showing only work", async () => {
    // The harness runs its hooks first: a fresh request, a screen with nothing to read.
    const fresh = { ...request("r1", "ls"), askedAt: Date.now() }
    const { tui, dialogs } = terminal({ requests: [fresh], raw: { still: 40, age: 400 } })
    tui.state = "other"
    dialogs.changed("t")
    // Still for longer than the screen need be, but the request is too new to say.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(dialogs.shown("t", "r1")).toBeNull()
    // The dialog is drawn: it reads, and never showed raw.
    tui.state = "ask"
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    expect(dialogs.shown("t", "r1")).toMatchObject({ type: "choices" })
  })

  it("turns raw once the request is old enough and the screen long still, with no dialog read", async () => {
    const fresh = { ...request("r1", "ls"), askedAt: Date.now() }
    const { tui, dialogs } = terminal({ requests: [fresh], raw: { still: 40, age: 150 } })
    tui.state = "other"
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    expect(dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
  })

  it("keeps a request raw for good from letting another's twin-looking dialog be answered", async () => {
    // A subagent's request, locked failed with its dialog still up, and the root's, the same.
    const sub = { ...request("r2", "ls"), actor: "subagent-1" }
    const { dialogs } = terminal({ requests: [request("r1", "ls"), sub] })
    dialogs.lock("t", "r2", "failed", ["screen"])
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    expect(dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
    expect(dialogs.shown("t", "r2")).toMatchObject({ type: "raw", reason: "failed" })
  })

  it("cuts what an adapter reads to the protocol's limits, and refuses what it can't cut", async () => {
    const base = fakeAdapter()
    const oversized = (id: string, detail: string): DialogAdapter => ({
      read: (rows, facts) => {
        const read = base.read(rows, facts)
        if (!read || read.dialog.type !== "choices") return read
        return {
          ...read,
          dialog: {
            ...read.dialog,
            detail,
            options: [{ id, label: "Yes", text: null }],
          },
        }
      },
    })
    // A heredoc's worth of detail is never approved from a cut view: it shows raw.
    const long = terminal({ adapter: oversized("1", "x".repeat(10_000)) })
    long.dialogs.changed("t")
    await until(() => long.dialogs.shown("t", "r1") !== null)
    expect(long.dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
    // An id past the limit can't be cut: the dialog reads as nothing, and so shows raw.
    const wide = terminal({ adapter: oversized("i".repeat(200), "ok") })
    wide.dialogs.changed("t")
    await until(() => wide.dialogs.shown("t", "r1") !== null)
    expect(wide.dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
  })

  it("is raw and unsupported where the harness has no adapter", async () => {
    const { dialogs } = terminal({ adapter: false })
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    expect(dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unsupported" })
  })

  it("stays null for a request whose dialog another request's is hiding", async () => {
    const { dialogs, state } = terminal({ requests: [request("r1", "ls"), request("r2", "pwd")] })
    expect(state.requests).toHaveLength(2)
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(dialogs.shown("t", "r2")).toBeNull()
  })

  it("turns raw for good once locked, and is kept once answered", async () => {
    const { tui, dialogs } = terminal()
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    const shown = dialogs.shown("t", "r1")
    dialogs.done("t", "r1")
    tui.state = "gone"
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(dialogs.shown("t", "r1")).toEqual(shown)
    expect(dialogs.closed("t", "r1")).toBe(true)
    dialogs.lock("t", "r1", "failed", ["the screen"])
    expect(dialogs.shown("t", "r1")).toEqual({ type: "raw", text: "the screen", reason: "failed" })
  })

  it("tells its readers only of a real change", async () => {
    const { tui, dialogs, told } = terminal()
    dialogs.changed("t")
    await until(() => told.length === 1)
    // Redrawing around the dialog changes nothing it offers.
    for (let tick = 1; tick <= 5; tick += 1) {
      tui.noise = tick
      dialogs.changed("t")
      // eslint-disable-next-line no-await-in-loop -- Each redraw is given its time.
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(told).toHaveLength(1)
  })

  it("tells of a request answered, and tells its readers", async () => {
    const { dialogs, told } = terminal()
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    const before = told.length
    expect(dialogs.answered("t").has("r1")).toBe(false)
    dialogs.done("t", "r1")
    expect(dialogs.answered("t").has("r1")).toBe(true)
    expect(told.length).toBe(before + 1)
  })

  it("is not looked at while an answer goes on", async () => {
    const { tui, dialogs } = terminal()
    dialogs.begin("t")
    tui.state = "other"
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(dialogs.shown("t", "r1")).toBeNull()
    dialogs.end("t")
    await until(() => dialogs.shown("t", "r1") !== null)
  })
})

describe("requests only the screen tells", () => {
  const prompt: ScreenRequest = { kind: "plan", tool: "plan", input: null, subject: "A plan" }

  it("are asked while the screen shows them, once, and cleared once it is still without them", async () => {
    const shows = { on: false }
    const { tui, dialogs, asked, cleared, use, state } = terminal({ requests: [] })
    use({
      ...fakeAdapter(),
      screenRequest: (rows) => (shows.on && rows.includes("PLAN") ? prompt : undefined),
    })
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(asked).toEqual([])
    shows.on = true
    tui.state = "other"
    const rows = tui.rows
    tui.rows = () => [...rows.call(tui), "PLAN"]
    dialogs.changed("t")
    await until(() => asked.length === 1)
    // It shows on: no second request, however often the screen is looked at.
    tui.noise = 1
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toHaveLength(1)
    expect(cleared).toEqual([])
    // It goes once the screen has been still without it.
    shows.on = false
    tui.noise = 2
    dialogs.changed("t")
    await until(() => cleared.length === 1)
    expect(state.requests).toEqual([])
  })
})

describe("the raw text of a screen", () => {
  it("is its rows without trailing blanks, long blank runs shortened, and fits 4 KiB from the bottom", () => {
    expect(rawText(["a  ", "", "", "", "b", "", ""])).toBe("a\n\nb")
    expect(rawText(["", "", "a"])).toBe("a")
    const rows = Array.from({ length: 100 }, (_, index) => `row ${index}`.padEnd(100, "."))
    const text = rawText(rows)
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(text.endsWith(rows[99]!)).toBe(true)
    expect(text.startsWith(rows[0]!)).toBe(false)
  })
})
