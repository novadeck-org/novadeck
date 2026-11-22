import type { AgentName } from "@novadeck/core/harnesses"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import type { TerminalMetadata } from "@novadeck/core/types"

import type { DemoTurns } from "../agents/turns"
import type { DemoTour, TourStage } from "../tour"
import { planFile, worktreeRoot } from "../works"
import { branches, coverContent, coverFile, type Hero } from "./content"
import { artistName, coverAsk, coverTold, namedAs, tourStoryMs } from "./story"

const noop = () => {}

type Artist = {
  readonly key: TerminalKey
  readonly harness: AgentName
  readonly tour: DemoTour
  readonly turns: DemoTurns
  readonly dispatch: (actions: BackendAction[]) => void
  readonly stage: TourStage
  readonly terminal: () => TerminalMetadata | undefined
  // It does nothing, once briefed, until nudged.
  readonly quiet: boolean
  // Its agent never starts: its terminal shows none.
  readonly never: boolean
}

// Plays the artist the tour starts in a terminal of its own, on no team: at its prompt until the
// tour rings its brief; then it describes itself, asks the lead what the game is, and, once the
// lead answers, draws the cover in a worktree of its own, shows it and tells the lead. Answers a
// function that stops it.
export const playTourArtist = ({
  key,
  harness,
  tour,
  turns,
  dispatch,
  stage,
  terminal,
  quiet,
  never,
}: Artist): (() => void) => {
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
  // Calls `then` once `ready` holds.
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
  const verbs = turns.as(harness)
  const handle = (): string => terminal()?.handle ?? "artist"
  const sessionTarget = { projectId: key.projectId, workspaceSessionId: key.workspaceSessionId }

  // Once the lead answered: the worktree, the cover, the image shown, the lead told.
  const draw = (hero: Hero) => {
    if (!alive()) return
    verbs.work(key, terminal())
    later(tourStoryMs.work, () => {
      const root = worktreeRoot("tour", branches.artist)
      stage.works?.openBranch(
        { projectId: key.projectId, terminalId: key.terminalId, root },
        branches.artist,
      )
      later(tourStoryMs.work, () => {
        stage.works?.setFiles(
          key.terminalId,
          [planFile(coverFile, 16, 0, { status: "added" })],
          Date.now(),
        )
        stage.files?.write(handle(), coverFile, "added")
        later(tourStoryMs.show, () => {
          stage.show(key, {
            kind: "image",
            name: "cover.svg",
            detail: "SVG, 960 × 540",
            path: `${root}/${coverFile}`,
            url: null,
            content: coverContent(hero),
          })
          const lead = stage.leadHandle()
          if (lead) stage.messages?.send(sessionTarget, handle(), lead, coverTold)
          stage.files?.end(handle())
          verbs.finish(key, terminal(), "completed", {
            after: tourStoryMs.talk,
            reply: "The cover is done.",
          })
        })
      })
    })
  }

  // Asks the lead what the game is, and waits for its answer.
  const ask = () => {
    const found = alive()
    const lead = stage.leadHandle()
    if (!found) return
    // No lead to ask (the story is over): it is done with nothing.
    if (!lead) return
    stage.messages?.join(sessionTarget, { terminalId: key.terminalId, handle: handle() })
    stage.messages?.send(sessionTarget, handle(), lead, coverAsk)
    stops.add(
      stage.onArtistAnswered(key, (hero) => {
        later(tourStoryMs.talk, () => draw(hero))
      }),
    )
    stage.askedLead({ key, handle: handle(), harness })
    verbs.finish(key, terminal(), "completed", {
      after: tourStoryMs.talk,
      reply: "I asked the lead about the game.",
    })
  }

  const describe = () => {
    const found = alive()
    if (!found) return
    dispatch([namedAs(key, artistName, found.handle ?? harness)])
    if (!tour.story()) {
      verbs.finish(key, terminal(), "completed", {
        after: tourStoryMs.talk,
        reply: "That's the cover artist: ready.",
      })
      return
    }
    later(tourStoryMs.talk, ask)
  }

  const work = () => {
    if (!alive()) return
    verbs.work(key, terminal())
    later(tourStoryMs.work, describe)
  }

  // At its prompt, no turn begun, until the tour rings its brief (and, if quiet, nudges it).
  later(tourStoryMs.bind, () => {
    if (!alive() || never) return
    verbs.rest(key, terminal())
    const briefed = () => tour.artists.getSnapshot().includes(key.terminalId)
    const before = tour.nudged.getSnapshot().filter((id) => id === key.terminalId).length
    when(
      (poke) => tour.artists.subscribe(poke),
      briefed,
      () => {
        if (!quiet) return later(tourStoryMs.bind, work)
        when(
          (poke) => tour.nudged.subscribe(poke),
          () => tour.nudged.getSnapshot().filter((id) => id === key.terminalId).length > before,
          () => later(tourStoryMs.bind, work),
        )
      },
    )
  })

  return () => {
    over = true
    timers.forEach(clearTimeout)
    timers.clear()
    stops.forEach((stop) => stop())
    stops.clear()
    turns.release(key)
  }
}
