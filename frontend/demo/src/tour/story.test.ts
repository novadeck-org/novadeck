import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoTurns } from "../agents/turns"
import { plainDemo } from "../index"
import { demoTourFolder, isDemoTour, type DemoTour } from "../tour"
import { demoRun } from "../tour-runs"
import { moneyHunk, splitMain, tipHunk } from "./split"
import {
  chosenMoney,
  fixedMoney,
  fixedTip,
  fixerHarness,
  moneyAsk,
  moneyFixerName,
  moneySubject,
  pickMoney,
  teammateCommand,
  tipFixerName,
  tourStoryMs,
} from "./story"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }

describe("the story's pieces", () => {
  it("runs the first fixer on another connected harness, else on the lead's", () => {
    expect(fixerHarness("claude", ["claude", "codex"])).toBe("codex")
    expect(fixerHarness("codex", ["codex"])).toBe("codex")
    expect(teammateCommand("claude")).toBe("claude --model haiku")
  })

  it("asks as the runner's ask does: options A and B, the first recommended", () => {
    const terminal = { id: "t", name: moneyFixerName, handle: "fox" } as TerminalMetadata
    const row = moneyAsk(key, terminal, "claude", "Tour", 5)
    expect(row).toMatchObject({
      kind: "ask",
      stopped: false,
      source: { terminalId: "t", handle: "fox", agent: "claude", projectName: "Tour" },
      ask: { subject: moneySubject, shape: { type: "options", recommend: 0 } },
    })
    if (row.kind !== "ask" || row.ask.shape.type !== "options") throw new Error("not options")
    expect(row.ask.shape.options.map(({ label }) => label)).toEqual(["$12.00", "$12"])
  })

  it("takes the option picked, else the first", () => {
    expect(chosenMoney(pickMoney(1))).toBe(1)
    expect(chosenMoney(pickMoney(7))).toBe(0)
    expect(chosenMoney(undefined)).toBe(0)
  })

  it("fixes the tip by dividing it by 100, and the money as the option says", () => {
    expect(splitMain.split("\n")[tipHunk.at - 1]).toContain("(total + total * tip) / people")
    expect(tipHunk.lines[0]).toContain("/ 100")
    expect(splitMain.split("\n")[moneyHunk(0).at - 1]).toContain("toFixed(1)")
    expect(moneyHunk(0).lines.join("\n")).toContain("toFixed(2)")
    expect(moneyHunk(1).lines.join("\n")).toContain("Number.isInteger")
  })
})

// The demo's workspace whose first project is the tour's, with the lead's terminal started there.
const open = async (setup?: (tour: DemoTour) => void) => {
  const backend = plainDemo("plain", undefined, undefined, demoTurns())
  const tour = backend.tour
  if (!isDemoTour(tour)) throw new Error("no demo tour")
  const seeded = workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 })
  const store = createWorkspaceStore(
    {
      ...seeded,
      projects: seeded.projects.map((each, index) =>
        index === 0 ? { ...each, directory: demoTourFolder } : each,
      ),
    },
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
  // The shell the person opens at the tour's prompt.
  const openShell = () => {
    const shell = backend.newTerminal({ target, directory: demoTourFolder })
    store.transact([{ type: "terminal/add", target, terminal: shell }])
    return shell.id
  }
  return {
    backend,
    tour,
    session,
    workspace,
    at,
    lead: terminal.id,
    project: project.id,
    openShell,
  }
}

const messagesOf = (backend: Awaited<ReturnType<typeof open>>["backend"]) => {
  const state = backend.messages!.state.getSnapshot()
  const distinct = new Map(
    Object.values(state.terminals)
      .flatMap((each) => each.threads.flatMap((thread) => thread.messages))
      .map((message) => [message.id, message]),
  )
  return [...distinct.values()]
}

