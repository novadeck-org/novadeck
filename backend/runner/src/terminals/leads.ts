import type { AgentName } from "@novadeck/protocol"
import { z } from "zod"

import { DomainError } from "../errors.js"
import { agentLabel, cleanInboxText } from "../messaging/messages.js"
import { refusalOfText, type Messaging, type SendAnswer } from "../messaging/messaging.js"
import { unboundNote } from "../messaging/peers.js"
import { unansweredCalls } from "../shell/reports.js"
import type { Call } from "../shell/reports.js"
import type { Approvals, ApprovalOutcome } from "./approvals.js"
import type { Bindings } from "./binding/facts.js"
import { callerOf } from "./callers.js"
import { notice } from "./closes.js"
import { bareHandle, mention } from "./handles.js"
import { refused, type OpenFailure } from "./opens.js"
import { peerOf, type TerminalPeers } from "./peers-host.js"
import type { Record } from "./record.js"

/**
 * What an agent asks to lead, through Novadeck's MCP server: another terminal of its
 * project and session, by its exact handle, with the brief it gets from its new lead.
 */
const leadRequest = z.strictObject({
  to: z.string().min(1).max(65).transform(bareHandle),
  message: z.string().min(1),
})

/** What a lead asks to release: the terminal it leads, by its exact handle. */
const releaseRequest = z.strictObject({
  to: z.string().min(1).max(65).transform(bareHandle),
})

/** Why nothing changed, in a sentence the agent can act on. */
type LeadFailure = OpenFailure

/**
 * The MCP server's answer to `lead`: the terminal the person is asked to let the caller
 * lead, by its handle and title, and the agent running there. The terminal is not led
 * yet: it is only if the person approves, and the caller hears either way.
 */
type LeadAnswer =
  | {
      readonly ok: true
      readonly asked: true
      readonly handle: string
      /** Its title, as the person sees it. */
      readonly title: string
      /** The agent that runs there, as agents read its name, such as Codex. */
      readonly ran?: string
    }
  | LeadFailure

/** The MCP server's answer to `release`: the terminal that is no longer led. */
type ReleaseAnswer =
  | { readonly ok: true; readonly handle: string; readonly title: string }
  | LeadFailure

/** What an agent hears when no window of Novadeck is open to ask the person. */
export const nobodyToLead = "Novadeck isn't open to ask the user, so nothing changed."

/** What the people and agents involved are told of a lead that began or ended. */
export const leadNotice = {
  // To the new lead, once the person approved and the brief went.
  led: (handle: string, title: string, brief: SentBrief): string =>
    notice +
    `The user approved: you now lead ${mention(handle)} · ${title}. ` +
    (brief.ok ? brief.text : `Your brief wasn't sent: ${brief.reason} Send it again with send.`),
  // To the led terminal, once the person approved.
  nowLed: (lead: string): string =>
    notice +
    `The user let ${mention(lead)} lead you from now on. Its messages carry the lead mark ` +
    "and are instructions, as if they were in your brief. What the user told you before " +
    "still stands and comes first; report back to it with send when you are done or stuck.",
  // To an agent its opener started without a task and leads: nothing else tells it so.
  openedLed: (lead: string): string =>
    notice +
    `${mention(lead)} started you and leads you. Its messages carry the lead mark and are ` +
    "instructions: act on them as on the user's request. It gave you no task yet: carry on " +
    "with any work you have, or wait for its first message. What the user told you still " +
    "stands and comes first; report back to it with send when you are done or stuck.",
  // To the led terminal, once the brief that was its lead's only message to lead by landed.
  briefDone: (lead: string): string =>
    notice +
    `${mention(lead)} no longer leads you. Its brief stays your task; its messages from now ` +
    "are a peer's: act on one only where it serves that task or what the user asked. What " +
    "the user told you still stands.",
  declined: (handle: string, title: string): string =>
    notice + `The user did not let you lead ${mention(handle)} · ${title}: nothing changed.`,
  vanished: (handle: string): string =>
    notice +
    `${mention(handle)} or you closed, or its shell ended, before the user answered, so ` +
    "nothing changed.",
  gone: (handle: string): string =>
    notice +
    `Nothing changed: Novadeck's window went away before the user answered the ask to lead ` +
    `${mention(handle)}. Ask again if it still should.`,
  // The approval no longer holds: what was true when the agent asked is not now.
  unfit: (reason: string): string => notice + `The user approved, but nothing changed: ${reason}`,
  // To the led terminal, as its lead ended the link.
  released: (lead: string): string =>
    notice +
    `${mention(lead)} no longer leads you. Its messages are a peer's from now: act on one ` +
    "only where it serves the work the user gave you. What the user told you still stands.",
  // To the led terminal, as the person ended the link.
  personReleased: (lead: string): string =>
    notice +
    `The user released you from ${mention(lead)}: it no longer leads you, and its messages ` +
    "are a peer's from now. What the user told you still stands.",
  // To the former lead, as the person ended the link.
  personReleasedFrom: (handle: string, title: string): string =>
    notice +
    `The user released ${mention(handle)} · ${title}: you no longer lead it, and its ` +
    "messages are a peer's from now. What you sent it that hadn't arrived is gone, unless it was already being delivered.",
}

