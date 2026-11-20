import type { ApprovalAction } from "@novadeck/protocol"
import { z } from "zod"

import { cleanInboxText, agentLabel } from "../messaging/messages.js"
import { noticeText } from "../messaging/notice-format.js"
import { unboundNote } from "../messaging/peers.js"
import { refusalOfText, type SendAnswer } from "../messaging/sending.js"
import { unansweredCalls } from "../shell/reports.js"
import type { Call } from "../shell/reports.js"
import { callerOf } from "./callers.js"
import { bareHandle, mention } from "./handles.js"
import {
  leadNotice,
  reportBack,
  nobodyToLead,
  type Identity,
  type Leads,
  type LeadsHost,
  type Seen,
} from "./leads.js"
import { refused, type OpenFailure } from "./opens.js"
import { peerOf } from "./peers-host.js"
import type { Record } from "./record.js"

/** What an agent asks to join: the terminal whose team it joins, and an introduction. */
const joinRequest = z.strictObject({
  to: z.string().min(1).max(65).transform(bareHandle),
  message: z.string().min(1).optional(),
})

/** What a lead asks to hand its team to: one of the terminals it leads. */
const handRequest = z.strictObject({
  to: z.string().min(1).max(65).transform(bareHandle),
})

/** Leaving takes nothing. */
const leaveRequest = z.strictObject({})

type Failure = OpenFailure

/** A terminal a team change is about: running, or asleep (no record; messaging holds its lead). */
type Party = {
  readonly summary: {
    readonly id: string
    readonly handle: string
    readonly title: string
    readonly sessionId: string
  }
}

/** A terminal as the answers name it: its handle and title, with the agent that runs there. */
type Named = {
  readonly handle: string
  readonly title: string
  readonly ran?: string
}

/**
 * The MCP server's answer to `join`, `leave` and `hand_lead`: either `asked`, the person
 * was asked and the caller hears the outcome as a notice, or what happened at once, where
 * agents decide for themselves (Swarm).
 */
export type TeamChangeAnswer =
  | ({ readonly ok: true; readonly asked: true } & Named)
  | ({
      readonly ok: true
      readonly joined: true
      /** What became of the introduction, if one was asked for. */
      readonly introduction?: string
    } & Named)
  | ({ readonly ok: true; readonly left: true } & Named)
  | ({
      readonly ok: true
      readonly handed: true
      /** The handles of the agents the new lead leads now, besides the caller. */
      readonly members: readonly string[]
      /** The handle of the lead the new lead took the caller's place under, if it had one. */
      readonly under?: string
    } & Named)
  | Failure

