import type { TerminalMove, TerminalMoved } from "@novadeck/protocol"

import type { CompanionItems } from "../companions/items.js"
import { DomainError } from "../errors.js"
import type { Feedback } from "../messaging/feedback.js"
import type { Inbox } from "../messaging/inbox.js"
import type { Messaging } from "../messaging/messaging.js"
import type { Approvals } from "./approvals.js"
import { notice } from "./closes.js"
import { mention } from "./handles.js"
import { leadNotice } from "./leads.js"
import type { Names } from "./names.js"
import type { OpenRequests } from "./opens.js"
import type { Record } from "./record.js"
import type { ListedTerminal } from "./saved-terminals.js"
import type { Saves } from "./saving.js"
import type { Sleepers } from "./sleepers.js"
import { summaryTitle, type Naming } from "./titles.js"

/** What a move asks of the workspace's sessions, which the runner's projects answer. */
export type MoveSessions = {
  /**
   * The project of a session that terminals may be in: NOT_FOUND when there is none, or it
   * or its project is going, CONFLICT when the session is being removed.
   */
  readonly projectOf: (sessionId: string) => string
}

export type MovesHost = {
  readonly stopping: () => boolean
  /** Every terminal the runner holds, by id. */
  readonly records: () => ReadonlyMap<string, Record>
  /** The terminal was closed in this runner's lifetime. */
  readonly closed: (terminalId: string) => boolean
  /** The terminal host is closing the terminal, its shell not yet ended. */
  readonly closingNow: (terminalId: string) => boolean
  /** The session's terminals are being closed, as it or its project is removed. */
  readonly closingSession: (sessionId: string) => boolean
  readonly saves: () => Saves
  readonly sleepers: () => Sleepers
  readonly messaging: () => Messaging
  readonly inbox: () => Inbox
  readonly feedback: () => Feedback
  readonly approvals: () => Approvals
  readonly opens: () => OpenRequests
  readonly items: () => CompanionItems | undefined
  /** Reports the record's current summary to every watcher. */
  readonly announce: (record: Record) => void
  /** Tells every watcher of a terminal kept only as saved. */
  readonly savedChanged: (row: ListedTerminal) => void
  /**
   * The project's handles: `claim` takes one back for the terminal, as an undo does; `next`
   * gives a handle nothing in the project holds; `givenAt` says when one was given.
   */
  readonly names: () => Pick<Names<Record>, "claim" | "next" | "givenAt">
}

/** A terminal that moves, as it was: running, or kept only as saved. */
type Member = {
  readonly id: string
  readonly record: Record | undefined
  readonly handle: string
  readonly naming: Naming
  /** The id of its lead, as `ledBy` keeps it: a move changes no id, so its team stays led. */
  readonly ledBy: string | null
  readonly openedBy: string | null
}

/**
 * A member of a move with what it is in the session it goes to, worked out once: the saved
 * row and the record in memory both take it from here, so they cannot differ. `summary` is a
 * running terminal's, its title's source following the handles that changed.
 */
type Placed = {
  readonly member: Member
  readonly handle: string
  readonly ledBy: string | null
  readonly openedBy: string | null
  /** Its naming, the handle its opener's title names following the opener's rename. */
  readonly naming: Naming
  readonly summary: Record["summary"] | undefined
}

/** A handle that changed as its terminal moved. */
type Rename = { readonly was: string; readonly now: string }

/** The renames in a sentence: whoever addressed the old handle must use the new one. */
const changes = (renames: readonly Rename[]): string =>
  "Handles changed with the move, so use the new ones: " +
  renames.map(({ was, now }) => `${mention(was)} is now ${mention(now)}`).join(", ") +
  "."

