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

// The sample projects the Inbox's rows are about.
const seed = demoSeed(0, true)

const run = (inbox: ReturnType<typeof createDemoInbox>, label: string, notes: string[] = []) => {
  const [group] = inboxGroups(inbox, seed)
  const context: DemoActionContext = {
    target: "selected",
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

  it("adds one row of a kind, waiting from now", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Stuck agent")
    const [added] = inbox.state.getSnapshot().items
    expect(added?.kind).toBe("trouble")
    expect(added?.at).toBeGreaterThan(1_000_000_000_000)
  })

  it("adds four asks at once, from four different terminals", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Several asks at once")
    const rows = inbox.state.getSnapshot().items

    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((row) => row.source.terminalId)).size).toBe(4)
    expect(new Set(rows.map((row) => row.source.projectId)).size).toBe(4)
    expect(rows.every((row) => row.kind !== "update")).toBe(true)
  })

  it("adds messages held long behind a dialog, for the doorbell's trouble sheet", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Messages held long")
    const [row] = inbox.state.getSnapshot().items

    expect(row).toMatchObject({
      id: demoInboxIds.waits,
      kind: "trouble",
      trouble: { type: "waits", waits: "dialog", count: 2 },
    })
  })

  it("adds the next kind that is missing, until every kind is there", () => {
    const inbox = createDemoInbox(1, [])
    const notes: string[] = []
    // Lifecycle controls and variants change or add rows rather than adding a kind.
    const kinds = inboxGroups(inbox, seed)[0]!.actions.length - 24
    for (let each = 0; each < kinds; each += 1) run(inbox, "A new row arrives", notes)
    expect(inbox.state.getSnapshot().items).toHaveLength(kinds)
    run(inbox, "A new row arrives", notes)
    expect(notes).toEqual(["Every kind is in the Inbox already."])
  })

  it("adds a permission whose command hides a line, for the card to mark", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Command hiding lines")
    const [row] = inbox.state.getSnapshot().items
    expect(row?.kind === "request" && row.request.dialog?.type === "choices").toBe(true)
    if (row?.kind !== "request" || row.request.dialog?.type !== "choices") return
    expect(row.request.dialog.detail).toBe(demoHiddenCommand)
  })

  it("adds a permission for a script of twelve lines, for the sheet to scroll in its box", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Long command")
    const [row] = inbox.state.getSnapshot().items
    if (row?.kind !== "request" || row.request.dialog?.type !== "choices")
      throw new Error("not a permission")
    expect(row.request.dialog.detail).toBe(demoLongCommand)
    expect(demoLongCommand.split("\n")).toHaveLength(12)
  })

  it("adds one of Claude's questions that takes several picks and the person's words", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Pick several, with your own words")
    const [row] = inbox.state.getSnapshot().items
    if (row?.kind !== "request" || row.request.dialog?.type !== "questions")
      throw new Error("not a question")
    expect(row.request.dialog.questions).toMatchObject([{ multiSelect: true, text: true }])
  })

  it.each([
    ["Plan still loading", demoPlanStates.loading],
    ["Plan not found", demoPlanStates.missing],
  ])("adds a plan approval for the box's %s state", (label, id) => {
    const inbox = createDemoInbox(1, [])
    run(inbox, label)
    const [row] = inbox.state.getSnapshot().items
    expect(row?.id).toBe(id)
    expect(row?.kind === "request" && row.request.kind).toBe("plan")
  })

  it("adds Claude Code's plan whose way back is the field that says what to change", () => {
    const inbox = createDemoInbox(1, [])
    run(inbox, "Plan with a change field")
    const [row] = inbox.state.getSnapshot().items
    expect(row?.id).toBe(demoInboxIds.plan)
    expect(row?.kind === "request" && row.request.dialog?.type === "choices").toBe(true)
    if (row?.kind !== "request" || row.request.dialog?.type !== "choices") return
    expect(row.request.dialog.options.at(-1)).toEqual({
      id: "3",
      label: "Tell Claude what to change",
      text: "field",
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
    expect(inbox.state.getSnapshot().items.some((row) => row.id === demoInboxIds.preview)).toBe(
      true,
    )
    expect(inbox.state.getSnapshot().answering).toEqual({})
  })

  it("makes withdrawn and ended asks reachable as retained history", () => {
    const outcomes: string[] = []
    const inbox = createDemoInbox(1, [], (_, __, outcome) => {
      if (outcome) outcomes.push(outcome)
    })
    run(inbox, "Ask withdrawn")
    // The withdrawn ask stays as a settled row; the ended session's is gone.
    expect(inbox.state.getSnapshot().items).toMatchObject([
      { id: demoInboxIds.preview, settled: { how: "withdrawn" } },
    ])
    run(inbox, "Ask session ended")
    expect(outcomes).toEqual(["withdrawn", "gone"])
    expect(inbox.state.getSnapshot().items).toEqual([])
  })

  it("leaves an ask replied in its terminal as a settled row", () => {
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

  it("clears the rows it and the Inbox demo added", () => {
    const inbox = createDemoInbox(1)
    run(inbox, "Clear the added rows")
    expect(inbox.state.getSnapshot().items).toEqual([])
  })
})

describe("the debug panel's grant actions", () => {
  const withCards = () => createDemoInbox(1, [])

  it("adds the Grant and approval cards", () => {
    const inbox = withCards()
    run(inbox, "Grant card")
    run(inbox, "Approval card")
    expect(
      inbox.state
        .getSnapshot()
        .items.map((row) => row.id)
        .toSorted(),
    ).toEqual([demoInboxIds.approval, demoInboxIds.grant].toSorted())
  })

  it("adds the Antigravity cards, one with a running teammate and one with an old Antigravity", () => {
    const inbox = withCards()
    run(inbox, "Grant card, Antigravity")
    run(inbox, "Grant card, old Antigravity")
    const proposals = inbox.state
      .getSnapshot()
      .items.flatMap((row) => (row.kind === "grant" ? [row.proposal] : []))
    expect(proposals.map((each) => each.covered.map(({ agent }) => agent))).toEqual([
      ["agy"],
      ["agy"],
    ])
    expect(
      proposals.map((each) => [each.covered[0]?.started, each.agyOutdated]).toSorted(),
    ).toEqual([
      [false, true],
      [true, false],
    ])
  })

  it("lists a live grant with its last use, and revokes it", () => {
    const inbox = withCards()
    const notes: string[] = []
    run(inbox, "Revoke a grant", notes)
    expect(notes).toEqual(["No grant is live. Add one with Live grant or the cards."])

    run(inbox, "Live grant")
    expect(inbox.grants.state.getSnapshot()[0]?.lastUse).not.toBeNull()
    run(inbox, "Revoke a grant")
    expect(inbox.grants.state.getSnapshot()).toEqual([])
  })

  it("shows a grant that ends by its time and leaves the list", () => {
    vi.useFakeTimers()
    try {
      const inbox = withCards()
      run(inbox, "Grant ends")
      expect(inbox.grants.state.getSnapshot()).toHaveLength(1)
      vi.advanceTimersByTime(4000)
      expect(inbox.grants.state.getSnapshot()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
