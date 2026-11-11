import type { AgentActivity, AgentName, StartupScreen } from "@novadeck/protocol"

import type { GitState } from "../terminals/git-state.js"
import { mention } from "../terminals/handles.js"
import { cut, shorten } from "../text.js"
import { agentLabel, clock, holdOf, isNotice, type Message } from "./messages.js"

/**
 * What the terminal manager knows of a terminal beyond messaging: its title; the summary its
 * own agent gave of its work; the git checkout its agent works in; when its agent's turn
 * last started or ended; what it waits on; what its agent session told the person and how
 * its turns ended; and, for a plain shell, what runs there.
 */
export type Whereabouts = {
  readonly title: string | null
  readonly summary: string | null
  /** The git checkout its agent works in now (see `Git`); null outside one. */
  readonly git: Git | null
  /** Whether its agent works, as its terminal shows: a turn, what it left running, or a shell-mode command. */
  readonly working: boolean
  /** When its agent's latest turn started, or ended once it has; null before one. */
  readonly since: number | null
  /** What its agent waits on the person for, if anything; null otherwise. */
  readonly waiting: Waiting | null
  /** What its idle agent waits on to wake it, if anything: see `Peer.waitsOn`. */
  readonly waitsOn: string | null
  /** Which of its screens holds the agent expected there for the person, if one does. */
  readonly startup: StartupScreen | null
  /** What its agent session told the person and how its turns ended, oldest first. */
  readonly happenings: readonly Happening[]
  /** Whether the latest `done` of its agent session still stands (see `standingDone`). */
  readonly standing: boolean
  /** Whether a program runs in its shell besides the prompt, and that program as shown. */
  readonly shell: Shell
}

/**
 * The git checkout an agent works in, as listings name it: the checkout's folder name as its
 * repository (a uberepo task's worktree is named after its repository), its branch, and
 * its `GitState`, null while unknown.
 */
export type Git = {
  readonly repo: string
  readonly branch: string | null
  readonly state: GitState | null
}

/** A plain shell's program: whether one runs besides the prompt, and its command as shown. */
export type Shell = { readonly running: boolean; readonly command: string | null }

/** A report an agent gave the person through `tell` or `done`: its subject, and when. */
export type Report = { readonly subject: string; readonly at: number }

/** An agent session's latest `tell` and latest `done`, each null before one. */
export type Reports = { readonly tell: Report | null; readonly done: Report | null }

/**
 * What an agent session told the person, or how one of its turns ended, as the report log
 * keeps it and `team` lists it: a `tell` (`update`) or `done` report, an ask, or a finished
 * turn with the start of its reply (or its error, failed).
 */
export type Happening =
  | {
      readonly kind: "update" | "done"
      readonly at: number
      readonly subject: string
      /** What it said at length; null where it was not read (see `read`). */
      readonly body: string | null
      /** Reads its body from the store when called, for the listing that quotes it (`team`). */
      readonly read?: () => string
      /** The pull request link it gave, found as it was written (see `pullRequestIn`). */
      readonly pr: string | null
    }
  | { readonly kind: "asked"; readonly at: number; readonly subject: string }
  | {
      readonly kind: "turn"
      readonly at: number
      /** When the turn started; null where Novadeck didn't see it, as after a restart. */
      readonly from: number | null
      readonly outcome: "completed" | "failed"
      readonly text: string | null
    }

/**
 * A request waiting on the person, as listing it shows: its kind, the tool it is about, a
 * short subject (a command, a file, a question), and how many more wait behind it.
 */
export type Waiting = {
  readonly kind: "permission" | "question" | "plan"
  readonly tool: string
  readonly subject: string | null
  readonly more: number
  /** When the oldest of them was asked; null where that isn't known. */
  readonly since: number | null
}

/** Whereabouts by terminal; undefined for one the manager can't tell of. */
export type About = (terminalId: string) => Whereabouts | undefined

/**
 * A terminal another can message, and what tells an agent which it is, all of it Novadeck's
 * own knowledge but the summary its own agent gave: its handle; the agent bound there, or
 * expected; its title; its state and since when; what it waits on; who leads it; the git
 * checkout it works in and the latest pull request its agent reported; for a plain shell,
 * what runs there; and what its agent session told the person.
 */
