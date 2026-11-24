import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import {
  beginRun,
  coachNow,
  nextTick,
  showAgain,
  stepRun,
  stepsFor,
  type TourEvent,
  type TourMade,
  type TourRun,
  type TourShow,
} from "./driver"
import { noTeam, sameSignals, tourSignals, type TourSignals } from "./signals"
import type { TourStarted } from "./start"
import { stepsOf, type Coach, type TourAct, type TourStep } from "./steps"
import type { TourHost } from "./tour-host"
import { closingKey, storageKey } from "./tour-storage"
import { useSelected } from "./use-selected"

// How long the tour waits on its agent at a step before nudging it, unless the backend says.
const defaultPatienceMs = 90_000
// How soon it rings the lead's first line again where the backend refused it, and how many times
// before it gives up: a refusal that stands (a terminal outside the tour's folder) isn't asked
// again forever.
const briefRetryMs = 2_000
const briefTries = 5

const isRun = (value: unknown): value is TourRun => {
  if (typeof value !== "object" || value === null) return false
  const run = value as Record<string, unknown>
  return (
    typeof run.terminalId === "string" &&
    harnesses.some(({ id }) => id === run.agent) &&
    (run.brief === "launch" || run.brief === "doorbell") &&
    typeof run.command === "string" &&
    typeof run.step === "number" &&
    typeof run.waitingSince === "number" &&
    (typeof run.doneAt === "number" || run.doneAt === null) &&
    (typeof run.approvalGoneAt === "number" || run.approvalGoneAt === null) &&
    typeof run.approvalSeen === "boolean" &&
    ["page", "nudged", "briefed", "asked", "declined"].every((key) => typeof run[key] === "boolean")
  )
}

// The step a stored run was at is kept by its id beside its index, so a run kept by a version
// whose steps differed (one with no id, or whose id isn't at that index now: another story's, or
// one with no page) is dropped, not followed at some other step.
const stepIdOf = (steps: readonly TourStep[], index: number): string => steps[index]?.id ?? "end"

export const readTourRun = (): TourRun | null => {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null")
    if (!isRun(stored)) return null
    const steps = stepsFor(stored)
    const { stepId } = stored as unknown as { readonly stepId?: unknown }
    if (stored.step < 0 || stored.step > steps.length || stepId !== stepIdOf(steps, stored.step))
      return null
    // What was only seen waiting isn't kept: after a reload it is seen anew.
    return {
      ...stored,
      captionAt: null,
      touched: null,
      approvalSeen: false,
      approvalGoneAt: null,
    }
  } catch {
    return null
  }
}

const writeTourRun = (run: TourRun | null, steps: readonly TourStep[] | null): void => {
  try {
    // A sheet seen isn't kept: after a reload the Inbox lists it anew, and until it has, its
    // absence would read as answered.
    if (run && steps)
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ ...run, asked: false, stepId: stepIdOf(steps, run.step) }),
      )
    else sessionStorage.removeItem(storageKey)
  } catch {
    // Without storage, a run isn't followed again after a reload.
  }
}

type Closing = NonNullable<TourDriver["closing"]>
type StoredClosing = Omit<Closing, "keepError">

const readClosing = (): StoredClosing | null => {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(closingKey) ?? "null")
    if (typeof stored !== "object" || stored === null) return null
    const { terminalId, projectId, agent } = stored as Record<string, unknown>
    return typeof terminalId === "string" &&
      (typeof projectId === "string" || projectId === null) &&
      harnesses.some(({ id }) => id === agent)
      ? { terminalId, projectId, agent: agent as AgentName }
      : null
  } catch {
    return null
  }
}

const writeClosing = (closing: StoredClosing | null): void => {
  try {
    if (closing) sessionStorage.setItem(closingKey, JSON.stringify(closing))
    else sessionStorage.removeItem(closingKey)
  } catch {
    // Without storage, a reload doesn't bring the closing card back.
  }
}

const noSignals: TourSignals = { lead: { kind: "gone" }, onScreen: false, ...noTeam }
const noState = (): (() => void) => () => {}

