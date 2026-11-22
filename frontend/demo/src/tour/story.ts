import type { AgentName } from "@novadeck/core/harnesses"
import type { InboxAnswer, InboxEntry } from "@novadeck/core/inbox"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import type { TerminalMetadata } from "@novadeck/core/types"

import type { DemoTurns } from "../agents/turns"
import { demoTourFolder, type DemoTour, type TourStage } from "../tour"
import { demoRun } from "../tour-runs"
import { planFile, worktreeRoot } from "../works"
import { terminalOf } from "../workspace"
import {
  branches,
  configFile,
  coverFile,
  fixerChanges,
  fixerDiffs,
  heroFile,
  heroOf,
  modelOf,
  pageContent,
  readmeFile,
  scoreFile,
  serverCommand,
  type Hero,
} from "./content"

// The story of the tour, as a runner would report it once the lead described itself: the lead
// opens a sculptor and a score fixer, asks to run the game's server and shows its page; the
// sculptor shows its model and asks the person who the hero is, then sculpts it; the fixer fixes
// the score and shows its changes; the lead names the game. An artist the tour starts on no team
// asks the lead what the game is, and draws its cover (`artist.ts`). Every step reaches the UI as
// the real thing does: terminals the lead leads, messages between them, an Inbox ask, works that
// change files, items on the agents' bars, writes in the Files panel.

// How long each step takes: short and fixed, so specs run fast. The person's answer, and their
// yes to the command, wait as long as they take.
export const tourStoryMs = {
  open: 300,
  bind: 300,
  work: 300,
  talk: 300,
  show: 400,
  // How long after its team is opened the lead asks to run the server: the team step's line has
  // its moment first (it holds 3 s once both teammates are named).
  serve: 3_800,
} as const

export const sculptorName = "Sculptor"
export const fixerName = "Score fixer"
export const artistName = "Cover artist"
export const serverName = "Game server"

export const heroSubject = "Who is your game's hero?"
export const heroOptions = ["A rocket", "A robot", "A cat"] as const

export const heroTold = (hero: Hero): string => `The hero is ${hero.name}.`
export const heroSculpted = "Hero sculpted."
export const scoreFixed = "Score fixed."
export const coverAsk =
  "I'm drawing the cover for your game. What is it called, and who is its hero?"
export const coverTold = `The cover is done: ${coverFile} in my worktree.`
export const coverAnswer = (hero: Hero): string =>
  `It's "${hero.title}", and its hero is ${hero.name}. Its picture belongs in ${coverFile}.`

const target = ({ projectId, workspaceSessionId }: TerminalKey) => ({
  projectId,
  workspaceSessionId,
})

// The command a teammate's terminal runs, as `open_agent` starts an agent: its harness, on the
// model the tour's lead runs on.
export const teammateCommand = (harness: AgentName): string =>
  `${harness} --model ${demoRun(harness).model}`

// A terminal the lead opened: led by it, as `open_agent` makes it.
export const openedTeammate = (
  key: TerminalKey,
  terminal: TerminalMetadata,
  lead: string,
): BackendAction => ({
  type: "terminal/add",
  target: target(key),
  terminal: { ...terminal, ledBy: lead, openedBy: lead },
})

// A terminal the lead opened with `open_terminal`: its own, led by no one, titled by the lead.
export const openedShell = (
  key: TerminalKey,
  terminal: TerminalMetadata,
  lead: string,
  by: string,
): BackendAction => ({
  type: "terminal/add",
  target: target(key),
  terminal: {
    ...terminal,
    name: serverName,
    titleSource: { kind: "agent", by },
    openedBy: lead,
  },
})

// An agent's describe: its terminal takes the name, as the agent's own, by its handle.
export const namedAs = (key: TerminalKey, name: string, by: string): BackendAction => ({
  type: "terminal/update",
  target: target(key),
  terminalId: key.terminalId,
  name,
  titleSource: { kind: "agent", by },
})

// The sculptor's ask, as the runner's `ask` makes its entry: three options, from its terminal, the
// agent working on meanwhile.
export const heroAsk = (
  key: TerminalKey,
  terminal: TerminalMetadata,
  harness: AgentName,
  projectName: string,
  at: number,
): InboxEntry => ({
  id: `tour-ask-${key.terminalId}`,
  kind: "ask",
  source: {
    projectId: key.projectId,
    workspaceSessionId: key.workspaceSessionId,
    terminalId: key.terminalId,
    handle: terminal.handle ?? "",
    agent: harness,
    title: terminal.name,
    projectName,
  },
  at,
  stopped: false,
  seen: false,
  ask: {
    subject: heroSubject,
    body: "I'll sculpt it in 3D out of simple shapes. Pick one, or type anything you like.",
    details: null,
    hardToUndo: null,
    shape: {
      type: "options",
      options: heroOptions.map((label) => ({ label, summary: null, details: null, code: null })),
      recommend: null,
    },
  },
})

