import type { AgentName } from "@novadeck/protocol"

import { busiestFolders, shorten, type Work } from "../terminals/work.js"
import { agentLabel, clock, holdOf, type Message } from "./mailbox.js"

/**
 * What the terminal manager knows of a terminal beyond messaging: its title and who gave
 * it (another terminal's handle when its agent did, null for the person); its folder,
 * relative to the project when inside it; its git branch; its current plan's title; what
 * its root session worked on; and how others read a folder it wrote in.
 */
export type Whereabouts = {
  readonly title: string | null
  readonly titledBy: string | null
  readonly folder: string | null
  readonly branch: string | null
  readonly plan: string | null
  readonly work: Work | null
  /** The handle of the terminal whose agent opened it with a task, if one did. */
  readonly openedBy: string | null
  readonly place: (path: string) => string
}

/** Whereabouts by terminal; undefined for one the manager can't tell of. */
export type About = (terminalId: string) => Whereabouts | undefined

/**
 * A terminal another can message, and what tells an agent which it is, all of it
 * NovaDeck's own knowledge, none of it an agent's say: its handle; the agent bound there;
 * its title, and who gave it; its folder and git branch; the person's first and latest
 * prompts there; its plan's title; the folders it writes in most; the latest message
 * between it and the caller; whether its agent is busy, and when it was last active.
 */
export type Peer = {
  readonly terminalId: string
  readonly handle: string
  readonly agent: AgentName | null
  /** The agent it was opened to run, which messages may already be sent to, before it binds. */
  readonly expecting: AgentName | null
  readonly title: string | null
  readonly titledBy: string | null
  readonly folder: string | null
  readonly branch: string | null
  readonly startedWith: string | null
  /** Who opened it with a task, told where "started with" is unknown. */
  readonly openedBy: string | null
  /** Left out when it is the prompt it started with. */
  readonly latest: string | null
  readonly plan: string | null
  readonly worksIn: readonly { readonly folder: string; readonly edits: number }[]
  /** Who sent the latest message between it and the caller (`you`, or its handle), and when. */
  readonly withYou: { readonly from: string; readonly text: string; readonly at: number } | null
  readonly state: "busy" | "idle" | null
  readonly activeAt: number | null
}

/** How long a message's excerpt shows, in characters. */
export const excerptChars = 80

/** The latest message between the caller and a peer, either way, shortened. */
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
      (from.terminalId === peer.terminalId && to.terminalId === self)
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
  readonly busy: boolean
  readonly where: Whereabouts | undefined
  readonly withYou: Peer["withYou"]
}): Peer => {
  const { where, agent } = input
  const work = agent ? (where?.work ?? null) : null
  const place = where?.place ?? ((path: string) => path)
  return {
    terminalId: input.terminalId,
    handle: input.handle,
    agent,
    expecting: agent ? null : input.expecting,
    title: where?.title ?? null,
    titledBy: where?.title ? where.titledBy : null,
    folder: where?.folder ?? null,
    branch: where?.branch ?? null,
    startedWith: work?.first ?? null,
    openedBy: where?.openedBy ?? null,
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

/** One peer as agents read it: a short block, each fact left out when unknown. */
export const renderPeer = (peer: Peer, now: number): readonly string[] =>
  [
    `- ${peer.handle}: ${
      peer.agent
        ? `${agentLabel(peer.agent)}, ${peer.state}${peer.activeAt === null ? "" : `, last active ${ago(peer.activeAt, now)}`}`
        : peer.expecting
          ? `expecting ${agentLabel(peer.expecting)}, not started yet`
          : "no agent NovaDeck can deliver to"
    }`,
    peer.title &&
      `  title: ${peer.title}${peer.titledBy ? ` (set by ${peer.titledBy}, not the user)` : ""}`,
    peer.folder && `  folder: ${peer.folder}${peer.branch ? `, branch ${peer.branch}` : ""}`,
    peer.startedWith
      ? `  started with: ${peer.startedWith}`
      : peer.openedBy && `  opened by ${peer.openedBy} with a task`,
    peer.latest && `  latest: ${peer.latest}`,
    peer.plan && `  plan: ${peer.plan}`,
    peer.worksIn.length > 0 &&
      `  works in: ${peer.worksIn.map(({ folder, edits }) => `${folder} (${edits})`).join(", ")}`,
    peer.withYou &&
      `  with you: ${peer.withYou.from}, ${ago(peer.withYou.at, now)}: ${peer.withYou.text}`,
  ].filter((line): line is string => Boolean(line))

/** The other terminals in the project and session, as agents read them. */
export const renderPeers = (peers: readonly Peer[], now: number): string =>
  peers.length === 0
    ? "There are no other terminals in this project and session."
    : [
        "Other terminals in this project and session:",
        ...peers.flatMap((peer) => renderPeer(peer, now)),
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

/** That a terminal's own session never bound, so replies can't reach it. */
export const unboundNote =
  "NovaDeck hasn't seen this terminal's own agent session, so replies can't reach you " +
  "until NovaDeck's hooks run here (in Codex, trust them with /hooks)."

/** What `agents` answers, as agents read it. */
export const renderAgents = (input: {
  readonly handle: string
  readonly peers: readonly Peer[]
  readonly messages: readonly {
    readonly message: Message
    readonly hold: ReturnType<typeof holdOf>
  }[]
  readonly unbound: boolean
  readonly now: number
}): string =>
  [
    `You are ${input.handle} in NovaDeck.`,
    renderPeers(input.peers, input.now),
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
): string =>
  [
    to === self
      ? `${self} is this terminal.`
      : `"${to.slice(0, 64)}" is no terminal's handle here. Send to one of these by its exact ` +
        "handle, picking by its title, folder and work; if more than one could be meant, ask " +
        "the user rather than guess.",
    renderPeers(peers, now),
  ].join("\n")
