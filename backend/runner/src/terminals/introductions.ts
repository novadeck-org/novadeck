import { harnesses } from "../harnesses/registry.js"
import { guessed } from "../harnesses/roots.js"
import { ago } from "../messaging/peers.js"
import { shorten } from "../text.js"
import { mention } from "./handles.js"
import type { Record } from "./record.js"
import type { Knew } from "./saved-terminals.js"

/**
 * An agent that calls a tool with a handle: its terminal's summary, its root session, and the
 * reports that keep what that session was shown.
 */
export type Caller = Pick<Record, "summary"> & Partial<Pick<Record, "root" | "agents">>

/**
 * A handle goes to a new terminal an hour after its last holder is gone (`handleCooldown`),
 * and an agent's context may still name the old one: its transcript, its briefs, messages it
 * was delivered, listings and notices. A call to such a handle refuses once, naming the new
 * holder, unless the agent's session was shown that terminal since it was given the handle.
 * A handle History knows no earlier holder of that closed after the session began (one never
 * given before, one whose holder closed before the session began, or longer ago than History
 * keeps) never refuses: there is no other terminal the session could mistake it for.
 *
 * A session knows a terminal under its handle when it began after the handle was given, or
 * was shown the terminal since, by an `agents` or `team` listing, a message exchanged with
 * it, the result of opening it, a notice naming it, or this refusal. Terminals whose handle
 * was given long ago (0) never refuse. Where a session's start is unknown (a report saved
 * before this was kept, or a root that is still a guess), it counts as beginning before
 * everything, so the first call to a recently given handle refuses.
 */
export const unknownTo = (
  knew: Knew,
  target: { readonly id: string; readonly givenAt: number },
  exchanged: (since: number) => boolean,
): boolean =>
  target.givenAt > 0 &&
  knew.since < target.givenAt &&
  !knew.shown.includes(target.id) &&
  !exchanged(knew.since)

/** What the refusal tells of the terminal that holds the handle now. */
export type Holder = {
  readonly title: string
  readonly summary: string | null
  readonly givenAt: number
}

/** What the refusal tells of the terminal that held the handle before, as History keeps it. */
export type Former = { readonly title: string; readonly closedAt: number }

/**
 * Why a call to `handle` was refused this once: the terminal it names now, the one it
 * named before, and that calling again with the same handle reaches the new one.
 */
export const introduction = (handle: string, holder: Holder, former: Former, now: number): string =>
  [
    `Nothing was done. ${mention(handle)} is not the terminal you may know by that name: ` +
      "Novadeck gives a handle to a new terminal an hour after its last holder closes.",
    `${mention(handle)} now is "${shorten(holder.title, 80)}"` +
      `${holder.summary ? `, ${shorten(holder.summary, 160)}` : ""}, opened ${ago(holder.givenAt, now)}.`,
    `The terminal you may have known as ${mention(handle)} ("${shorten(former.title, 80)}") ` +
      `closed ${ago(former.closedAt, now)}.`,
    `If you mean the new ${mention(handle)}, call again with the same handle and it goes ` +
      "through; `agents` describes every terminal here.",
  ].join("\n")

/** How many sessions' knowledge is kept in memory; the oldest goes past it. */
const kept = 512

/** How many terminals a session's `shown` keeps; the oldest goes past it. */
const shownKept = 256

/**
 * What each agent session was shown of its project's terminals, by terminal, agent and
 * session. Kept with the session's report (`AgentReport.knew`), so one resumed after a
 * runner restart keeps it, and in memory for a session with no report to hold it, as a root
 * that is still a guess.
 */
export class Introductions {
  private readonly known = new Map<string, Knew>()

  /** `save` keeps a caller's reports, as they changed. */
  constructor(private readonly save: (caller: Caller) => void = () => undefined) {}

  /**
   * What the caller's root session knows: what it was shown, and when it began. Nothing for
   * a terminal with no bound session, which no handle was ever named to.
   */
  knew(caller: Caller): Knew | undefined {
    const { root } = caller
    if (!root) return undefined
    const key = keyOf(caller)
    const known = this.known.get(key)
    if (known) return known
    const report = caller.agents?.[root.agent]
    const saved = report?.sessionId === root.sessionId ? report.knew : undefined
    // A guess may be corrected to another session, and its start is not known: it counts as
    // having begun before everything, until it is confirmed (its own key).
    return this.keep(
      key,
      isGuess(caller) ? { since: 0, shown: saved?.shown ?? [] } : (saved ?? zero),
    )
  }

  /** The terminals are shown to the caller's root session by name. */
  show(caller: Caller, ids: readonly string[]): void {
    const { root } = caller
    const knew = this.knew(caller)
    if (!root || !knew) return
    const fresh = ids.filter((id) => id !== caller.summary.id && !knew.shown.includes(id))
    if (fresh.length === 0) return
    const next = {
      since: knew.since,
      shown: [...knew.shown, ...fresh].slice(-shownKept),
    }
    this.keep(keyOf(caller), next)
    const report = caller.agents?.[root.agent]
    if (!caller.agents || report?.sessionId !== root.sessionId) return
    // A guess is kept in memory only: it may be corrected to another session.
    if (isGuess(caller)) return
    caller.agents = {
      ...caller.agents,
      [root.agent]: { ...report, knew: next },
    }
    this.save(caller)
  }

  private keep(key: string, knew: Knew): Knew {
    this.known.delete(key)
    this.known.set(key, knew)
    if (this.known.size > kept) this.known.delete(this.known.keys().next().value!)
    return knew
  }
}

/**
 * Where a caller's root session's knowledge is kept in memory: by terminal, agent and
 * session, and whether the root is still a guess, so a guess's unknown start doesn't stay
 * with it once its harness confirms it.
 */
const keyOf = (caller: Caller): string =>
  JSON.stringify([caller.summary.id, caller.root?.agent, caller.root?.sessionId, isGuess(caller)])

const isGuess = ({ root }: Caller): boolean =>
  !!root && guessed(root, harnesses[root.agent].messaging.root)

/** A session whose start is not known, and that was shown nothing. */
const zero: Knew = { since: 0, shown: [] }
