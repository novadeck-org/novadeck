import type { AgentName, TitleSource } from "@novadeck/protocol"

import { busiestFolders, firstFrom, shorten, type Work } from "../terminals/work.js"
import { agentLabel, clock, holdOf, type Message } from "./mailbox.js"

/**
 * What the terminal manager knows of a terminal beyond messaging: its title and who it
 * is from; the summary its own agent gave of its work; its folder, relative to
 * the project when inside it; its git branch; its current plan's title; what its root
 * session worked on; and how others read a folder it wrote in.
 */
export type Whereabouts = {
  readonly title: string | null
  readonly titleSource: TitleSource | null
  readonly summary: string | null
  readonly folder: string | null
  readonly branch: string | null
  readonly plan: string | null
  readonly work: Work | null
  /** The handle of the terminal whose agent opened it, if one did. */
  readonly openedBy: string | null
  /** Whether its agent works, as its terminal shows: its turn, or what that left running. */
  readonly working: boolean
  /** What its agent waits on the person for, if anything; null otherwise. */
  readonly waiting: Waiting | null
  readonly place: (path: string) => string
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
}

/** Whereabouts by terminal; undefined for one the manager can't tell of. */
export type About = (terminalId: string) => Whereabouts | undefined

/**
 * A terminal another can message, and what tells an agent which it is, all of it
 * Novadeck's own knowledge, and only what is marked so an agent's say: its handle; the
 * agent bound there; its title, and who it is from; the summary its own agent gave of its work;
 * its folder and git branch; the person's first and latest prompts there; its
 * plan's title; the folders it writes in most; the latest message between it and the
 * caller; whether its agent is busy or waits on the person, and when it was last active.
 */
export type Peer = {
  readonly terminalId: string
  readonly handle: string
  readonly agent: AgentName | null
  /** The agent it was opened to run, which messages may already be sent to, before it binds. */
  readonly expecting: AgentName | null
  /**
   * The agent whose prompt shows there with no session bound, but whose hooks Novadeck
   * can't run there until the user trusts them (Codex's `/hooks`): nothing can deliver.
   */
  readonly untrusted: AgentName | null
  readonly title: string | null
  readonly titleSource: TitleSource | null
  /** What its own agent said it works on, through `summarize`. */
  readonly summary: string | null
  readonly folder: string | null
  readonly branch: string | null
  readonly startedWith: string | null
  /** The handle of the terminal that leads it now: running, and in its session; else null. */
  readonly lead: string | null
  /** The opener whose command "started with" is, not the user's; null when it is the user's. */
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
  readonly activeAt: number | null
}

/** How long a message's excerpt shows, in characters. */
export const excerptChars = 80

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
    const { from, to } = message
    const between =
      (from.terminalId === self && to.terminalId === peer.terminalId) ||
      (from.terminalId === peer.terminalId &&
        to.terminalId === self &&
        message.state === "delivered")
    if (between && (!last || message.sentAt >= last.sentAt)) last = message
  }
  if (!last) return null
  const from = last.from.terminalId === self ? "you" : peer.handle
  return { from, text: shorten(last.text, excerptChars), at: last.sentAt }
}

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
}): Peer => {
  const { where, agent } = input
  const work = agent ? (where?.work ?? null) : null
  const openedBy = where?.openedBy ?? null
  const place = where?.place ?? ((path: string) => path)
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
    branch: where?.branch ?? null,
    startedWith: work?.first ?? null,
    lead: input.lead,
    // In a terminal an agent opened, a first prompt nobody submitted is its command's.
    startedBy: firstFrom(work, openedBy) === "opener" ? openedBy : null,
    latest: work?.latest !== work?.first ? (work?.latest ?? null) : null,
    plan: agent ? (where?.plan ?? null) : null,
    worksIn: work
      ? busiestFolders(work.folders).map(({ folder, edits }) => ({
          // One separator wherever the runner runs, as agents read it.
          folder: `${place(folder).replaceAll("\\", "/").replace(/\/$/, "")}/`,
          edits,
        }))
      : [],
    withYou: input.withYou,
    state: agent ? (input.busy ? "busy" : "idle") : null,
    waiting: agent ? (where?.waiting ?? null) : null,
    activeAt: work?.activeAt ?? null,
  }
}

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
  if (source?.kind === "agent") return ` (set by ${source.by}, not the user)`
  return source?.kind === "murmur" ? " (written by Novadeck's local model, not the user)" : ""
}