/** What the people and agents involved are told of a team that changed. */
export const teamNotice = {
  // To the lead, as an agent joined its team.
  joined: (handle: string, title: string, byUser: boolean): string =>
    noticeText("Team", {
      facts:
        `${mention(handle)} · ${title} joined your team${byUser ? ", as the user approved" : ""}: ` +
        "you now lead it. It treats your messages as instructions and reports back to you with " +
        "send; you can close it at once, and release it. Being its lead gives you none of the " +
        "user's approvals of actions.",
    }),
  // To the agent that joined, once the person approved.
  nowJoined: (lead: string, title: string, introduction?: string): string =>
    noticeText("Team", {
      facts:
        `The user approved: you joined ${mention(lead)} · ${title}'s team. ` +
        `${mention(lead)} leads you from now on.` +
        (introduction === undefined ? "" : ` ${introduction}`),
      actions: [reportBack],
    }),
  // To the agent that asked to join, as it did not.
  joinDeclined: (handle: string, title: string): string =>
    noticeText("Team", {
      facts: `The user did not let you join ${mention(handle)} · ${title}'s team: nothing changed.`,
    }),
  // To the lead, as an agent left its team.
  left: (handle: string, title: string, byUser: boolean): string =>
    noticeText("Team", {
      facts: `${mention(handle)} · ${title} left your team${byUser ? ", as the user approved" : ""}: you no longer lead it.`,
    }),
  // To the agent that left, once the person approved.
  nowLeft: (lead: string): string =>
    noticeText("Team", {
      facts:
        `The user approved: you left ${mention(lead)}'s team. It no longer leads you. A brief ` +
        "it opened you with stays your task.",
    }),
  leaveDeclined: (lead: string): string =>
    noticeText("Team", {
      facts: `The user did not let you leave ${mention(lead)}'s team: nothing changed.`,
    }),
  // To the lead that got its team handed over.
  handedTo: (
    from: string,
    members: readonly string[],
    under: string | undefined,
    byUser: boolean,
  ): string =>
    noticeText("Team", {
      facts:
        `${mention(from)} handed you the lead of its team${byUser ? ", as the user approved" : ""}: ` +
        `you now lead ${[...members, from].map(mention).join(", ")}` +
        (under === undefined ? "" : `, and take its place under ${mention(under)}, who leads you`) +
        ". They treat your messages as instructions and report back to you with send; you can " +
        "close them at once, and release them. Being their lead gives you none of the user's " +
        "approvals of actions.",
    }),
  // To each agent the caller led, besides the new lead.
  newLead: (from: string, to: string, byUser: boolean): string =>
    noticeText("Team", {
      facts:
        `${mention(from)} handed its team to ${mention(to)}${byUser ? ", as the user approved" : ""}: ` +
        `${mention(to)} leads you from now on, and ${mention(from)} no longer does.`,
      actions: [reportBack],
    }),
  // To the lead the caller had, as the new lead took the caller's place.
  placed: (from: string, to: string): string =>
    noticeText("Team", {
      facts:
        `${mention(from)} handed its team to ${mention(to)}, which takes its place under you: ` +
        `you lead ${mention(to)} now, in its place, and ${mention(from)} is led by it.`,
    }),
  // To the caller, once the person approved.
  nowHanded: (to: string, members: readonly string[]): string =>
    noticeText("Team", {
      facts:
        `The user approved: you handed your team to ${mention(to)}. It leads ` +
        (members.length === 0 ? "you" : `${members.map(mention).join(", ")} and you`) +
        " now.",
    }),
  handDeclined: (handle: string): string =>
    noticeText("Team", {
      facts: `The user did not let you hand your team to ${mention(handle)}: nothing changed.`,
    }),
  gone: (what: string): string =>
    noticeText("Team", {
      facts: `Nothing changed: Novadeck's window went away before the user answered the ask to ${what}.`,
      actions: ["Ask again if it still should."],
    }),
  vanished: (what: string): string =>
    noticeText("Team", {
      facts: `You or the agent concerned closed before the user answered, so nothing ${what}.`,
    }),
}

/** What became of an introduction, in words for the agent that sent it. */
const introductionLine = (sent: SendAnswer): string =>
  !sent.ok
    ? `Your introduction wasn't sent: ${sent.reason}`
    : sent.state === "held"
      ? `Your introduction, message ${sent.id}, is held until the user lets messages go.`
      : `Your introduction, message ${sent.id}, is sent; its replies arrive by themselves.`

/** What the asked-for outcome of an approval does, and how each end of it is told. */
type Asked = {
  readonly caller: Record
  /** The terminal named as the request's target. */
  readonly target: Party
  readonly action: ApprovalAction
  readonly seen: Seen
  /** Why what was asked no longer holds once the person approved; undefined while it does. */
  readonly unfit: () => string | undefined
  /** What the person approved, done: the caller's notice. */
  readonly done: () => string
  readonly declined: string
  readonly gone: string
  readonly vanished: string
}

/**
 * Teams that members and leads change themselves: an agent's join of another terminal's team,
 * its leave of its lead's team, and a lead's hand-over of its team to one of its members.
 * Where the person lets agents decide (Swarm) each takes effect at once; otherwise the person
 * approves it, as a `lead`, and the caller hears the outcome as a notice. The mode is read at
 * each call.
 */
export class Teams {
  constructor(
    private readonly host: LeadsHost,
    private readonly leads: Leads,
  ) {}

  /** The agent running in the terminal, as an approval pins it down. */
  private seenIn(caller: Identity, target: Party): Seen | undefined {
    const there = this.leads.identity(target)
    return there ? { caller, target: there } : undefined
  }

  /** The terminals, besides `except`, that the caller leads: running or asleep, in its session. */
  private ledBy(caller: Record, ...except: readonly Record[]): Party[] {
    const { host } = this
    const mine = (each: Party) =>
      !except.some((one) => one.summary.id === each.summary.id) &&
      host.messaging().leadOf(each.summary.id)?.terminalId === caller.summary.id
    return [
      ...host.records().values(),
      ...host.sleepers().sleepersOf(caller.summary.sessionId),
    ].filter(mine)
  }