export type Peer = {
  readonly terminalId: string
  readonly handle: string
  readonly agent: AgentName | null
  /** The agent it was opened to run, which messages may already be sent to, before it binds. */
  readonly expecting: AgentName | null
  /**
   * The agent whose prompt shows there with no session bound, but whose hooks Novadeck
   * can't run there until the person trusts them (Codex's `/hooks`): nothing can deliver.
   */
  readonly untrusted: AgentName | null
  /** Which of its screens holds the expected agent for the person; its work waits on them. */
  readonly startup: StartupScreen | null
  readonly title: string | null
  /** What its own agent said it works on, through `describe`. */
  readonly summary: string | null
  readonly state: "busy" | "idle" | "asleep" | null
  /**
   * Since when it is busy or idle: its latest turn's start, or its end. When it is asleep,
   * when its last turn ended.
   */
  readonly since: number | null
  /** What its agent waits on the person for; its work is blocked until they answer. */
  readonly waiting: Waiting | null
  /**
   * What its idle agent waits on to wake it, with no word from anyone: its job's own
   * description, cut short, or "a job it started" where it gave none (never its command,
   * which may carry a secret), and how many more; or a wake-up it set.
   */
  readonly waitsOn: string | null
  /** The handle of the terminal that leads it now: running, and in its session; else null. */
  readonly lead: string | null
  readonly git: Git | null
  /** The latest pull request link its agent gave in a `tell` or `done`; null without one. */
  readonly pr: string | null
  /** What runs in a terminal with no agent there or expected; null for an agent's. */
  readonly shell: Shell | null
  readonly happenings: readonly Happening[]
  /** Whether the latest `done` in its happenings still stands (see `standingDone`). */
  readonly standing: boolean
}

/**
 * The `done` of an agent session that still stands: its latest, read or not, unless the
 * person's prompt or a message delivered to the agent came after it and gave it more to do.
 * The one rule behind the terminal summary's `reported`.
 */
export const standingDone = (
  reports: Reports | undefined,
  personAt: number | undefined,
  deliveredAt: number | null,
): Report | null => {
  const since = Math.max(personAt ?? 0, deliveredAt ?? 0)
  return reports?.done && reports.done.at > since ? reports.done : null
}

/**
 * When the latest message delivered to a terminal was delivered, a peer's or the person's,
 * never one of Novadeck's own notices, which give its agent nothing to do; null before one.
 */
export const deliveredTo = (messages: Iterable<Message>, terminalId: string): number | null => {
  let last: number | null = null
  for (const message of messages) {
    const { to, deliveredAt } = message
    if (to.terminalId !== terminalId || deliveredAt === null || isNotice(message)) continue
    if (last === null || deliveredAt > last) last = deliveredAt
  }
  return last
}

/** `deliveredTo` for every terminal, in one pass over the messages. */
export const deliveredToAll = (messages: Iterable<Message>): ReadonlyMap<string, number> => {
  const last = new Map<string, number>()
  for (const message of messages) {
    const { to, deliveredAt } = message
    if (deliveredAt === null || isNotice(message)) continue
    if ((last.get(to.terminalId) ?? -Infinity) < deliveredAt) last.set(to.terminalId, deliveredAt)
  }
  return last
}