/** Who is reading a listing: its handle, and the handle of the terminal that leads it. */
export type Viewer = { readonly handle: string; readonly lead: string | null }

/**
 * How a peer relates to the reader, by who leads it now: led by you, your lead, or led by
 * another. A lead whose terminal closed leads no one, so nothing is said of it.
 */
const relationLine = (peer: Peer, viewer: Viewer): string | null => {
  if (peer.handle === viewer.lead) return "your lead: it opened this terminal and directs your work"
  if (!peer.lead) return null
  if (peer.lead === viewer.handle) return "led by you"
  return `led by ${peer.lead}`
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

/** One peer as agents read it: a short block, each fact left out when unknown. */
export const renderPeer = (peer: Peer, now: number, viewer: Viewer): readonly string[] =>
  [
    `- ${peer.handle}: ${
      peer.agent
        ? `${agentLabel(peer.agent)}, ${peer.waiting ? waitingNote(peer.waiting) : peer.state}${peer.activeAt === null ? "" : `, last active ${ago(peer.activeAt, now)}`}`
        : peer.untrusted
          ? `no agent Novadeck can deliver to: ${untrustedNote(peer.untrusted)}`
          : peer.expecting
            ? `expecting ${agentLabel(peer.expecting)}, not started yet`
            : "no agent Novadeck can deliver to"
    }`,
    peer.title && `  title: ${peer.title}${titleNote(peer)}`,
    peer.summary && `  described by its agent: ${peer.summary.split("\n").join(" / ")}`,
    peer.folder && `  folder: ${peer.folder}${peer.branch ? `, branch ${peer.branch}` : ""}`,
    relationLine(peer, viewer) && `  ${relationLine(peer, viewer)}`,
    peer.startedWith &&
      `  started with${peer.startedBy ? ` (${peer.startedBy}'s command)` : ""}: ${peer.startedWith}`,
    peer.latest && `  latest: ${peer.latest}`,
    peer.plan && `  plan: ${peer.plan}`,
    peer.worksIn.length > 0 &&
      `  works in: ${peer.worksIn.map(({ folder, edits }) => `${folder} (${edits})`).join(", ")}`,
    peer.withYou &&
      `  with you: ${peer.withYou.from}, ${ago(peer.withYou.at, now)}: ${peer.withYou.text}`,
  ].filter((line): line is string => Boolean(line))

/** The other terminals in the project and session, as agents read them. */
export const renderPeers = (peers: readonly Peer[], now: number, viewer: Viewer): string =>
  peers.length === 0
    ? "There are no other terminals in this project and session."
    : [
        "Other terminals in this project and session:",
        ...peers.flatMap((peer) => renderPeer(peer, now, viewer)),
      ].join("\n")

/** What `agents` says of the caller's own message not yet delivered, or gone. */
const standing = (message: Message, hold: ReturnType<typeof holdOf>): string => {
  if (message.state === "held")
    return hold === "release"
      ? "held until the user releases its thread"
      : "held while the user has messaging paused"
  if (message.state === "gone") return "won't arrive: the agent session it was for ended"
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

/** What `agents` answers, as agents read it. */
export const renderAgents = (input: {
  readonly handle: string
  /** The handle of the caller's running lead; null when it has none. */
  readonly lead: string | null
  readonly peers: readonly Peer[]
  readonly messages: readonly {
    readonly message: Message
    readonly hold: ReturnType<typeof holdOf>
  }[]
  readonly unbound: boolean
  readonly now: number
}): string =>
  [
    `You are ${input.handle} in Novadeck.`,
    renderPeers(input.peers, input.now, { handle: input.handle, lead: input.lead }),
    ...(input.messages.length > 0
      ? [
          "Your messages not yet delivered:",
          ...input.messages.map(
            ({ message, hold }) =>
              `- ${message.id} to ${message.to.handle}, sent ${clock(message.sentAt)}: ${standing(message, hold)}`,
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
      ? `${self} is this terminal.`
      : `"${to.slice(0, 64)}" is no terminal's handle here. Send to one of these by its exact ` +
        "handle, picking by its title, folder and work; if more than one could be meant, ask " +
        "the user rather than guess.",
    renderPeers(peers, now, { handle: self, lead }),
  ].join("\n")
