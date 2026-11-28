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
  changesOf,
  diffsOf,
  heroOf,
  modelFile,
  modelOf,
  pageContent,
  teamParts,
  pitches,
  serverCommand,
  written,
  type Hero,
  type Written,
} from "./content"

// The story of the tour, as a runner would report it once the lead described itself: the lead
// asks the person which game to make, three pitches to pick from; with the answer it asks to run
// the game's server, and once the person has allowed that, opens three teammates (Core, World and
// Feel) and shows its page. The teammates tell each other what they export, one of them asks the
// person a question of its own, and each shows its work, tells the lead its first version is in,
// polishes it and tells the lead it is polished; the lead shows the page again as each lands.
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
} as const

export const serverName = "Game server"

export const pitchSubject = "Which game shall we build?"

// The teammate that asks the person a question of its own, where the story is told to: World,
// about the hero's colour.
export const heroColourSubject = "What colour should the hero be?"
export const heroColours = ["Red", "Blue", "Green"] as const

// What a teammate tells the lead as its work comes along, as its task words it.
export const firstVersion = (role: string): string => `${role}: first version in`
export const polishedNote = (role: string): string => `${role}: polished`

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
  // As the runner opens an agent's terminal: beside the person's, not over it.
  select: false,
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
  select: false,
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

