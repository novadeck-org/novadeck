import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoTurns } from "../agents/turns"
import { plainDemo } from "../index"
import { demoTourFolder, isDemoTour, type DemoTour } from "../tour"
import { demoRun } from "../tour-runs"
import {
  chosenTagline,
  pickTagline,
  taglineAsk,
  taglineSubject,
  taglines,
  teamHarnesses,
  teammateCommand,
  tourStoryMs,
  tourStrip,
} from "./story"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }

describe("the story's pieces", () => {
  it("runs the designer on another connected harness, else on the lead's", () => {
    expect(teamHarnesses("claude", ["claude", "codex"])).toEqual({
      copywriter: "claude",
      designer: "codex",
    })
    expect(teamHarnesses("codex", ["codex"])).toEqual({ copywriter: "codex", designer: "codex" })
    expect(teammateCommand("claude")).toBe("claude --model haiku")
  })

  it("asks as the runner's ask does: options A and B, each with its line", () => {
    const terminal = { id: "t", name: "Copywriter", handle: "fox" } as TerminalMetadata
    const row = taglineAsk(key, terminal, "claude", "Tour", 5)
    expect(row).toMatchObject({
      kind: "ask",
      stopped: false,
      source: { terminalId: "t", handle: "fox", agent: "claude", projectName: "Tour" },
      ask: { subject: taglineSubject, shape: { type: "options" } },
    })
    if (row.kind !== "ask" || row.ask.shape.type !== "options") throw new Error("not options")
    expect(row.ask.shape.options.map(({ label, summary }) => [label, summary])).toEqual(
      taglines.map(({ label, line }) => [label, line]),
    )
  })

  it("takes the tagline of the option picked, the person's words, or the first", () => {
    expect(chosenTagline(pickTagline(1)).line).toBe(taglines[1].line)
    expect(
      chosenTagline({ kind: "ask", answer: { type: "reply", option: null, text: " Hello " } }),
    ).toEqual({ label: "your words", line: "Hello" })
    expect(chosenTagline(undefined)).toBe(taglines[0])
  })

  it("shows the strip as an agent's tour-strip.html, a page asked to open, from the lead", () => {
    const { item, content } = tourStrip(key, "moth", "Fish & <chips>", 9)
    expect(item).toMatchObject({
      kind: "file",
      name: "tour-strip.html",
      by: "agent",
      openAsked: true,
      holder: { terminalId: "t" },
      from: { terminalId: "t", handle: "moth" },
    })
    expect(content).toMatchObject({ state: "ready", content: { kind: "file", truncated: false } })
    const page =
      content.state === "ready" && content.content.kind === "file"
        ? content.content.lines.join("\n")
        : ""
    expect(page).toContain('<p class="t">Fish &amp; &lt;chips&gt;</p>')
    expect(page.startsWith("<!doctype html>")).toBe(true)
  })
})

const open = async (setup?: (tour: DemoTour) => void) => {
  const backend = plainDemo("plain", undefined, undefined, demoTurns())
  const tour = backend.tour
  if (!isDemoTour(tour)) throw new Error("no demo tour")
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  setup?.(tour)
  const project = store.getSnapshot().projects[0]!
  const target = { projectId: project.id, workspaceSessionId: project.history[0]!.id }
  const terminal = backend.newTerminal({
    target,
    directory: demoTourFolder,
    launch: { command: demoRun("claude").command },
  })
  store.transact([{ type: "terminal/add", target, terminal }])
  await vi.dynamicImportSettled()
  const session = () =>
    store
      .getSnapshot()
      .projects.find((each) => each.id === project.id)!
      .history.find((each) => each.id === target.workspaceSessionId)!
  const workspace = (): Workspace => store.getSnapshot()
  const at = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms)
  }
  return { backend, tour, session, workspace, at, lead: terminal.id }
}

describe("the story in the demo", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("opens two named teammates, talks, asks, and shows the strip once answered", async () => {
    const { backend, tour, session, at, lead } = await open()
    // The lead names itself; its turn stays open for the story.
    await at(tourPhaseTotal())
    const named = session().state.roster.terminals.filter((each) => each.ledBy === lead)
    expect(named.map((each) => each.name)).toEqual(["Copywriter", "Designer"])
    expect(named.every((each) => each.titleSource?.kind === "agent")).toBe(true)
    const leader = session().state.roster.terminals.find((each) => each.id === lead)!
    expect(leader.state === "running" && leader.agent?.lastTurn).toBeFalsy()

    // The talk: the designer's look to the lead, between agents, with terminal ids.
    await at(tourStoryMs.talk + 3000)
    const copywriter = named[0]!
    const state = backend.messages!.state.getSnapshot()
    const messages = Object.values(state.terminals).flatMap((each) =>
      each.threads.flatMap((thread) => thread.messages),
    )
    const distinct = new Map(messages.map((message) => [message.id, message]))
    expect(distinct.size).toBe(1)
    for (const message of distinct.values())
      expect(message).toMatchObject({ from: { kind: "agent" }, to: { kind: "agent" } })

    // The ask waits in the Inbox as long as the person takes.
    await at(60_000)
    const rows = backend.inbox!.state.getSnapshot().items.filter((row) => row.kind === "ask")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: { terminalId: copywriter.id }, stopped: false })
    expect(session().state.items.some((item) => item.name === "tour-strip.html")).toBe(false)

    tour.answerTagline(1)
    await at(5000)
    // The answered ask no longer waits: it stays settled, or goes.
    expect(
      backend.inbox!.state.getSnapshot().items.filter((row) => row.kind === "ask" && !row.settled),
    ).toHaveLength(0)
    const shown = session().state.items.find((item) => item.name === "tour-strip.html")
    expect(shown).toMatchObject({ by: "agent", openAsked: true, from: { terminalId: lead } })
    const content = await new Promise<unknown>((resolve) => {
      backend.companions!.follow(
        { projectId: "p", workspaceSessionId: "s" },
        shown!.id,
        { reveal: undefined },
        resolve,
      )
    })
    expect(JSON.stringify(content)).toContain(`<p class=\\"t\\">${taglines[1].line}</p>`)
    await at(2000)
    const done = session().state.roster.terminals.find((each) => each.id === lead)!
    expect(done.state === "running" && done.agent?.lastTurn?.outcome).toBe("completed")
  })

  it("waits for a nudge before opening its team, and stops when its process exits", async () => {
    const { tour, session, at, lead } = await open((each) => each.goQuietTeam())
    await at(tourPhaseTotal())
    expect(session().state.roster.terminals.filter((each) => each.ledBy === lead)).toEqual([])
    await tour.nudge!(lead)
    await at(tourStoryMs.open * 2 + 10)
    expect(session().state.roster.terminals.some((each) => each.ledBy === lead)).toBe(true)
    tour.stop()
    expect(session().state.roster.terminals.find((each) => each.id === lead)?.state).toBe("exited")
  })
})

// Long enough for the lead to bind, work, describe itself, and open and name both teammates.
const tourPhaseTotal = () =>
  300 + 400 + tourStoryMs.open * 2 + tourStoryMs.bind + tourStoryMs.work + 50