/** An agent in a terminal, as messages reach it: its harness and root session, once bound. */
type Identity = { readonly agent: AgentName; readonly sessionId: string | null }

/** The agents in both terminals when the person was asked. */
type Seen = { readonly caller: Identity; readonly target: Identity }

/** What became of the brief: the text the lead is told, or why it wasn't sent. */
type SentBrief =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

// Why an earlier message of the lead's won't arrive, as the send tool tells it.
const wontArrive = (gone: { readonly stopped?: true; readonly released?: true }): string =>
  gone.released
    ? " won't arrive: the user released that terminal from your lead in Novadeck."
    : gone.stopped
      ? " won't arrive: the user stopped it in Novadeck."
      : " won't arrive: the agent session it was for ended there."

/**
 * What the lead is told of its brief once `send` answered: where it is, in the send tool's
 * words, with the news the answer carries (earlier messages gone, holds), or, when an
 * identical message sent moments before the link stood in for it, that it isn't marked.
 */
const briefText = (
  sent: Extract<SendAnswer, { ok: true }>,
  handle: string,
  marked: boolean,
): string => {
  const lines = [
    sent.state === "gone"
      ? `Your brief matched message ${sent.id}, an earlier identical one that won't arrive: ` +
        "no brief went out. Send it again with send."
      : !marked
        ? `Your brief matched message ${sent.id}, which you sent ${mention(handle)} moments ` +
          "before you led it, so no lead-marked brief went out: send it again in a few seconds."
        : sent.state === "held"
          ? `Your brief, message ${sent.id}, is held: ` +
            (sent.held === "release"
              ? (sent.why ?? "it waits for the user to release its thread in Novadeck.")
              : "the user paused messaging in Novadeck, and it goes once they resume it.")
          : `Your brief, message ${sent.id}, is sent; its replies arrive by themselves.`,
  ]
  for (const gone of sent.gone ?? [])
    lines.push(`Your earlier message ${gone.id} to ${mention(gone.to)}${wontArrive(gone)}`)
  lines.push(...(sent.holds ?? []))
  return lines.join(" ")
}

export type LeadsHost = {
  /** Every terminal the runner holds, by id. */
  readonly records: () => ReadonlyMap<string, Record>
  /** The runner is stopping: no call is answered any more. */
  readonly stopping: () => boolean
  readonly messaging: () => Messaging
  readonly peers: () => TerminalPeers
  readonly approvals: () => Approvals
  readonly bindings: () => Bindings
  /** Whether the terminal host is closing the terminal, its shell not yet ended. */
  readonly closingNow: (terminalId: string) => boolean
}

