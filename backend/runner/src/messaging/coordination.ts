import type { Check } from "@novadeck/forges"
import type { PullRequest } from "@novadeck/protocol"
import { redact } from "@novadeck/secrets"

import { mention } from "../terminals/handles.js"
import { shorten } from "../text.js"
import type { Peer, Whereabouts } from "./peers.js"

// What terminals in one project and session wait on, as facts: their pull requests' unfinished
// checks and the kind of runner each needs or holds, whose work is based on whose, and what an
// agent says its own waits on. Nothing here says what anyone should do.

/** A branch's pull request with what a forge told of its base branch and unfinished checks. */
export type CiPullRequest = PullRequest & {
  /** The branch it targets, where the forge says. */
  readonly base?: string | undefined
  /** Its checks that have not finished, where the forge could list them. */
  readonly checks?: readonly Check[] | undefined
}

/** Whose work is based on another terminal's, and how it is known. */
export type Stack = {
  /** The terminal whose work it builds on. */
  readonly onTerminalId: string
  readonly onHandle: string
  /** That terminal's branch. */
  readonly branch: string
  /** `pull-request`: its pull request targets that branch; `commits`: its worktree started from that branch's commits. */
  readonly via: "pull-request" | "commits"
  /** The number of the pull request that targets the branch, for `pull-request`. */
  readonly pull?: number | undefined
}

/** What an agent said its work waits on, and when. */
export type Statement = { readonly text: string; readonly at: number }

/** A terminal as the coordination facts read it: its handle, whether it is the reader, and its work. */
export type Party = {
  readonly terminalId: string
  readonly handle: string
  /** The terminal reading the listing. */
  readonly you?: boolean
  readonly pulls: readonly Pull[]
  readonly stacks: readonly Stack[]
}

/** One pull request's unfinished checks. */
export type Pull = {
  readonly number: number
  readonly branch: string
  readonly checks: readonly Check[]
}

/** The pull requests with unfinished checks among a terminal's worktrees. */
export const pullsOf = (
  worktrees: readonly { readonly branch: string; readonly pullRequest?: PullRequest | undefined }[],
): Pull[] =>
  worktrees.flatMap(({ branch, pullRequest }) => {
    const checks = (pullRequest as CiPullRequest | undefined)?.checks ?? []
    return pullRequest && checks.length > 0 ? [{ number: pullRequest.number, branch, checks }] : []
  })

/** How a listing names a runner kind the forge didn't report. */
export const unnamedRunner = "a runner kind the forge doesn't report"

const runnerOf = (check: Check): string => check.runner ?? unnamedRunner

