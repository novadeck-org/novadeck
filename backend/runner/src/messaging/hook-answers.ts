import type { HarnessEvent } from "@novadeck/harness-core/events"
import { silentFor, type MessagingProfile } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { rootedIn, type Root } from "../harnesses/roots.js"
import type { HookAnswer } from "../shell/reports.js"
import type { Deliveries } from "./deliveries.js"
import { runsOn } from "./deliveries.js"
import { continues, running } from "./delivery.js"
import type { Leasing } from "./leasing.js"
import { isFromLead } from "./leasing.js"
import { addressed, feed, type Live } from "./live.js"
import type { Loops } from "./loops.js"
import type { MessageStore } from "./message-store.js"
import { undelivered } from "./messages.js"
import type { Sessions } from "./sessions.js"
import type { Person, Withdrawals } from "./withdrawals.js"

/** What a doorbell prompt's hook adds when its messages couldn't come now. */
const stillWaiting =
  "Novadeck: agent messages are still waiting for this session; they will come on a later turn, and this automatic notice can be ignored."

/** What a doorbell prompt's hook adds when nothing waits for it any more. */
const nothingWaiting =
  "Novadeck: no agent messages are waiting any more; this automatic notice can be ignored."

/** A lease is given only with this long left before its hook's deadline, in milliseconds. */
export const leaseMargin = 300

/** What an ask's handlers share: its terminal, root, harness profile and the hook's report. */
type Asked = {
  /** The person's prompt and the asks it withdraws, when this hook can tell the agent of it. */
  readonly person: Person | undefined
  readonly live: Live
  readonly root: Root
  readonly profile: MessagingProfile
  readonly silent: HookAnswer
  readonly events: readonly HarnessEvent[]
  readonly event: string
  /** Whether its deadline leaves time to lease and print. */
  readonly time: boolean
}

/** What a turn already given a delivery prints beside a new one, as Antigravity's does. */
const joined = (kept: string | undefined, text: string): string =>
  kept ? `${kept}\n${text}` : text

/**
 * What a hook prints, and, at the start of a root turn the person's prompt or the doorbell
 * began with time left to print, the same answer with more after what it says: how
 * Novadeck's automatic notices go beside messages (see terminals/nudges.ts).
 */
export type Answer = HookAnswer & { readonly adding?: (extra: string) => string }

/** What a turn's start says, with Novadeck's notices after it, a paragraph apart. */
const withNotices = (text: string, notices: string): string =>
  text ? `${text}\n\n${notices}` : notices

/** A hook's delivery with the sender's hold notices after it, if any; empty with neither. */
const noted = (text: string | undefined, holds: readonly string[]): string =>
  [...(text ? [text] : []), ...holds].join("\n")

/** What hook answers ask of the rest of messaging. */
export type HookAnswersHost = {
  readonly sessions: Sessions
  readonly store: MessageStore
  readonly loops: Loops
  readonly now: () => number
  readonly deliveries: Deliveries
  readonly leasing: Leasing
  readonly withdrawals: Withdrawals
  /** The caller's messages held long, as words, told once (`Holds.heldFrom`). */
  readonly heldFrom: (terminalId: string) => readonly string[]
}

/**
 * What each hook prints, as it asks once its report is applied: the messages a turn
 * takes, leased to it, with Novadeck's notices; and what a report that asks nothing tells
 * the terminal's delivery.
 */
export class HookAnswers {
  constructor(readonly host: HookAnswersHost) {}

  /** What the terminal's root session did, decoded from a report, for its delivery state. */
  observe(terminalId: string, events: readonly HarnessEvent[], person?: Person): void {
    const { deliveries, withdrawals } = this.host
    const live = this.host.sessions.get(terminalId)
    if (!live) return
    feed(this.host.loops, this.host.now, live, events)
    const before = withdrawals.before(live)
    for (const event of events) deliveries.turn(live, event)
    withdrawals.personTurn(live, before, events, person)
  }

