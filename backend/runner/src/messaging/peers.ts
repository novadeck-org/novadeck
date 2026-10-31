import type { AgentActivity, AgentName, TitleSource } from "@novadeck/protocol"

import { bareHandle, mention } from "../terminals/handles.js"
import { busiestFolders, firstFrom, plainPrompt, type Work } from "../terminals/work.js"
import { cut, shorten } from "../text.js"
import { agentLabel, clock, holdOf, isNotice, senderTerminal, type Message } from "./messages.js"

/**
 * What the terminal manager knows of a terminal beyond messaging: its title and who it
 * is from; the summary its own agent gave of its work; its folder, relative to
 * the project when inside it; its git branch; its current plan's title; what its root
 * session worked on; its agent's latest reports; and how others read a folder it wrote in.
 */
export type Whereabouts = {
  readonly title: string | null
  readonly titleSource: TitleSource | null
  readonly summary: string | null
  /** Where its agent works now: its terminal's folder, or another checkout its tool calls are in. */
  readonly folder: string | null
  /** Its terminal's own folder, where its agent works in another checkout; null otherwise. */
  readonly startedIn: string | null
  /** The git branch of `folder`. */
  readonly branch: string | null
  readonly plan: string | null
  readonly work: Work | null
  /** The handle of the terminal whose agent opened it, if one did. */
  readonly openedBy: string | null
  /** Whether its agent works, as its terminal shows: its turn, or what that left running. */
  readonly working: boolean
  /** What its agent waits on the person for, if anything; null otherwise. */
  readonly waiting: Waiting | null
  /** What its idle agent waits on to wake it, if anything: see `Peer.waitsOn`. */
  readonly waitsOn: string | null
  /** The latest reports its agent session gave the person. */
  readonly reports: Reports
  readonly place: (path: string) => string
}

/** A report an agent gave the person through `tell` or `done`: its subject, and when. */
export type Report = { readonly subject: string; readonly at: number }

/** An agent session's latest `tell` and latest `done`, each null before one. */
export type Reports = { readonly tell: Report | null; readonly done: Report | null }

/**
 * A request waiting on the person, as listing it shows: its kind, the tool it is about, a
 * short subject (a command, a file, a question), and how many more wait behind it.
 */
export type Waiting = {
  readonly kind: "permission" | "question" | "plan"
  readonly tool: string
  readonly subject: string | null
  readonly more: number
}

/** Whereabouts by terminal; undefined for one the manager can't tell of. */
export type About = (terminalId: string) => Whereabouts | undefined

/**
 * A terminal another can message, and what tells an agent which it is, all of it
 * Novadeck's own knowledge, and only what is marked so an agent's say: its handle; the
 * agent bound there; its title, and who it is from; the summary its own agent gave of its work;
 * its folder and git branch; the person's first and latest prompts there; its
 * plan's title; the folders it writes in most; the latest message between it and the
 * caller; whether its agent is busy or waits on the person; whether it reported its task
 * done and its latest report; and when it was last active.
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
  readonly title: string | null
  readonly titleSource: TitleSource | null
  /** What its own agent said it works on, through `summarize`. */
  readonly summary: string | null
  /** Where its agent works now, and that folder's git branch (see `Whereabouts`). */
  readonly folder: string | null
  /** Its terminal's own folder, where its agent works in another checkout; null otherwise. */
  readonly startedIn: string | null
  readonly branch: string | null
  readonly startedWith: string | null
  /** The handle of the terminal that leads it now: running, and in its session; else null. */
  readonly lead: string | null
  /** The opener whose command "started with" is, not the person's; null when it is the person's. */
  readonly startedBy: string | null
  /** Left out when it is the prompt it started with. */
  readonly latest: string | null
  readonly plan: string | null
  readonly worksIn: readonly { readonly folder: string; readonly edits: number }[]
  /** Who sent the latest message between it and the caller (`you`, or its handle), and when. */
  readonly withYou: { readonly from: string; readonly text: string; readonly at: number } | null
  readonly state: "busy" | "idle" | null
  /** What its agent waits on the person for; its work is blocked until they answer. */
  readonly waiting: Waiting | null
  /**
   * What its idle agent waits on to wake it, with no word from anyone: its job's own
   * description, cut short, or "a job it started" where it gave none (never its command,
   * which may carry a secret), and how many more; or a wake-up it set.
   */
  readonly waitsOn: string | null
  /**
   * Its agent's report that its task is finished, made since the person's latest prompt
   * and the latest message delivered to it; null otherwise.
   */
  readonly done: Report | null
  /** Its agent's latest `tell` or `done`, when it isn't `done`; null without one. */
  readonly update: Report | null
  readonly activeAt: number | null
}

