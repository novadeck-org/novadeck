import type { ScreenText } from "@novadeck/emulator/headless"
import { dialogs as codexDialogs } from "@novadeck/harness-codex/dialogs"
import type { DialogAdapter, ScreenRequest } from "@novadeck/harness-core/dialogs"
import type { ActivityEvent } from "@novadeck/harness-core/events"
import { fakeAdapter, FakeTui } from "@novadeck/harness-core/testing/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import {
  dialogTextLimits,
  maxRawDialogText,
  requestDialog,
  type AgentName,
} from "@novadeck/protocol"

import { apply, started as startedActivity, type Activity } from "../harnesses/activity.js"
import type { Binding } from "../harnesses/bindings.js"
import { logs, useLogger } from "../log.js"
import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { Dialogs, identified, rawText, type Waiting } from "./dialogs.js"
import { SeenTerminals } from "./seen.js"

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
    raw?: { still: number; age: number; latest?: number }
    seen?: SeenTerminals
    /** Other work holds the terminal's input while it says so. */
    busy?: () => boolean
    /** How long a terminal must be unseen before a reveal, 0 by default. */
    grace?: number
    /** What pressing keys does to the screen, as the TUI's own would. */
    press?: (data: string, tui: FakeTui) => void
  } = {},
) => {
  const tui = new FakeTui()
  const state = { requests: options.requests ?? [request("r1", "ls")] }
  const told: string[] = []
  const asked: ScreenRequest[] = []
  const cleared: string[] = []
  const pressed: string[] = []
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
      busy: () => options.busy?.() ?? false,
      press: (_terminal, data) => {
        pressed.push(data)
        options.press?.(data, tui)
        dialogs.changed("t")
        return true
      },
    },
    {
      throttleMs: 5,
      settleMs: 40,
      rawStillMs: options.raw?.still ?? 40,
      rawAgeMs: options.raw?.age ?? 40,
      rawLatestMs: options.raw?.latest ?? Number.POSITIVE_INFINITY,
      ...(options.seen && { seen: options.seen }),
      graceMs: options.grace ?? 0,
    },
  )
  return {
    tui,
    dialogs,
    state,
    told,
    asked,
    cleared,
    pressed,
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

  it("is answerable for each request whose dialog takes a prompt, though one screen reads for several", async () => {
    // A request asked from elsewhere reads the same screen, as a dialog answered as a prompt.
    const prompting = (cwd: string | null): DialogAdapter => ({
      read: (rows, facts) => {
        const read = fakeAdapter().read(rows, facts)
        return read && (facts.cwd === cwd ? read : { ...read, prompt: () => "> Which?\n\nYes" })
      },
    })
    const other = { ...request("r2", "ls"), facts: { ...request("r2", "ls").facts, cwd: "/else" } }
    const both = terminal({ requests: [request("r1", "ls"), other], adapter: prompting("none") })
    both.dialogs.changed("t")
    await until(() => both.dialogs.shown("t", "r2") !== null)
    expect(both.dialogs.shown("t", "r1")).toMatchObject({ type: "choices" })
    expect(both.dialogs.shown("t", "r2")).toMatchObject({ type: "choices" })

    // Beside a dialog answered by keys, it can't be told from that one: it is raw.
    const mixed = terminal({ requests: [request("r1", "ls"), other], adapter: prompting(null) })
    mixed.dialogs.changed("t")
    await until(() => mixed.dialogs.shown("t", "r2") !== null)
    expect(mixed.dialogs.shown("t", "r1")).toMatchObject({ type: "choices" })
    expect(mixed.dialogs.shown("t", "r2")).toMatchObject({ type: "raw", reason: "unrecognized" })
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

  it("turns raw on a screen that never rests, once the request has waited long enough", async () => {
    // As Claude Code's countdown to blocking a request redraws its dialog every second.
    const fresh = { ...request("r1", "ls"), askedAt: Date.now() }
    const { tui, dialogs } = terminal({
      requests: [fresh],
      raw: { still: 10_000, age: 40, latest: 240 },
    })
    tui.state = "other"
    const ticking = setInterval(() => {
      tui.noise += 1
      dialogs.changed("t")
    }, 10)
    try {
      dialogs.changed("t")
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(dialogs.shown("t", "r1")).toBeNull()
      await until(() => dialogs.shown("t", "r1") !== null)
      expect(dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
      // The dialog read after all: it takes the raw's place.
      tui.state = "ask"
      await until(() => dialogs.shown("t", "r1")?.type === "choices")
    } finally {
      clearInterval(ticking)
    }
  })

  it("stays read through a frame of a moving screen, however long the request has waited", async () => {
    const old = { ...request("r1", "ls"), askedAt: Date.now() - 30_000 }
    const { tui, dialogs } = terminal({
      requests: [old],
      raw: { still: 10_000, age: 40, latest: 200 },
    })
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1")?.type === "choices")
    tui.state = "other"
    tui.noise += 1
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(dialogs.shown("t", "r1")).toMatchObject({ type: "choices" })
    tui.state = "ask"
    dialogs.changed("t")
  })

  it("gives a new request its own wait, however long the screen has gone unread", async () => {
    const { tui, dialogs, state } = terminal({ raw: { still: 10_000, age: 10, latest: 200 } })
    tui.state = "other"
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    state.requests = [...state.requests, { ...request("r2", "pwd"), askedAt: Date.now() }]
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(dialogs.shown("t", "r2")).toBeNull()
    await until(() => dialogs.shown("t", "r2") !== null)
  })

  it("follows a screen that never rests only now and then", async () => {
    const { tui, dialogs } = terminal({ raw: { still: 10_000, age: 40, latest: 80 } })
    tui.state = "other"
    const ticking = setInterval(() => {
      tui.noise += 1
      dialogs.changed("t")
    }, 15)
    try {
      dialogs.changed("t")
      await until(() => dialogs.shown("t", "r1") !== null)
      const first = JSON.stringify(dialogs.shown("t", "r1"))
      await until(() => JSON.stringify(dialogs.shown("t", "r1")) !== first)
    } finally {
      clearInterval(ticking)
    }
  })

  it("keeps raw text steady while the screen moves, and takes the new text once it rests", async () => {
    const { tui, dialogs, told } = terminal({ raw: { still: 80, age: 40, latest: 60_000 } })
    tui.state = "other"
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    const shown = told.length
    const ticking = setInterval(() => {
      tui.noise += 1
      dialogs.changed("t")
    }, 15)
    await new Promise((resolve) => setTimeout(resolve, 120))
    clearInterval(ticking)
    expect(told.length).toBe(shown)
    const last = tui.noise
    await until(() => JSON.stringify(dialogs.shown("t", "r1")).includes(`transcript ${last}`))
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
    const long = terminal({ adapter: oversized("1", "x".repeat(dialogTextLimits.detail + 1)) })
    long.dialogs.changed("t")
    await until(() => long.dialogs.shown("t", "r1") !== null)
    expect(long.dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
    // An id past the limit can't be cut: the dialog reads as nothing, and so shows raw.
    const wide = terminal({ adapter: oversized("i".repeat(200), "ok") })
    wide.dialogs.changed("t")
    await until(() => wide.dialogs.shown("t", "r1") !== null)
    expect(wide.dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
  })

  it("cuts a display string at the limit without leaving half an emoji", async () => {
    const base = fakeAdapter()
    const labelled: DialogAdapter = {
      read: (rows, facts) => {
        const read = base.read(rows, facts)
        if (!read || read.dialog.type !== "choices") return read
        // The limit (512) falls inside the emoji.
        const label = `${"x".repeat(511)}😀tail`
        return { ...read, dialog: { ...read.dialog, options: [{ id: "1", label, text: null }] } }
      },
    }
    const { dialogs } = terminal({ adapter: labelled })
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    expect(dialogs.shown("t", "r1")).toMatchObject({
      type: "choices",
      options: [{ label: "x".repeat(511) }],
    })
  })

  it("is raw, with the screen's text, where its adapter throws on the screen", async ({
    resources,
  }) => {
    const failed: unknown[] = []
    const before = logs.current()
    const note = (evt: string, _message?: string, detail?: unknown) =>
      void (evt === "dialogs.read-failed" && failed.push(detail))
    useLogger({
      for: () => ({ debug: note, info: note, warn: note, error: note, fatal: note }),
      flush: () => {},
      close: () => {},
    })
    resources.defer(() => useLogger(before))
    const adapter: DialogAdapter = {
      read: () => {
        throw new Error("a layout it never saw")
      },
      screenRequest: () => {
        throw new Error("a layout it never saw")
      },
    }
    const { dialogs } = terminal({ adapter })
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    expect(dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
    // It throws again on each redraw, which the log tells only once while it waits.
    const redraw = async () => {
      dialogs.changed("t")
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    await redraw()
    await redraw()
    await redraw()
    // Its class alone: an adapter's message may quote the screen.
    expect(failed).toEqual([{ data: { error: "Error" } }])
    expect(JSON.stringify(failed)).not.toContain("a layout it never saw")
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

describe("an MCP server's form in Codex, which only its screen tells", () => {
  type Form = { readonly screens: Record<string, ScreenText>; readonly after: ScreenText }
  const { forms } = loadProbe<{ forms: Record<string, Form> }>(
    adapterFolder("codex"),
    "elicitation.probe.json",
  )

  it("waits on the person while the form shows, raw to answer in the terminal, and goes with it", async () => {
    const { tui, dialogs, asked, cleared, use, state } = terminal({ requests: [] })
    use(codexDialogs)
    const form = forms.enum!
    tui.rows = () => [...form.screens["120x40"]!.rows]
    dialogs.changed("t")
    await until(() => asked.length === 1)
    expect(asked[0]).toMatchObject({
      kind: "question",
      tool: "mcp__probe__elicitation",
      subject: "Which colour do you want?",
    })
    await until(() => dialogs.shown("t", "screen") !== null)
    expect(dialogs.shown("t", "screen")).toMatchObject({ type: "raw" })
    // Answered in the terminal, the call's result takes its place: the request goes.
    tui.rows = () => [...form.after.rows]
    dialogs.changed("t")
    await until(() => cleared.length === 1)
    expect(state.requests).toEqual([])
    expect(asked).toHaveLength(1)
  })
})

describe("requests only the screen tells, where the adapter throws on a later screen", () => {
  const prompt: ScreenRequest = { kind: "plan", tool: "plan", input: null, subject: "A plan" }

  it("keep what they raised: a screen it can't read says nothing of it", async () => {
    const reads = { throws: false }
    const { tui, dialogs, asked, cleared, use, state } = terminal({ requests: [] })
    use({
      ...fakeAdapter(),
      screenRequest: () => {
        if (reads.throws) throw new Error("a layout it never saw")
        return prompt
      },
    })
    dialogs.changed("t")
    await until(() => asked.length === 1)
    reads.throws = true
    tui.noise = 1
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(cleared).toEqual([])
    expect(state.requests.map((each) => each.ref)).toEqual(["screen"])
  })
})

describe("requests only the screen tells, held out of sight by a view of their harness's own", () => {
  const prompt: ScreenRequest = { kind: "plan", tool: "plan", input: null, subject: "A plan" }
  // A view over the prompt, as Codex's `/diff` pager is: closing it shows the prompt again.
  const viewing = (): DialogAdapter => ({
    ...fakeAdapter(),
    screenRequest: (rows) => (rows.includes("PLAN") ? prompt : undefined),
    reveal: (rows) => (rows.includes("PAGER") ? "q" : undefined),
  })
  const showing = (tui: FakeTui, row: string) => {
    tui.state = "other"
    const rows = FakeTui.prototype.rows
    tui.rows = function (this: FakeTui) {
      return [...rows.call(this), row]
    }
  }

  it("keep their ref while the view hides them, and go once nothing shows or hides them", async () => {
    // A terminal in sight, so nothing is revealed by itself: only the request's life is tested.
    const seen = new SeenTerminals()
    seen.report("window", ["t"])
    const { tui, dialogs, asked, cleared, state, use } = terminal({ requests: [], seen })
    use(viewing())
    showing(tui, "PLAN")
    dialogs.changed("t")
    await until(() => asked.length === 1)
    // The view opens over it, long enough for a still screen: hidden, not gone.
    showing(tui, "PAGER")
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(cleared).toEqual([])
    // It closes, and the prompt shows again: the same request, not a second.
    showing(tui, "PLAN")
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(asked).toHaveLength(1)
    expect(cleared).toEqual([])
    // Answered in the terminal, nothing in its place: it goes once the screen is still.
    showing(tui, "DONE")
    dialogs.changed("t")
    await until(() => cleared.length === 1)
    expect(state.requests).toEqual([])
  })

  it("keep Codex's MCP form through its /diff pager, as probed", async () => {
    const { forms } = loadProbe<{
      forms: Record<string, { screens: Record<string, ScreenText>; after: ScreenText }>
    }>(adapterFolder("codex"), "elicitation.probe.json")
    const { states } = loadProbe<{ states: Record<string, ScreenText> }>(
      adapterFolder("codex"),
      "hidden-dialog.probe.json",
    )
    const seen = new SeenTerminals()
    seen.report("window", ["t"])
    const { tui, dialogs, asked, cleared, use } = terminal({ requests: [], seen })
    use(codexDialogs)
    const form = forms.enum!
    tui.rows = () => [...form.screens["120x40"]!.rows]
    dialogs.changed("t")
    await until(() => asked.length === 1)
    // The pager over it (0.170.0's, as it holds a dialog out of view).
    tui.rows = () => [...states.permissionHeld!.rows]
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(cleared).toEqual([])
    tui.rows = () => [...form.screens["120x40"]!.rows]
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(asked).toHaveLength(1)
    expect(cleared).toEqual([])
  })
})

describe("a request only the screen tells, through the root's turns", () => {
  const binding: Binding = { agent: "codex", sessionId: "s", instance: "7" }
  const base = { agent: "codex", sessionId: "s", instance: "7" } as const
  const prompt: ScreenRequest = { kind: "plan", tool: "plan", input: null, subject: "A plan" }

  it("outlives the root's turn's end, and goes once the screen is still without it", async () => {
    // The dialogs over the activity the runner keeps: what they raise and clear is applied to
    // it, as the terminals' typing does (`dialogsHost`), and the root's turn ends in it.
    let activity: Activity = apply(startedActivity(0), binding, {
      ...base,
      type: "turn-started",
      startedAt: 1,
      cause: "prompt",
    } as ActivityEvent)!
    const step = (event: ActivityEvent) => (activity = apply(activity, binding, event) ?? activity)
    const tui = new FakeTui()
    const shows = { on: true }
    tui.state = "other"
    const rows = FakeTui.prototype.rows
    tui.rows = function (this: FakeTui) {
      return [...rows.call(this), ...(shows.on ? ["PLAN"] : [])]
    }
    const asked: string[] = []
    const dialogs = new Dialogs(
      {
        pending: () => ({
          agent: "codex" as AgentName,
          requests: activity.pending.map((each): Waiting => ({
            ref: each.requestId,
            actor: each.actor,
            facts: { kind: each.kind, tool: each.toolName, input: null, cwd: null },
            subject: each.subject,
            screen: each.screen === true,
            askedAt: each.askedAt,
          })),
        }),
        adapter: () => ({
          ...fakeAdapter(),
          screenRequest: (screen) => (screen.includes("PLAN") ? prompt : undefined),
        }),
        screen: () => Promise.resolve(tui.screen()),
        ask: (_terminal, each) => {
          const requestId = `screen:${each.tool}:${asked.length}`
          asked.push(requestId)
          step({
            ...base,
            type: "attention-requested",
            startedAt: Date.now(),
            requestId,
            actor: null,
            toolName: each.tool,
            kind: each.kind,
            subject: each.subject,
            choices: [],
            screen: true,
          } as ActivityEvent)
          dialogs.changed("t")
        },
        clear: (_terminal, ref) =>
          step({
            ...base,
            type: "attention-resolved",
            startedAt: Date.now(),
            requestId: ref,
            actor: null,
            toolName: "plan",
            loose: false,
            outcome: "allowed",
          } as ActivityEvent),
        changed: () => {},
        busy: () => false,
        press: () => true,
      },
      { throttleMs: 5, settleMs: 40, rawStillMs: 40, rawAgeMs: 40, graceMs: 0 },
    )
    dialogs.changed("t")
    await until(() => asked.length === 1)
    // The root's turn ends under it: the request stands, and no second is raised.
    step({
      ...base,
      type: "turn-ended",
      outcome: "completed",
      startedAt: Date.now(),
    } as ActivityEvent)
    expect(activity.pending.map(({ requestId }) => requestId)).toEqual(asked)
    tui.noise = 1
    dialogs.changed("t")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(asked).toHaveLength(1)
    expect(activity.pending).toHaveLength(1)
    // The screen without it, and still: it goes.
    shows.on = false
    tui.noise = 2
    dialogs.changed("t")
    await until(() => activity.pending.length === 0)
    expect(asked).toHaveLength(1)
  })
})

describe("the raw text of a screen", () => {
  it("is its rows without trailing blanks, long blank runs shortened, and fits the protocol's limit from the bottom", () => {
    expect(rawText(["a  ", "", "", "", "b", "", ""])).toBe("a\n\nb")
    expect(rawText(["", "", "a"])).toBe("a")
    const rows = Array.from({ length: 100 }, (_, index) => `row ${index}`.padEnd(100, "."))
    const text = rawText(rows)
    expect(text.length).toBeLessThanOrEqual(maxRawDialogText)
    expect(text.endsWith(rows[99]!)).toBe(true)
    expect(text.startsWith(rows[0]!)).toBe(false)
    // A row too long on its own is cut to the limit, and the raw dialog parses.
    const wide = rawText(["x".repeat(maxRawDialogText * 2)])
    expect(wide).toHaveLength(maxRawDialogText)
    expect(
      requestDialog.safeParse({ type: "raw", text: wide, reason: "unrecognized" }).success,
    ).toBe(true)
  })
})

describe("the dialog as the protocol shows it", () => {
  // Past every display limit, so each string comes back cut to exactly its own.
  const over = (field: keyof typeof dialogTextLimits) => "x".repeat(dialogTextLimits[field] + 100)

  it("cuts each display string of a questions dialog to the protocol's limit for it", () => {
    const shown = identified({
      type: "questions",
      chat: null,
      questions: [
        {
          id: "q",
          header: over("header"),
          question: over("question"),
          options: [{ id: "o", label: over("label"), description: over("description") }],
          multiSelect: false,
          text: false,
        },
      ],
    })
    expect(requestDialog.safeParse(shown).success).toBe(true)
    if (shown?.type !== "questions") throw new Error("not a questions dialog")
    const [question] = shown.questions
    expect(question!.header).toHaveLength(dialogTextLimits.header)
    expect(question!.question).toHaveLength(dialogTextLimits.question)
    expect(question!.options[0]!.label).toHaveLength(dialogTextLimits.label)
    expect(question!.options[0]!.description).toHaveLength(dialogTextLimits.description)
  })

  it("cuts a form's message, fields and choices, and a choices dialog's title and labels", () => {
    const form = identified({
      type: "form",
      message: over("message"),
      fields: [
        {
          id: "f",
          label: over("label"),
          description: over("description"),
          kind: "choice",
          choices: [over("label")],
          required: true,
        },
      ],
    })
    expect(requestDialog.safeParse(form).success).toBe(true)
    if (form?.type !== "form") throw new Error("not a form")
    expect(form.message).toHaveLength(dialogTextLimits.message)
    expect(form.fields[0]!.label).toHaveLength(dialogTextLimits.label)
    expect(form.fields[0]!.description).toHaveLength(dialogTextLimits.description)
    expect(form.fields[0]!.choices[0]).toHaveLength(dialogTextLimits.label)

    const choices = identified({
      type: "choices",
      title: over("title"),
      detail: "x".repeat(dialogTextLimits.detail),
      options: [{ id: "1", label: over("label"), text: null }],
    })
    expect(requestDialog.safeParse(choices).success).toBe(true)
    if (choices?.type !== "choices") throw new Error("not a choices dialog")
    expect(choices.title).toHaveLength(dialogTextLimits.title)
    expect(choices.detail).toHaveLength(dialogTextLimits.detail)
    expect(choices.options[0]!.label).toHaveLength(dialogTextLimits.label)
  })
})

describe("a dialog held out of view", () => {
  const REVEAL = "<reveal>"
  // The fake TUI's elsewhere screen stands for a dialog drawn below the view; the keys bring it up.
  const holding = (): DialogAdapter => ({
    ...fakeAdapter(),
    reveal: (rows) => (rows.includes("FAKE ELSEWHERE") ? REVEAL : undefined),
  })
  const scrolls = (data: string, tui: FakeTui) => {
    if (data === REVEAL) tui.state = "ask"
  }
  const held = (options: Parameters<typeof terminal>[0] = {}) => {
    const made = terminal({ adapter: holding(), press: scrolls, ...options })
    made.tui.state = "other"
    return made
  }
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

  it("is scrolled into view for an unseen terminal, and then reads", async () => {
    const { tui, dialogs, pressed } = held({ seen: new SeenTerminals() })
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1")?.type === "choices")
    expect(pressed).toEqual([REVEAL])
    expect(tui.state).toBe("ask")
  })

  it("is scrolled into view where no client says anything of the terminal", async () => {
    const { dialogs, pressed } = held()
    dialogs.changed("t")
    await until(() => pressed.length > 0)
    expect(pressed).toEqual([REVEAL])
  })

  it("waits for the screen to be still before pressing", async () => {
    const { tui, dialogs, pressed } = held()
    const ticking = setInterval(() => {
      tui.noise += 1
      dialogs.changed("t")
    }, 10)
    try {
      dialogs.changed("t")
      await settle(120)
      expect(pressed).toEqual([])
    } finally {
      clearInterval(ticking)
    }
    await until(() => pressed.length > 0)
  })

  it("is never scrolled for a terminal a client has in sight", async () => {
    const seen = new SeenTerminals()
    seen.report("window", ["t"])
    const { dialogs, pressed } = held({ seen })
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    await settle()
    expect(pressed).toEqual([])
    expect(dialogs.shown("t", "r1")).toMatchObject({ type: "raw", reason: "unrecognized" })
  })

  it("is scrolled once the terminal turns unseen, as the window closes", async () => {
    const seen = new SeenTerminals()
    seen.report("window", ["t"])
    const { dialogs, pressed } = held({ seen })
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    seen.release("window")
    await until(() => pressed.length > 0)
    await until(() => dialogs.shown("t", "r1")?.type === "choices")
  })

  it("is pressed for once for a screen that stays held", async () => {
    // Keys that scroll nothing, so the same screen stays.
    const { dialogs, pressed } = held({ press: () => {} })
    dialogs.changed("t")
    await until(() => pressed.length > 0)
    for (let round = 0; round < 3; round += 1) {
      dialogs.changed("t")
      // eslint-disable-next-line no-await-in-loop -- Each round is let to look.
      await settle()
    }
    expect(pressed).toEqual([REVEAL])
  })

  it("is pressed for again once the terminal was seen and unseen again", async () => {
    const seen = new SeenTerminals()
    const { dialogs, pressed } = held({ seen, press: () => {} })
    dialogs.changed("t")
    await until(() => pressed.length === 1)
    seen.report("window", ["t"])
    await settle()
    seen.report("window", [])
    await until(() => pressed.length === 2)
  })

  it("is pressed for again after the screen changed", async () => {
    const { tui, dialogs, pressed } = held({ press: () => {} })
    dialogs.changed("t")
    await until(() => pressed.length === 1)
    tui.noise += 1
    dialogs.changed("t")
    await until(() => pressed.length === 2)
  })

  it("is not pressed for by a harness that holds none out of view", async () => {
    const { tui, dialogs, pressed } = terminal({ press: scrolls })
    tui.state = "other"
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    await settle()
    expect(pressed).toEqual([])
  })

  it("is left alone while an answer goes on", async () => {
    const { dialogs, pressed } = held()
    dialogs.begin("t")
    dialogs.changed("t")
    await settle()
    expect(pressed).toEqual([])
    dialogs.end("t")
    await until(() => pressed.length > 0)
  })
})

describe("a dialog read from the facts while held out of view", () => {
  // The fake TUI's elsewhere screen stands for the pill: the read comes from the facts alone.
  const pill = (): DialogAdapter => {
    const plain = fakeAdapter()
    return {
      read: (rows, facts) => {
        if (!rows.includes("FAKE ELSEWHERE")) return plain.read(rows, facts)
        const read = plain.read(new FakeTui().rows(), facts)
        return read && { ...read, reveal: "R", keys: () => undefined }
      },
      reveal: (rows) => (rows.includes("FAKE ELSEWHERE") ? "R" : undefined),
    }
  }

  it("shows for the terminal's only request, with an id of its own", async () => {
    const seen = new SeenTerminals()
    seen.report("window", ["t"])
    const only = terminal({ adapter: pill(), seen })
    only.tui.state = "other"
    only.dialogs.changed("t")
    await until(() => only.dialogs.shown("t", "r1") !== null)
    expect(only.pressed).toEqual([])
    const held = only.dialogs.shown("t", "r1")
    expect(held).toMatchObject({ type: "choices", title: "ls" })
    // The same dialog once in view is another card.
    const plain = terminal({ adapter: pill(), seen })
    plain.dialogs.changed("t")
    await until(() => plain.dialogs.shown("t", "r1") !== null)
    expect(plain.dialogs.shown("t", "r1")).toMatchObject({ type: "choices" })
    expect(plain.dialogs.shown("t", "r1")).not.toEqual(held)
    expect((plain.dialogs.shown("t", "r1") as { id: string }).id).not.toBe(
      (held as { id: string }).id,
    )
  })

  it("counts for none where another request waits too, which is revealed for an unseen terminal", async () => {
    const other = { ...request("r2", "ls"), facts: { ...request("r2", "ls").facts, cwd: "/else" } }
    const two = terminal({
      adapter: pill(),
      requests: [request("r1", "ls"), other],
      press: (data, tui) => {
        if (data === "R") tui.state = "ask"
      },
    })
    two.tui.state = "other"
    two.dialogs.changed("t")
    await until(() => two.pressed.length > 0)
    expect(two.pressed).toEqual(["R"])
    expect(two.dialogs.shown("t", "r1")).not.toMatchObject({ type: "choices" })
  })
})

describe("a dialog held out of view, for a terminal unseen only a moment", () => {
  const REVEAL = "<reveal>"
  const holding = (): DialogAdapter => ({
    ...fakeAdapter(),
    reveal: (rows) => (rows.includes("FAKE ELSEWHERE") ? REVEAL : undefined),
  })
  const scrolls = (data: string, tui: FakeTui) => {
    if (data === REVEAL) tui.state = "ask"
  }
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const held = (options: Parameters<typeof terminal>[0] = {}) => {
    const made = terminal({ adapter: holding(), press: scrolls, ...options })
    made.tui.state = "other"
    return made
  }

  it("waits out the grace period from the runner's start", async () => {
    const seen = new SeenTerminals()
    const { dialogs, pressed } = held({ seen, grace: 300 })
    const started = Date.now()
    dialogs.changed("t")
    await settle(150)
    expect(pressed).toEqual([])
    await until(() => pressed.length > 0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
  })

  it("counts the grace from the connection's release, as a window that reloads", async () => {
    const seen = new SeenTerminals()
    seen.report("window", ["t"])
    const { dialogs, pressed } = held({ seen, grace: 300 })
    dialogs.changed("t")
    await settle(350)
    seen.release("window")
    await settle(150)
    expect(pressed).toEqual([])
    await until(() => pressed.length > 0)
  })

  it("is not pressed for while another entry holds the terminal's input", async () => {
    let busy = true
    const { dialogs, pressed } = held({ busy: () => busy })
    dialogs.changed("t")
    await settle(200)
    expect(pressed).toEqual([])
    busy = false
    await until(() => pressed.length > 0)
  })

  it("counts the only request that waits, not one answered already", async () => {
    const other = { ...request("r2", "ls"), facts: { ...request("r2", "ls").facts, cwd: "/else" } }
    const { dialogs } = held({
      adapter: {
        read: (rows, facts) => {
          const read = fakeAdapter().read(new FakeTui().rows(), facts)
          return rows.includes("FAKE ELSEWHERE") && read
            ? { ...read, reveal: REVEAL, keys: () => undefined }
            : fakeAdapter().read(rows, facts)
        },
      },
      requests: [request("r1", "ls"), other],
      seen: (() => {
        const seen = new SeenTerminals()
        seen.report("window", ["t"])
        return seen
      })(),
    })
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1") !== null)
    // Two requests wait: neither reads from the pill.
    expect(dialogs.shown("t", "r1")).not.toMatchObject({ type: "choices" })
    dialogs.done("t", "r2")
    dialogs.changed("t")
    await until(() => dialogs.shown("t", "r1")?.type === "choices")
  })
})
