import type { PullRequest } from "@novadeck/protocol"

import { kindShown, minutes, pullsOf, type Party, type Pull } from "../messaging/coordination.js"
import { noticeText } from "../messaging/notice-format.js"
import { listed } from "../messaging/peers.js"
import { mention } from "./handles.js"
import { waitingOf } from "./peers-host.js"
import type { Record } from "./record.js"

/** A check queued this long for a runner kind others in its session hold is told of, once. */
export const queuedLongMs = 10 * 60_000

/** How often the terminals' checks are read for a long queue. */
export const queueEveryMs = 60_000

/** A terminal as a queue notice reads it. */
export type QueueEntry = Party & {
  readonly sessionId: string
  /** Its agent waits on the person: no notice goes to it. */
  readonly waitingOnUser: boolean
  /** An agent is bound to it: where none is, no notice can be taken. */
  readonly bound: boolean
}

export type QueueNoticesHost = {
  readonly entries: () => readonly QueueEntry[]
  /** Sends a notice to a terminal's agent; false where none was sent (see `Messaging.notice`). */
  readonly notice: (terminalId: string, text: string) => boolean
  readonly stopping: () => boolean
  readonly now?: () => number
}

/** The running terminals as queue entries: their pull requests' unfinished checks. */
export const queueEntries = (
  records: Iterable<Pick<Record, "summary" | "terminal" | "bound">>,
  worktrees: (terminalId: string) => readonly {
    readonly branch: string
    readonly pullRequest?: PullRequest | undefined
  }[],
): QueueEntry[] =>
  [...records].flatMap((record) => {
    if (record.terminal.exit !== null) return []
    const { id, handle, sessionId } = record.summary
    const pulls = pullsOf(worktrees(id))
    if (pulls.length === 0) return []
    return [
      {
        terminalId: id,
        handle,
        sessionId,
        pulls,
        stacks: [],
        waitingOnUser: waitingOf(record.bound?.activity ?? null) !== null,
        bound: record.bound !== null,
      },
    ]
  })

type Episode = {
  readonly terminalId: string
  readonly pull: number
  readonly runner: string
  /** The recipients not yet told, each with the words for it. */
  readonly pending: Map<string, string>
}

/** Whether a pull request has a queued check whose runner the forge didn't tell (yet). */
const queuedUnnamed = (pull: Pull): boolean =>
  pull.checks.some((check) => check.state === "queued" && check.runner === undefined)

/** The queued checks of a pull request for a runner kind: the earliest moment among them. */
const queuedSince = (pull: Pull, runner: string): number | undefined => {
  const times = pull.checks.flatMap((check) =>
    check.state === "queued" && check.runner === runner && check.since !== undefined
      ? [check.since]
      : [],
  )
  return times.length === 0 ? undefined : Math.min(...times)
}

/** The pull requests of a party with checks running on a runner kind, with since when. */
const running = (party: Party, runner: string): { pull: Pull; since: number | undefined }[] =>
  party.pulls.flatMap((pull) => {
    const mine = pull.checks.filter((check) => check.state === "running" && check.runner === runner)
    if (mine.length === 0) return []
    const times = mine.flatMap(({ since }) => (since === undefined ? [] : [since]))
    return [{ pull, since: times.length === 0 ? undefined : Math.min(...times) }]
  })

/**
 * Tells terminals of a long queue, once per episode: when a pull request's check has been
 * queued `queuedLongMs` for a kind of runner that other terminals in its session hold with
 * running checks, the queued terminal and the holders get one notice of the facts (who holds
 * the runners, since when). An episode ends when the check is no longer queued, so a later
 * queue is a new one; a queued check whose runner the forge stops naming (a read that failed)
 * keeps it going. A recipient with no bound agent is dropped. A terminal waiting on the person is not told (it is, once it no longer
 * waits, while the episode lasts), and a notice that wasn't sent is tried again.
 */