/** How long a message's excerpt shows, in characters. */
const excerptChars = 80
/** How long a report's subject shows, in characters. */
const reportChars = 120

/**
 * The `done` of an agent session that still stands: its latest, read or not, unless the
 * person's prompt or a message delivered to the agent came after it and gave it more to do.
 * The one rule behind a peer's `done` in the agents listing and the terminal summary's
 * `reported`, so they never differ.
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

/**
 * The latest message between the caller and a peer, either way, shortened: one the caller
 * sent, or one delivered to it. A message still on its way to the caller (queued, held
 * or leased) is never shown, so listing peers never gets past a pause or delivery.
 */
export const lastBetween = (
  messages: Iterable<Message>,
  self: string,
  peer: { readonly terminalId: string; readonly handle: string },
): Peer["withYou"] => {
  let last: Message | undefined
  for (const message of messages) {
    const { to } = message
    const from = senderTerminal(message.from)
    const between =
      (from === self && to.terminalId === peer.terminalId) ||
      (from === peer.terminalId && to.terminalId === self && message.state === "delivered")
    if (between && (!last || message.sentAt >= last.sentAt)) last = message
  }
  if (!last) return null
  const from = senderTerminal(last.from) === self ? "you" : peer.handle
  return { from, text: shorten(last.text, excerptChars), at: last.sentAt }
}

/** A report as a listing shows it, its subject cut short. */
const cutShort = (report: Report): Report => ({
  ...report,
  subject: shorten(report.subject, reportChars),
})

/** A peer, from what messaging knows of it and the manager's whereabouts. */
export const peerOf = (input: {
  readonly terminalId: string
  readonly handle: string
  readonly agent: AgentName | null
  readonly expecting: AgentName | null
  readonly untrusted?: AgentName | null
  readonly busy: boolean
  readonly where: Whereabouts | undefined
  readonly withYou: Peer["withYou"]
  /** Its running lead's handle; null when it has none, or the terminal that leads it is gone. */
  readonly lead: string | null
  /** When the latest message delivered to it was delivered: see `deliveredTo`. */
  readonly deliveredAt: number | null
}): Peer => {
  const { where, agent } = input
  const work = agent ? (where?.work ?? null) : null
  const openedBy = where?.openedBy ?? null
  const place = where?.place ?? ((path: string) => path)
  const reports = agent ? where?.reports : undefined
  const done = standingDone(reports, work?.personAt, input.deliveredAt)
  const [latest] = [reports?.tell, reports?.done]
    .filter((report): report is Report => Boolean(report))
    .toSorted((a, b) => b.at - a.at)
  return {
    terminalId: input.terminalId,
    handle: input.handle,
    agent,
    expecting: agent || input.untrusted ? null : input.expecting,
    untrusted: agent ? null : (input.untrusted ?? null),
    title: where?.title ?? null,
    titleSource: where?.title ? where.titleSource : null,
    summary: where?.summary ?? null,
    folder: where?.folder ?? null,
    startedIn: where?.startedIn ?? null,
    branch: where?.branch ?? null,
    // What an older runner kept with its wrapping tags shows without them too.
    startedWith: work?.first ? plainPrompt(work.first) : null,
    lead: input.lead,
    // In a terminal an agent opened, a first prompt nobody submitted is its command's.
    startedBy: firstFrom(work, openedBy) === "opener" ? openedBy : null,
    latest: work?.latest && work.latest !== work.first ? plainPrompt(work.latest) : null,
    plan: agent ? (where?.plan ?? null) : null,
    worksIn: work
      ? busiestFolders(work.folders).map(({ folder, edits }) => ({
          // One separator wherever the runner runs, as agents read it.
          folder: `${quietPath(place(folder).replaceAll("\\", "/")).replace(/\/$/, "")}/`,
          edits,
        }))
      : [],
    withYou: input.withYou && { ...input.withYou, text: plainPrompt(input.withYou.text) },
    state: agent ? (input.busy ? "busy" : "idle") : null,
    waiting: agent ? (where?.waiting ?? null) : null,
    waitsOn: agent && !input.busy ? (where?.waitsOn ?? null) : null,
    done: done && cutShort(done),
    update: latest && latest !== done ? cutShort(latest) : null,
    activeAt: work?.activeAt ?? null,
  }
}

// A path's part that is an id rather than a name: a UUID, a long hex digest, or a folder
// path a harness encoded into one name (`-home-me-work-repo`), as scratchpads, Claude Code's
// project memory and Antigravity's conversation folders hold.
const idPart =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|-[^/]*-[^/]*-[^/]{8,})$/i

/**
 * A path with each run of id parts as one `…`, so a folder outside the project reads by its
 * names, as `/tmp/claude-1000/…/scratchpad/`, rather than by ids no agent can use.
 */