/** What the people and agents in a moved terminal's old and new place are told. */
export const moveNotice = {
  // To a terminal that left its lead as it moved on its own.
  left: (lead: string, renames: readonly Rename[] = []): string =>
    notice +
    `The user moved you to another session in Novadeck, so ${mention(lead)} no longer leads ` +
    "you: its messages are a peer's from now, and it can no longer see you. What the user " +
    "told you still stands." +
    (renames.length === 0 ? "" : " " + changes(renames)),
  // To a terminal that left a lead as it moved on its own, one that is gone and has no handle.
  leftGone: (renames: readonly Rename[] = []): string =>
    notice +
    "The user moved you to another session in Novadeck, so your lead no longer leads you: its " +
    "messages are a peer's from now, and it can no longer see you. What the user told you " +
    "still stands." +
    (renames.length === 0 ? "" : " " + changes(renames)),
  // To the lead a terminal left as it moved.
  leftBy: (handle: string, title: string): string =>
    notice +
    `The user moved ${mention(handle)} · ${title} to another session in Novadeck: you no ` +
    "longer lead it, and you can no longer see it. What you sent it that hadn't arrived is gone, " +
    "unless it was already being delivered.",
  // To a terminal whose handle changed, or whose lead's or teammates' did, in the new session.
  renamed: (handle: string, renames: readonly Rename[]): string =>
    notice +
    `The user moved you to another session in Novadeck. Your handle there is ${mention(handle)}. ` +
    `${changes(renames)} The agents you knew there are out of reach, and you see this ` +
    "session's agents now.",
  // To a terminal moved on its own, whose handle and lead stayed.
  alone: (): string =>
    notice +
    "The user moved you to another session in Novadeck: the agents you knew there are out of " +
    "reach, but for your team if it came along, and you see this session's agents now.",
  // To the lead an undo of a move puts back over the terminal.
  leadsAgain: (handle: string, title: string): string =>
    notice +
    `The user moved ${mention(handle)} · ${title} back to this session in Novadeck: you lead ` +
    "it again, and you can see it.",
}

/**
 * Moving a terminal to another session of its project, without restarting it: its place in
 * the runner's records, in messaging, in the Inbox and on the companion bar all change at
 * once, in one step with nothing awaited, so nothing sees it half moved (`apply` lists what
 * follows a terminal). A lead takes its team, and a teammate moved alone leaves its lead.
 */
export class Moves {
  constructor(private readonly host: MovesHost) {}

  /** The terminal's place now: its record's summary, or the saved row's. */
  private member(terminalId: string): Member | undefined {
    const { host } = this
    const record = host.records().get(terminalId)
    if (record)
      return {
        id: terminalId,
        record,
        handle: record.summary.handle,
        naming: record.naming,
        ledBy: record.summary.ledBy,
        openedBy: record.openedBy,
      }
    const row = host.saves().saved(terminalId)
    return (
      row && {
        id: terminalId,
        record: undefined,
        handle: row.handle,
        naming: row.naming,
        ledBy: row.ledBy,
        openedBy: row.openedBy,
      }
    )
  }

  /** The handle the terminal has now, running or kept only as saved. */
  private handleOf(terminalId: string): string | undefined {
    const { host } = this
    return host.records().get(terminalId)?.summary.handle ?? host.saves().saved(terminalId)?.handle
  }

  /** Every terminal of the session, running or kept only as saved. */
  private inSession(sessionId: string): Member[] {
    const { host } = this
    const records = [...host.records().values()].filter(
      (record) => record.summary.sessionId === sessionId,
    )
    const saved = host
      .saves()
      .terminals(sessionId)
      .filter(({ id }) => !host.records().has(id))
    return [
      ...records.map((record) => this.member(record.summary.id)!),
      ...saved.map((row): Member => ({
        id: row.id,
        record: undefined,
        handle: row.handle,
        naming: row.naming,
        ledBy: row.ledBy,
        openedBy: row.openedBy,
      })),
    ]
  }

  /** The terminal then the team it leads at every depth, each lead before its workers. */
  private team(root: Member, all: readonly Member[]): Member[] {
    const members = [root]
    const seen = new Set([root.id])
    for (const lead of members)
      for (const each of all)
        if (each.ledBy === lead.id && !seen.has(each.id)) {
          seen.add(each.id)
          members.push(each)
        }
    return members
  }

  /** Why a terminal can't move now, in a sentence for the person; undefined when it can. */
  private unfit(member: Member): string | undefined {
    const { host } = this
    const { record, id, handle } = member
    if (record) {
      if (record.closed || host.closingNow(id) || host.closed(id))
        return `${mention(handle)} is closing.`
      if (record.hibernating) return `${mention(handle)}'s agent is being stopped to rest.`
    } else if (host.sleepers().waking(id)) return `${mention(handle)} is being woken.`
    if (host.messaging().briefOf(id) !== undefined)
      return `${mention(handle)} has a brief from its lead that hasn't arrived yet.`
    if (host.opens().involves(id))
      return `${mention(handle)} has a terminal on its way: it asked its agent to open one.`
    if (host.approvals().involves(id))
      return `${mention(handle)} is waiting for you to answer a request in Novadeck.`
    return undefined
  }

