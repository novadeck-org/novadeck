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
  builderChanges,
  builderDiffs,
  gameFile,
  heroOf,
  modelFile,
  modelOf,
  pageContent,
  serverCommand,
  type Hero,
} from "./content"

// The story of the tour, as a runner would report it once the lead described itself: the lead
// asks the person what game to make, on one sheet of two questions; with the answers it opens a
// modeller and a builder, asks to run the game's server and shows its page; the modeller shows
// the hero's model, the builder shows its changes to the game, and the lead shows the page again.
// Every step reaches the UI as the real thing does: terminals the lead leads, messages between
// them, an Inbox ask, works that change files, items on the agents' bars, writes in the Files
// panel.

// How long each step takes: short and fixed, so specs run fast. The person's answer, and their
// yes to the command, wait as long as they take.
export const tourStoryMs = {
  open: 300,
  bind: 300,
  work: 300,
  talk: 300,
  show: 400,
  // How long after its team is opened the lead asks to run the server: the team step's line has
  // its moment first. The tour comes to that step only once its first line has been read (shown
  // a second or so after the lead named itself, then held 3 s), and shows the team's line a
  // second after that, which it holds 3 s.
  serve: 7_800,
} as const

export const modellerName = "Modeller"
export const builderName = "Builder"
export const serverName = "Game server"

export const sheetSubject = "Which game shall we build?"
export const worldOptions = ["Fantasy", "Sci-fi", "Modern"] as const
export const kindOptions = ["RPG", "Shooter", "Strategy"] as const

export const modelled = "Hero modelled."
export const gameBuilt = "Game built."

export const heroColourSubject = "What colour should the hero be?"
export const heroColours = ["Red", "Blue", "Green"] as const

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

const sourceOf = (
  key: TerminalKey,
  terminal: TerminalMetadata,
  harness: AgentName,
  projectName: string,
): InboxEntry["source"] => ({
  projectId: key.projectId,
  workspaceSessionId: key.workspaceSessionId,
  terminalId: key.terminalId,
  handle: terminal.handle ?? "",
  agent: harness,
  title: terminal.name,
  projectName,
})

const options = (labels: readonly string[]) => labels.map((label) => ({ label, summary: null }))

// The lead's sheet, as the runner's `ask` makes its entry for several questions: the world and
// the kind of the game, three options each, from the lead's own terminal, the agent waiting.
export const sheetAsk = (
  key: TerminalKey,
  terminal: TerminalMetadata,
  harness: AgentName,
  projectName: string,
  at: number,
): InboxEntry => ({
  id: `tour-ask-${key.terminalId}`,
  kind: "ask",
  source: sourceOf(key, terminal, harness, projectName),
  at,
  stopped: false,
  seen: false,
  ask: {
    subject: sheetSubject,
    body: "Pick a world and a kind of game, or type anything you like.",
    details: null,
    hardToUndo: null,
    shape: {
      type: "questions",
      questions: [
        {
          header: "The world",
          question: "The world",
          options: options(worldOptions),
          multiSelect: false,
          recommend: null,
        },
        {
          header: "The kind",
          question: "The kind",
          options: options(kindOptions),
          multiSelect: false,
          recommend: null,
        },
      ],
    },
  },
})

// A teammate's own question, as the runner's `ask` makes its entry for options: from its
// terminal, the agent working on meanwhile.
export const heroColourAsk = (
  key: TerminalKey,
  terminal: TerminalMetadata,
  harness: AgentName,
  projectName: string,
  at: number,
): InboxEntry => ({
  id: `tour-ask-${key.terminalId}`,
  kind: "ask",
  source: sourceOf(key, terminal, harness, projectName),
  at,
  stopped: false,
  seen: false,
  ask: {
    subject: heroColourSubject,
    body: "I'll paint the hero's model in it. Pick one, or type anything you like.",
    details: null,
    hardToUndo: null,
    shape: {
      type: "options",
      options: heroColours.map((label) => ({ label, summary: null, details: null, code: null })),
      recommend: null,
    },
  },
})

// What the person gives a question: the option's index, or their own words.
export type Given = number | string

