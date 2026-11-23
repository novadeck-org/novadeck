import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { TerminalMetadata } from "@novadeck/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoTurns } from "../agents/turns"
import { plainDemo } from "../index"
import { demoTourFolder, isDemoTour, tourHarness, type DemoTour } from "../tour"
import { demoRun } from "../tour-runs"
import { atTourScreen, describedAs, tourLeadName, tourPhaseMs } from "./player"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }

describe("the tour agent's pieces", () => {
  it("names the harness a tour command starts", () => {
    expect(tourHarness(demoRun("claude").command)).toBe("claude")
    expect(tourHarness(demoRun("codex").command)).toBe("codex")
    expect(tourHarness(demoRun("agy").command)).toBe("agy")
    expect(tourHarness(demoRun("opencode").command)).toBe("opencode")
    expect(tourHarness("zsh")).toBeUndefined()
  })

  it("holds an agent at a screen as the runner reports it, and describes it as its own", () => {
    expect(atTourScreen(key, "codex", "sign-in")).toEqual([
      expect.objectContaining({ type: "terminal/process", process: "codex" }),
      expect.objectContaining({
        type: "terminal/status",
        status: { state: "running", agent: { working: false, startup: "sign-in" } },
      }),
    ])
    expect(describedAs(key, "owl")).toMatchObject({
      name: tourLeadName,
      titleSource: { kind: "agent", by: "owl" },
    })
  })
})

// The demo's backend with a store the UI's terminal is added to, as the app does.
const open = (agent: "claude" | "agy" = "claude", setup?: (tour: DemoTour) => void) => {
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
  const terminal: TerminalMetadata = {
    ...backend.newTerminal({
      target,
      directory: demoTourFolder,
      launch: { command: demoRun(agent).command },
    }),
  }
  store.transact([{ type: "terminal/add", target, terminal }])
  const held = () =>
    store
      .getSnapshot()
      .projects.find((each) => each.id === project.id)
      ?.history.find((each) => each.id === target.workspaceSessionId)
      ?.state.roster.terminals.find((each) => each.id === terminal.id)
  const at = async (ms: number) => {
    // The player and its stage load on their first start.
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(ms)
    return held()
  }
  return { tour, held, at, id: terminal.id }
}

describe("the tour agent in the demo", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("binds, works, describes itself and finishes its turn, with the story off", async () => {
    const { at } = open("claude", (tour) => tour.configure({ story: false }))
    expect((await at(0))?.state).toBe("idle")
    const working = await at(tourPhaseMs.bind + 10)
    expect(working).toMatchObject({ state: "running", process: "claude", agent: { working: true } })
    await at(tourPhaseMs.work)
    const described = await at(0)
    expect(described).toMatchObject({
      name: tourLeadName,
      titleSource: { kind: "agent", by: described?.handle },
    })
    const done = await at(tourPhaseMs.finish + 10)
    expect(done).toMatchObject({ agent: { working: false, lastTurn: { outcome: "completed" } } })
  })

  it("waits at a held screen until it's answered", async () => {
    const { at, tour } = open("claude", (each) => each.holdAt("sign-in"))
    expect(await at(tourPhaseMs.bind + 10)).toMatchObject({
      process: "claude",
      agent: { working: false, startup: "sign-in" },
    })
    expect(await at(5000)).toMatchObject({ agent: { startup: "sign-in" } })
    tour.answer()
    expect(await at(tourPhaseMs.bind + 10)).toMatchObject({ agent: { working: true } })
  })

  it("answers a held screen on its own after screenMs", async () => {
    const { at } = open("claude", (tour) => {
      tour.holdAt("startup")
      tour.configure({ screenMs: 1000 })
    })
    expect(await at(900)).toMatchObject({ agent: { startup: "startup" } })
    expect(await at(800)).toMatchObject({ agent: { working: true } })
  })

  it("sits idle at its prompt, no turn begun, until nudged, then works and describes itself", async () => {
    const { at, tour, id } = open("claude", (each) => each.goQuiet())
    const quiet = await at(2000)
    expect(quiet).toMatchObject({ agent: { working: false } })
    expect(quiet?.state === "running" && quiet.agent?.lastTurn).toBeFalsy()
    expect(quiet?.name).not.toBe(tourLeadName)
    await tour.nudge!(id)
    expect(await at(tourPhaseMs.bind + 10)).toMatchObject({ agent: { working: true } })
    await at(tourPhaseMs.work + 10)
    expect((await at(0))?.name).toBe(tourLeadName)
    expect(tour.nudged.getSnapshot()).toEqual([id])
  })

  it("asks the person's permission first, and names itself no sooner", async () => {
    const { at } = open("claude", (each) => {
      each.askPermission()
      each.configure({ story: false })
    })
    expect(await at(tourPhaseMs.bind + 10)).toMatchObject({
      agent: { working: true, attention: { kind: "permission", count: 1 } },
    })
    const waiting = await at(5000)
    expect(waiting).toMatchObject({ agent: { attention: { kind: "permission" } } })
    expect(waiting?.name).not.toBe(tourLeadName)
  })

  it("starts Antigravity's agent only once it's briefed", async () => {
    const { at, tour, id } = open("agy")
    expect(await at(2000)).toMatchObject({ process: "agy", agent: { working: false } })
    await tour.brief(id)
    expect(await at(tourPhaseMs.bind + 10)).toMatchObject({ agent: { working: true } })
  })
})