// The answer picking option `option`, or giving the person's own words, as the Inbox sends it.
export const pickHero = (answer: number | string): InboxAnswer => ({
  kind: "ask",
  answer:
    typeof answer === "number"
      ? { type: "reply", option: answer, text: "" }
      : { type: "reply", option: null, text: answer },
})

// The hero an answer names: the option picked, or the person's own words. An ask that ended
// unanswered (dismissed, withdrawn) leaves the first option.
export const chosenHero = (answer: InboxAnswer | undefined): Hero => {
  const reply = answer?.kind === "ask" && answer.answer.type === "reply" ? answer.answer : undefined
  const option = reply?.option
  if (option !== null && option !== undefined && heroOptions[option])
    return heroOf(heroOptions[option])
  const own = reply?.text.trim()
  return heroOf(own || heroOptions[0])
}

type Story = {
  readonly key: TerminalKey
  readonly harness: AgentName
  readonly tour: DemoTour
  readonly turns: DemoTurns
  readonly dispatch: (actions: BackendAction[]) => void
  readonly stage: TourStage
  // The lead's terminal as the workspace holds it now; none once it's closed.
  readonly terminal: () => TerminalMetadata | undefined
  // The lead opens its team only once nudged again.
  readonly quietTeam: boolean
  // The sculptor does nothing, once it is there, until nudged.
  readonly quietSculptor: boolean
  // There is no page: this computer has neither Node nor Python.
  readonly noPage: boolean
  // Ends the lead's turn once both teammates have reported.
  readonly finish: () => void
}

const handleOf = (found: TerminalMetadata | undefined, fallback: string) =>
  found?.handle ?? fallback

export type Teammate = {
  readonly key: TerminalKey
  readonly handle: string
  readonly harness: AgentName
}