export type TourDriver = {
  // Follows a run the person just started.
  readonly begin: (agent: AgentName, started: TourStarted) => void
  // The step's caption box came on screen, with its line: a held step holds from then.
  readonly captioned: (line: string) => void
  // The person touched what the caption with this line marks as its step's subject.
  readonly touched: (line: string) => void
  // Brings what the tour is about now into view, as the person asks by the caption box's button.
  readonly show: () => void
  // The run followed now, with what it shows; null while none runs.
  readonly shown: {
    readonly terminalId: string
    readonly agent: AgentName
    readonly coach: Coach | null
    // Whether the caption box's button has something to bring into view now: a terminal held at
    // something of its own, or the step's subject. Where it hasn't, the box offers "Show me" only
    // once what it marks is out of sight.
    readonly bring: boolean
    // The act its step belongs to, which a wipe opens.
    readonly act: TourAct
    // The Inbox row of the team's question waiting now.
    readonly askingRow: string | null
    // The terminals of the roles found, and of the lead's teammates, which the stage marks.
    readonly roles: TourSignals["roles"]
    readonly team: readonly string[]
    // What each role's pane shows now.
    readonly open: TourSignals["open"]
    readonly away: boolean
  } | null
  // The tour just finished its story, for its closing card: its lead, project and agent.
  readonly closing: {
    readonly terminalId: string
    readonly projectId: string | null
    readonly agent: AgentName
    // Why keeping the project failed, where it did: the card says so and offers another try.
    readonly keepError: string | null
  } | null
  // Asks the backend to keep the project again, after it refused.
  readonly retryKeep: () => void
  readonly end: () => void
  // Puts the closing card away.
  readonly close: () => void
  // Brings the tour's project, and its lead, back on screen.
  readonly back: () => void
}

/**
 * Follows a run of the tour: reads its signals off the workspace, moves it on with each change
 * and as its waits end, and rings its lead its first line, or a nudge, through the backend. It
 * opens, pans and zooms nothing of its own once the run has begun: what a step is about comes
 * into view as the person presses its caption box's button (`show`), or as they go there.
 */
// A terminal held at something of its own the person answers there: a teammate's screen, its
// program ended, or an agent asking their permission.
const waitingOn = (signals: TourSignals): string | undefined =>
  signals.teamScreen?.terminalId ?? signals.teamLeft?.terminalId ?? signals.permission?.terminalId

const hasShow = ({ moves, tab }: TourShow): boolean => moves.length > 0 || tab !== null

