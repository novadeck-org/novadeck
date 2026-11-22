import { createDemoInbox } from "@novadeck/demo/inbox"
import {
  demoHiddenCommand,
  demoLongCommand,
  demoInboxIds,
  demoPlanStates,
} from "@novadeck/demo/inbox/fixtures"
import { demoSeed } from "@novadeck/demo/samples"
import { vi } from "vitest"

import { inboxGroups } from "./inbox"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

// The sample projects the Inbox's entries are about.
const seed = demoSeed(0, true)

const run = (inbox: ReturnType<typeof createDemoInbox>, label: string, notes: string[] = []) => {
  const [group] = inboxGroups(inbox, seed)
  const context: DemoActionContext = {
    target: "selected",
    harness: "claude",
    selected: () => undefined,
    select: () => {},
    addTerminal: () => {
      throw new Error("unused")
    },
    addInBackground: () => {
      throw new Error("unused")
    },
    startFresh: () => undefined,
    dispatch: undefined,
    workspace: () => undefined,
    note: (text) => notes.push(text),
    crash: () => {},
    failViewLoads: () => {},
  }
  void group!.actions.find((action) => action.label === label)!.run(context)
}

describe("the debug panel's Inbox group", () => {
  it("is absent where the demo has no Inbox", () => {
    expect(inboxGroups(undefined, seed)).toEqual([])
  })

  it("is absent where the workspace has none of the sample projects, as the content showcase", () => {
    expect(inboxGroups(createDemoInbox(1, []), { ...seed, projects: [] })).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = inboxGroups(createDemoInbox(1, []), seed)
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("adds one entry of a kind, waiting from now", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Stuck agent")
    const [added] = inbox.state.getSnapshot().items
    expect(added?.kind).toBe("trouble")
    expect(added?.at).toBeGreaterThan(1_000_000_000_000)
  })

  it("adds four asks at once, from four different terminals", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Several asks at once")
    const entries = inbox.state.getSnapshot().items

    expect(entries).toHaveLength(4)
    expect(new Set(entries.map((entry) => entry.source.terminalId)).size).toBe(4)
    expect(new Set(entries.map((entry) => entry.source.projectId)).size).toBe(4)
    expect(entries.every((entry) => entry.kind !== "update")).toBe(true)
  })

  it("adds messages held long behind a dialog, for the doorbell's trouble sheet", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Messages held long")
    const [entry] = inbox.state.getSnapshot().items

    expect(entry).toMatchObject({
      id: demoInboxIds.waits,
      kind: "trouble",
      trouble: { type: "waits", waits: "dialog", count: 2 },
    })
  })

  it("adds the next kind that is missing, until every kind is there", () => {
    const inbox = createDemoInbox(1, [])
    const notes: string[] = []
    // Lifecycle controls and variants change or add entries rather than adding a kind.
    const kinds = inboxGroups(inbox, seed)[0]!.actions.length - 23
    for (let each = 0; each < kinds; each += 1) run(inbox, "A new entry arrives", notes)
    expect(inbox.state.getSnapshot().items).toHaveLength(kinds)
    run(inbox, "A new entry arrives", notes)
    expect(notes).toEqual(["Every kind is in the Inbox already."])
  })

  it("adds Codex's form from an MCP server, which only its screen tells, as its text", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Form from an MCP server, in Codex")
    const [entry] = inbox.state.getSnapshot().items
    expect(entry).toMatchObject({
      kind: "request",
      source: { agent: "codex" },
      request: {
        kind: "question",
        tool: "mcp__deploy__elicitation",
        dialog: { type: "raw", text: expect.stringContaining("Field 1/2") },
      },
    })
  })

  it("adds a permission whose command hides a line, for the card to mark", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Command hiding lines")
    const [entry] = inbox.state.getSnapshot().items
    expect(entry?.kind === "request" && entry.request.dialog?.type === "choices").toBe(true)
    if (entry?.kind !== "request" || entry.request.dialog?.type !== "choices") return
    expect(entry.request.dialog.detail).toBe(demoHiddenCommand)
  })

  it("adds a permission for a script of twelve lines, for the sheet to scroll in its box", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Long command")
    const [entry] = inbox.state.getSnapshot().items
    if (entry?.kind !== "request" || entry.request.dialog?.type !== "choices")
      throw new Error("not a permission")
    expect(entry.request.dialog.detail).toBe(demoLongCommand)
    expect(demoLongCommand.split("\n")).toHaveLength(12)
  })

  it("adds one of Claude's questions that takes several picks and the person's words", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Pick several, with your own words")
    const [entry] = inbox.state.getSnapshot().items
    if (entry?.kind !== "request" || entry.request.dialog?.type !== "questions")
      throw new Error("not a question")
    expect(entry.request.dialog.questions).toMatchObject([{ multiSelect: true, text: true }])
  })

  it.each([
    ["Plan still loading", demoPlanStates.loading],
    ["Plan not found", demoPlanStates.missing],
  ])("adds a plan approval for the box's %s state", (label, id) => {
    const inbox = createDemoInbox(1, [])
    run(inbox, label)
    const [entry] = inbox.state.getSnapshot().items
    expect(entry?.id).toBe(id)
    expect(entry?.kind === "request" && entry.request.kind).toBe("plan")
  })

  it("adds Claude Code's plan whose way back is the field that says what to change", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Plan with a change field")
    const [entry] = inbox.state.getSnapshot().items
    expect(entry?.id).toBe(demoInboxIds.plan)
    expect(entry?.kind === "request" && entry.request.dialog?.type === "choices").toBe(true)
    if (entry?.kind !== "request" || entry.request.dialog?.type !== "choices") return
    expect(entry.request.dialog.options.at(-1)).toEqual({
      id: "3",
      label: "Tell Claude what to change",
      text: "field",
    })
  })

  it("adds what a newer Novadeck sends that this build can't show", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Ask in a shape from a newer Novadeck")
    run(inbox, "Dialog from a newer Novadeck")
    run(inbox, "Update from a newer Novadeck")
    const entries = inbox.state.getSnapshot().items
    expect(entries.find((entry) => entry.id === demoInboxIds.newerAsk)).toMatchObject({
      kind: "ask",
      source: { agent: "newer" },
      ask: { shape: { type: "newer" } },
    })
    expect(entries.find((entry) => entry.id === demoInboxIds.newerDialog)).toMatchObject({
      kind: "request",
      request: { dialog: { type: "newer" } },
    })
    expect(entries.find((entry) => entry.id === demoInboxIds.newerUpdate)).toMatchObject({
      kind: "update",
      source: { agent: "newer" },
      update: { type: "newer" },
    })
  })

  it("makes the next answer fail", () => {
    const inbox = createDemoInbox(1)
    run(inbox, "Fail the next answer")
    inbox.answer(inbox.state.getSnapshot().items[0]!.id, { kind: "update", action: "read" })

    expect(Object.keys(inbox.state.getSnapshot().failed)).toHaveLength(1)
  })

  it("makes the next answer report that its ask is no longer available", () => {
    const inbox = createDemoInbox(1)
    run(inbox, "Stale next answer")
    inbox.answer(demoInboxIds.preview, {
      kind: "ask",
      answer: { type: "reply", option: null, text: "Sample products." },
    })

    expect(inbox.state.getSnapshot().failed[demoInboxIds.preview]).toBe(
      "That ask is no longer available.",
    )
    expect(inbox.state.getSnapshot().items.some((entry) => entry.id === demoInboxIds.preview)).toBe(
      true,
    )
    expect(inbox.state.getSnapshot().answering).toEqual({})
  })

  it("makes withdrawn and ended asks reachable, the first leaving and the second kept resolved", () => {
    const outcomes: string[] = []
    const inbox = createDemoInbox(1, [], (_, __, outcome) => {
      if (outcome) outcomes.push(outcome)
    })
    run(inbox, "Ask withdrawn")
    // The withdrawn ask leaves the Inbox, as its agent's withdrawal does; the ended session's
    // stays, resolved, saying so.
    expect(inbox.state.getSnapshot().items).toEqual([])
    run(inbox, "Ask session ended")
    expect(outcomes).toEqual(["withdrawn", "gone"])
    expect(inbox.state.getSnapshot().items).toMatchObject([
      { id: demoInboxIds.preview, settled: { how: "ended" } },
    ])
  })

  it("makes a resolved entry of every kind reachable, in four groups", () => {
    const inbox = createDemoInbox(1, [])
    for (const label of [
      "Resolved dialogs",
      "Resolved asks",
      "Resolved updates",
      "Resolved Novadeck entries",
    ])
      run(inbox, label)
    const hows = inbox.state
      .getSnapshot()
      .items.map((entry) => entry.settled?.how)
      .filter((how) => how !== undefined)
    // Only the ten that resolved last are listed, of seventeen.
    expect(hows).toHaveLength(10)
    for (const entry of inbox.state.getSnapshot().items) expect(entry.stopped).toBe(false)
  })

  it("lists every way an entry ends once the seventeen are added", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Seventeen resolved entries")
    const items = inbox.state.getSnapshot().items
    expect(items).toHaveLength(10)
    // Newest first by when each was added, none of them open.
    expect(items.map(({ at }) => at)).toEqual(items.map(({ at }) => at).toSorted((a, b) => b - a))
    expect(items.every((entry) => entry.settled !== undefined)).toBe(true)
  })

  it("resolves each group's entries with how they ended and what was answered", () => {
    for (const [label, hows] of [
      ["Resolved dialogs", ["answered", "answered", "terminal", "gone"]],
      ["Resolved asks", ["answered", "dismissed", "replied", "answered", "ended"]],
      ["Resolved updates", ["read", "read"]],
      [
        "Resolved Novadeck entries",
        ["released", "stopped", "worked", "worked", "delivered", "worked"],
      ],
    ] as const) {
      const inbox = createDemoInbox(1, [])
      run(inbox, label)
      expect(
        inbox.state
          .getSnapshot()
          .items.toSorted((a, b) => a.at - b.at)
          .map((entry) => entry.settled?.how),
        label,
      ).toEqual(hows)
    }
    const dialogs = createDemoInbox(1, [])
    run(dialogs, "Resolved dialogs")
    expect(
      dialogs.state
        .getSnapshot()
        .items.find((entry) => entry.kind === "request" && entry.settled?.how === "answered")
        ?.settled?.answer,
    ).toBeDefined()
  })

  it("leaves an ask replied in its terminal as a settled entry", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Ask replied in terminal")
    expect(inbox.state.getSnapshot().items).toMatchObject([
      { id: demoInboxIds.preview, settled: { how: "replied" } },
    ])
  })

  it("makes a queued reply's delivery failure reachable", () => {
    vi.useFakeTimers()
    try {
      const inbox = createDemoInbox(1)
      run(inbox, "Next reply not delivered")
      inbox.answer(demoInboxIds.preview, {
        kind: "ask",
        answer: { type: "reply", option: null, text: "Samples." },
      })
      vi.runAllTimers()
      expect(inbox.state.getSnapshot().failed[demoInboxIds.preview]).toContain(
        "Your reply was not delivered",
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears the entries it and the Inbox demo added", () => {
    const inbox = createDemoInbox(1)
    run(inbox, "Clear the added entries")
    expect(inbox.state.getSnapshot().items).toEqual([])
  })
})