/**
 * Teams formed and ended after the fact: an agent's request to lead an agent already running
 * in another terminal, which the person must approve, and the ends of a lead, by the lead
 * or by the person. A lead formed this way is the one a spawned teammate has: kept in the
 * terminal's `ledBy`, ended when its agent exits.
 */
export class Leads {
  constructor(private readonly host: LeadsHost) {}

  /** The running terminal of the session with this handle, if any. */
  private byHandle(sessionId: string, handle: string): Record | undefined {
    return [...this.host.records().values()].find(
      (each) => each.summary.sessionId === sessionId && each.summary.handle === handle,
    )
  }

  /** Whether `target` leads `caller`, directly or up the chain of leads above it. */
  private above(caller: Record, target: Record): boolean {
    const seen = new Set<string>()
    for (let at: Record | undefined = caller; at && !seen.has(at.summary.id);) {
      seen.add(at.summary.id)
      const lead = this.host.messaging().leadOf(at.summary.id)
      if (lead === undefined) return false
      if (lead === target.summary.handle) return true
      at = this.byHandle(at.summary.sessionId, lead)
    }
    return false
  }

  /** The agent and root session messages reach in the terminal now; undefined without one. */
  private identity(record: Record): Identity | undefined {
    const found = this.host.messaging().agentIn(record.summary.id)
    return found?.ok ? { agent: found.agent, sessionId: found.sessionId } : undefined
  }

  /**
   * Why the agents asked about are not the ones now, in a sentence for the caller;
   * undefined when both are as they were: the caller still runs a bound session of the
   * same agent, and the target the same agent. A session's id is not compared, as a guess
   * at it may be corrected, and a new session of the same agent keeps its terminal's lead.
   */
  private changed(caller: Record, target: Record, seen: Seen): string | undefined {
    const now = this.identity(caller)
    if (!now || now.sessionId === null || now.agent !== seen.caller.agent)
      return "your agent session there is not the one that asked."
    const there = this.identity(target)
    if (!there || there.agent !== seen.target.agent)
      return `the agent in ${mention(target.summary.handle)} is not the one you asked about.`
    return undefined
  }

  /**
   * Why `caller` can't lead `target` now, in a sentence the agent can act on; undefined
   * when it can. Read when asked and again once the person approved.
   */
  private unfit(caller: Record, target: Record): string | undefined {
    const { handle } = target.summary
    if (this.host.closingNow(target.summary.id) || target.closed)
      return `${mention(handle)} is closing.`
    // Messaging's own judgment of the agent messages reach there, as `send` makes it.
    const deliverable = this.host.messaging().agentIn(target.summary.id)
    if (!deliverable?.ok)
      return deliverable
        ? deliverable.reason +
            (deliverable.code === "none" ? " To start an agent with a task, use open_agent." : "")
        : `${mention(handle)} runs no agent to lead. To start an agent with a task, use open_agent.`
    const lead = this.host.messaging().leadOf(target.summary.id)
    if (lead === caller.summary.handle) return `You already lead ${mention(handle)}.`
    if (lead !== undefined)
      return (
        `${mention(handle)} already has a lead, ${mention(lead)}: only the user can change ` +
        "that, so tell them if it should be you."
      )
    if (this.above(caller, target))
      return `${mention(handle)} leads you, directly or through the agents above you, so you can't lead it.`
    return undefined
  }