export class QueueNotices {
  private readonly episodes = new Map<string, Episode>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly host: QueueNoticesHost) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), queueEveryMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Whether an episode goes on: its pull request still has a check queued for its runner kind,
   * or one queued whose runner kind isn't told now.
   */
  private lasts(episode: Episode, entries: readonly QueueEntry[]): boolean {
    const pull = entries
      .find((entry) => entry.terminalId === episode.terminalId)
      ?.pulls.find((each) => each.number === episode.pull)
    if (pull === undefined) return false
    return queuedSince(pull, episode.runner) !== undefined || queuedUnnamed(pull)
  }

  /** One reading of the terminals' checks: starts the episodes due, and sends what is pending. */
  tick(): void {
    if (this.host.stopping()) return
    const now = (this.host.now ?? Date.now)()
    const entries = this.host.entries()
    const waiting = new Map(entries.map((entry) => [entry.terminalId, entry.waitingOnUser]))
    // The terminals an agent is bound to.
    const bound = new Map(
      entries.filter((entry) => entry.bound).map((entry) => [entry.terminalId, true]),
    )
    for (const party of entries) {
      const mates = entries.filter((each) => each.sessionId === party.sessionId)
      for (const pull of party.pulls) {
        const kinds = new Set(pull.checks.flatMap(({ runner }) => (runner ? [runner] : [])))
        for (const runner of kinds) {
          const since = queuedSince(pull, runner)
          if (since === undefined || now - since < queuedLongMs) continue
          const key = `${party.terminalId}\0${pull.number}\0${runner}`
          if (this.episodes.has(key)) continue
          const holders = mates.filter(
            (each) => each.terminalId !== party.terminalId && running(each, runner).length > 0,
          )
          if (holders.length === 0) continue
          this.episodes.set(key, {
            terminalId: party.terminalId,
            pull: pull.number,
            runner,
            pending: recipients(party, pull, runner, since, holders, now),
          })
        }
      }
    }
    for (const [key, episode] of this.episodes) {
      if (!this.lasts(episode, entries)) {
        this.episodes.delete(key)
        continue
      }
      for (const [terminalId, text] of episode.pending) {
        const reader = bound.get(terminalId)
        // Gone, or without an agent to take it: it is not tried again.
        if (reader === undefined) episode.pending.delete(terminalId)
        else if (waiting.get(terminalId) === true) continue
        else if (this.host.notice(terminalId, text)) episode.pending.delete(terminalId)
      }
    }
  }
}

/** Each recipient of an episode's notice, with its words: the queued terminal and the holders. */
const recipients = (
  queued: QueueEntry,
  pull: Pull,
  runner: string,
  since: number,
  holders: readonly QueueEntry[],
  now: number,
): Map<string, string> => {
  const told = new Map<string, string>()
  // The label is the forge's, not Novadeck's: quoted, one clipped line.
  const kind = kindShown(runner)
  const held = (reader: string): string =>
    listed(
      holders.flatMap((holder) =>
        running(holder, runner).map(({ pull: theirs, since: began }) => {
          const owner = holder.terminalId === reader ? "your" : `${mention(holder.handle)}'s`
          return `${owner} PR #${theirs.number}${began === undefined ? "" : ` (running ${minutes(began, now)})`}`
        }),
      ),
    )
  told.set(
    queued.terminalId,
    noticeText("CI queue", {
      facts:
        `Your PR #${pull.number}'s ${kind} check has been queued ${minutes(since, now)}; ` +
        `${kind} runners held by ${held(queued.terminalId)}.`,
    }),
  )
  for (const holder of holders)
    told.set(
      holder.terminalId,
      noticeText("CI queue", {
        facts:
          `${mention(queued.handle)}'s PR #${pull.number}'s ${kind} check has been queued ` +
          `${minutes(since, now)}; ${kind} runners held by ${held(holder.terminalId)}.`,
      }),
    )
  return told
}
