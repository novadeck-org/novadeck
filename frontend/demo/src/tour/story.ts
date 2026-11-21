import type { AgentName } from "@novadeck/core/harnesses"
import type { InboxAnswer, InboxRow } from "@novadeck/core/inbox"
import { itemIdOf, type Item, type ItemContent } from "@novadeck/core/items"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import type { TerminalMetadata } from "@novadeck/core/types"

import type { DemoTurns } from "../agents/turns"
import { demoTourFolder, type DemoTour, type TourStage } from "../tour"
import { demoRun } from "../tour-runs"
import { terminalOf } from "../workspace"

// The rest of the tour's story, as a runner would report it once the lead described itself: it
// opens two teammates, who talk, one asks the person which tagline to use, and the lead shows
// the card it wrote with the answer. Every step reaches the UI as the real thing does: terminals
// the lead leads, messages between them, an Inbox ask, an item on the lead's bar.

// How long each step takes: short and fixed, so specs run fast. The person's answer waits as long
// as it takes.
export const tourStoryMs = { open: 300, bind: 300, work: 300, talk: 300, show: 400 } as const

export const copywriterName = "Copywriter"
export const designerName = "Designer"

export const taglineSubject = "Which tagline for the comic strip?"

// The two taglines the copywriter offers, as the ask's options A and B.
export const taglines = [
  { label: "A", line: "Every agent, one calm workspace." },
  { label: "B", line: "Your agents, finally on the same page." },
] as const

// What the team says before the ask, as the brief has it: the designer sends its look to the
// lead, and only to the lead. The copywriter tells the lead only the person's pick, once made.
export const tourTalk = {
  designerToLead:
    "Look: background #fff6dc; text #140b1f; accent #ffe24a; line Ink on cream. Final.",
} as const

export const taglineMessage = (label: string, line: string): string =>
  `The person picked ${label}: "${line}". Use it as the strip's punchline.`

const target = ({ projectId, workspaceSessionId }: TerminalKey) => ({
  projectId,
  workspaceSessionId,
})

// The harnesses the lead's two teammates run on: the copywriter on the lead's, the designer on
// another connected agent where there is one, else on the lead's too, so the team is mixed
// where the person has two agents.
export const teamHarnesses = (
  lead: AgentName,
  connected: readonly AgentName[],
): { readonly copywriter: AgentName; readonly designer: AgentName } => ({
  copywriter: lead,
  designer: connected.find((agent) => agent !== lead) ?? lead,
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
  terminal: { ...terminal, ledBy: lead },
})

// An agent's describe: its terminal takes the name, as the agent's own, by its handle.
export const namedAs = (key: TerminalKey, name: string, by: string): BackendAction => ({
  type: "terminal/update",
  target: target(key),
  terminalId: key.terminalId,
  name,
  titleSource: { kind: "agent", by },
})

// The copywriter's ask, as the runner's `ask` makes its row: options A and B, each with its
// line, from the copywriter's terminal, the agent working on meanwhile.
export const taglineAsk = (
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
    subject: taglineSubject,
    body: "The lead is making a comic strip of the tour for you. Which tagline should be its punchline?",
    details: null,
    hardToUndo: null,
    shape: {
      type: "options",
      options: taglines.map(({ label, line }) => ({
        label,
        summary: line,
        details: null,
        code: null,
      })),
      recommend: null,
    },
  },
})

// The answer picking option `option`, as the Inbox sends it.
export const pickTagline = (option: number): InboxAnswer => ({
  kind: "ask",
  answer: { type: "reply", option, text: "" },
})

// The tagline an answer chose: its option's line, or the person's own words where they gave no
// option. An ask that ended unanswered (dismissed, withdrawn) leaves it to the first.
export const chosenTagline = (
  answer: InboxAnswer | undefined,
): { readonly label: string; readonly line: string } => {
  const reply = answer?.kind === "ask" && answer.answer.type === "reply" ? answer.answer : undefined
  const option = reply?.option === null || reply === undefined ? undefined : taglines[reply.option]
  if (option) return option
  const words = reply?.text.trim()
  return words ? { label: "your words", line: words } : taglines[0]
}

