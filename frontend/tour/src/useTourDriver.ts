import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { beginRun, coachNow, nextTick, stepRun, type TourEvent, type TourRun } from "./driver"
import { askFixer } from "./fixer-call"
import { noTeam, sameSignals, tourSignals, type TourSignals } from "./signals"
import type { TourStarted } from "./start"
import {
  closingMoves,
  stepsOf,
  type Coach,
  type TourAct,
  type TourMove,
  type TourStep,
} from "./steps"
import type { TourHost } from "./tour-host"
import { useSelected } from "./use-selected"

// How long the tour waits on its agent at a step before nudging it, unless the backend says.
const defaultPatienceMs = 90_000
// How soon it rings an agent's first line again where the backend refused it, and how many
// times before it gives up: a refusal that stands (a terminal outside the tour's folder) isn't
// asked again forever.
const briefRetryMs = 2_000
const briefTries = 5
// How long after a window lands the tour frames the team again, for Canvas to settle first.
const frameSettleMs = 400

// Where a run is kept, in this window's session storage: a reload while the tour runs follows
// it again, as its terminal survives the reload.
const storageKey = "novadeck.tour"

const isRun = (value: unknown): value is TourRun => {
  if (typeof value !== "object" || value === null) return false
  const run = value as Record<string, unknown>
  return (
    typeof run.terminalId === "string" &&
    harnesses.some(({ id }) => id === run.agent) &&
    (run.brief === "launch" || run.brief === "doorbell") &&
    typeof run.step === "number" &&
    typeof run.waitingSince === "number" &&
    ["nudged", "briefed", "asked", "entered"].every((key) => typeof run[key] === "boolean")
  )
}

// The step a stored run was at is kept by its id beside its index, so a run kept by a version
// whose steps differed (one with no id, or whose id isn't at that index now) is dropped, not
// followed at some other step.
const stepIdOf = (steps: readonly TourStep[], index: number): string => steps[index]?.id ?? "end"

export const readTourRun = (steps: readonly TourStep[]): TourRun | null => {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null")
    if (!isRun(stored)) return null
    const { stepId } = stored as unknown as { readonly stepId?: unknown }
    if (stored.step < 0 || stored.step > steps.length || stepId !== stepIdOf(steps, stored.step))
      return null
    // A run kept from before steps held on their result has no `doneAt`.
    return { ...stored, doneAt: typeof stored.doneAt === "number" ? stored.doneAt : null }
  } catch {
    return null
  }
}

const writeTourRun = (run: TourRun | null, steps: readonly TourStep[]): void => {
  try {
    // A question seen isn't kept: after a reload the Inbox lists it anew, and until it has, its
    // absence would read as answered.
    if (run)
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ ...run, asked: false, stepId: stepIdOf(steps, run.step) }),
      )
    else sessionStorage.removeItem(storageKey)
  } catch {
    // Without storage, a run isn't followed again after a reload.
  }
}

// The closing card while it shows, kept beside the run.
const closingKey = "novadeck.tour.closing"