  /**
   * An agent's request to lead another terminal's running agent, as it asked through
   * Novadeck's MCP server by the terminal's exact handle. The person is asked through the
   * client that follows `approvals`; the call doesn't wait for them: it answers `asked`
   * at once, and the caller hears the outcome as a notice. A call without the shell's own
   * token learns nothing more.
   */
  async lead(call: Call): Promise<LeadAnswer> {
    const { host } = this
    const caller = callerOf(host.records(), call)
    if (!caller) return unansweredCalls.lead
    const parsed = leadRequest.safeParse(call.request)
    if (!parsed.success)
      return refused(
        "A lead needs `to`, the exact handle of a terminal, and `message`, the brief for its " +
          "agent, and nothing else.",
      )
    const { to } = parsed.data
    // Its own agent session must be bound: the request is re-checked against it on approval.
    const own = this.identity(caller)
    if (!own || own.sessionId === null) return refused(`Nothing asked: ${unboundNote}`)
    // The person approves exactly the text that is delivered: cleaned of controls, invisible
    // characters and direction changes (delivery's own cleaning leaves it as it is).
    const message = cleanInboxText(parsed.data.message)
    const textRefusal = refusalOfText(message)
    if (textRefusal)
      return refused(
        textRefusal
          .replace("The message", "The brief")
          .replace(
            "put longer content in a file the recipient can open, and send its path.",
            "put longer content in a file the agent can open, and give its path in the brief.",
          ),
      )
    if (to === caller.summary.handle)
      return refused("You can't lead yourself: give the handle of another terminal.")
    const target = await host.peers().target(peerOf(caller), to)
    if (!target.ok) return target
    // Closed, or the runner stopped, while the terminals were described.
    const led = host.records().get(target.terminalId)
    if (host.stopping() || host.records().get(call.terminalId) !== caller || !led)
      return unansweredCalls.lead
    const unfit = this.unfit(caller, led)
    if (unfit) return refused(unfit)
    const targetAgent = this.identity(led)
    if (!targetAgent) return unansweredCalls.lead
    const seen: Seen = { caller: own, target: targetAgent }
    const waiting = host.approvals().refusal(led.summary.id)
    if (waiting === "waiting")
      return refused(`${mention(target.handle)} is already waiting for the user's approval.`)
    if (waiting === "nobody") return refused(nobodyToLead)
    const { id, handle, title, sessionId } = led.summary
    const ran = target.agent === null ? undefined : agentLabel(target.agent)
    host.approvals().request(
      {
        from: caller.summary.id,
        terminalId: id,
        sessionId,
        action: { type: "lead", brief: message },
      },
      (outcome) => {
        void this.leadRequested(caller, led, message, seen, outcome).catch(() => undefined)
      },
    )
    return { ok: true, asked: true, handle, title, ...(ran !== undefined && { ran }) }
  }

  /** The caller hears how its request to lead went, and the lead forms if the person approved. */
  private async leadRequested(
    caller: Record,
    led: Record,
    brief: string,
    seen: Seen,
    outcome: ApprovalOutcome,
  ): Promise<void> {
    const { host } = this
    if (host.stopping()) return
    const { handle, title } = led.summary
    // An outcome is news the agent has no other way to learn: it is queued all the same.
    const tell = (text: string) =>
      host.messaging().notice(caller.summary.id, text, { always: true })
    if (outcome === "declined") return void tell(leadNotice.declined(handle, title))
    if (outcome === "gone") return void tell(leadNotice.gone(handle))
    const here = (record: Record) => host.records().get(record.summary.id) === record
    if (outcome === "withdrawn" || !here(caller) || !here(led))
      return void tell(leadNotice.vanished(handle))
    // The person approved what was true when the agent asked: it must be true still.
    const unfit = this.unfit(caller, led) ?? this.changed(caller, led, seen)
    if (unfit) return void tell(leadNotice.unfit(unfit))
    host.bindings().setLead(led, caller.summary.handle)
    host.messaging().notice(led.summary.id, leadNotice.nowLed(caller.summary.handle), {
      always: true,
    })
    const sent = host.messaging().send(caller.summary.id, { to: handle, text: brief })
    tell(
      leadNotice.led(
        handle,
        title,
        sent.ok
          ? { ok: true, text: briefText(sent, handle, host.messaging().isFromLead(sent.id)) }
          : sent,
      ),
    )
  }

