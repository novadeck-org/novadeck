import { mention } from "../terminals/handles.js"
import {
  ago,
  asksLine,
  detailLine,
  doneLine,
  endedLine,
  failureLine,
  foldersLine,
  headLine,
  runningLine,
  showingLine,
  worktreesLine,
  type Peer,
  type Viewer,
} from "./peers.js"
import { happened, type Entry } from "./team.js"

/** How many of a terminal's latest timeline entries a lookup shows. */
export const lookedEntries = 10

/**
 * One terminal as `agents` with its handle shows it: everything the listing says of it,
 * whole (what it waits on the user for in full, every worktree with its pull request), the
 * folders its work wrote in, its asks open in the person's Inbox, then its latest
 * happenings as `team` lists a member's (its reports with their bodies, its asks, each turn
 * it ended without a report with the start of its reply, its failed turns) and the messages
 * between it and the caller. A peer sees what a teammate does.
 */
const lookedUp = (
  peer: Peer,
  viewer: Viewer,
  exchanges: readonly Entry[],
  now: number,
): readonly string[] => {
  const entries = [...happened(peer.happenings), ...exchanges].toSorted((a, b) => a.at - b.at)
  const shown = entries.slice(-lookedEntries)
  const earlier = entries.length - shown.length
  const facts = [
    headLine(peer, now, viewer, true),
    detailLine(peer),
    worktreesLine(peer, true),
    foldersLine(peer),
    runningLine(peer, now),
    endedLine(peer, now),
    showingLine(peer, now),
    doneLine(peer, now, true),
    asksLine(peer, now),
    failureLine(peer, now),
  ].filter((line): line is string => Boolean(line))
  // Its tells since its latest done are in the timeline already, with their bodies.
  const timeline =
    shown.length > 0
      ? [
          `  latest${earlier > 0 ? ` (and ${earlier} earlier)` : ""}:`,
          ...shown.map(({ at, text }) => `    ${ago(at, now)}, ${text}`),
        ]
      : peer.agent
        ? ["  nothing reported yet"]
        : []
  return [...facts, ...timeline]
}

/** What `agents` answers when asked for terminals by handle, as agents read it. */
export const renderLookup = (input: {
  readonly handle: string
  readonly lead: string | null
  /** The terminals asked for, in the order asked. */
  readonly peers: readonly Peer[]
  /** Each one's messages with the caller, as `exchanged` makes them. */
  readonly exchanges: (peer: Peer) => readonly Entry[]
  readonly now: number
}): string => {
  const viewer: Viewer = { handle: input.handle, lead: input.lead }
  return [
    `You are ${mention(input.handle)} in Novadeck.`,
    ...input.peers.flatMap((peer) => lookedUp(peer, viewer, input.exchanges(peer), input.now)),
  ].join("\n")
}