export const useTourDriver = ({ backend, workspace, commands }: TourHost): TourDriver => {
  const { tour } = backend
  // What else its signals read: the agents' messages and the Inbox, where the backend has them.
  const messages = useSyncExternalStore(backend.messages?.state.subscribe ?? noState, () =>
    backend.messages?.state.getSnapshot(),
  )
  const inbox = useSyncExternalStore(backend.inbox?.state.subscribe ?? noState, () =>
    backend.inbox?.state.getSnapshot(),
  )
  // The works the backend tracks, which say when the modeller and the builder have changed their
  // files: followed while a run is (below), as the Worktrees panel would.
  const worksState = backend.works?.state
  const works = useSyncExternalStore(
    worksState?.subscribe ?? noState,
    () => worksState?.getSnapshot().works,
  )
  // The approvals waiting on the person, one of which is the lead's run.
  const approvals = useSyncExternalStore(backend.approvals?.pending.subscribe ?? noState, () =>
    backend.approvals?.pending.getSnapshot(),
  )
  const [closing, setClosingNow] = useState<StoredClosing | null>(readClosing)
  const [keepError, setKeepError] = useState<string | null>(null)
  // Kept as the run is, so a reload still ends on it.
  const setClosing = useCallback((next: StoredClosing | null): void => {
    writeClosing(next)
    setClosingNow(next)
  }, [])
  // A run followed again after a reload waits afresh: the time the page was away isn't the
  // agent's, and the Inbox lists a question anew only a moment later. A step done holds again
  // from now, once its caption shows again.
  const [run, setRun] = useState<TourRun | null>(() => {
    const stored = readTourRun()
    const now = Date.now()
    return (
      stored && {
        ...stored,
        stepAt: now,
        waitingSince: now,
        doneAt: stored.doneAt === null ? null : now,
      }
    )
  })
  const steps = run ? stepsFor(run) : stepsOf(true)
  const following = run !== null
  useEffect(() => (following ? backend.works?.watch() : undefined), [following, backend.works])
  // The run as the last event left it, which the next one moves on from, so a burst of events
  // in one frame each builds on the one before.
  const current = useRef(run)
  // The lead's first line to ring again, for the run it was for, and how many times it was tried.
  const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; tries: number }>({ tries: 0 })
  const dropRetry = useCallback((): void => {
    clearTimeout(retry.current.timer)
    retry.current = { tries: 0 }
  }, [])
  // The same, for what runs later: a retry reads them as they are by then.
  const sources = useRef({ messages, inbox, works, approvals })
  useEffect(() => {
    sources.current = { messages, inbox, works, approvals }
  }, [messages, inbox, works, approvals])
  const patienceMs = tour?.patienceMs ?? defaultPatienceMs
  const signals = useSelected(
    workspace,
    (state) =>
      run ? tourSignals(state, run.terminalId, { messages, inbox, works, approvals }) : noSignals,
    sameSignals,
  )

  // Keeps the project through the backend, best effort: a refusal is kept to show on the card.
  const keep = useCallback((): void => {
    setKeepError(null)
    tour?.keep?.().then(undefined, (error: unknown) => {
      console.error("Novadeck couldn't keep the tour's project:", error)
      setKeepError(
        error instanceof Error && error.message ? error.message : "Something went wrong.",
      )
    })
  }, [tour])

  const make = useCallback(
    (moves: readonly TourMade[]): void => {
      for (const move of moves)
        if (move.kind === "view") commands.changeView(move.view)
        else if (move.kind === "travel") commands.travel(move.terminalId)
        // A frame later: the view just changed, and Canvas hears a framing only once it's there.
        else requestAnimationFrame(() => requestAnimationFrame(() => commands.frameAll()))
    },
    [commands],
  )

  // Moves the run on by one event and acts on what follows: ringing the lead its first line
  // (again, a little later, where the backend refused) or a nudge.
  const dispatch = useCallback(
    function dispatch(event: TourEvent): void {
      const before = current.current
      if (!before) return
      const outcome = stepRun(before, stepsFor(before), event, patienceMs)
      current.current = outcome.run
      writeTourRun(outcome.run, outcome.run && stepsFor(outcome.run))
      setRun(outcome.run)
      if (!outcome.run) dropRetry()
      // Its story done: the project is the person's to keep, so it is kept at once, whatever
      // they do with the closing card; a refusal shows on the card.
      if (outcome.end === "done") keep()
      // Its closing card, in the project it ran in.
      if (outcome.end === "done") {
        const project = workspace
          .getSnapshot()
          .projects.find((each) =>
            each.history.some((session) =>
              session.state.roster.terminals.some(({ id }) => id === before.terminalId),
            ),
          )
        setClosing({
          terminalId: before.terminalId,
          projectId: project?.id ?? null,
          agent: before.agent,
        })
      }
      const { terminalId } = before
      // Only for the run it was for: one ended or begun anew since lets it go.
      const again = (): void => {
        if (current.current?.terminalId !== terminalId) return
        dispatch({
          type: "signals",
          signals: tourSignals(workspace.getSnapshot(), terminalId, sources.current),
          now: Date.now(),
        })
      }
      // Rings the lead its first line through the backend; where it refuses, the run is told,
      // and it is rung again a little later, up to `briefTries` times.
      if (outcome.brief && tour)
        tour.brief(terminalId).then(
          () => {
            clearTimeout(retry.current.timer)
            retry.current = { tries: 0 }
          },
          (error: unknown) => {
            console.error("Novadeck couldn't give the tour's agent its brief:", error)
            if (current.current?.terminalId !== terminalId) return
            const { tries } = retry.current
            if (tries >= briefTries) return
            dispatch({ type: "brief-failed" })
            clearTimeout(retry.current.timer)
            retry.current = { tries: tries + 1, timer: setTimeout(again, briefRetryMs) }
          },
        )
      if (outcome.nudge)
        tour
          ?.nudge?.(outcome.nudge)
          .catch((error: unknown) =>
            console.error("Novadeck couldn't nudge the tour's agent:", error),
          )
    },
    [tour, patienceMs, keep, workspace, dropRetry, setClosing],
  )

  // A retry left waiting goes with the page.
  useEffect(() => dropRetry, [dropRetry])

  // Each change of its signals moves it on.
  useEffect(() => {
    if (current.current) dispatch({ type: "signals", signals, now: Date.now() })
  }, [signals, dispatch])

  // And so does the end of a wait.
  const tickAt = run ? nextTick(run, steps, signals, patienceMs) : null
  useEffect(() => {
    if (tickAt === null) return
    const timer = setTimeout(
      () => dispatch({ type: "tick", signals, now: Date.now() }),
      Math.max(0, tickAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [tickAt, signals, dispatch])

  // The step's caption box showed, or the person touched what it marks: the run is told, with
  // the signals as they are now.
  const told = useCallback(
    (type: "caption" | "touched", line: string): void => {
      const now = current.current
      if (!now) return
      dispatch({
        type,
        line,
        signals: tourSignals(workspace.getSnapshot(), now.terminalId, sources.current),
        now: Date.now(),
      })
    },
    [dispatch, workspace],
  )
  const captioned = useCallback((line: string): void => told("caption", line), [told])
  const touched = useCallback((line: string): void => told("touched", line), [told])

  const begin = useCallback(
    (agent: AgentName, started: TourStarted): void => {
      dropRetry()
      // A closing card left open from a tour before goes, as its project did.
      setClosing(null)
      const { brief, command, page } = started.run
      const next = beginRun(
        { terminalId: started.terminalId, agent, brief, command, page },
        Date.now(),
      )
      current.current = next
      writeTourRun(next, stepsFor(next))
      setRun(next)
      // As the person started it: the tour plays in Canvas, on its lead's window. The one time
      // the tour moves the view; from here on only the person does, or their press on a caption
      // box's button.
      make([
        { kind: "view", view: "canvas" },
        { kind: "travel", terminalId: started.terminalId },
      ])
    },
    [dropRetry, setClosing, make],
  )

  // What the caption box's button brings into view: a terminal held at something of its own, or
  // the step's subject.
  const show = useCallback((): void => {
    const now = current.current
    if (!now) return
    const state = tourSignals(workspace.getSnapshot(), now.terminalId, sources.current)
    const waiting = waitingOn(state)
    if (waiting) return commands.travel(waiting)
    // A panel the coach points to open by its rail button, where the rail is hidden (Zen).
    const click = coachNow(now, stepsFor(now), state)?.click ?? []
    const panel = click.includes("inbox-button")
      ? "inbox"
      : click.includes("files-button")
        ? "files"
        : null
    if (panel) return commands.showPanel(panel)
    const again = showAgain(now, stepsFor(now), state)
    make(again.moves)
    if (again.tab) commands.openBarTab(again.tab.terminalId, again.tab.key)
  }, [workspace, commands, make])

  const projectOf = useSelected(
    workspace,
    (state) =>
      run
        ? (state.projects.find((project) =>
            project.history.some((session) =>
              session.state.roster.terminals.some(({ id }) => id === run.terminalId),
            ),
          )?.id ?? null)
        : null,
    Object.is,
  )

  const shown = useMemo(() => {
    if (!run) return null
    const coach = coachNow(run, steps, signals)
    return {
      terminalId: run.terminalId,
      agent: run.agent,
      coach,
      // Only for the step's own box, or one pointing at a terminal held at something of its own:
      // not for a teammate's question, whose rail button the tour marks.
      bring:
        coach !== null &&
        ((coach.terminalId !== undefined && coach.terminalId === waitingOn(signals)) ||
          (coach === steps[run.step]?.coach && hasShow(showAgain(run, steps, signals)))),
      act: steps[Math.min(run.step, steps.length - 1)]!.act,
      // A teammate's question, which the tour points at whatever the step, else the lead's sheet.
      askingRow: signals.askingRow ?? signals.sheet.row,
      roles: signals.roles,
      open: signals.open,
      team: signals.team.ids,
      away: !signals.onScreen,
    }
  }, [run, steps, signals])

  return useMemo(
    () => ({
      begin,
      captioned,
      touched,
      show,
      shown,
      closing: closing && { ...closing, keepError },
      retryKeep: keep,
      close: () => setClosing(null),
      end: () => dispatch({ type: "end" }),
      back: () => {
        if (run && projectOf) commands.revealTerminal(run.terminalId, projectOf)
      },
    }),
    [
      begin,
      captioned,
      touched,
      show,
      shown,
      dispatch,
      run,
      projectOf,
      commands,
      closing,
      keepError,
      keep,
      setClosing,
    ],
  )
}