// The lead's pitch, as the runner's `ask` makes its entry for options: three games it invented,
// each a title and a line, from the lead's own terminal, the agent waiting.
export const pitchAsk = (
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
    subject: pitchSubject,
    body: "Pick one, or write your own: a team of agents builds it.",
    details: null,
    hardToUndo: null,
    shape: {
      type: "options",
      options: pitches.map(({ title, line }) => ({
        label: title,
        summary: line,
        details: null,
        code: null,
      })),
      recommend: null,
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

// The game an answer to the pitch names: the pitch picked, or the person's own words. An ask that
// ended unanswered (dismissed, withdrawn) leaves the first pitch.
export const chosenHero = (answer: InboxAnswer | undefined): Hero => {
  const reply = answer?.kind === "ask" && answer.answer.type === "reply" ? answer.answer : undefined
  if (reply?.option !== null && reply?.option !== undefined) return heroOf(reply.option)
  return heroOf(reply?.text.trim() || 0)
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
  // The first teammate does nothing, once it is there, until nudged.
  readonly quietMate: boolean
  // World asks the person a question of its own, and keeps working until it is answered; it
  // doesn't polish its work before.
  readonly mateAsks: boolean
  // There is no page: this computer has neither Node nor Python.
  readonly noPage: boolean
  // Ends the lead's turn once all the teammates have said they are polished.
  readonly finish: () => void
}

const handleOf = (found: TerminalMetadata | undefined, fallback: string) =>
  found?.handle ?? fallback

export type Teammate = {
  readonly key: TerminalKey
  readonly handle: string
  readonly harness: AgentName
  // Its part: the role it names itself by, and the branch its worktree is on.
  readonly role: string
  readonly branch: string
}

// What the teammates tell each other, as their tasks ask: each what it exports or needs.
export const teammateLines = {
  world: "World: src/world.js exports buildWorld(scene). Call it from your loop.",
  feel: "Feel: src/feel.js exports hud(state). Call it each frame, and tell me what score is.",
} as const

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
  quietMate,
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

  // A message from a teammate to the lead (or another teammate), then `then`.
  const say = (from: Teammate | "lead", text: string, then?: () => void, to?: Teammate) => {
    const found = lead()
    if (!found) return
    const handle = (who: Teammate | "lead") =>
      who === "lead" ? handleOf(found, harness) : who.handle
    const sent = stage.messages?.send(
      sessionTarget,
      handle(from),
      handle(to ?? "lead"),
      text,
      then,
      then,
    )
    // A refused send, or no messages here, goes on as if it landed.
    if (!sent && then) later(tourStoryMs.talk, then)
  }

  // The game the person's pick named, once they answered; how many first versions and polished
  // parts the lead has heard of; and whether the lead showed its page, which it shows again as
  // each lands.
  let hero: Hero | undefined
  let paged = false
  let landed = 0
  let polished = 0
  const showPage = () => {
    paged = true
    stage.page(
      key,
      hero && landed > 0 ? pageContent(hero, 1 + landed + polished) : pageContent(undefined, 1),
    )
  }

  // A teammate's first version is in: the lead looks at the page, which now shows it.
  const firstIn = () => {
    landed += 1
    later(tourStoryMs.show, () => {
      if (paged) showPage()
    })
  }

  // A teammate is polished: once all are, the lead shows the finished game and ends its turn.
  const polishedIn = () => {
    polished += 1
    later(tourStoryMs.show, () => {
      if (paged) showPage()
      if (polished >= teamParts.length) finish()
    })
  }

  // A teammate binds, works and names itself, then goes on with `named`.
  const settle = (mate: Teammate, named: () => void) => {
    stage.messages?.join(sessionTarget, { terminalId: mate.key.terminalId, handle: mate.handle })
    later(tourStoryMs.bind, () => {
      if (!current(mate.key)) return
      turns.as(mate.harness).work(mate.key, current(mate.key))
      later(tourStoryMs.work, () => {
        if (!current(mate.key)) return
        dispatch([namedAs(mate.key, mate.role, mate.handle)])
        named()
      })
    })
  }

  // The teammate opens its worktree (`open_worktree`) on its branch.
  const worktree = (mate: Teammate) =>
    stage.works?.openBranch(
      {
        projectId: key.projectId,
        terminalId: mate.key.terminalId,
        root: worktreeRoot("tour", mate.branch),
      },
      mate.branch,
    )
  // It writes `files` there: the work changes exactly these, and the Files panel shows each as
  // the agent writes it, its cursor on the last.
  const write = (mate: Teammate, files: readonly Written[]) => {
    stage.works?.setFiles(
      mate.key.terminalId,
      files.map(({ path, added, removed, status }) =>
        planFile(path, added, removed, status ? { status } : {}),
      ),
      Date.now(),
    )
    for (const file of files) stage.files?.write(mate.handle, file.path, file.status ?? "modified")
  }
  // Its turn ends.
  const rest = (mate: Teammate) => {
    stage.files?.end(mate.handle)
    turns.as(mate.harness).finish(mate.key, current(mate.key), "completed", {
      after: tourStoryMs.talk,
      reply: `${mate.role} is polished.`,
    })
  }

  // The lead opens a teammate: a terminal it leads, with a handle at once.
  const hire = (part: (typeof teamParts)[number]): Teammate | undefined => {
    const found = lead()
    if (!found) return undefined
    const base = stage.newTerminal({
      target: sessionTarget,
      directory: demoTourFolder,
      launch: { command: teammateCommand(harness) },
    })
    const mate: Teammate = {
      key: { ...sessionTarget, terminalId: base.id },
      handle: handleOf(base, part.branch),
      harness,
      role: part.role,
      branch: part.branch,
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

  // A teammate's part, once it is named: its worktree, its files written, its first version shown
  // and told to the lead, then one polishing change and its word that it is polished, where its
  // question to the person (if it asks one) has been answered. `shown` shows what it made.
  const work = (
    mate: Teammate,
    files: readonly Written[],
    shown: () => void,
    question: Promise<void>,
  ) => {
    worktree(mate)
    later(tourStoryMs.work, () => {
      write(mate, files)
      later(tourStoryMs.show, () => {
        shown()
        say(mate, firstVersion(mate.role), () => {
          firstIn()
          void question.then(() => {
            if (over) return
            // The polishing change: a few more lines in its files.
            write(
              mate,
              files.map((file) => ({ ...file, added: file.added + 4 })),
            )
            later(tourStoryMs.show, () =>
              say(mate, polishedNote(mate.role), () => {
                polishedIn()
                rest(mate)
              }),
            )
          })
        })
      })
    })
  }

  // What a teammate shows of its changes: its changes item, with the diffs of its code.
  const showChanges = (mate: Teammate, chosen: Hero, files: readonly Written[]) => () => {
    const root = worktreeRoot("tour", mate.branch)
    const lines = files.reduce((sum, file) => sum + file.added, 0)
    stage.show(mate.key, {
      kind: "changes",
      name: mate.branch,
      detail: `${files.length} file${files.length === 1 ? "" : "s"} · +${lines}`,
      path: root,
      url: null,
      content: { state: "ready", stamp: "1", content: changesOf(root, files) },
      diffs: diffsOf(files, chosen),
    })
  }

  // Core writes the game's rules and loop.
  const core = (mate: Teammate, chosen: Hero) =>
    settle(mate, () => {
      const files = [written.core]
      work(mate, files, showChanges(mate, chosen, files), Promise.resolve())
    })

  // World builds the scene and models the hero, shows its model and, where asked to, asks the
  // person what colour the hero is, working on meanwhile.
  const world = (mate: Teammate, chosen: Hero) =>
    settle(mate, () => {
      const files = written.world
      // Resolved once the person has dealt with its question, or at once where it asks none.
      const question = new Promise<void>((answered) =>
        later(tourStoryMs.work, () => {
          const found = current(mate.key)
          if (!mateAsks || !found) return answered()
          asked(
            heroColourAsk(mate.key, found, mate.harness, projectName(), Date.now()),
            (on) => tour.mate((given) => on(pickOption(given))),
            () => answered(),
          )
        }),
      )
      work(
        mate,
        files,
        () => {
          const root = worktreeRoot("tour", mate.branch)
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
        },
        question,
      )
    })

  // Feel adds the title, the HUD and the juice.
  const feel = (mate: Teammate, chosen: Hero) =>
    settle(mate, () => {
      const files = [written.feel]
      work(mate, files, showChanges(mate, chosen, files), Promise.resolve())
    })

  // The lead asks to run the game's server in a new terminal, which waits on the person's yes,
  // and opens nobody before they answer; allowed, a terminal of its own opens and the lead opens
  // its team, then shows the game's page; declined, it opens its team and shows no page.
  const serve = (chosen: Hero) => {
    const found = lead()
    if (!found) return
    void stage.approve(key, serverCommand, demoTourFolder).then((approved) => {
      if (over || !lead()) return
      if (!approved) return team(chosen, false)
      const base = stage.newTerminal({
        target: sessionTarget,
        directory: demoTourFolder,
        title: serverName,
      })
      dispatch([openedShell(key, base, found.id, handleOf(found, harness))])
      later(tourStoryMs.show, () => team(chosen, true))
    })
  }

  // The lead opens its team, one teammate after the other, then shows the page (where the server
  // runs) and ends its turn: its team is at work, and each message that comes back wakes it. A
  // lead at rest is what the tour's wait on it counts. The teammates tell each other what they
  // export, once all are there.
  const team = (chosen: Hero, page: boolean) => {
    const mates: Teammate[] = []
    const runs = [core, world, feel] as const
    const open = (at: number) => {
      const part = teamParts[at]
      const mate = part && hire(part)
      if (!mate) return
      mates.push(mate)
      if (at === 0 && quietMate) {
        // Held at its prompt, no turn begun, until the tour nudges (the lead, which the tour
        // can't tell from it, or the teammate itself).
        const before = nudged(mate.key.terminalId)
        const wake = () => {
          if (nudged(mate.key.terminalId) <= before) return
          stop()
          stops.delete(stop)
          runs[at]?.(mate, chosen)
        }
        const stop = tour.nudged.subscribe(wake)
        stops.add(stop)
        turns.as(mate.harness).rest(mate.key, current(mate.key))
        stage.messages?.join(sessionTarget, {
          terminalId: mate.key.terminalId,
          handle: mate.handle,
        })
      } else runs[at]?.(mate, chosen)
      if (at < teamParts.length - 1) return later(tourStoryMs.open, () => open(at + 1))
      // All three are there.
      const [first, second, third] = mates
      later(tourStoryMs.talk, () => {
        if (second && first) say(second, teammateLines.world, undefined, first)
        if (third && second) say(third, teammateLines.feel, undefined, second)
      })
      later(tourStoryMs.show, () => {
        if (page) showPage()
        turns.as(harness).finish(key, terminal(), "completed", {
          after: tourStoryMs.talk,
          reply: "My team is at work.",
        })
      })
    }
    open(0)
  }

  // The lead asks the person which game to make, and waits as long as they take; then it asks to
  // run the game's server, or, where there is none, opens its team for the game they named.
  const begin = () => {
    const found = lead()
    if (!found) return
    stage.messages?.join(sessionTarget, {
      terminalId: key.terminalId,
      handle: handleOf(found, harness),
    })
    later(tourStoryMs.open, () => {
      const entry = pitchAsk(key, found, harness, projectName(), Date.now())
      asked(
        entry,
        (on) => tour.sheet((pick) => on(pickOption(pick))),
        (given) => {
          hero = chosenHero(given)
          stage.chose(hero)
          if (noPage) team(hero, false)
          else serve(hero)
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