const escaped = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

// The strip as the lead writes it from its brief's template: three panels of the run, the
// designer's look (paper, ink and accent), its line and the copywriter's, and the chosen
// tagline as the punchline. One file, its look inline, lettered in the comic font the runner
// puts beside it; the demo has no files beside it, so it letters in the fallback.
export const stripPage = (line: string): readonly string[] => [
  '<!doctype html><html><head><meta charset="utf-8"><style>',
  ":root{--p:#fff6dc;--i:#140b1f;--a:#ffe24a}",
  "@font-face{font-family:S;src:url(strip.woff2)}",
  "body{margin:0;background:var(--i);font-family:S,Impact,sans-serif;letter-spacing:.04em}",
  ".s{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr);gap:10px;padding:10px;min-height:100vh;box-sizing:border-box}",
  ".p{padding:0 14px 20px;background:var(--p);color:var(--i)}",
  ".c,.b,.t{text-transform:uppercase}",
  ".c{display:inline-block;margin:0 0 30px -14px;padding:5px 12px;background:var(--i);color:var(--p)}",
  ".b{display:inline-block;padding:6px 10px;background:#fff;color:#111;border:2px solid;box-shadow:3px 3px 0}",
  ".t{font-size:40px;line-height:1;overflow-wrap:anywhere}",
  '</style></head><body><div class="s">',
  '<div class="p"><b class="c">You press start</b><p class="b">your agent:<br>On it. Hiring two.</p></div>',
  '<div class="p"><b class="c">Two hires, two opinions</b><p class="b">designer:<br>Ink on cream. Final.</p><p class="b">copywriter:<br>Two taglines. Boss picks.</p></div>',
  `<div class="p" style="background:var(--a)"><b class="c">Your pick</b><p class="t">${escaped(line)}</p><p>Made by your team, in Novadeck.</p></div>`,
  "</div></body></html>",
]

// What the lead shows: tour-strip.html as a file on its bar, which the pane draws as a page,
// asked to open, from the lead's terminal (as the runner's `show` of a file makes, `by: "agent"`).
export const tourStrip = (
  key: TerminalKey,
  handle: string,
  line: string,
  now: number,
): { readonly item: Item; readonly content: ItemContent } => {
  const lines = stripPage(line)
  return {
    item: {
      id: itemIdOf(`tour-card-${key.terminalId}`),
      holder: { terminalId: key.terminalId },
      kind: "file",
      name: "tour-strip.html",
      detail: "tour-strip.html",
      path: `${demoTourFolder}/tour-strip.html`,
      url: null,
      lines: null,
      secret: false,
      by: "agent",
      from: { terminalId: key.terminalId, handle },
      version: 1,
      openAsked: true,
      shownAt: now,
      plan: null,
    },
    content: {
      state: "ready",
      stamp: "1",
      content: {
        kind: "file",
        path: `${demoTourFolder}/tour-strip.html`,
        firstLine: 1,
        lines,
        from: 1,
        to: lines.length,
        total: lines.length,
        truncated: false,
        clamped: false,
      },
    },
  }
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
  // Ends the lead's turn once the card is shown.
  readonly finish: () => void
}

const handleOf = (found: TerminalMetadata | undefined, fallback: string) =>
  found?.handle ?? fallback

type Teammate = {
  readonly key: TerminalKey
  readonly handle: string
  readonly harness: AgentName
}

