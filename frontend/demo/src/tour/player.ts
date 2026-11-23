import type { AgentName } from "@novadeck/core/harnesses"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import type { TerminalMetadata } from "@novadeck/core/types"

import type { DemoTurns } from "../agents/turns"
import type { DemoTour, TourScreen, TourStage } from "../tour"
import { demoRun } from "../tour-runs"
import { playTourStory } from "./story"

// How long each phase of the demo's tour agent takes: short and fixed, so specs run fast.
export const tourPhaseMs = { bind: 300, work: 400, finish: 400 } as const

// What the tour's terminal is named once its agent describes itself.
export const tourLeadName = "Game lead"

const noop = () => {}

const target = ({ projectId, workspaceSessionId }: TerminalKey) => ({
  projectId,
  workspaceSessionId,
})

// An agent held for the person at one of its own screens, as the runner reports it: its
// process is the harness, and it waits there, not working.
export const atTourScreen = (
  key: TerminalKey,
  harness: AgentName,
  screen: TourScreen,
): BackendAction[] => [
  { type: "terminal/process", target: target(key), terminalId: key.terminalId, process: harness },
  {
    type: "terminal/status",
    target: target(key),
    terminalId: key.terminalId,
    status: { state: "running", agent: { working: false, startup: screen } },
  },
]

// The agent's describe: its terminal takes the name, as the agent's own.
export const describedAs = (key: TerminalKey, by: string): BackendAction => ({
  type: "terminal/update",
  target: target(key),
  terminalId: key.terminalId,
  name: tourLeadName,
  titleSource: { kind: "agent", by },
})

// The lead's program ended and its shell is back at the prompt, as a harness that quits leaves it.
export const leftToShell = (key: TerminalKey): BackendAction[] => [
  { type: "terminal/update", target: target(key), terminalId: key.terminalId, agentRan: true },
  { type: "terminal/process", target: target(key), terminalId: key.terminalId, process: "zsh" },
  {
    type: "terminal/status",
    target: target(key),
    terminalId: key.terminalId,
    status: { state: "idle" },
  },
]

// The lead's process ended, as one that exits reports.
export const exited = (key: TerminalKey): BackendAction => ({
  type: "terminal/status",
  target: target(key),
  terminalId: key.terminalId,
  status: { state: "exited", exitCode: 1, signal: null },
})

type Player = {
  readonly key: TerminalKey
  readonly harness: AgentName
  readonly tour: DemoTour
  readonly turns: DemoTurns
  readonly dispatch: (actions: BackendAction[]) => void
  // The terminal as the workspace holds it now; none once it's closed.
  readonly terminal: () => TerminalMetadata | undefined
  // What the story's rest needs of the backend; without it the lead stops after describing itself.
  readonly stage?: TourStage | undefined
}

// Plays the tour's agent in its terminal: an optional startup screen, held until answered;
// bound at the doorbell's ring where the harness waits for one (Antigravity), else at once;
// working; describing itself (once nudged, where quiet); then, with the story on, asking the
// person what game to make, opening its modeller and builder, running the game's server and
// showing its page, and showing it again once the team built the game (see `story.ts`); and a
// finished turn. Answers a function
// that stops it.
export const playTourAgent = ({ key, harness, tour, turns, dispatch, terminal, stage }: Player) => {
  const plan = tour.take()
  const verbs = turns.as(harness)
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const stops = new Set<() => void>()
  let over = false
  const later = (ms: number, then: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!over) then()
    }, ms)
    timers.add(timer)
  }
  // Calls `then` once `ready` holds; every phase checks the terminal is still there.
  const when = (
    subscribe: (poke: () => void) => () => void,
    ready: () => boolean,
    then: () => void,
  ) => {
    let done = false
    let stop: () => void = noop
    const poke = () => {
      if (done || over || !ready()) return
      done = true
      stop()
      stops.delete(stop)
      then()
    }
    stop = subscribe(poke)
    stops.add(stop)
    poke()
  }
  const alive = (): TerminalMetadata | undefined => {
    const found = terminal()
    if (!found) over = true
    return found
  }
  const finish = (reply: string) =>
    verbs.finish(key, terminal(), "completed", { after: tourPhaseMs.finish, reply })
  const describe = () => {
    const found = alive()
    if (!found) return
    dispatch([describedAs(key, found.handle ?? harness)])
    if (!stage || !tour.story()) return finish("That's the game lead: ready.")
    const stopStory = playTourStory({
      key,
      harness,
      tour,
      turns,
      dispatch,
      stage,
      terminal,
      quietTeam: plan.quietTeam === true,
      quietModeller: plan.quietModeller === true,
      mateAsks: plan.mateAsks === true,
      noPage: plan.noPage === true,
      finish: () => finish("The game is built."),
    })
    stops.add(stopStory)
  }
  const work = () => {
    if (!alive()) return
    verbs.work(key, terminal())
    later(tourPhaseMs.work, describe)
  }
  // A permission dialog of the agent's own, as a shell command it wants to run would raise: it
  // waits, working, until the person answers it in the Inbox or its terminal.
  const askPermission = () => {
    if (!alive()) return
    verbs.ask(key, terminal(), "permission", 1)
    const check = () => {
      const found = alive()
      if (!found) return
      if (found.state !== "running" || found.agent?.attention === undefined) return work()
      later(tourPhaseMs.bind, check)
    }
    later(tourPhaseMs.bind, check)
  }
  // The agent shows at its prompt; the doorbell's harness starts only once rung. A quiet one sits
  // idle there, no turn begun, as an agent that never took its first line does, until nudged.
  const bound = () => {
    if (!alive()) return
    if (plan.quiet) {
      verbs.rest(key, terminal())
      return when(
        (poke) => tour.nudged.subscribe(poke),
        () => tour.nudged.getSnapshot().includes(key.terminalId),
        () => later(tourPhaseMs.bind, work),
      )
    }
    if (demoRun(harness).brief === "launch") return plan.permission ? askPermission() : work()
    verbs.rest(key, terminal())
    when(
      (poke) => tour.briefed.subscribe(poke),
      () => tour.briefed.getSnapshot().includes(key.terminalId),
      () => later(tourPhaseMs.bind, plan.permission ? askPermission : work),
    )
  }
  later(tourPhaseMs.bind, () => {
    if (!alive()) return
    if (!plan.screen) return bound()
    dispatch(atTourScreen(key, harness, plan.screen))
    const ms = tour.screenMs()
    let answered = false
    const answer = () => {
      if (answered) return
      answered = true
      stop()
      stops.delete(stop)
      later(tourPhaseMs.bind, bound)
    }
    const stop = tour.answered(answer)
    stops.add(stop)
    if (ms !== undefined) later(ms, answer)
  })
  const stop = () => {
    over = true
    timers.forEach(clearTimeout)
    timers.clear()
    stops.forEach((each) => each())
    stops.clear()
    turns.release(key)
  }
  // Its process exits, as an agent that can't go on does: the terminal says so, and nothing
  // more is played.
  const stopHere = tour.stopped(() => {
    if (over) return
    stop()
    dispatch([exited(key)])
  })
  stops.add(stopHere)
  // Its program ends, its shell back, as the debug panel or `&tourAgent=shell` asks.
  const leave = () => {
    if (over) return
    stop()
    dispatch(leftToShell(key))
  }
  stops.add(tour.shelled(leave))
  if (plan.shell) later(tourPhaseMs.bind * 2, leave)
  return stop
}