  /**
   * What a Stop, prompt-time or tool-call hook prints, as it asks once its report is
   * applied: the messages waiting for the terminal's root session, leased to it, when its
   * report is a root turn event that may take them and its `deadline` leaves time to print
   * them. A harness whose injected messages last one call gets a turn's delivery again on
   * each later call of it. At a root tool call, or a later model call of such a harness,
   * only the lead's messages are leased: what directs the worker reaches it mid-turn. At
   * the start of a root turn the person's prompt or the doorbell began, with time to print,
   * the answer also says how to print it with Novadeck's notices after it (`adding`).
   */
  ask(
    terminalId: string,
    report: {
      readonly agent: AgentName
      readonly event: string
      readonly events: readonly HarnessEvent[]
      readonly deadline: number
      /** Told of a root turn the person's own prompt started; the notice it answers goes to the agent. */
      readonly person?: Person
    },
  ): Answer {
    const { deliveries, withdrawals } = this.host
    const profile = harnesses[report.agent].messaging
    const silent = { leaseId: null, stdout: silentFor(profile, report.event) }
    const kind = profile.asks[report.event]
    const live = this.host.sessions.get(terminalId)
    if (!live) return silent
    if (!kind) {
      this.observe(terminalId, report.events, report.person)
      return silent
    }
    const root = live.root
    // The Stop is this ask's own to settle, by whether it continues the turn.
    const stop =
      kind === "stop"
        ? report.events.find(
            (event): event is Extract<HarnessEvent, { type: "turn-ended" }> =>
              event.type === "turn-ended" && event.outcome === "completed" && rootedIn(root, event),
          )
        : undefined
    feed(this.host.loops, this.host.now, live, report.events)
    const before = withdrawals.before(live)
    for (const event of report.events) if (event !== stop) deliveries.turn(live, event)
    withdrawals.personTurn(live, before, report.events, report.person)
    if (!root) return silent
    const asked = {
      person: report.person,
      live,
      root,
      profile,
      silent,
      events: report.events,
      event: report.event,
      time: report.deadline - this.host.now() >= leaseMargin,
    }
    if (kind === "stop") return this.askStop(asked, stop)
    return kind === "tool" ? this.askTool(asked) : this.askPrompt(asked)
  }

  /**
   * A root Stop: the turn continues with the messages waiting, when it may, else ends. A
   * report with no root Stop of the session says nothing.
   */
  private askStop(
    { live, root, profile, silent, time }: Asked,
    stop: Extract<HarnessEvent, { type: "turn-ended" }> | undefined,
  ): HookAnswer {
    if (!stop) return silent
    const background = runsOn(stop.background)
    const lease =
      time &&
      continues(live.delivery) &&
      this.host.leasing.lease(live, root, { kind: "stop", background, print: profile.stop })
    // The turn goes on with what it was given, which the tracker counts as running through.
    if (lease)
      feed(this.host.loops, this.host.now, live, [
        {
          type: "turn-continued",
          agent: root.agent,
          sessionId: root.sessionId,
          instance: stop.instance,
          startedAt: stop.startedAt,
        },
      ])
    this.host.deliveries.step(live, {
      type: "stop",
      continued: Boolean(lease),
      background,
      at: this.host.now(),
      startedAt: stop.startedAt,
    })
    return lease ? { leaseId: lease.id, stdout: profile.stop(lease.text) } : silent
  }