/** How long since a moment, in words: "6 min". */
export const minutes = (since: number, now: number): string => {
  const min = Math.floor((now - since) / 60_000)
  if (min < 1) return "under a minute"
  if (min < 60) return `${min} min`
  const hours = Math.floor(min / 60)
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`
}

const whose = (party: Party): string => (party.you ? "your" : `${mention(party.handle)}'s`)
const who = (party: Party): string => (party.you ? "you" : mention(party.handle))

/** One runner kind: who runs on it and who waits for it. */
type Occupancy = {
  readonly running: Map<string, { party: Party; pull: Pull; checks: Check[] }>
  readonly queued: Map<string, { party: Party; pull: Pull; checks: Check[] }>
}

/** The pull requests' unfinished checks grouped by runner kind. */
export const occupancy = (parties: readonly Party[]): ReadonlyMap<string, Occupancy> => {
  const kinds = new Map<string, Occupancy>()
  for (const party of parties)
    for (const pull of party.pulls)
      for (const check of pull.checks) {
        const kind = runnerOf(check)
        const held = kinds.get(kind) ?? { running: new Map(), queued: new Map() }
        kinds.set(kind, held)
        const side = check.state === "running" ? held.running : held.queued
        const key = `${party.terminalId}\0${pull.number}`
        const entry = side.get(key) ?? { party, pull, checks: [] }
        entry.checks.push(check)
        side.set(key, entry)
      }
  return kinds
}

/** The earliest moment among checks, where any says. */
const earliest = (checks: readonly Check[]): number | undefined => {
  const times = checks.flatMap(({ since }) => (since === undefined ? [] : [since]))
  return times.length === 0 ? undefined : Math.min(...times)
}

const held = (
  entries: Iterable<{ party: Party; pull: Pull; checks: Check[] }>,
  now: number,
): string =>
  [...entries]
    .map(({ party, pull, checks }) => {
      const since = earliest(checks)
      const count = checks.length > 1 ? `${checks.length} checks, ` : ""
      return `${whose(party)} PR #${pull.number}${since === undefined ? "" : ` (${count}${minutes(since, now)})`}`
    })
    .join(", ")

/**
 * The project-wide lines on runners: for each kind of runner, whose pull requests hold running
 * checks on it and whose wait for it, with how long. A forge that doesn't report a check's
 * runner kind has those checks listed under a kind of their own, and says so.
 */
export const runnerLines = (parties: readonly Party[], now: number): readonly string[] => {
  // The kind the forge doesn't name comes last.
  const kinds = [...occupancy(parties)].toSorted(
    ([a], [b]) => Number(a === unnamedRunner) - Number(b === unnamedRunner),
  )
  if (kinds.length === 0) return []
  return [
    "CI checks running or queued in this project and session, by kind of runner (from the forge, as of its last look):",
    ...kinds.map(([kind, { running, queued }]) => {
      const parts = [
        running.size > 0 ? `running: ${held(running.values(), now)}` : null,
        queued.size > 0 ? `queued: ${held(queued.values(), now)}` : null,
      ].filter((part): part is string => part !== null)
      return `- ${kind}: ${parts.join(" · ")}`
    }),
  ]
}

/** How many checks one pull request names in a terminal's own line. */
const namedChecks = 4

/** A terminal's own pull requests' unfinished checks, one line; null without any. */
export const checksLine = (pulls: readonly Pull[], now: number): string | null => {
  if (pulls.length === 0) return null
  const parts = pulls.map(({ number, checks }) => {
    const shown = checks.slice(0, namedChecks).map((check) => {
      const since = check.since === undefined ? "" : ` ${minutes(check.since, now)}`
      const runner = check.runner === undefined ? "" : ` (${shorten(check.runner, 60)})`
      return `${shorten(check.name, 60)} ${check.state}${since}${runner}`
    })
    const more = checks.length - shown.length
    return `PR #${number}: ${[...shown, ...(more > 0 ? [`and ${more} more`] : [])].join(", ")}`
  })
  return `  checks: ${parts.join(" · ")}`
}

/** What an agent says its work waits on, in one line, with when it said so. */
export const statedLine = (said: Statement | null | undefined, now: number): string | null =>
  said
    ? `  says it waits on: "${shorten(redact(said.text), 200)}" (${minutes(said.at, now)} ago)`
    : null

/**
 * Whose work is based on whose, from pull requests that target another terminal's branch and
 * worktrees started from another's commits, one line each, in both directions' words.
 */
export const stackLines = (parties: readonly Party[]): readonly string[] => {
  const lines = parties.flatMap((party) =>
    party.stacks.map((stack) => {
      const on = parties.find((each) => each.terminalId === stack.onTerminalId)
      const owner = on
        ? on.you
          ? "your"
          : `${mention(on.handle)}'s`
        : `${mention(stack.onHandle)}'s`
      const how =
        stack.via === "pull-request"
          ? `its PR #${stack.pull} targets that branch`
          : "its worktree started from that branch's commits"
      return `- ${who(party)} ${party.you ? "wait" : "waits"} on ${owner} branch ${shorten(stack.branch, 80)} (${how})`
    }),
  )
  return lines.length > 0 ? ["Work based on another terminal's work:", ...lines] : []
}

/** The project-wide coordination lines of a listing: runners, then what is based on what. */
export const coordinationLines = (parties: readonly Party[], now: number): readonly string[] => [
  ...runnerLines(parties, now),
  ...stackLines(parties),
]

/**
 * The parties of a listing: each peer that runs an agent, and its reader, from where its
 * agent works (`where`, as the manager reads it).
 */
export const partiesOf = (
  reader: { readonly terminalId: string; readonly handle: string },
  where: Whereabouts | undefined,
  peers: readonly Peer[],
): readonly Party[] => [
  {
    terminalId: reader.terminalId,
    handle: reader.handle,
    you: true,
    pulls: pullsOf(where?.worktrees ?? []),
    stacks: where?.stacks ?? [],
  },
  ...peers.flatMap((peer) =>
    peer.agent
      ? [
          {
            terminalId: peer.terminalId,
            handle: peer.handle,
            pulls: pullsOf(peer.worktrees),
            stacks: peer.stacks ?? [],
          },
        ]
      : [],
  ),
]