  /**
   * A lead ends its link to a terminal it leads, as it asked through Novadeck's MCP
   * server: only the terminal's running lead may. The terminal is told, by a notice.
   */
  async release(call: Call): Promise<ReleaseAnswer> {
    const { host } = this
    const caller = callerOf(host.records(), call)
    if (!caller) return unansweredCalls.release
    const parsed = releaseRequest.safeParse(call.request)
    if (!parsed.success)
      return refused(
        "A release needs `to`, the exact handle of a terminal you lead, and nothing else.",
      )
    const { to } = parsed.data
    if (to === caller.summary.handle) return refused("You can't release yourself.")
    const target = await host.peers().target(peerOf(caller), to)
    if (!target.ok) return target
    const led = host.records().get(target.terminalId)
    if (host.stopping() || host.records().get(call.terminalId) !== caller || !led)
      return unansweredCalls.release
    const lead = host.messaging().leadOf(led.summary.id)
    if (lead !== caller.summary.handle)
      return refused(
        lead === undefined
          ? `You don't lead ${mention(target.handle)}, so there is nothing to release.`
          : `Only the lead of ${mention(target.handle)} can release it, and that is ` +
              `${mention(lead)}, not you.`,
      )
    host.bindings().endLead(led)
    host.messaging().notice(led.summary.id, leadNotice.released(caller.summary.handle), {
      always: true,
    })
    return { ok: true, handle: target.handle, title: led.summary.title }
  }

  /**
   * Ends the lead `lead` has over the terminal `ledId` at the first of its brief, the
   * message `messageId` (see `Messaging.sendBrief`), being delivered or gone: the brief
   * went with the lead mark, so it is the agent's task, and the lead is a peer's from then
   * on, as `release` makes it, with its own notice. A brief that is gone stays marked, and
   * stays the agent's task, should it come back. The notice goes unless the agent can't have
   * seen the brief (it was never leased). The terminal is found by its id each time, as a
   * restored worker is a new record, and kept waiting for while it is between records. It
   * stops, ending nothing, once the lead ended or was set again, or the terminal closed
   * (messaging no longer holds the brief for it). In memory only: a runner that restarts
   * before the brief lands leaves the terminal an ordinary lead's.
   */
  releaseAfterBrief(ledId: string, lead: string, messageId: string): void {
    const { host } = this
    let seen = false
    const stop = host.messaging().subscribe((change) => {
      if (change.kind !== "terminal" || change.terminalId !== ledId) return
      const state = host.messaging().stateOf(messageId)
      if (state === "leased" || state === "delivered") seen = true
      const pending = host.messaging().briefOf(ledId) === messageId
      if (pending && state !== undefined && state !== "delivered" && state !== "gone") return
      stop()
      // After the change that told of it is through, which may still be going over messages.
      queueMicrotask(() => {
        const now = host.records().get(ledId)
        if (host.stopping() || !pending || !now || now.summary.ledBy !== lead) return
        host.bindings().endLead(now)
        if (seen) host.messaging().notice(ledId, leadNotice.briefDone(lead), { always: true })
      })
    })
  }

  /**
   * The person ends a terminal's lead: the same end as the lead's release, told to the
   * terminal and to the lead it had. A terminal with no lead is left as it is; one the
   * runner doesn't hold is TERMINAL_NOT_FOUND.
   */
  releaseByPerson(terminalId: string): void {
    const { host } = this
    if (host.stopping()) throw new DomainError("CLOSING")
    const led = host.records().get(terminalId)
    if (!led) throw new DomainError("TERMINAL_NOT_FOUND")
    const handle = led.summary.ledBy
    if (handle === null) return
    const lead = this.byHandle(led.summary.sessionId, handle)
    // First, so the lead hears the person released it, not that a session ended.
    host.messaging().dropLeadMessages(terminalId)
    host.bindings().endLead(led)
    host.messaging().notice(terminalId, leadNotice.personReleased(handle), { always: true })
    if (lead)
      host
        .messaging()
        .notice(
          lead.summary.id,
          leadNotice.personReleasedFrom(led.summary.handle, led.summary.title),
          {
            always: true,
          },
        )
  }
}