/** A pull request or merge request's address, as an agent reports one. */
const pullRequest = /\bhttps?:\/\/[^\s<>"'`()[\]]+\/(?:pull|pulls|merge_requests)\/\d+/g

/** The last pull request link in a report's text; null without one. */
export const pullRequestIn = (text: string): string | null => {
  const found = [...text.matchAll(pullRequest)].at(-1)
  return found ? cut(found[0], 300) : null
}

/**
 * The latest pull request link an agent session gave in a `tell` or `done`; null without
 * one. The log found it when the report was made, so no body is read for it.
 */
export const reportedPullRequest = (happenings: readonly Happening[]): string | null => {
  for (const happening of happenings.toReversed())
    if ((happening.kind === "update" || happening.kind === "done") && happening.pr)
      return happening.pr
  return null
}

/** A peer, from what messaging knows of it and the manager's whereabouts. */
export const peerOf = (input: {
  readonly terminalId: string
  readonly handle: string
  readonly agent: AgentName | null
  readonly expecting: AgentName | null
  readonly untrusted?: AgentName | null
  /** Whether no process runs there: its agent's session rests, and a message wakes it. */
  readonly asleep?: boolean
  readonly busy: boolean
  readonly where: Whereabouts | undefined
  /** Its running lead's handle; null when it has none, or the terminal that leads it is gone. */
  readonly lead: string | null
}): Peer => {
  const { where, agent } = input
  const untrusted = agent ? null : (input.untrusted ?? null)
  const expecting = agent || untrusted ? null : input.expecting
  const happenings = agent ? (where?.happenings ?? []) : []
  return {
    terminalId: input.terminalId,
    handle: input.handle,
    agent,
    expecting,
    untrusted,
    startup: agent || untrusted ? null : (where?.startup ?? null),
    title: where?.title ?? null,
    summary: where?.summary ?? null,
    state: agent ? (input.asleep ? "asleep" : input.busy ? "busy" : "idle") : null,
    since: agent ? (where?.since ?? null) : null,
    waiting: agent && !input.asleep ? (where?.waiting ?? null) : null,
    waitsOn: agent && !input.busy && !input.asleep ? (where?.waitsOn ?? null) : null,
    lead: input.lead,
    git: where?.git ?? null,
    pr: reportedPullRequest(happenings),
    shell: agent || expecting || untrusted ? null : (where?.shell ?? null),
    happenings,
    standing: agent ? (where?.standing ?? false) : false,
  }
}

/**
 * Text an agent or the person wrote, as a listing shows it: one line, cut short, so it can
 * never begin a line of its own that reads as Novadeck's.
 */
export const flat = (text: string, max: number): string => shorten(text, max)

/** How long ago a moment was, in words. */
export const ago = (at: number, now: number): string => {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** How long since a moment, in words: "for 6 min". */
export const lasted = (since: number, now: number): string => {
  const minutes = Math.floor((now - since) / 60_000)
  if (minutes < 1) return "for under a minute"
  if (minutes < 60) return `for ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `for ${hours} h` : `for ${Math.floor(hours / 24)} days`
}

/** Who is reading a listing: its handle, and the handle of the terminal that leads it. */
export type Viewer = { readonly handle: string; readonly lead: string | null }

/** How a peer relates to its reader, by who leads whom now. */
export type Relation = "your lead" | "your teammate" | "led by you" | "peer"

/**
 * How a peer relates to the reader, from the running leads only: the reader's lead, led by
 * the same lead as the reader, led by the reader, or any other agent. A plain shell has none.
 */
export const relationOf = (peer: Peer, viewer: Viewer): Relation | null => {
  if (!peer.agent && !peer.expecting && !peer.untrusted) return null
  if (peer.handle === viewer.lead) return "your lead"
  if (peer.lead !== null && peer.lead === viewer.handle) return "led by you"
  if (peer.lead !== null && peer.lead === viewer.lead) return "your teammate"
  return "peer"
}

/** How long a question's or plan's subject shows in `agents`, in characters; `team` shows more. */
const waitingChars = 80
const fullWaitingChars = 600

/**
 * What a request waiting on the person is: its kind and subject, whole in `team`, never
 * more; a permission's subject never shows (see `waitingOf`).
 */
const waitingNote = (
  { kind, tool, subject, more, since }: Waiting,
  now: number,
  full: boolean,
): string => {
  const shown = subject && flat(subject, full ? fullWaitingChars : waitingChars)
  const what =
    kind === "permission"
      ? `permission to use ${tool}`
      : kind === "question"
        ? `a question${shown ? `: ${shown}` : ""}`
        : `approval of its plan${shown ? `: ${shown}` : ""}`
  const long = since === null ? "" : ` ${lasted(since, now)}`
  return `waiting on the user${long}: ${what}${more > 0 ? ` (and ${more} more)` : ""}`
}

// How long past its time a wake-up still counts as coming, as the app allows it.
const wakeGraceMs = 120_000

/**
 * What an idle agent waits on, shortly, at `now`: a job still within its timeout, or a
 * wake-up not long past; null when nothing is left to wake it. Its own words only: a
 * command may carry a secret (`KEY=… cmd`), as a permission's subject may, so peers never
 * read one.
 */
export const waitsOnNote = (
  waiting: NonNullable<AgentActivity["waiting"]>,
  now: number,
): string | null => {
  const [first, ...rest] = waiting.jobs.filter(({ until }) => until === null || until > now)
  const wake = waiting.wake && waiting.wake.at + wakeGraceMs > now ? waiting.wake : null
  const more = rest.length > 0 ? ` (and ${rest.length} more)` : ""
  if (first)
    return `${first.description ? shorten(first.description, 80) : "a job it started"}${more}`
  return wake ? `a wake-up it set${wake.reason ? `: ${shorten(wake.reason, 80)}` : ""}` : null
}

/** Why nothing can deliver to an agent whose hooks Novadeck can't run where it runs. */
export const untrustedNote = (agent: AgentName): string =>
  `${agentLabel(agent)} runs there, but Novadeck's hooks aren't trusted for it yet ` +
  "(the user can trust them with /hooks)"

/** That a terminal's own session never bound, so replies can't reach it. */
export const unboundNote =
  "Novadeck hasn't seen this terminal's own agent session, so replies can't reach you " +
  "until Novadeck's hooks run here (in Codex, trust them with /hooks)."

/**
 * What runs there and what it is doing: an agent busy or idle and since when, waiting on
 * the user, for how long and for what (whole in `team`), waiting on its own job or wake-up,
 * or asleep, with when its last turn ended;
 * an agent expected there; why no agent there takes messages; or a plain shell's program.
 */
const statusOf = (peer: Peer, now: number, full: boolean): string => {
  if (peer.agent) {
    const doing =
      peer.state === "asleep"
        ? `asleep${peer.since !== null ? ` (last turn ended ${ago(peer.since, now)})` : ""}, no process running; a message wakes it`
        : peer.waiting
          ? waitingNote(peer.waiting, now, full)
          : peer.waitsOn
            ? `waiting on ${peer.waitsOn}, will wake by itself`
            : `${peer.state}${peer.since !== null ? ` ${lasted(peer.since, now)}` : ""}`
    return `${agentLabel(peer.agent)}, ${doing}`
  }
  if (peer.untrusted) return `no agent Novadeck can deliver to: ${untrustedNote(peer.untrusted)}`
  if (peer.expecting)
    return `expecting ${agentLabel(peer.expecting)}, ${peer.startup ? `waiting on the user: its ${peer.startup} screen` : "not started yet"}`
  if (peer.shell?.running)
    return peer.shell.command ? `shell, running ${peer.shell.command}` : "shell, running a program"
  return "shell, at its prompt"
}

/** Title as a listing shows it, one line. */
const titleChars = 80

/** An entry's first line: its handle and title, what runs there and its state, and its relation. */
export const headLine = (peer: Peer, now: number, viewer: Viewer, full = false): string => {
  const title = peer.title ? ` · ${flat(peer.title, titleChars)}` : ""
  const relation = relationOf(peer, viewer)
  return `- ${mention(peer.handle)}${title}: ${statusOf(peer, now, full)}${relation ? `, ${relation}` : ""}`
}

/**
 * Where an agent works, as listings show it: its repository and branch, how far ahead of
 * its upstream (or that it has none), uncommitted changes, and its reported pull request.
 */
const gitText = (peer: Peer): string | null => {
  const { git, pr } = peer
  const parts = git
    ? [
        [git.repo, git.branch].filter(Boolean).join(" "),
        git.state && git.branch && !git.state.detached
          ? git.state.ahead !== null
            ? git.state.ahead > 0 && `${git.state.ahead} ahead`
            : git.state.gone
              ? "upstream gone"
              : "no upstream"
          : null,
        git.state?.dirty && "uncommitted changes",
      ]
    : []
  const all = [...parts, pr && `PR ${pr}`].filter((part): part is string => Boolean(part))
  return all.length > 0 ? all.join(", ") : null
}

/** How long a summary shows, in characters. */
const summaryChars = 160

/** An agent's second line: the summary its agent gave, quoted, and where it works. */
export const detailLine = (peer: Peer): string | null => {
  if (peer.shell) return null
  const parts = [peer.summary && `"${flat(peer.summary, summaryChars)}"`, gitText(peer)].filter(
    (part): part is string => Boolean(part),
  )
  return parts.length > 0 ? `  ${parts.join(" · ")}` : null
}

/** How many of an agent's latest `done` subjects `agents` lists, and how long each shows. */
const shownDones = 3
const doneChars = 100

/**
 * An agent's `done` reports as `agents` lists them: the latest few, newest first, each when
 * and its subject quoted, the latest marked while it still stands, then how many came
 * before. Subjects only; a report at length is for `team`. Null before one.
 */
export const doneLine = (peer: Peer, now: number): string | null => {
  const dones = peer.happenings.flatMap((happening) =>
    happening.kind === "done" ? [happening] : [],
  )
  if (!peer.agent || dones.length === 0) return null
  const shown = dones.slice(-shownDones).toReversed()
  const parts = shown.map(
    (done, index) =>
      `${ago(done.at, now)} "${flat(done.subject, doneChars)}"${index === 0 && peer.standing ? " (still current)" : ""}`,
  )
  const earlier = dones.length - shown.length
  return `  done: ${[...parts, ...(earlier > 0 ? [`and ${earlier} earlier`] : [])].join(" · ")}`
}

/** How much of a failed turn's error shows. */
const failureChars = 120

/**
 * That an agent's last turn failed, when, and why: only while it is not at work again,
 * since a new turn has no outcome yet. Null otherwise.
 */
export const failureLine = (peer: Peer, now: number): string | null => {
  if (!peer.agent || peer.state === "busy") return null
  const last = peer.happenings.findLast((happening) => happening.kind === "turn")
  if (last?.kind !== "turn" || last.outcome !== "failed") return null
  return `  last turn failed ${ago(last.at, now)}${last.text ? `: ${flat(last.text, failureChars)}` : ""}`
}

/** One terminal as `agents` shows it: one line for a shell, up to four for an agent. */
export const renderPeer = (peer: Peer, now: number, viewer: Viewer): readonly string[] =>
  [
    headLine(peer, now, viewer),
    detailLine(peer),
    doneLine(peer, now),
    failureLine(peer, now),
  ].filter((line): line is string => Boolean(line))

/** Words as a list reads them: "a", "a and b", "a, b and c". */
export const listed = (words: readonly string[]): string =>
  words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`

/**
 * The teams there, one line each, from the running leads only: who leads and who it leads,
 * the reader as "you". The reader's own come first; with `own`, only those.
 */
export const rosterLines = (
  viewer: Viewer,
  peers: readonly Peer[],
  own = false,
): readonly string[] => {
  const leads = [
    ...new Set(
      [viewer.lead, viewer.handle, ...peers.map((peer) => peer.lead)].filter(
        (lead): lead is string => lead !== null,
      ),
    ),
  ]
  const lines = leads.flatMap((lead) => {
    const mine = lead === viewer.handle || lead === viewer.lead
    if (own && !mine) return []
    const members = [
      ...peers.filter((peer) => peer.lead === lead).map((peer) => mention(peer.handle)),
      ...(viewer.lead === lead ? ["you"] : []),
    ]
    if (members.length === 0) return []
    const leader = lead === viewer.handle ? "you" : mention(lead)
    return [{ mine, line: `- led by ${leader}: ${listed(members)}` }]
  })
  return lines.toSorted((a, b) => Number(b.mine) - Number(a.mine)).map(({ line }) => line)
}

/** The other terminals in the project and session, as agents read them. */
const renderPeers = (peers: readonly Peer[], now: number, viewer: Viewer): string => {
  if (peers.length === 0) return "There are no other terminals in this project and session."
  const teams = rosterLines(viewer, peers)
  return [
    ...(teams.length > 0 ? ["Teams in this project and session:", ...teams] : []),
    "Other terminals in this project and session:",
    ...peers.flatMap((peer) => renderPeer(peer, now, viewer)),
  ].join("\n")
}

/** What `agents` says of the caller's own message not yet delivered, or gone. */
const standing = (
  message: Message,
  hold: ReturnType<typeof holdOf>,
  why: string | undefined,
): string => {
  if (message.state === "held")
    return hold === "release"
      ? why
        ? `held: ${why}`
        : "held until the user releases its thread"
      : "held while the user has messaging paused"
  if (message.state === "gone")
    return message.stopped
      ? "won't arrive: the user stopped it in Novadeck"
      : "won't arrive: the agent session it was for ended"
  return message.state
}

/** What `agents` answers, as agents read it. */
export const renderAgents = (input: {
  readonly handle: string
  /** The handle of the caller's running lead; null when it has none. */
  readonly lead: string | null
  readonly peers: readonly Peer[]
  readonly messages: readonly {
    readonly message: Message
    readonly hold: ReturnType<typeof holdOf>
    /** Why a message held for release is (`Holds.holdWhy`), as `send` told it. */
    readonly why?: string
  }[]
  readonly unbound: boolean
  readonly now: number
}): string =>
  [
    `You are ${mention(input.handle)} in Novadeck.`,
    renderPeers(input.peers, input.now, { handle: input.handle, lead: input.lead }),
    ...(input.messages.length > 0
      ? [
          "Your messages not yet delivered:",
          ...input.messages.map(
            ({ message, hold, why }) =>
              `- ${message.id} to ${mention(message.to.handle)}, sent ${clock(message.sentAt)}: ${standing(message, hold, why)}`,
          ),
        ]
      : []),
    ...(input.unbound ? [unboundNote] : []),
  ].join("\n")

/**
 * Why `send` refused a `to` that is no current handle of a terminal there: handles are
 * exact and never reused, so it names none of them, with every one described.
 */
export const unknownHandle = (
  to: string,
  self: string,
  peers: readonly Peer[],
  now: number,
  lead: string | null,
): string =>
  [
    to === self
      ? `${mention(self)} is this terminal.`
      : `"${cut(to, 64)}" is no terminal's handle here. Send to one of these by its exact ` +
        "handle, picking by its title, summary and branch; if more than one could be meant, " +
        "ask the user rather than guess.",
    renderPeers(peers, now, { handle: self, lead }),
  ].join("\n")
