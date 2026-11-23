import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import {
  beginRun,
  coachNow,
  nextTick,
  stepRun,
  stepsFor,
  type TourEvent,
  type TourMade,
  type TourRun,
} from "./driver"
import { noTeam, sameSignals, tourSignals, type TourSignals } from "./signals"
import type { TourStarted } from "./start"
import { closingMoves, stepsOf, type Coach, type TourAct, type TourStep } from "./steps"
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
// How long after a window lands the tour frames the team again, for Canvas to settle first.
const frameSettleMs = 400

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
    ["page", "nudged", "briefed", "asked", "entered", "tabbed", "declined"].every(
      (key) => typeof run[key] === "boolean",
    )
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
  // The run followed now, with what it shows; null while none runs.
  readonly shown: {
    readonly terminalId: string
    readonly agent: AgentName
    readonly coach: Coach | null
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
 * and as its waits end, makes each step's moves once as it begins, and rings its lead its
 * first line, or a nudge, through the backend. It never takes the person's view back: a step's
 * moves are made once, and only while the tour's project is on screen.
 */
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
        else if (move.kind === "reveal") commands.reveal(move.terminalId, move.panel)
        // A frame later: the view just changed, and Canvas hears a framing only once it's there.
        else if (move.kind === "fit-all")
          requestAnimationFrame(() => requestAnimationFrame(() => commands.frameAll()))
        else commands.showInbox()
    },
    [commands],
  )

  // Moves the run on by one event and acts on what follows: a step's moves and pane tab, and
  // ringing the lead its first line (again, a little later, where the backend refused) or a
  // nudge.
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
      // Its story done, every window framed for the closing card.
      make(outcome.end === "done" ? closingMoves : outcome.moves)
      if (outcome.tab) commands.openBarTab(outcome.tab.terminalId, outcome.tab.key)
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
    [tour, patienceMs, make, keep, commands, workspace, dropRetry, setClosing],
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

  // The step's caption box showed: the run is told, with the signals as they are now.
  const captioned = useCallback(
    (line: string): void => {
      const now = current.current
      if (!now) return
      dispatch({
        type: "caption",
        line,
        signals: tourSignals(workspace.getSnapshot(), now.terminalId, sources.current),
        now: Date.now(),
      })
    },
    [dispatch, workspace],
  )

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
    },
    [dropRetry, setClosing],
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

  // A teammate held at its own agent's screen (its own question, as folder trust or sign-in), or
  // an agent asking the person's permission, waits on them in its terminal, which isn't on
  // screen: brought there once per hold, for the coach to point at.
  const held =
    run && signals.onScreen
      ? (signals.teamScreen?.terminalId ??
        signals.teamLeft?.terminalId ??
        signals.permission?.terminalId)
      : undefined
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!held) revealed.current = null
    if (!held || revealed.current === held) return
    revealed.current = held
    commands.reveal(held)
  }, [held, commands])

  // A teammate's own question to the person waits in the Inbox: it is opened once per question,
  // for the coach to point at its row.
  const question = run && signals.onScreen && !held ? signals.askingRow : null
  const questioned = useRef<string | null>(null)
  useEffect(() => {
    if (!question) questioned.current = null
    if (!question || questioned.current === question) return
    questioned.current = question
    commands.showInbox()
  }, [question, commands])

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
        // A teammate's question, which the tour points at whatever the step, else the lead's sheet.
        askingRow: signals.askingRow ?? signals.sheet.row,
        roles: signals.roles,
        open: signals.open,
        team: signals.team.ids,
        away: !signals.onScreen,
      },
    [run, steps, signals],
  )

  return useMemo(
    () => ({
      begin,
      captioned,
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