  /**
   * Moves the terminal, and the team it leads, to the session `input.to` names; see
   * `terminals.move` in the contract for what each failure is.
   */
  move(input: TerminalMove, sessions: MoveSessions): TerminalMoved {
    const { host } = this
    if (host.stopping()) throw new DomainError("CLOSING")
    const root = this.member(input.terminalId)
    if (!root || (!root.record && host.closed(root.id))) throw new DomainError("TERMINAL_NOT_FOUND")
    const source = root.record
      ? root.record.summary.sessionId
      : host.saves().saved(root.id)!.sessionId
    const projectId = sessions.projectOf(source)
    if (host.closingSession(source))
      throw new DomainError("CONFLICT", "The terminal's session is being removed.")
    const target = input.to.sessionId
    if (sessions.projectOf(target) !== projectId)
      throw new DomainError("CONFLICT", "A terminal moves only within its project.")
    if (target === source)
      throw new DomainError("CONFLICT", "The terminal is in that session already.")
    if (host.closingSession(target))
      throw new DomainError("CONFLICT", "That session is being removed.")
    const members = this.team(root, this.inSession(source))
    for (const member of members) {
      const why = this.unfit(member)
      if (why !== undefined) throw new DomainError("CONFLICT", why)
    }
    const placed = this.placed(members, target, input)
    const left = root.ledBy
    // The rows of the team move together, so the move is saved whole or not at all.
    const shadows = placed.map((each) => this.shadow(each, target))
    if (!host.saves().saveTogether(shadows)) {
      if (host.stopping()) throw new DomainError("CLOSING")
      throw new Error("Novadeck couldn't save the move of a terminal, so it didn't move it.")
    }
    this.apply(placed, source, target, projectId, left)
    return {
      sessionId: target,
      moved: placed.map(({ member, handle }) => ({
        terminalId: member.id,
        handle,
        was: member.handle,
      })),
      left,
    }
  }

  /**
   * The handle and lead each member has in the session, the lead before its workers: the
   * handle it has, which is its own in the whole project, unless a terminal there holds it
   * (only terminals made before handles were unique in a project can), else the project's
   * next. An undo's handle is taken back where no terminal there holds it and the project
   * gives it again (see `Names.claim`). Leads and openers are ids, which a move
   * leaves as they are: the workers keep their lead; the terminal asked for leaves its own,
   * but for the lead an undo names while that terminal is in the session. A title that
   * names its opener's handle follows the opener's new one.
   */
  private placed(members: readonly Member[], target: string, input: TerminalMove): Placed[] {
    const { host } = this
    const there = this.inSession(target)
    const claimed = new Set<string>()
    const holds = (handle: string) =>
      claimed.has(handle) || there.some((each) => each.handle === handle)
    const named = members.map((member, index) => {
      const back = input.handles?.[member.id]
      let handle: string | undefined
      if (
        back !== undefined &&
        !holds(back) &&
        (back === member.handle || host.names().claim(target, back, member.id))
      )
        handle = back
      else if (!holds(member.handle)) handle = member.handle
      handle ??= host.names().next(target)
      claimed.add(handle)
      const lead =
        index === 0
          ? input.lead !== undefined && there.some((each) => each.id === input.lead)
            ? input.lead
            : null
          : member.ledBy
      return { member, handle, ledBy: lead }
    })
    const handles = new Map(named.map(({ member, handle }) => [member.id, handle]))
    return named.map(({ member, handle, ledBy }) => {
      const { openedBy } = member
      // The title's source may name the old handle of an opener that moved with it.
      const now = openedBy === null ? undefined : handles.get(openedBy)
      const naming =
        now !== undefined && member.naming.opener
          ? { ...member.naming, opener: { ...member.naming.opener, by: now } }
          : member.naming
      const { record } = member
      const summary = record && {
        ...record.summary,
        sessionId: target,
        handle,
        ledBy,
        ...summaryTitle(naming, { handle, command: record.summary.command }),
      }
      return { member, handle, ledBy, openedBy, naming, summary }
    })
  }

  /** What is saved of a member in the session: its record as it will be, or its row. */
  private shadow({ member, handle, ledBy, openedBy, naming, summary }: Placed, sessionId: string) {
    const { record } = member
    if (record && summary) return { ...record, summary, openedBy, naming }
    const {
      transcript: _transcript,
      savedAt: _savedAt,
      ...row
    } = this.host.saves().saved(member.id)!
    return { ...row, sessionId, handle, ledBy, openedBy, naming }
  }