// The sheet's answer picking `world` and `kind`, as the Inbox sends it.
export const pickSheet = (world: Given, kind: Given): InboxAnswer => ({
  kind: "ask",
  answer: {
    type: "questions",
    answers: [world, kind].map((pick) =>
      typeof pick === "number" ? { options: [pick], text: "" } : { options: [], text: pick },
    ),
  },
})

// The answer picking option `option` of an options ask, or giving the person's own words.
export const pickOption = (answer: Given): InboxAnswer => ({
  kind: "ask",
  answer:
    typeof answer === "number"
      ? { type: "reply", option: answer, text: "" }
      : { type: "reply", option: null, text: answer },
})

// The words an options answer gives: the option picked, else the person's own, else the first
// option.
export const chosenOption = (
  answer: InboxAnswer | undefined,
  labels: readonly string[],
): string => {
  const reply = answer?.kind === "ask" && answer.answer.type === "reply" ? answer.answer : undefined
  const picked = reply?.option === null || reply === undefined ? undefined : labels[reply.option]
  return picked ?? (reply?.text.trim() || labels[0]!)
}

// The game a sheet's answer names: for each question the option picked or the person's own
// words. An ask that ended unanswered (dismissed, withdrawn) leaves the first options.
export const chosenHero = (answer: InboxAnswer | undefined): Hero => {
  const given =
    answer?.kind === "ask" && answer.answer.type === "questions" ? answer.answer.answers : []
  const word = (at: number, labels: readonly string[]) => {
    const one = given[at]
    const own = one?.text.trim()
    return (
      (one?.options[0] !== undefined ? labels[one.options[0]] : undefined) ?? (own || labels[0]!)
    )
  }
  return heroOf(word(0, worldOptions), word(1, kindOptions))
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
  // The modeller does nothing, once it is there, until nudged.
  readonly quietModeller: boolean
  // The modeller asks the person a question of its own, and waits for it, before it reports.
  readonly mateAsks: boolean
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
  quietModeller,
  mateAsks,
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

  // The game the person's sheet named, once they answered; and whether the team has built it.
  let hero: Hero | undefined
  let built = false
  // Whether the lead showed its page, which it shows again once the game is built.
  let paged = false
  const showPage = () => {
    paged = true
    stage.page(key, built && hero ? pageContent(hero, 2) : pageContent(undefined, 1))
  }

  // Each teammate's report the lead heard: once both are in, the lead shows the built game and
  // ends its turn.
  const reported = new Set<string>()
  const reports = (mate: Teammate) => {
    reported.add(mate.key.terminalId)
    if (reported.size < 2) return
    built = true
    later(tourStoryMs.show, () => {
      if (paged) showPage()
      finish()
    })
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
  const report = (mate: Teammate, text: string) => {
    say(mate, text)
    stage.files?.end(mate.handle)
    turns.as(mate.harness).finish(mate.key, current(mate.key), "completed", {
      after: tourStoryMs.talk,
      reply: text,
    })
    later(tourStoryMs.talk, () => reports(mate))
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

  // Puts `entry` in the Inbox, from `asker`'s terminal, and calls `answered` once the person
  // has dealt with it, as long as that takes: answered, which takes the entry away, or
  // dismissed or withdrawn, which settles it. `listen` hears an answer the debug panel or a spec
  // gives, which answers the entry as the person would.
  const asked = (
    entry: InboxEntry,
    listen: (on: (answer: InboxAnswer) => void) => () => void,
    answered: (given: InboxAnswer | undefined) => void,
  ) => {
    let seen = false
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      stop()
      stops.delete(stop)
      stopAnswer()
      stops.delete(stopAnswer)
      answered(stage.answeredWith(entry.id))
    }
    const check = () => {
      const state = stage.inbox?.state.getSnapshot()
      const held = state?.items.find(({ id }) => id === entry.id)
      if (held && !held.settled) {
        seen = true
        return
      }
      if (seen || held?.settled) end()
    }
    const stop = stage.inbox?.state.subscribe(check) ?? (() => {})
    const stopAnswer = listen((answer) => stage.answerEntry(entry.id, answer))
    stops.add(stop)
    stops.add(stopAnswer)
    if (!stage.inbox) return later(tourStoryMs.talk, end)
    stage.inbox.add(entry)
    check()
  }

  const projectName = () =>
    stage.workspace()?.projects.find(({ id }) => id === key.projectId)?.name ?? ""

  // The modeller writes its model in its worktree, shows it, and, where asked to, asks the
  // person what colour the hero is and waits; then it tells the lead.
  const model = (mate: Teammate, chosen: Hero) => {
    const root = worktreeRoot("tour", branches.modeller)
    write(mate, [{ path: modelFile, added: 38, removed: 0, status: "added" }])
    later(tourStoryMs.show, () => {
      const sculpted = modelOf(chosen, "1")
      stage.show(mate.key, {
        kind: "model",
        name: "hero.gltf",
        detail: "glTF, 2 kB",
        path: `${root}/${modelFile}`,
        url: null,
        content: sculpted.content,
        bytes: sculpted.bytes,
      })
      const writer = current(mate.key)
      if (!mateAsks || !writer) return report(mate, modelled)
      asked(
        heroColourAsk(mate.key, writer, mate.harness, projectName(), Date.now()),
        (on) => tour.mate((given) => on(pickOption(given))),
        (given) => report(mate, `${modelled} Its colour is ${chosenOption(given, heroColours)}.`),
      )
    })
  }

  // The modeller binds, names itself, opens its worktree and models the hero.
  const modeller = (mate: Teammate, chosen: Hero) =>
    settle(mate, modellerName, () => {
      worktree(mate, branches.modeller)
      later(tourStoryMs.work, () => model(mate, chosen))
    })

  // The builder binds, names itself, opens its worktree, builds the game, shows its changes and
  // reports.
  const builder = (mate: Teammate, chosen: Hero) =>
    settle(mate, builderName, () => {
      worktree(mate, branches.builder)
      later(tourStoryMs.work, () => {
        write(mate, [{ path: gameFile, added: 3, removed: 3 }])
        later(tourStoryMs.show, () => {
          const root = worktreeRoot("tour", branches.builder)
          stage.show(mate.key, {
            kind: "changes",
            name: "build-game",
            detail: "1 file · +3 −3",
            path: root,
            url: null,
            content: { state: "ready", stamp: "1", content: builderChanges(root) },
            diffs: builderDiffs(chosen),
          })
          report(mate, gameBuilt)
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
      later(tourStoryMs.show, showPage)
    })
  }

  // With the sheet answered, the lead opens its team.
  const team = (chosen: Hero) => {
    const first = hire("modeller")
    if (first && quietModeller) {
      // Held at its prompt, no turn begun, until the tour nudges (the lead, which the tour
      // can't tell from it, or the teammate itself).
      const before = nudged(first.key.terminalId)
      const wake = () => {
        if (nudged(first.key.terminalId) <= before) return
        stop()
        stops.delete(stop)
        modeller(first, chosen)
      }
      const stop = tour.nudged.subscribe(wake)
      stops.add(stop)
      turns.as(first.harness).rest(first.key, current(first.key))
      stage.messages?.join(sessionTarget, {
        terminalId: first.key.terminalId,
        handle: first.handle,
      })
    } else if (first) modeller(first, chosen)
    later(tourStoryMs.open, () => {
      const second = hire("builder")
      if (second) builder(second, chosen)
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
  }

  // The lead asks the person what game to make, and waits as long as they take; then it opens
  // its team for the game they named.
  const begin = () => {
    const found = lead()
    if (!found) return
    stage.messages?.join(sessionTarget, {
      terminalId: key.terminalId,
      handle: handleOf(found, harness),
    })
    later(tourStoryMs.open, () => {
      const entry = sheetAsk(key, found, harness, projectName(), Date.now())
      asked(
        entry,
        (on) => tour.sheet(({ world, kind }) => on(pickSheet(world, kind))),
        (given) => {
          hero = chosenHero(given)
          stage.chose(hero)
          team(hero)
        },
      )
    })
  }

  // Nudges the tour rang a terminal (or the lead, which stands for a teammate it can't name yet).
  const nudged = (terminalId: string) =>
    tour.nudged.getSnapshot().filter((id) => id === terminalId || id === key.terminalId).length

  // A lead told to wait asks only once nudged again after the point it's at now.
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

  return () => {
    over = true
    timers.forEach(clearTimeout)
    timers.clear()
    stops.forEach((stop) => stop())
    stops.clear()
  }
}
