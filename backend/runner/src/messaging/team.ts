import { mention } from "../terminals/handles.js"
import { senderTerminal, isNotice, type Message } from "./messages.js"
import {
  ago,
  detailLine,
  flat,
  headLine,
  relationOf,
  rosterLines,
  type Happening,
  type Peer,
  type Relation,
  type Viewer,
} from "./peers.js"

/**
 * What a caller saw at its last `team`: when it looked, and each member's state then (see
 * `stateKey`), so a member with nothing new since collapses to one line.
 */
export type Look = { readonly at: number; readonly states: ReadonlyMap<string, string> }

/** What tells a member's state apart for `team`: what runs there, busy or idle, what it waits on. */
export const stateKey = (peer: Peer): string =>
  JSON.stringify([
    peer.agent,
    peer.expecting,
    peer.state,
    peer.waiting?.kind ?? null,
    peer.waiting?.subject ?? null,
    peer.waitsOn,
  ])

/** How many entries each member shows at most, the latest. */
export const shownEntries = 5

/** One line of a member's timeline: when, and what. */
export type Entry = { readonly at: number; readonly text: string }

// How much of each kind of text an entry shows, in characters.
const subjectChars = 160
const bodyChars = 240
const textChars = 200

/**
 * A member's reports, asks and turns that ended without a report, as entries. A turn counts
 * as reported when a `tell` or `done` came after the turn before it ended, up to its own end.
 */
export const happened = (happenings: readonly Happening[]): Entry[] => {
  const reports = happenings.filter(({ kind }) => kind === "update" || kind === "done")
  let previous = -Infinity
  return happenings.flatMap((happening): Entry[] => {
    const { at } = happening
    if (happening.kind === "turn") {
      const reported = reports.some((report) => report.at > previous && report.at <= at)
      previous = at
      if (reported) return []
      const said = happening.text && flat(happening.text, textChars)
      return [
        {
          at,
          text:
            happening.outcome === "failed"
              ? `turn failed${said ? `: ${said}` : ""}`
              : `turn ended without a report${said ? `: "${said}"` : ""}`,
        },
      ]
    }
    if (happening.kind === "asked")
      return [{ at, text: `asked the user: ${flat(happening.subject, subjectChars)}` }]
    const body = happening.body.trim() ? ` — ${flat(happening.body, bodyChars)}` : ""
    return [{ at, text: `${happening.kind}: ${flat(happening.subject, subjectChars)}${body}` }]
  })
}

/**
 * The messages between the caller and a member, either way, as entries: one the caller
 * sent in any state, saying where it is; one the member sent the caller only once
 * delivered, else that one is on its way with no text, so a listing never gets past a
 * pause or a delivery. Novadeck's own notices aren't messages between them.
 */
export const exchanged = (
  messages: Iterable<Message>,
  caller: string,
  member: { readonly terminalId: string; readonly handle: string },
): Entry[] => {
  const entries: Entry[] = []
  for (const message of messages) {
    if (isNotice(message)) continue
    const from = senderTerminal(message.from)
    const said = `"${flat(message.text, textChars)}"`
    if (from === caller && message.to.terminalId === member.terminalId) {
      const where =
        message.state === "delivered"
          ? ""
          : message.state === "gone"
            ? ", won't arrive"
            : message.state === "held"
              ? ", held until the user lets it go"
              : ", on its way"
      entries.push({ at: message.sentAt, text: `you → ${mention(member.handle)}${where}: ${said}` })
    } else if (from === member.terminalId && message.to.terminalId === caller) {
      if (message.state === "gone") continue
      entries.push({
        at: message.sentAt,
        text:
          message.state === "delivered"
            ? `${mention(member.handle)} → you: ${said}`
            : `${mention(member.handle)} → you: a message on its way to you`,
      })
    }
  }
  return entries
}

/** The order members show in: the reader's lead, its teammates, then those it leads. */
const rank: { readonly [relation in Relation]: number } = {
  "your lead": 0,
  "your teammate": 1,
  "led by you": 2,
  peer: 3,
}

/** What `team` answers, as agents read it, and what the caller saw, for its next look. */
export const renderTeam = (input: {
  readonly handle: string
  readonly lead: string | null
  readonly peers: readonly Peer[]
  /** Each member's messages with the caller, as `exchanged` makes them. */
  readonly exchanges: (peer: Peer) => readonly Entry[]
  /** What the caller saw at its last `team`; undefined before one, or after its session changed. */
  readonly look: Look | undefined
  /** Show every member's latest entries, whatever the caller saw before. */
  readonly all: boolean
  readonly now: number
}): { readonly text: string; readonly look: Look } => {
  const viewer: Viewer = { handle: input.handle, lead: input.lead }
  const members = input.peers
    .map((peer) => ({ peer, relation: relationOf(peer, viewer) }))
    .filter(({ relation }) => relation !== null && relation !== "peer")
    .toSorted((a, b) => rank[a.relation!] - rank[b.relation!])
    .map(({ peer }) => peer)
  const look: Look = {
    at: input.now,
    states: new Map(members.map((peer) => [peer.handle, stateKey(peer)])),
  }
  if (members.length === 0)
    return {
      look,
      text:
        `You are ${mention(input.handle)} in Novadeck, on no team in this project and session: ` +
        "no agent leads you, and you lead none. Call agents to see every terminal here.",
    }
  const before = input.all ? undefined : input.look
  const blocks = members.flatMap((peer) => {
    const entries = [...happened(peer.happenings), ...input.exchanges(peer)]
      .filter(({ at }) => before === undefined || at > before.at)
      .toSorted((a, b) => a.at - b.at)
    const head = headLine(peer, input.now, viewer, true)
    if (before && entries.length === 0 && before.states.get(peer.handle) === stateKey(peer))
      return [`${head} · nothing new since you last looked`]
    const shown = entries.slice(-shownEntries)
    const earlier = entries.length - shown.length
    const detail = detailLine(peer)
    return [
      head,
      ...(detail ? [detail] : []),
      ...(shown.length > 0
        ? [
            `  ${before ? "since you last looked" : "latest"}${earlier > 0 ? ` (and ${earlier} earlier)` : ""}:`,
            ...shown.map(({ at, text }) => `    ${ago(at, input.now)}, ${text}`),
          ]
        : before
          ? []
          : ["  nothing reported yet"]),
    ]
  })
  return {
    look,
    text: [
      `You are ${mention(input.handle)} in Novadeck.`,
      "Your team in this project and session:",
      ...rosterLines(viewer, input.peers, true),
      ...blocks,
    ].join("\n"),
  }
}