// Plays the story after the lead described itself, answering a function that stops it.
export const playTourStory = ({
  key,
  harness,
  tour,
  turns,
  dispatch,
  stage,
  terminal,
  quietTeam,
  quietSculptor,
  noPage,
  finish,
}: Story): (() => void) => {
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
  const current = (at: TerminalKey) => terminalOf(stage.workspace(), at)
  const sessionTarget = target(key)
  const lead = () => {
    const found = terminal()
    if (!found) over = true
    return found
  }

  const say = (from: Teammate | "lead", text: string, then?: () => void) => {
    const found = lead()
    if (!found) return
    const handle = (who: Teammate | "lead") =>
      who === "lead" ? handleOf(found, harness) : who.handle
    const sent = stage.messages?.send(sessionTarget, handle(from), handle("lead"), text, then, then)
    // A refused send, or no messages here, goes on as if it landed.
    if (!sent && then) later(tourStoryMs.talk, then)
  }

  // Each teammate's report the lead heard: once both are in, it ends its turn.
  const reported = new Set<string>()
  const reports = (mate: Teammate) => {
    reported.add(mate.key.terminalId)
    if (reported.size >= 2) later(tourStoryMs.show, finish)
  }

  // A teammate binds, works and names itself, then goes on with `named`.
  const settle = (mate: Teammate, name: string, named: () => void) => {
    stage.messages?.join(sessionTarget, { terminalId: mate.key.terminalId, handle: mate.handle })
    later(tourStoryMs.bind, () => {
      if (!current(mate.key)) return
      turns.as(mate.harness).work(mate.key, current(mate.key))
      later(tourStoryMs.work, () => {
        if (!current(mate.key)) return
        dispatch([namedAs(mate.key, name, mate.handle)])
        named()
      })
    })
  }

  // The teammate opens its worktree (`open_worktree`) on `branch`.
  const worktree = (mate: Teammate, branch: string) =>
    stage.works?.openBranch(
      {
        projectId: key.projectId,
        terminalId: mate.key.terminalId,
        root: worktreeRoot("tour", branch),
      },
      branch,
    )
  // It writes `files` there: the work changes exactly these, and the Files panel shows each as
  // the agent writes it, its cursor on the last.
  const write = (
    mate: Teammate,
    files: readonly {
      readonly path: string
      readonly added: number
      readonly removed: number
      readonly status?: "added"
    }[],
  ) => {
    stage.works?.setFiles(
      mate.key.terminalId,
      files.map(({ path, added, removed, status }) =>
        planFile(path, added, removed, status ? { status } : {}),
      ),
      Date.now(),
    )
    for (const file of files) stage.files?.write(mate.handle, file.path, file.status ?? "modified")
  }
  // It tells the lead, and its turn ends.
  const report = (mate: Teammate, text: string, counted = true) => {
    say(mate, text)
    stage.files?.end(mate.handle)
    turns.as(mate.harness).finish(mate.key, current(mate.key), "completed", {
      after: tourStoryMs.talk,
      reply: text,
    })
    if (counted) later(tourStoryMs.talk, () => reports(mate))
  }

  // The lead opens a teammate: a terminal it leads, with a handle at once.
  const hire = (fallback: string): Teammate | undefined => {
    const found = lead()
    if (!found) return undefined
    const base = stage.newTerminal({
      target: sessionTarget,
      directory: demoTourFolder,
      launch: { command: teammateCommand(harness) },
    })
    const mate: Teammate = {
      key: { ...sessionTarget, terminalId: base.id },
      handle: handleOf(base, fallback),
      harness,
    }
    dispatch([openedTeammate(mate.key, base, found.id)])
    return mate
  }

  // The hero the person chose, once they did.
  let hero: Hero | undefined

  // The sculptor's ask waits for the person's answer, as long as it takes; then the sculptor
  // tells the lead who the hero is, the lead names the game in its own worktree, and the sculptor
  // sculpts the model, which the open pane shows anew.
  const asked = (mate: Teammate, modelId: string) => {
    const writer = current(mate.key)
    if (!lead() || !writer) return
    const project = stage.workspace()?.projects.find(({ id }) => id === key.projectId)
    const entry = heroAsk(mate.key, writer, mate.harness, project?.name ?? "", Date.now())
    let seen = false
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      stop()
      stops.delete(stop)
      stopAnswer()
      stops.delete(stopAnswer)
      const chosen = chosenHero(stage.answeredWith(entry.id))
      hero = chosen
      stage.chose(chosen)
      say(mate, heroTold(chosen))
      later(tourStoryMs.talk, () => {
        sculpt(mate, modelId, chosen)
        named(chosen)
      })
    }
    const check = () => {
      const state = stage.inbox?.state.getSnapshot()
      const held = state?.items.find(({ id }) => id === entry.id)
      if (held && !held.settled) {
        seen = true
        return
      }
      // Answered, which takes the entry away, or dismissed or withdrawn, which settles it.
      if (seen || held?.settled) end()
    }
    const stop = stage.inbox?.state.subscribe(check) ?? (() => {})
    const stopAnswer = tour.hero((answer) => stage.answerEntry(entry.id, pickHero(answer)))
    stops.add(stop)
    stops.add(stopAnswer)
    if (!stage.inbox) return later(tourStoryMs.talk, end)
    stage.inbox.add(entry)
    check()
  }

  // The sculptor rewrites hero.gltf in its worktree, and tells the lead.
  const sculpt = (mate: Teammate, modelId: string, chosen: Hero) => {
    write(mate, [{ path: heroFile, added: 38, removed: 12 }])
    stage.update(modelId, modelOf(chosen, "2"))
    later(tourStoryMs.work, () => report(mate, heroSculpted))
  }

  // The lead opens its worktree and names the game in src/config.js.
  const named = (chosen: Hero) => {
    const found = lead()
    if (!found) return
    const mate: Teammate = { key, handle: handleOf(found, harness), harness }
    later(tourStoryMs.work, () => {
      worktree(mate, branches.lead)
      later(tourStoryMs.work, () => {
        write(mate, [{ path: configFile, added: 9, removed: 9 }])
        stage.page(key, pageContent(chosen, 2))
        later(tourStoryMs.talk, () => stage.files?.end(mate.handle))
      })
    })
  }

  // The sculptor binds, names itself, opens its worktree, shows its model and asks.
  const sculptor = (mate: Teammate) =>
    settle(mate, sculptorName, () => {
      worktree(mate, branches.sculptor)
      later(tourStoryMs.work, () => {
        const model = modelOf(undefined, "1")
        const id = stage.show(mate.key, {
          kind: "model",
          name: "hero.gltf",
          detail: "glTF, 3 kB",
          path: `${worktreeRoot("tour", branches.sculptor)}/${heroFile}`,
          url: null,
          content: model.content,
          bytes: model.bytes,
        })
        later(tourStoryMs.show, () => asked(mate, id))
      })
    })

  // The fixer binds, names itself, opens its worktree, fixes the score, shows its changes and
  // reports.
  const fixer = (mate: Teammate) =>
    settle(mate, fixerName, () => {
      worktree(mate, branches.fixer)
      later(tourStoryMs.work, () => {
        write(mate, [
          { path: scoreFile, added: 1, removed: 4 },
          { path: readmeFile, added: 0, removed: 4 },
        ])
        later(tourStoryMs.show, () => {
          const root = worktreeRoot("tour", branches.fixer)
          stage.show(mate.key, {
            kind: "changes",
            name: "fix-score",
            detail: "2 files · +1 −8",
            path: root,
            url: null,
            content: { state: "ready", stamp: "1", content: fixerChanges(root) },
            diffs: fixerDiffs,
          })
          report(mate, scoreFixed)
        })
      })
    })

  // The lead asks to run the game's server in a new terminal, which waits on the person's yes;
  // allowed, a terminal of its own opens and the lead shows the game's page.
  const serve = () => {
    const found = lead()
    if (!found) return
    void stage.approve(key, serverCommand, demoTourFolder).then((approved) => {
      if (over || !approved || !lead()) return
      const base = stage.newTerminal({
        target: sessionTarget,
        directory: demoTourFolder,
        title: serverName,
      })
      dispatch([openedShell(key, base, found.id, handleOf(found, harness))])
      later(tourStoryMs.show, () => stage.page(key, pageContent(undefined, 1)))
    })
  }

  const begin = () => {
    const found = lead()
    if (!found) return
    stage.messages?.join(sessionTarget, {
      terminalId: key.terminalId,
      handle: handleOf(found, harness),
    })
    later(tourStoryMs.open, () => {
      const first = hire("sculptor")
      if (first && quietSculptor) {
        // Held at its prompt, no turn begun, until the tour nudges (the lead, which the tour
        // can't tell from it, or the teammate itself).
        const before = nudged(first.key.terminalId)
        const wake = () => {
          if (nudged(first.key.terminalId) <= before) return
          stop()
          stops.delete(stop)
          sculptor(first)
        }
        const stop = tour.nudged.subscribe(wake)
        stops.add(stop)
        turns.as(first.harness).rest(first.key, current(first.key))
        stage.messages?.join(sessionTarget, {
          terminalId: first.key.terminalId,
          handle: first.handle,
        })
      } else if (first) sculptor(first)
      later(tourStoryMs.open, () => {
        const second = hire("fixer")
        if (second) fixer(second)
        if (!noPage) later(tourStoryMs.serve, serve)
        // Its steps so far done, the lead ends its turn: its team is at work, and each message
        // that comes back wakes it. A lead at rest is what the tour's wait on it counts.
        later(tourStoryMs.show, () =>
          turns.as(harness).finish(key, terminal(), "completed", {
            after: tourStoryMs.talk,
            reply: "My team is at work.",
          }),
        )
      })
    })
  }

  // Nudges the tour rang a terminal (or the lead, which stands for a teammate it can't name yet).
  const nudged = (terminalId: string) =>
    tour.nudged.getSnapshot().filter((id) => id === terminalId || id === key.terminalId).length

  // A lead told to wait opens its team only once nudged again after the point it's at now.
  if (quietTeam) {
    const before = nudged(key.terminalId)
    const wake = () => {
      if (nudged(key.terminalId) <= before) return
      stop()
      stops.delete(stop)
      begin()
    }
    const stop = tour.nudged.subscribe(wake)
    stops.add(stop)
  } else begin()

  // The artist's question, which the lead answers once it knows the hero.
  stops.add(
    stage.onArtistAsk((artist) => {
      const answer = () => {
        if (!hero) return later(tourStoryMs.talk, answer)
        const found = lead()
        if (!found) return
        const told = () => stage.artistAnswered(artist, hero!)
        const sent = stage.messages?.send(
          sessionTarget,
          handleOf(found, harness),
          artist.handle,
          coverAnswer(hero),
          told,
          told,
        )
        if (!sent) later(tourStoryMs.talk, told)
      }
      later(tourStoryMs.talk, answer)
    }),
  )

  return () => {
    over = true
    timers.forEach(clearTimeout)
    timers.clear()
    stops.forEach((stop) => stop())
    stops.clear()
  }
}