  /**
   * Puts the members in the session in memory, and tells who should hear of it, after the
   * save. Everything that follows a terminal is here, for whoever adds one that keeps its
   * session or handle:
   * - the record: summary (sessionId, handle, ledBy, and the title whose source names a
   *   handle), naming and openedBy, as `placed` worked them out, announced to watchers;
   * - the saved row, saved with the others in `move`, and with it the companion bar's items,
   *   which follow by the foreign key's cascade;
   * - a sleeper's session for its wake (`Sleepers.move`), with watchers told of it;
   * - messaging's `Live` for every member, a sleeper's resting one too (`messaging.move`),
   *   the one writer of a terminal's place there;
   * - the Inbox's entries (`inbox.moved`) and the feedback draft's session and handle;
   * - the companion items' watchers (`items.terminalMoved`).
   * Two orders matter. `messaging.move` comes before `inbox.moved`, as `Inbox.reconcile` reads
   * the owner from `Live`. The save comes before `items.terminalMoved`, as the cascade has
   * moved the items by then.
   * What deliberately does not follow: messages, which are addressed by terminal id within the
   * project. A brief, an open request and an approval naming a member refuse the move in
   * `unfit`, so none is in flight to carry. A terminal that leaves its lead ends the lead as
   * `Bindings.endLead` does, without its save or announcement: the team's save is one.
   */
  private apply(
    placed: readonly Placed[],
    source: string,
    target: string,
    projectId: string,
    left: string | null,
  ): void {
    const { host } = this
    const [first] = placed
    // Before the lead ends, so the lead hears the terminal moved, not that a session ended.
    if (left !== null) host.messaging().dropLeadMessages(first!.member.id)
    const lead = left === null ? undefined : host.records().get(left)
    const leader = lead?.summary.sessionId === source ? lead : undefined
    for (const { member, handle, ledBy, openedBy, naming, summary } of placed) {
      const { id, record } = member
      if (member === first!.member && left !== null) host.messaging().endLead(id)
      host.messaging().move(id, { projectId, sessionId: target }, handle, ledBy)
      host.inbox().moved(id, target, handle)
      host.feedback().moved(id, target, handle)
      if (record && summary) {
        record.openedBy = openedBy
        record.naming = naming
        if (summary.handle !== record.summary.handle)
          record.handleGivenAt = host.names().givenAt(target, summary.handle)
        record.summary = summary
        if (member === first!.member) record.suspended = null
        host.announce(record)
      } else {
        const row = host
          .saves()
          .terminals(target)
          .find((each) => each.id === id)
        if (row && !host.sleepers().move(row)) host.savedChanged(row)
      }
      host.items()?.terminalMoved(id)
    }
    this.tell(placed, target, left, leader)
  }

  /**
   * The agents that run now hear what changed for them, in one notice each, or that they moved
   * when nothing else did. A sleeper hears nothing, as a notice would wake it: it finds the new
   * session's agents when it wakes. The lead of a sleeper moved alone hears at once.
   */
  private tell(
    placed: readonly Placed[],
    target: string,
    left: string | null,
    lead: Record | undefined,
  ): void {
    const { host } = this
    const messaging = host.messaging()
    const [first] = placed
    const renames = placed
      .filter(({ member, handle }) => handle !== member.handle)
      .map(({ member, handle }) => ({ was: member.handle, now: handle }))
    // A sleeper has no record to take its title from: its saved row names it.
    const row = first!.member.record ? undefined : host.saves().saved(first!.member.id)
    const title =
      first!.member.record?.summary.title ??
      (row &&
        summaryTitle(row.naming, {
          handle: first!.member.handle,
          command: row.command,
        }).title) ??
      ""
    if (lead)
      messaging.notice(lead.summary.id, moveNotice.leftBy(first!.member.handle, title), {
        always: true,
      })
    // The lead an undo rejoins leads the terminal again.
    const rejoined = first!.ledBy === null ? undefined : host.records().get(first!.ledBy)
    if (rejoined)
      messaging.notice(rejoined.summary.id, moveNotice.leadsAgain(first!.handle, title), {
        always: true,
      })
    // The handle of the lead the terminal left, running or only saved; none where it is gone.
    const leftHandle = left === null ? undefined : (lead?.summary.handle ?? this.handleOf(left))
    // The handle the lead has in the session it is in; a lead that isn't running names none.
    const leadHandle = first!.ledBy === null ? undefined : this.handleOf(first!.ledBy)
    placed.forEach(({ member, handle, ledBy }, index) => {
      if (!member.record) return
      const text =
        index === 0 && left !== null && ledBy === null
          ? leftHandle !== undefined
            ? moveNotice.left(leftHandle, renames)
            : moveNotice.leftGone(renames)
          : index === 0 && ledBy !== null && leadHandle !== undefined
            ? leadNotice.nowLed(leadHandle) + (renames.length === 0 ? "" : " " + changes(renames))
            : renames.length > 0
              ? moveNotice.renamed(handle, renames)
              : moveNotice.alone()
      messaging.notice(member.id, text, { always: true })
    })
  }
}
