import type { AgentName } from "@novadeck/core/harnesses"
import type { InboxAnswer, InboxRow } from "@novadeck/core/inbox"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import type { TerminalMetadata } from "@novadeck/core/types"

import type { DemoTurns } from "../agents/turns"
import { demoTourFolder, type DemoTour, type TourStage } from "../tour"
import { demoRun } from "../tour-runs"
import { planFile, worktreeRoot } from "../works"
import { terminalOf } from "../workspace"
import { moneyAnswers, moneyBranch, splitFile, tipBranch } from "./split"

// The rest of the tour's story, as a runner would report it once the lead described itself: it
// opens a fixer for the first bug, which opens its worktree, edits split.js and reports; the
// person opens a terminal and the tour hands it their own agent as the second fixer, which opens
// its worktree and asks which way to show whole amounts; once answered it edits and reports; and
// the lead says both are fixed. Every step reaches the UI as the real thing does: terminals the
// lead leads, messages between them, an Inbox ask, works that change split.js.

// How long each step takes: short and fixed, so specs run fast. The person's answer, and their
// terminal, wait as long as they take.
export const tourStoryMs = { open: 300, bind: 300, work: 300, talk: 300, show: 400 } as const

export const tipFixerName = "Tip fixer"
export const moneyFixerName = "Money fixer"

export const moneySubject = "Whole amounts: $12.00 or $12?"

export const fixedTip = "Fixed bug 1."
export const fixedMoney = "Fixed bug 2."

const target = ({ projectId, workspaceSessionId }: TerminalKey) => ({
  projectId,
  workspaceSessionId,
})

// The harness the lead's first fixer runs on: another connected agent where there is one, else the
// lead's, so the team is mixed where the person has two agents. The second fixer is the person's
// own agent, the lead's.
export const fixerHarness = (lead: AgentName, connected: readonly AgentName[]): AgentName =>
  connected.find((agent) => agent !== lead) ?? lead

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
  terminal: { ...terminal, ledBy: lead },
})

// A terminal the person opened, taken by the tour as the lead's second fixer: led by it from now.
export const adoptedTeammate = (key: TerminalKey, lead: string): BackendAction => ({
  type: "terminal/update",
  target: target(key),
  terminalId: key.terminalId,
  ledBy: lead,
})

// An agent's describe: its terminal takes the name, as the agent's own, by its handle.
export const namedAs = (key: TerminalKey, name: string, by: string): BackendAction => ({
  type: "terminal/update",
  target: target(key),
  terminalId: key.terminalId,
  name,
  titleSource: { kind: "agent", by },
})

// The second fixer's ask, as the runner's `ask` makes its row: options A and B, from its
// terminal, the agent working on meanwhile.
export const moneyAsk = (
  key: TerminalKey,
  terminal: TerminalMetadata,
  harness: AgentName,
  projectName: string,
  at: number,
): InboxRow => ({
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
    subject: moneySubject,
    body: "money() shows $12.5 for 12.50, and for a whole amount it would show $12.0. Which should it show for $12?",
    details: null,
    hardToUndo: null,
    shape: {
      type: "options",
      options: moneyAnswers.map(({ label, summary }) => ({
        label,
        summary,
        details: null,
        code: null,
      })),
      recommend: 0,
    },
  },
})

// The answer picking option `option`, as the Inbox sends it.
export const pickMoney = (option: number): InboxAnswer => ({
  kind: "ask",
  answer: { type: "reply", option, text: "" },
})

// The option an answer chose, by index (the person's own words win in the real agent; here they
// pick the first); an ask that ended unanswered (dismissed, withdrawn) is the first.
export const chosenMoney = (answer: InboxAnswer | undefined): number => {
  const reply = answer?.kind === "ask" && answer.answer.type === "reply" ? answer.answer : undefined
  return reply?.option !== null && reply?.option !== undefined && moneyAnswers[reply.option]
    ? reply.option
    : 0
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
  // The lead opens its fixer only once nudged again.
  readonly quietTeam: boolean
  // Ends the lead's turn once both fixes are reported.
  readonly finish: () => void
}

const handleOf = (found: TerminalMetadata | undefined, fallback: string) =>
  found?.handle ?? fallback