describe("the story in the demo", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("opens a fixer that fixes bug 1 in its own worktree and reports", async () => {
    const { backend, session, at, lead } = await open()
    await at(tourPhaseTotal())
    const fixers = session().state.roster.terminals.filter((each) => each.ledBy === lead)
    expect(fixers.map((each) => each.name)).toEqual([tipFixerName])
    expect(fixers[0]!.titleSource?.kind).toBe("agent")
    const works = backend
      .works!.state.getSnapshot()
      .works.filter((w) => w.branch?.startsWith("fix-"))
    expect(works).toHaveLength(1)
    expect(works[0]).toMatchObject({
      branch: "fix-tip",
      terminalId: fixers[0]!.id,
      files: [{ path: "split.js", added: 1, removed: 1 }],
    })
    expect(messagesOf(backend).map(({ text }) => text)).toEqual([fixedTip])
    // The lead's turn stays open until both have reported.
    const leader = session().state.roster.terminals.find((each) => each.id === lead)!
    expect(leader.state === "running" && leader.agent?.lastTurn).toBeFalsy()
  })

  it("takes the person's terminal as the second fixer, which asks, and merges once answered", async () => {
    const { backend, tour, session, at, lead, project, openShell } = await open()
    await at(tourPhaseTotal())
    const shellId = openShell()
    await tour.fixer!(shellId)
    await at(tourStoryMs.bind + tourStoryMs.work + 50)
    const taken = session().state.roster.terminals.find((each) => each.id === shellId)!
    expect(taken).toMatchObject({ ledBy: lead, name: moneyFixerName })
    expect(taken.state === "running" && taken.agent?.working).toBe(true)

    // The ask waits in the Inbox as long as the person takes.
    await at(60_000)
    const rows = backend.inbox!.state.getSnapshot().items.filter((row) => row.kind === "ask")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: { terminalId: shellId }, stopped: false })
    const worksNow = backend
      .works!.state.getSnapshot()
      .works.filter((w) => w.branch?.startsWith("fix-"))
    expect(worksNow.map((work) => work.branch).toSorted()).toEqual(["fix-money", "fix-tip"])

    tour.answerMoney(1)
    await at(5000)
    expect(
      backend.inbox!.state.getSnapshot().items.filter((row) => row.kind === "ask" && !row.settled),
    ).toHaveLength(0)
    expect(messagesOf(backend).map(({ text }) => text)).toEqual(
      expect.arrayContaining([fixedTip, fixedMoney]),
    )
    // The merged preview of split.js holds both hunks, the money fix as picked.
    const preview = await backend.works!.preview(project, "split.js")
    expect(preview.main).toBe(splitMain)
    expect(preview.works.map((work) => [work.branch, work.hunks])).toEqual(
      expect.arrayContaining([
        ["fix-tip", [tipHunk]],
        ["fix-money", [moneyHunk(1)]],
      ]),
    )
    await at(2000)
    const done = session().state.roster.terminals.find((each) => each.id === lead)!
    expect(done.state === "running" && done.agent?.lastTurn?.outcome).toBe("completed")
  })

  it("lists the tour's repo in its Files panel, and no other project's", async () => {
    const { backend, project } = await open()
    const root = await backend.files!.list(project, "")
    expect(root.entries.map((entry) => entry.name)).toContain("split.js")
  })

  it("leaves a shell that isn't the tour's, or a second one, alone", async () => {
    const { tour, session, at, lead, openShell } = await open()
    await at(tourPhaseTotal())
    const first = openShell()
    const second = openShell()
    await tour.fixer!(first)
    await tour.fixer!(second)
    await at(tourStoryMs.bind + tourStoryMs.work + 50)
    const led = session().state.roster.terminals.filter((each) => each.ledBy === lead)
    expect(led.map((each) => each.id)).toContain(first)
    expect(led.map((each) => each.id)).not.toContain(second)
  })

  it("waits for a nudge before opening its fixer, and stops when its process exits", async () => {
    const { tour, session, at, lead } = await open((each) => each.goQuietTeam())
    await at(tourPhaseTotal())
    expect(session().state.roster.terminals.filter((each) => each.ledBy === lead)).toEqual([])
    await tour.nudge!(lead)
    await at(tourStoryMs.open + 10)
    expect(session().state.roster.terminals.some((each) => each.ledBy === lead)).toBe(true)
    tour.stop()
    expect(session().state.roster.terminals.find((each) => each.id === lead)?.state).toBe("exited")
  })
})

// Long enough for the lead to bind, work, describe itself, and the first fixer to open, name itself,
// edit and report.
const tourPhaseTotal = () =>
  300 +
  400 +
  tourStoryMs.open +
  tourStoryMs.bind +
  tourStoryMs.work * 2 +
  tourStoryMs.talk * 2 +
  100