  /** Gives the terminal, running or asleep, `leadId` as its lead. */
  private setLead(member: Party, leadId: string): void {
    const { host } = this
    const record = host.records().get(member.summary.id)
    if (record) host.bindings().setLead(record, leadId)
    else host.sleepers().setLead(member.summary.id, leadId)
  }

  /**
   * Ends the terminal's lead, running or asleep. What the lead sent it that hadn't arrived is
   * gone first, as when the person releases it, so none arrives lead-marked after.
   */
  private endLead(member: Party): void {
    const { host } = this
    const record = host.records().get(member.summary.id)
    host.messaging().dropLeadMessages(member.summary.id)
    if (record) host.bindings().endLead(record)
    else host.sleepers().endLead(member.summary.id)
  }

  /** Whether the terminal is still there to be asked about: running, or asleep. */
  private present(party: Party): boolean {
    return (
      this.host.records().has(party.summary.id) ||
      this.host.sleepers().peer(party.summary.id) !== undefined
    )
  }

  /** Where the target is, after the terminals were described: closed meanwhile is none. */
  private found(call: Call, caller: Record, terminalId: string, handle: string, none: Failure) {
    const { host } = this
    const found = host.records().get(terminalId)
    if (!found && host.sleepers().resting(terminalId))
      return refused(
        `${mention(handle)}'s agent is asleep, so nothing changed. A message to it wakes it.`,
      )
    if (host.stopping() || host.records().get(call.terminalId) !== caller || !found) return none
    return found
  }

  /** Asks the person, and acts on the outcome; the answer is `asked`. */
  private ask(asked: Asked): void {
    const { host } = this
    const { caller, target } = asked
    host.approvals().request(
      {
        from: caller.summary.id,
        terminalId: target.summary.id,
        sessionId: target.summary.sessionId,
        action: asked.action,
      },
      (outcome) => {
        if (host.stopping()) return
        const tell = (text: string) =>
          host.messaging().notice(caller.summary.id, text, { always: true })
        if (outcome === "declined") return void tell(asked.declined)
        if (outcome === "gone") return void tell(asked.gone)
        const here = host.records().get(caller.summary.id) === caller
        if (outcome === "withdrawn" || !here || !this.present(target))
          return void tell(asked.vanished)
        // The person approved what was true when the agent asked: it must be true still.
        const unfit = asked.unfit() ?? this.leads.changed(caller, target, asked.seen)
        if (unfit) return void tell(leadNotice.unfit(unfit))
        tell(asked.done())
      },
    )
  }

  /** Why nobody can be asked about `target` now, as a refusal; undefined when someone can. */
  private unaskable(handle: string, target: Party): Failure | undefined {
    const waiting = this.host.approvals().refusal(target.summary.id)
    if (waiting === "waiting")
      return refused(
        `A question about ${mention(handle)} is still waiting for the user's answer, so nothing ` +
          "changed. Try again once it is answered.",
      )
    return waiting === "nobody" ? refused(nobodyToLead) : undefined
  }

  /** Why `caller` can't join `target`'s team now; undefined when it can. */
  private unfitJoin(caller: Record, target: Record): string | undefined {
    const { handle } = target.summary
    if (this.host.messaging().leadOf(caller.summary.id) !== undefined)
      return "You have a lead already: leave its team first."
    if (this.host.closingNow(target.summary.id) || target.closed)
      return `${mention(handle)} is closing.`
    const noAgent = this.leads.noAgent(target)
    if (noAgent) return noAgent
    if (this.leads.above(target, caller))
      return `You lead ${mention(handle)}, directly or through other agents, so you can't join its team.`
    return undefined
  }