// Plays the story after the lead described itself, answering a function that stops it: the
// teammates open, bind, work and name themselves; they talk; the copywriter asks the person; and,
// once answered, tells the lead, who shows its card and finishes.
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
  const team = teamHarnesses(harness, tour.connected())
  const mates: Teammate[] = []
  const lead = () => {
    const found = terminal()
    if (!found) over = true
    return found
  }
  const sessionTarget = target(key)

  // The lead opens one teammate: a terminal it leads, with a handle at once, which binds, works
  // and names itself.
  const open = (name: string, at: AgentName, named: () => void) => {
    const found = lead()
    if (!found) return
    const base = stage.newTerminal({
      target: sessionTarget,
      directory: demoTourFolder,
      launch: { command: teammateCommand(at) },
    })
    const mate: Teammate = {
      key: { ...sessionTarget, terminalId: base.id },
      handle: handleOf(base, name.toLowerCase()),
      harness: at,
    }
    mates.push(mate)
    dispatch([openedTeammate(mate.key, base, found.id)])
    stage.messages?.join(sessionTarget, { terminalId: mate.key.terminalId, handle: mate.handle })
    later(tourStoryMs.bind, () => {
      if (!current(mate.key)) return
      turns.as(at).work(mate.key, current(mate.key))
      later(tourStoryMs.work, () => {
        if (!current(mate.key)) return
        dispatch([namedAs(mate.key, name, mate.handle)])
        named()
      })
    })
  }

  const say = (from: Teammate | "lead", to: Teammate | "lead", text: string, then?: () => void) => {
    const found = lead()
    if (!found) return
    const handle = (who: Teammate | "lead") =>
      who === "lead" ? handleOf(found, harness) : who.handle
    const sent = stage.messages?.send(sessionTarget, handle(from), handle(to), text, then, then)
    // A refused send, or no messages here, goes on as if it landed.
    if (!sent && then) later(tourStoryMs.talk, then)
  }

  const present = (line: string) => {
    const found = lead()
    if (!found) return
    const card = tourStrip(key, handleOf(found, harness), line, Date.now())
    stage.hold(card.item.id, card.content)
    dispatch([{ type: "item/upsert", target: sessionTarget, item: card.item }])
    later(tourStoryMs.show, finish)
  }

  // Waits for the person's answer to the ask, as long as it takes, and goes on with the tagline
  // it chose.
  const asked = (copywriter: Teammate) => {
    const found = lead()
    const writer = current(copywriter.key)
    if (!found || !writer) return
    const project = stage.workspace()?.projects.find(({ id }) => id === key.projectId)
    const row = taglineAsk(
      copywriter.key,
      writer,
      copywriter.harness,
      project?.name ?? "",
      Date.now(),
    )
    let seen = false
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      stop()
      stops.delete(stop)
      stopAnswer()
      stops.delete(stopAnswer)
      const { label, line } = chosenTagline(stage.answeredWith(row.id))
      later(tourStoryMs.talk, () => {
        say(copywriter, "lead", taglineMessage(label, line), () => present(line))
        turns.as(copywriter.harness).finish(copywriter.key, current(copywriter.key), "completed", {
          after: tourStoryMs.talk,
          reply: `Sent ${label} to the lead.`,
        })
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
    const stopAnswer = tour.tagline((option) => stage.answerRow(row.id, pickTagline(option)))
    stops.add(stop)
    stops.add(stopAnswer)
    if (!stage.inbox) return later(tourStoryMs.talk, end)
    stage.inbox.add(row)
    check()
  }

  const talk = () => {
    const [copywriter, designer] = mates
    if (!copywriter || !designer) return
    say(designer, "lead", tourTalk.designerToLead)
    turns.as(designer.harness).finish(designer.key, current(designer.key), "completed", {
      after: tourStoryMs.talk,
      reply: "Sent the look.",
    })
    later(tourStoryMs.talk, () => asked(copywriter))
  }

  const begin = () => {
    const found = lead()
    if (!found) return
    stage.messages?.join(sessionTarget, {
      terminalId: key.terminalId,
      handle: handleOf(found, harness),
    })
    let named = 0
    const onNamed = () => {
      named += 1
      if (named === 2) later(tourStoryMs.talk, talk)
    }
    later(tourStoryMs.open, () => open(copywriterName, team.copywriter, onNamed))
    later(tourStoryMs.open * 2, () => open(designerName, team.designer, onNamed))
  }

  // A lead told to wait opens its team only once nudged again after the point it's at now.
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