export const quietPath = (path: string): string =>
  path
    .split("/")
    .map((part) => (idPart.test(part) ? "…" : part))
    .filter((part, at, parts) => part !== "…" || parts[at - 1] !== "…")
    .join("/")

/** How long ago a moment was, in words. */
export const ago = (at: number, now: number): string => {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** Who a peer's title is from, as agents read it after the title; nothing for the person's. */
const titleNote = (peer: Peer): string => {
  const source = peer.titleSource
  if (source?.kind === "agent") return ` (set by ${mention(source.by)}, not the user)`
  return source?.kind === "murmur" ? " (written by Novadeck's local model, not the user)" : ""
}

/** Who is reading a listing: its handle, and the handle of the terminal that leads it. */
type Viewer = { readonly handle: string; readonly lead: string | null }

/**
 * How a peer relates to the reader, by who leads it now: led by you, your lead, or led by
 * another. A lead whose terminal closed leads no one, so nothing is said of it.
 */
const relationLine = (peer: Peer, viewer: Viewer): string | null => {
  if (peer.handle === viewer.lead) return "your lead: it directs your work"
  if (!peer.lead) return null
  if (peer.lead === viewer.handle) return "led by you"
  return `led by ${mention(peer.lead)}`
}

/** What a request waiting on the person is, shortly: its kind and subject, never more. */
const waitingNote = ({ kind, tool, subject, more }: Waiting): string => {
  const shown = subject && shorten(subject, 80)
  const what =
    kind === "permission"
      ? `permission to use ${tool}${shown ? `: ${shown}` : ""}`
      : kind === "question"
        ? `a question${shown ? `: ${shown}` : ""}`
        : `approval of its plan${shown ? `: ${shown}` : ""}`
  return `waiting on the user: ${what}${more > 0 ? ` (and ${more} more)` : ""}`
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

/**
 * Its agent and what that is doing: busy, idle, waiting on the user and for what, or
 * waiting on its own job or wake-up; or why no agent there takes messages.
 */
const statusOf = (peer: Peer): string =>
  peer.agent
    ? `${agentLabel(peer.agent)}, ${peer.waiting ? waitingNote(peer.waiting) : peer.waitsOn ? `waiting on ${peer.waitsOn}, will wake by itself` : peer.state}`
    : peer.untrusted
      ? `no agent Novadeck can deliver to: ${untrustedNote(peer.untrusted)}`
      : peer.expecting
        ? `expecting ${agentLabel(peer.expecting)}, not started yet`
        : "no agent Novadeck can deliver to"

/** One peer as agents read it: a short block, each fact left out when unknown. */
export const renderPeer = (peer: Peer, now: number, viewer: Viewer): readonly string[] =>
  [
    `- ${mention(peer.handle)}: ${statusOf(peer)}${peer.agent && peer.activeAt !== null ? `, last active ${ago(peer.activeAt, now)}` : ""}`,
    peer.title && `  title: ${peer.title}${titleNote(peer)}`,
    peer.summary && `  described by its agent: ${peer.summary.split("\n").join(" / ")}`,
    peer.done && `  reported done ${ago(peer.done.at, now)}: ${peer.done.subject}`,
    peer.update && `  latest update ${ago(peer.update.at, now)}: ${peer.update.subject}`,
    peer.folder &&
      `  folder: ${peer.folder}${peer.branch ? `, branch ${peer.branch}` : ""}${peer.startedIn ? ` (its agent works here now; its terminal started in ${peer.startedIn})` : ""}`,
    relationLine(peer, viewer) && `  ${relationLine(peer, viewer)}`,
    peer.startedWith &&
      `  started with${peer.startedBy ? ` (${mention(peer.startedBy)}'s command)` : ""}: ${peer.startedWith}`,
    peer.latest && `  latest: ${peer.latest}`,
    peer.plan && `  plan: ${peer.plan}`,
    peer.worksIn.length > 0 &&
      `  works in: ${peer.worksIn.map(({ folder, edits }) => `${folder} (${edits})`).join(", ")}`,
    peer.withYou &&
      `  with you: ${peer.withYou.from === "you" ? "you" : mention(peer.withYou.from)}, ${ago(peer.withYou.at, now)}: ${peer.withYou.text}`,
  ].filter((line): line is string => Boolean(line))

/** How long the summary a compact line falls back to shows, in characters. */
const compactSummaryChars = 100

/**
 * One peer as a compact listing reads it, on one line: its handle and title; its agent and
 * whether that is busy, idle, waiting on the user (always, as a lead scans for it) or on
 * its own job; its branch; how it relates to the reader; and its standing done, else its
 * latest update, else its agent's summary.
 */
export const compactPeer = (peer: Peer, now: number, viewer: Viewer): string => {
  const relation =
    peer.handle === viewer.lead
      ? "your lead"
      : peer.lead === viewer.handle
        ? "led by you"
        : peer.lead && `led by ${mention(peer.lead)}`
  const facts = [statusOf(peer), peer.branch && `on ${peer.branch}`, relation].filter(Boolean)
  const latest = peer.done
    ? `done ${ago(peer.done.at, now)}: ${peer.done.subject}`
    : peer.update
      ? `update ${ago(peer.update.at, now)}: ${peer.update.subject}`
      : peer.summary && `described as: ${shorten(peer.summary, compactSummaryChars)}`
  const title = peer.title ? ` · ${peer.title}` : ""
  return `- ${mention(peer.handle)}${title}: ${facts.join(", ")}${latest ? ` — ${latest}` : ""}`
}

/**
 * How a listing shows the terminals: `compact`, a line each; `full`, a block each; or
 * `one`, the block of the terminal with that handle alone.
 */
export type View =
  | { readonly kind: "compact" }
  | { readonly kind: "full" }
  | { readonly kind: "one"; readonly handle: string }

/**
 * Past how many other terminals a listing is compact unless asked for in full; the
 * `agents` tool's description says it in words ("more than five").
 */
export const compactPast = 5

/** The view a listing takes unless asked for one: compact past `compactPast` terminals. */
export const defaultView = (peers: readonly Peer[]): View =>
  peers.length > compactPast ? { kind: "compact" } : { kind: "full" }

/** What a compact listing says of how to see more. */
const compactNote =
  'One line each, as there are many; call agents with terminal (a handle, as "@fox") for ' +
  "one terminal's details (its folder, prompts, plan, the folders it writes in, and the " +
  "latest message between you), or with full true for every terminal's."

/** The other terminals in the project and session, as agents read them, in `view`. */
const renderPeers = (
  peers: readonly Peer[],
  now: number,
  viewer: Viewer,
  view: View = defaultView(peers),
): string => {
  if (peers.length === 0) return "There are no other terminals in this project and session."
  if (view.kind === "one") {
    const handle = bareHandle(view.handle)
    const peer = peers.find((each) => each.handle === handle)
    if (peer) return renderPeer(peer, now, viewer).join("\n")
    return [
      `"${cut(view.handle, 64)}" is no other terminal's handle here; these are:`,
      renderPeers(peers, now, viewer),
    ].join("\n")
  }
  if (view.kind === "compact")
    return [
      `Other terminals in this project and session (${peers.length}). ${compactNote}`,
      ...peers.map((peer) => compactPeer(peer, now, viewer)),
    ].join("\n")
  return [
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

/** Why nothing can deliver to an agent whose hooks Novadeck can't run where it runs. */
export const untrustedNote = (agent: AgentName): string =>
  `${agentLabel(agent)} runs there, but Novadeck's hooks aren't trusted for it yet ` +
  "(the user can trust them with /hooks)"

/** That a terminal's own session never bound, so replies can't reach it. */
export const unboundNote =
  "Novadeck hasn't seen this terminal's own agent session, so replies can't reach you " +
  "until Novadeck's hooks run here (in Codex, trust them with /hooks)."

/** Handles as a listing names them, in order: `@fox, @owl`. */
const mentions = (peers: readonly Peer[]): string =>
  peers.map(({ handle }) => mention(handle)).join(", ")

/**
 * The caller's team, from who leads whom now: its lead and the others that lead leads, and
 * the terminals the caller leads; nothing when it is in no team.
 */
const teamLines = (
  handle: string,
  lead: string | null,
  peers: readonly Peer[],
): readonly string[] => {
  const mates = lead ? peers.filter((peer) => peer.lead === lead) : []
  const led = peers.filter((peer) => peer.lead === handle)
  return [
    lead &&
      `Your team: led by ${mention(lead)}${mates.length > 0 ? `, with ${mentions(mates)}` : ", no other teammates"}.`,
    led.length > 0 && `${lead ? "You also lead" : "Your team: you lead"} ${mentions(led)}.`,
  ].filter((line): line is string => Boolean(line))
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
  /** How to show the terminals; by default compact past `compactPast` of them. */
  readonly view?: View
}): string =>
  [
    `You are ${mention(input.handle)} in Novadeck.`,
    ...teamLines(input.handle, input.lead, input.peers),
    renderPeers(
      input.peers,
      input.now,
      {
        handle: input.handle,
        lead: input.lead,
      },
      input.view,
    ),
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
        "handle, picking by its title, folder and work; if more than one could be meant, ask " +
        "the user rather than guess.",
    ...teamLines(self, lead, peers),
    renderPeers(peers, now, { handle: self, lead }),
  ].join("\n")