  /** The caller's join: `to` leads it from now on. */
  async join(call: Call): Promise<TeamChangeAnswer> {
    const { host } = this
    const caller = callerOf(host.records(), call)
    if (!caller) return unansweredCalls.join
    const parsed = joinRequest.safeParse(call.request)
    if (!parsed.success)
      return refused(
        "A join needs `to`, the exact handle of the terminal whose team you join, and takes " +
          "only `message`, your introduction, besides.",
      )
    const { to } = parsed.data
    const own = this.leads.identity(caller)
    if (!own || own.sessionId === null) return refused(`Nothing asked: ${unboundNote}`)
    // The person approves exactly the text that is delivered.
    const message =
      parsed.data.message === undefined ? undefined : cleanInboxText(parsed.data.message)
    const textRefusal = message === undefined ? undefined : refusalOfText(message)
    if (textRefusal) return refused(textRefusal.replace("The message", "The introduction"))
    if (to === caller.summary.handle) return refused("You can't join your own team.")
    const target = await host.peers().target(peerOf(caller), to)
    if (!target.ok) return target
    const lead = this.found(call, caller, target.terminalId, target.handle, unansweredCalls.join)
    if ("ok" in lead) return lead
    const unfit = this.unfitJoin(caller, lead)
    if (unfit) return refused(unfit)
    const seen = this.seenIn(own, lead)
    if (!seen) return unansweredCalls.join
    const { handle, title } = lead.summary
    const ran = target.agent === null ? undefined : agentLabel(target.agent)
    const named = { handle, title, ...(ran !== undefined && { ran }) }
    const joined = (byUser: boolean): string | undefined => {
      host.bindings().setLead(caller, lead.summary.id)
      host
        .messaging()
        .notice(
          lead.summary.id,
          teamNotice.joined(caller.summary.handle, caller.summary.title, byUser),
          { always: true },
        )
      // The notice names the caller, so its handle is the lead's to use.
      host.peers().introduce(lead.summary.id, caller.summary.id)
      if (message === undefined) return undefined
      return introductionLine(
        host.messaging().send(caller.summary.id, { to: handle, text: message }),
      )
    }
    if (host.agentMode() === "swarm") {
      const introduction = joined(false)
      return {
        ok: true,
        joined: true,
        ...named,
        ...(introduction && { introduction }),
      }
    }
    const unaskable = this.unaskable(handle, lead)
    if (unaskable) return unaskable
    this.ask({
      caller,
      target: lead,
      action: { type: "join", ...(message !== undefined && { message }) },
      seen,
      unfit: () => this.unfitJoin(caller, lead),
      done: () => teamNotice.nowJoined(handle, title, joined(true)),
      declined: teamNotice.joinDeclined(handle, title),
      gone: teamNotice.gone(`let you join ${mention(handle)}'s team`),
      vanished: teamNotice.vanished(`changed about joining ${mention(handle)}'s team`),
    })
    return { ok: true, asked: true, ...named }
  }

  /** Why `caller` can't leave its team now; the lead it has otherwise, running or asleep. */
  private leaving(caller: Record): Party | string {
    const lead = this.host.messaging().leadOf(caller.summary.id)
    const found =
      lead &&
      (this.host.records().get(lead.terminalId) ?? this.host.sleepers().peer(lead.terminalId))
    return found ?? "You have no lead, so there is no team to leave."
  }

  /** The caller's leave: its lead no longer leads it. */
  async leave(call: Call): Promise<TeamChangeAnswer> {
    const { host } = this
    const caller = callerOf(host.records(), call)
    if (!caller) return unansweredCalls.leave
    if (!leaveRequest.safeParse(call.request).success) return refused("A leave takes nothing.")
    const lead = this.leaving(caller)
    if (typeof lead === "string") return refused(lead)
    if (host.stopping()) return unansweredCalls.leave
    const { handle, title } = lead.summary
    const agent = host.messaging().agentIn(lead.summary.id)
    const ran = agent?.ok ? agentLabel(agent.agent) : undefined
    const named = { handle, title, ...(ran !== undefined && { ran }) }
    const left = (byUser: boolean): void => {
      this.endLead(caller)
      host
        .messaging()
        .notice(
          lead.summary.id,
          teamNotice.left(caller.summary.handle, caller.summary.title, byUser),
          {
            always: true,
          },
        )
    }
    if (host.agentMode() === "swarm") {
      left(false)
      return { ok: true, left: true, ...named }
    }
    const unaskable = this.unaskable(handle, lead)
    if (unaskable) return unaskable
    const own = this.leads.identity(caller)
    const seen = own && this.seenIn(own, lead)
    if (!seen) return unansweredCalls.leave
    this.ask({
      caller,
      target: lead,
      action: { type: "leave" },
      seen,
      unfit: () =>
        host.messaging().leadOf(caller.summary.id)?.terminalId === lead.summary.id
          ? undefined
          : "you no longer have that lead.",
      done: () => {
        left(true)
        return teamNotice.nowLeft(handle)
      },
      declined: teamNotice.leaveDeclined(handle),
      gone: teamNotice.gone(`let you leave ${mention(handle)}'s team`),
      vanished: teamNotice.vanished(`changed about leaving ${mention(handle)}'s team`),
    })
    return { ok: true, asked: true, ...named }
  }