const readClosing = (): TourDriver["closing"] => {
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

const writeClosing = (closing: TourDriver["closing"]): void => {
  try {
    if (closing) sessionStorage.setItem(closingKey, JSON.stringify(closing))
    else sessionStorage.removeItem(closingKey)
  } catch {
    // Without storage, a reload doesn't bring the closing card back.
  }
}

const noShells: readonly string[] = []
const noRefused: ReadonlySet<string> = new Set()

const noSignals: TourSignals = { lead: { kind: "gone" }, onScreen: false, ...noTeam }
const noState = (): (() => void) => () => {}

export type TourDriver = {
  // Follows a run the person just started.
  readonly begin: (agent: AgentName, started: TourStarted) => void
  // The run followed now, with what it shows; null while none runs.
  readonly shown: {
    readonly terminalId: string
    readonly agent: AgentName
    readonly coach: Coach | null
    // The act its step belongs to, which a wipe opens.
    readonly act: TourAct
    // The Inbox row of the team's question waiting now.
    readonly askingRow: string | null
    // The window that shows the merged preview of the tour's file.
    readonly previewWindow: string | null
    readonly away: boolean
  } | null
  // The tour just finished its story, for its closing card: its lead, project and agent.
  readonly closing: {
    readonly terminalId: string
    readonly projectId: string | null
    readonly agent: AgentName
  } | null
  readonly end: () => void
  // Puts the closing card away.
  readonly close: () => void
  // Brings the tour's project, and its lead, back on screen.
  readonly back: () => void
}

/**
 * Follows a run of the tour: reads its signals off the workspace, moves it on with each change
 * and as its waits end, makes each step's moves once as it begins, and rings its lead its
 * first line, or a nudge, through the backend. It never takes the person's view back: a step's
 * moves are made once, and only while the tour's project is on screen.
 */
export const useTourDriver = ({
  backend,
  workspace,
  commands,
  previews: previewStore,
}: TourHost): TourDriver => {
  const { tour } = backend
  // The story it plays: without a way to start the person's fixer it has no step for it.
  const steps = useMemo(() => stepsOf(tour?.fixer !== undefined), [tour?.fixer])
  // What else its signals read: the agents' messages and the Inbox, where the backend has them.
  const messages = useSyncExternalStore(backend.messages?.state.subscribe ?? noState, () =>
    backend.messages?.state.getSnapshot(),
  )
  const inbox = useSyncExternalStore(backend.inbox?.state.subscribe ?? noState, () =>
    backend.inbox?.state.getSnapshot(),
  )
  // The works the backend tracks, which say when a fixer's fix has landed: followed while a run
  // is (below), as the Worktrees panel would.
  const worksState = backend.works?.state
  const works = useSyncExternalStore(
    worksState?.subscribe ?? noState,
    () => worksState?.getSnapshot().works,
  )
  // The files the person has open merged, in the app's sessions.
  const previews = useSyncExternalStore(previewStore.subscribe, previewStore.getSnapshot)
  const [closing, setClosingNow] = useState<TourDriver["closing"]>(readClosing)
  // Kept as the run is, so a reload still ends on it.
  const setClosing = useCallback((next: TourDriver["closing"]): void => {
    writeClosing(next)
    setClosingNow(next)
  }, [])
  // A run followed again after a reload waits afresh: the time the page was away isn't the
  // agent's, and the Inbox lists a question anew only a moment later.
  const [run, setRun] = useState<TourRun | null>(() => {
    const stored = readTourRun(steps)
    return stored && { ...stored, waitingSince: Date.now() }
  })
  const following = run !== null
  useEffect(() => (following ? backend.works?.watch() : undefined), [following, backend.works])
  // The run as the last event left it, which the next one moves on from, so a burst of events
  // in one frame each builds on the one before.
  const current = useRef(run)
  // A ring of the first line to try again, for the run it was for, and how many were tried.
  const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; tries: number }>({ tries: 0 })
  const dropRetry = useCallback((): void => {
    clearTimeout(retry.current.timer)
    retry.current = { tries: 0 }
  }, [])
  // The same, for what runs later: a retry reads them as they are by then.
  const sources = useRef({ messages, inbox, previews, works, openedAfter: run?.fileAfter })
  useEffect(() => {
    sources.current = { messages, inbox, previews, works, openedAfter: run?.fileAfter }
  }, [messages, inbox, previews, works, run?.fileAfter])
  const patienceMs = tour?.patienceMs ?? defaultPatienceMs
  const signals = useSelected(
    workspace,
    (state) =>
      run
        ? tourSignals(state, run.terminalId, {
            messages,
            inbox,
            previews,
            works,
            openedAfter: run.fileAfter,
          })
        : noSignals,
    sameSignals,
  )

  const make = useCallback(
    (terminalId: string, moves: readonly TourMove[]): void => {
      for (const move of moves)
        if (move.kind === "view") commands.changeView(move.view)
        else if (move.kind === "reveal") commands.reveal(terminalId, move.panel)
        // A frame later: the view just changed, and Canvas hears a framing only once it's there.
        else if (move.kind === "fit-all")
          requestAnimationFrame(() => requestAnimationFrame(() => commands.frameAll()))
        else commands.showInbox()
    },
    [commands],
  )

  // Moves the run on by one event and acts on what follows: a step's moves, and ringing the
  // lead its first line (again, a little later, where the backend refused) or a nudge.
  const dispatch = useCallback(
    function dispatch(event: TourEvent): void {
      const before = current.current
      if (!before) return
      const outcome = stepRun(before, steps, event, patienceMs)
      current.current = outcome.run
      writeTourRun(outcome.run, steps)
      setRun(outcome.run)
      if (!outcome.run) dropRetry()
      // Its story done: the closing card, in the project it ran in.
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
      // Its story done, every window framed for the closing card.
      make(terminalId, outcome.end === "done" ? closingMoves : outcome.moves)
      // Only for the run it was for: one ended or begun anew since lets it go.
      const again = (): void => {
        if (current.current?.terminalId !== terminalId) return
        dispatch({
          type: "signals",
          signals: tourSignals(workspace.getSnapshot(), terminalId, sources.current),
          now: Date.now(),
        })
      }
      if (outcome.brief)
        tour?.brief(terminalId).then(
          () => dropRetry(),
          (error: unknown) => {
            console.error("Novadeck couldn't give the tour's agent its brief:", error)
            if (current.current?.terminalId !== terminalId) return
            if (retry.current.tries >= briefTries) return
            dispatch({ type: "brief-failed" })
            clearTimeout(retry.current.timer)
            retry.current = {
              tries: retry.current.tries + 1,
              timer: setTimeout(again, briefRetryMs),
            }
          },
        )
      if (outcome.nudge)
        tour
          ?.nudge?.(terminalId)
          .catch((error: unknown) =>
            console.error("Novadeck couldn't nudge the tour's agent:", error),
          )
    },
    [tour, steps, patienceMs, make, workspace, dropRetry, setClosing],
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

  const begin = useCallback(
    (agent: AgentName, started: TourStarted): void => {
      dropRetry()
      // A closing card left open from a tour before goes, as its project did.
      setClosing(null)
      const next = beginRun(
        { terminalId: started.terminalId, agent, brief: started.run.brief },
        Date.now(),
      )
      current.current = next
      writeTourRun(next, steps)
      setRun(next)
    },
    [dropRetry, setClosing, steps],
  )

  // While a step frames the team, each window the team gains is framed with the rest, a moment
  // after it lands: Canvas sets its camera afresh as a window comes, and drops a framing asked
  // before it settles. Only a new window: coming back to the tour, the person's own framing stays.
  const framing = run && steps[run.step]?.frameTeam && signals.onScreen ? signals.team.count : null
  const framingFor = run?.terminalId
  // The most windows framed so far, for the run it was for: another run starts from none.
  const framed = useRef({ terminalId: framingFor, count: 0 })
  useEffect(() => {
    if (framed.current.terminalId !== framingFor)
      framed.current = { terminalId: framingFor, count: 0 }
    if (framing === null || framing <= framed.current.count) return
    framed.current = { terminalId: framingFor, count: framing }
    const timer = setTimeout(() => commands.frameAll(), frameSettleMs)
    return () => clearTimeout(timer)
  }, [framing, framingFor, commands])

  // A teammate held at its own agent's screen (a mixed team's folder trust), or an agent asking
  // the person's permission, waits on them in its terminal, which isn't on screen: brought there
  // once per hold, for the coach to point at.
  const held =
    run && signals.onScreen
      ? (signals.teamScreen?.terminalId ?? signals.permission?.terminalId)
      : undefined
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!held) revealed.current = null
    if (!held || revealed.current === held) return
    revealed.current = held
    commands.reveal(held)
  }, [held, commands])

  // The shell the person opens in the tour's project at its prompt (the `yours` step) is handed to
  // the backend once, to start the person's agent there as the second fixer; a refusal is asked
  // again a little later, as the brief's is, unless it is a conflict, which stands. A shell the
  // backend refused for good, or never took, is left: the next one the person opened is the
  // candidate, so one refused terminal never holds the step; the newest is asked first, and a
  // call made while another is under way is refused by the backend as a second fixer.
  const fixer = tour?.fixer
  const shells = run && steps[run.step]?.id === "yours" ? signals.fresh : noShells
  const [refused, setRefused] = useState<ReadonlySet<string>>(noRefused)
  const candidate = shells.find((id) => !refused.has(id))
  useEffect(() => {
    if (!candidate || !fixer) return
    return askFixer(fixer, candidate, {
      tries: briefTries,
      retryMs: briefRetryMs,
      onRefused: () => setRefused((now) => new Set(now).add(candidate)),
    })
  }, [candidate, fixer])

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

  const shown = useMemo(
    () =>
      run && {
        terminalId: run.terminalId,
        agent: run.agent,
        coach: coachNow(run, steps, signals),
        act: steps[Math.min(run.step, steps.length - 1)]!.act,
        askingRow: signals.askingRow,
        previewWindow: signals.preview?.windowId ?? null,
        away: !signals.onScreen,
      },
    [run, steps, signals],
  )

  return useMemo(
    () => ({
      begin,
      shown,
      closing,
      close: () => setClosing(null),
      end: () => dispatch({ type: "end" }),
      back: () => {
        if (run && projectOf) commands.revealTerminal(run.terminalId, projectOf)
      },
    }),
    [begin, shown, dispatch, run, projectOf, commands, closing, setClosing],
  )
}