  /**
   * A root turn's start, or a later model call of it: what waits goes with the prompt. A
   * harness whose injected messages last one call also gets the turn's delivery again, with
   * the lead's messages that came since joined to it.
   */
  private askPrompt({ live, root, profile, silent, events, time, person }: Asked): Answer {
    const { leasing } = this.host
    const start = events.find(
      (event): event is Extract<HarnessEvent, { type: "turn-started" }> =>
        event.type === "turn-started" && rootedIn(root, event),
    )
    if (!start) return silent
    // A later model call of the turn sees again what its first was given.
    const kept = profile.reinjectPerCall
      ? leasing.recall(live.terminalId, live.delivery.epoch)
      : undefined
    // What this terminal sent that waits long goes with whatever the hook prints, once.
    // The asks the person's prompt takes out go with their notice, while the hook has time to
    // print it, and leave only when it acknowledges having; else they stay, and the next
    // answer that can does both.
    const noticed = time ? this.host.withdrawals.notices(live, root, person) : { texts: [] }
    const notes = noticed.texts
    // What a harness whose injected messages last one call gives again on each later call.
    const noting = profile.reinjectPerCall && notes.length > 0
    const holds = [...notes, ...(time ? this.host.heldFrom(live.terminalId) : [])]
    if (start.cause === "call") {
      // A notice paid at a later call is given again on the turn's remaining ones, as one
      // paid at its first is.
      const carried = notes.length > 0 ? joined(kept, noted("", notes)) : kept
      const settles = noticed.withdrawal
      const print = (text: string) => profile.prompt(noted(joined(kept, text), holds))
      const added =
        time && running(live.delivery)
          ? leasing.lease(live, root, {
              kind: "midturn",
              print,
              only: isFromLead,
              keeps: (text) => joined(carried, text),
              settles,
            })
          : undefined
      if (added) return { leaseId: added.id, stdout: print(added.text) }
      const only = leasing.noticed(live, "midturn", noticed, noting ? carried : undefined)
      const rest = noted(kept, holds)
      if (only) return { leaseId: only.id, stdout: profile.prompt(rest) }
      return rest ? { leaseId: null, stdout: profile.prompt(rest) } : silent
    }
    const print = (text: string) => profile.prompt(noted(text, holds))
    // A turn the person's prompt or the doorbell began, with time to print, can take
    // Novadeck's notices after what it says; they last one call, never kept with a delivery.
    const begun = time && (start.cause === "prompt" || start.cause === "doorbell")
    const answered = (leaseId: string | null, text: string): Answer => ({
      leaseId,
      stdout: text || holds.length > 0 ? print(text) : silent.stdout,
      ...(begun && { adding: (extra: string) => print(withNotices(text, extra)) }),
    })
    const lease =
      time &&
      leasing.lease(live, root, {
        kind: "prompt",
        print,
        ...(profile.reinjectPerCall && { keeps: (text: string) => noted(text, notes) }),
        settles: noticed.withdrawal,
      })
    if (lease) return answered(lease.id, lease.text)
    // Else a lease of the notices alone, whose acknowledgement withdraws the asks and, for a
    // harness whose injected messages last one call, keeps the notice for each later call.
    const only = leasing.noticed(
      live,
      "prompt",
      noticed,
      noting ? joined(kept, noted("", notes)) : undefined,
    )
    if (kept !== undefined) return answered(only?.id ?? null, kept)
    if (start.cause !== "doorbell") return answered(only?.id ?? null, "")
    // A doorbell whose messages couldn't be leased now, as too late or while paused, says
    // they still wait; one with none left, as when they went another way, that none do.
    const waits = [...this.host.store.messages()].some(
      (message) =>
        message.to.terminalId === live.terminalId &&
        undelivered(message) &&
        addressed(message, root),
    )
    return answered(only?.id ?? null, waits ? stillWaiting : nothingWaiting)
  }

  /**
   * A root tool call finished, in a turn that runs: the lead's messages waiting go beside
   * its result, as its harness reads them. A peer's wait for the turn's end.
   */
  private askTool({ live, root, profile, silent, events, event, time, person }: Asked): HookAnswer {
    const { leasing } = this.host
    const { call } = profile
    // Only the root agent's own call, not a failure that was an abort (the person's Esc ends
    // the turn, and a tool's cancel is no call to answer in).
    const called = events.some(
      (each) =>
        each.type === "attention-resolved" &&
        each.actor === null &&
        each.interrupted !== true &&
        rootedIn(root, each),
    )
    if (!call || !called || !time || !running(live.delivery)) return silent
    // What this terminal sent that waits long goes beside the result too, once.
    const noticed = this.host.withdrawals.notices(live, root, person)
    const holds = [...noticed.texts, ...this.host.heldFrom(live.terminalId)]
    const print = (text: string) => call(noted(text, holds), event)
    const lease = leasing.lease(live, root, {
      kind: "midturn",
      print,
      only: isFromLead,
      settles: noticed.withdrawal,
    })
    if (lease) return { leaseId: lease.id, stdout: print(lease.text) }
    const only = leasing.noticed(live, "midturn", noticed, undefined)
    if (only) return { leaseId: only.id, stdout: print("") }
    return holds.length > 0 ? { leaseId: null, stdout: print("") } : silent
  }
}