  /** Why `caller` can't hand its team to `target` now; undefined when it can. */
  private unfitHand(caller: Record, target: Record): string | undefined {
    const { handle } = target.summary
    if (this.host.closingNow(target.summary.id) || target.closed)
      return `${mention(handle)} is closing.`
    const lead = this.host.messaging().leadOf(target.summary.id)
    if (lead?.terminalId === caller.summary.id) return undefined
    return lead === undefined
      ? `You don't lead ${mention(handle)}, so you can't hand your team to it.`
      : `${mention(handle)} is led by ${mention(lead.handle)}, not you, so you can't hand your team to it.`
  }

  /** A lead's hand-over: `to` leads the caller's team, and the caller. */
  async hand(call: Call): Promise<TeamChangeAnswer> {
    const { host } = this
    const caller = callerOf(host.records(), call)
    if (!caller) return unansweredCalls.handLead
    const parsed = handRequest.safeParse(call.request)
    if (!parsed.success)
      return refused(
        "A hand_lead needs `to`, the exact handle of a terminal you lead, and nothing else.",
      )
    const { to } = parsed.data
    if (to === caller.summary.handle) return refused("You can't hand your team to yourself.")
    const target = await host.peers().target(peerOf(caller), to)
    if (!target.ok) return target
    const heir = this.found(
      call,
      caller,
      target.terminalId,
      target.handle,
      unansweredCalls.handLead,
    )
    if ("ok" in heir) return heir
    const unfit = this.unfitHand(caller, heir)
    if (unfit) return refused(unfit)
    const { handle, title } = heir.summary
    const ran = target.agent === null ? undefined : agentLabel(target.agent)
    const named = { handle, title, ...(ran !== undefined && { ran }) }
    const handed = (byUser: boolean) => {
      const { id } = caller.summary
      const members = this.ledBy(caller, heir)
      const above = host.messaging().leadOf(id)
      const { bindings, messaging, peers } = {
        bindings: host.bindings(),
        messaging: host.messaging(),
        peers: host.peers(),
      }
      const tell = (whom: string, text: string) => messaging.notice(whom, text, { always: true })
      // The heir takes the caller's place: under the caller's own lead, or under none.
      // What the old lead and the lead above sent them that hadn't arrived is gone first, so
      // none arrives lead-marked from one that no longer leads.
      for (const each of [heir, caller, ...members]) messaging.dropLeadMessages(each.summary.id)
      if (above) this.setLead(heir, above.terminalId)
      else bindings.endLead(heir)
      for (const member of members) this.setLead(member, heir.summary.id)
      this.setLead(caller, heir.summary.id)
      const handles = members.map((each) => each.summary.handle)
      tell(
        heir.summary.id,
        teamNotice.handedTo(caller.summary.handle, handles, above?.handle, byUser),
      )
      peers.introduce(heir.summary.id, id, ...members.map((each) => each.summary.id))
      for (const member of members) {
        tell(member.summary.id, teamNotice.newLead(caller.summary.handle, handle, byUser))
        peers.introduce(member.summary.id, heir.summary.id)
      }
      if (above) {
        tell(above.terminalId, teamNotice.placed(caller.summary.handle, handle))
        peers.introduce(above.terminalId, heir.summary.id)
      }
      return { handles, ...(above !== undefined && { under: above.handle }) }
    }
    if (host.agentMode() === "swarm") {
      const { handles, under } = handed(false)
      return {
        ok: true,
        handed: true,
        ...named,
        members: handles,
        ...(under && { under }),
      }
    }
    const unaskable = this.unaskable(handle, heir)
    if (unaskable) return unaskable
    const own = this.leads.identity(caller)
    const seen = own && this.seenIn(own, heir)
    if (!seen) return unansweredCalls.handLead
    this.ask({
      caller,
      target: heir,
      action: { type: "hand" },
      seen,
      unfit: () => this.unfitHand(caller, heir),
      done: () => teamNotice.nowHanded(handle, handed(true).handles),
      declined: teamNotice.handDeclined(handle),
      gone: teamNotice.gone(`let you hand your team to ${mention(handle)}`),
      vanished: teamNotice.vanished(`changed about handing your team to ${mention(handle)}`),
    })
    return { ok: true, asked: true, ...named }
  }
}