type Teammate = {
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

  // Each fixer's report the lead heard: once both are in, it says so and finishes its turn.
  const reported = new Set<string>()
  const reports = (mate: Teammate) => {
    reported.add(mate.key.terminalId)
    if (reported.size >= 2) later(tourStoryMs.show, finish)
  }

  // A fixer binds, works and names itself, then goes on with `named`.
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

  // The fixer opens its worktree (`open_worktree`) on `branch`.
  const worktree = (mate: Teammate, branch: string) =>
    stage.works?.openBranch(
      {
        projectId: key.projectId,
        terminalId: mate.key.terminalId,
        root: worktreeRoot("tour", branch),
      },
      branch,
    )
  // It edits split.js there, `lines` added and one removed.
  const edit = (mate: Teammate, lines: number) =>
    stage.works?.setFiles(mate.key.terminalId, [planFile(splitFile, lines, 1)], Date.now())
  // It tells the lead, and its turn ends.
  const report = (mate: Teammate, text: string) => {
    say(mate, text)
    turns.as(mate.harness).finish(mate.key, current(mate.key), "completed", {
      after: tourStoryMs.talk,
      reply: text,
    })
    later(tourStoryMs.talk, () => reports(mate))
  }

  // The lead opens the first fixer: a terminal it leads, with a handle at once, which binds,
  // works, names itself, opens its worktree, edits and reports.
  const hire = () => {
    const found = lead()
    if (!found) return
    const at = fixerHarness(harness, tour.connected())
    const base = stage.newTerminal({
      target: sessionTarget,
      directory: demoTourFolder,
      launch: { command: teammateCommand(at) },
    })
    const mate: Teammate = {
      key: { ...sessionTarget, terminalId: base.id },
      handle: handleOf(base, "tipfixer"),
      harness: at,
    }
    dispatch([openedTeammate(mate.key, base, found.id)])
    settle(mate, tipFixerName, () => {
      worktree(mate, tipBranch)
      later(tourStoryMs.work, () => {
        edit(mate, 1)
        report(mate, fixedTip)
      })
    })
  }

  // The second fixer's ask waits for the person's answer, as long as it takes, then it edits the
  // way they chose and reports.
  const asked = (mate: Teammate) => {
    const writer = current(mate.key)
    if (!lead() || !writer) return
    const project = stage.workspace()?.projects.find(({ id }) => id === key.projectId)
    const row = moneyAsk(mate.key, writer, mate.harness, project?.name ?? "", Date.now())
    let seen = false
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      stop()
      stops.delete(stop)
      stopAnswer()
      stops.delete(stopAnswer)
      const option = chosenMoney(stage.answeredWith(row.id))
      stage.picked(option)
      later(tourStoryMs.talk, () => {
        edit(mate, moneyAnswers[option]?.lines.length ?? 1)
        report(mate, fixedMoney)
      })
    }
    const check = () => {
      const state = stage.inbox?.state.getSnapshot()
      const held = state?.items.find(({ id }) => id === row.id)
      if (held && !held.settled) {
        seen = true
        return
      }
      // Answered, which takes the row away, or dismissed or withdrawn, which settles it.
      if (seen || held?.settled) end()
    }
    const stop = stage.inbox?.state.subscribe(check) ?? (() => {})
    const stopAnswer = tour.money((option) => stage.answerRow(row.id, pickMoney(option)))
    stops.add(stop)
    stops.add(stopAnswer)
    if (!stage.inbox) return later(tourStoryMs.talk, end)
    stage.inbox.add(row)
    check()
  }

  // The tour hands the shell the person opened their own agent: led by the lead from now, it
  // binds, works, names itself, opens its worktree and asks.
  let adopted = false
  const adopt = (terminalId: string) => {
    const found = lead()
    const shell = current({ ...sessionTarget, terminalId })
    if (!found || !shell || adopted) return
    if (shell.directory !== demoTourFolder || shell.ledBy) return
    if (shell.state === "running" && shell.agent) return
    adopted = true
    const mate: Teammate = {
      key: { ...sessionTarget, terminalId },
      handle: handleOf(shell, "moneyfixer"),
      harness,
    }
    dispatch([adoptedTeammate(mate.key, found.id)])
    settle(mate, moneyFixerName, () => {
      worktree(mate, moneyBranch)
      later(tourStoryMs.work, () => asked(mate))
    })
  }

  const begin = () => {
    const found = lead()
    if (!found) return
    stage.messages?.join(sessionTarget, {
      terminalId: key.terminalId,
      handle: handleOf(found, harness),
    })
    stops.add(tour.onFixer(adopt))
    later(tourStoryMs.open, hire)
  }

  // A lead told to wait opens its fixer only once nudged again after the point it's at now.
  const nudges = () => tour.nudged.getSnapshot().filter((id) => id === key.terminalId).length
  if (quietTeam) {
    const before = nudges()
    const wake = () => {
      if (nudges() <= before) return
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
