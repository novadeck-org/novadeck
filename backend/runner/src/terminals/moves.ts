import type { TerminalMove, TerminalMoved } from "@novadeck/protocol"

import type { CompanionItems } from "../companions/items.js"
import { DomainError } from "../errors.js"
import type { Inbox } from "../messaging/inbox.js"
import type { Messaging } from "../messaging/messaging.js"
import type { Approvals } from "./approvals.js"
import { notice } from "./closes.js"
import { mention } from "./handles.js"
import { leadNotice } from "./leads.js"
import type { OpenRequests } from "./opens.js"
import type { Record } from "./record.js"
import type { ListedTerminal } from "./saved-terminals.js"
import type { Saves } from "./saving.js"
import type { Sleepers } from "./sleepers.js"
import { summaryTitle } from "./titles.js"

/** What a move asks of the workspace's sessions, which the runner's projects answer. */
export type MoveSessions = {
  /**
   * The project of a session that terminals may be in: NOT_FOUND when there is none, or it
   * or its project is going, CONFLICT when the session is being removed.
   */
  readonly projectOf: (sessionId: string) => string
  /** Creates the session; a taken id is a CONFLICT. */
  readonly create: (session: { id: string; projectId: string; name: string }) => void
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
  readonly approvals: () => Approvals
  readonly opens: () => OpenRequests
  readonly items: () => CompanionItems | undefined
  /** Reports the record's current summary to every watcher. */
  readonly announce: (record: Record) => void
  /** Tells every watcher of a terminal kept only as saved. */
  readonly savedChanged: (row: ListedTerminal) => void
  /** Records that the session gave the handle, unless it gave it already; whether it did now. */
  readonly adopt: (sessionId: string, handle: string) => boolean
  /** The handle the session gives its next terminal. */
  readonly draw: (sessionId: string) => string
}

/** A terminal that moves, as it was: running, or kept only as saved. */
type Member = {
  readonly id: string
  readonly record: Record | undefined
  readonly handle: string
  readonly ledBy: string | null
  readonly openedBy: string | null
}

/** A member of a move with the handle and lead it has in the session it goes to. */
type Placed = { readonly member: Member; readonly handle: string; readonly ledBy: string | null }

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
    "reach, and you see this session's agents now.",
  // To the lead an undo of a move puts back over the terminal.
  leadsAgain: (handle: string, title: string): string =>
    notice +
    `The user moved ${mention(handle)} · ${title} back to this session in Novadeck: you lead ` +
    "it again, and you can see it.",
}

/**
 * Moving a terminal to another session of its project, without restarting it: its place in
 * the runner's records, in messaging, in the Inbox and on the companion bar all change at
 * once, in one step with nothing awaited, so nothing sees it half moved. A lead takes its
 * team, and a teammate moved alone leaves its lead.
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
        ledBy: record.summary.ledBy,
        openedBy: record.openedBy,
      }
    const row = host.saves().saved(terminalId)
    return (
      row && {
        id: terminalId,
        record: undefined,
        handle: row.handle,
        ledBy: row.ledBy,
        openedBy: row.openedBy,
      }
    )
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
        if (each.ledBy === lead.handle && !seen.has(each.id)) {
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
    return undefined
  }

  /**
   * Moves the terminal, and the team it leads, to the session `input.to` names, or makes;
   * see `terminals.move` in the contract for what each failure is.
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
    const existing = "sessionId" in input.to ? input.to.sessionId : undefined
    if (existing !== undefined) {
      if (sessions.projectOf(existing) !== projectId)
        throw new DomainError("CONFLICT", "A terminal moves only within its project.")
      if (existing === source)
        throw new DomainError("CONFLICT", "The terminal is in that session already.")
      if (host.closingSession(existing))
        throw new DomainError("CONFLICT", "That session is being removed.")
    }
    const members = this.team(root, this.inSession(source))
    for (const member of members) {
      const why = this.unfit(member)
      if (why !== undefined) throw new DomainError("CONFLICT", why)
    }
    // Everything is judged: a session made now is the one thing that stays if the rest fails.
    const target =
      existing ??
      (() => {
        const made = "newSession" in input.to ? input.to.newSession : undefined
        sessions.create({ id: made!.id, projectId, name: made!.name })
        return made!.id
      })()
    const placed = this.placed(members, target, input)
    const left = root.ledBy
    // The rows of the team move together, so none is left led by a handle that went.
    const shadows = placed.map(({ member, handle, ledBy }) => {
      const { record } = member
      if (!record) return this.rowOf(member, target, handle, ledBy, placed)
      const openedBy =
        placed.find((each) => each.member.handle === member.openedBy)?.handle ?? member.openedBy
      return {
        ...record,
        summary: {
          ...record.summary,
          sessionId: target,
          handle,
          ledBy,
          ...summaryTitle(record.naming, {
            handle,
            command: record.summary.command,
            openedBy,
          }),
        },
        openedBy,
      }
    })
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
   * handle it has, unless a terminal there holds it, or leads under it, or the session gave
   * it to another (History's rule when it restores one), else the session's next. An undo's
   * handle is taken back where no terminal there holds or leads under it. The workers'
   * leads follow their lead's new handle; the terminal asked for leaves its own, but for the
   * lead an undo names while a terminal of the session has that handle.
   */
  private placed(members: readonly Member[], target: string, input: TerminalMove): Placed[] {
    const { host } = this
    const there = this.inSession(target)
    const claimed = new Set<string>()
    const holds = (handle: string) =>
      claimed.has(handle) || there.some((each) => each.handle === handle || each.ledBy === handle)
    const renamed = new Map<string, string>()
    return members.map((member, index) => {
      const back = input.handles?.[member.id]
      let handle: string | undefined
      if (back !== undefined && !holds(back)) {
        host.adopt(target, back)
        handle = back
      } else if (!holds(member.handle) && host.adopt(target, member.handle)) handle = member.handle
      handle ??= host.draw(target)
      claimed.add(handle)
      renamed.set(member.handle, handle)
      const lead =
        index === 0
          ? input.lead !== undefined && there.some((each) => each.handle === input.lead)
            ? input.lead
            : null
          : (renamed.get(member.ledBy ?? "") ?? member.ledBy)
      return { member, handle, ledBy: lead }
    })
  }

  /** A terminal kept only as saved, as its row says it is in the session. */
  private rowOf(
    member: Member,
    sessionId: string,
    handle: string,
    ledBy: string | null,
    placed: readonly { member: Member; handle: string }[],
  ) {
    const {
      transcript: _transcript,
      savedAt: _savedAt,
      ...row
    } = this.host.saves().saved(member.id)!
    return {
      ...row,
      sessionId,
      handle,
      ledBy,
      openedBy:
        placed.find((each) => each.member.handle === member.openedBy)?.handle ?? member.openedBy,
    }
  }

  /** Puts the members in the session in memory, and tells who should hear of it. */
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
    const lead =
      left === null
        ? undefined
        : [...host.records().values()].find(
            (each) => each.summary.sessionId === source && each.summary.handle === left,
          )
    for (const { member, handle, ledBy } of placed) {
      const { id, record } = member
      if (member === first!.member && left !== null) host.messaging().endLead(id)
      host.approvals().withdraw(id)
      host.messaging().move(id, { projectId, sessionId: target }, handle, ledBy)
      host.inbox().moved(id, target, handle)
      if (record) {
        const renamedOpener = placed.find((each) => each.member.handle === member.openedBy)
        if (renamedOpener) record.openedBy = renamedOpener.handle
        // The title's source may name the old handle.
        record.summary = {
          ...record.summary,
          sessionId: target,
          handle,
          ledBy,
          ...summaryTitle(record.naming, {
            handle,
            command: record.summary.command,
            openedBy: record.openedBy,
          }),
        }
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
    this.tell(placed, target, left, lead)
  }

  /**
   * The agents that run now hear what changed for them, in one notice each; a sleeper hears
   * it when it wakes, but for the lead of a sleeper moved alone, who hears at once.
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
          openedBy: row.openedBy,
        }).title) ??
      ""
    if (lead)
      messaging.notice(lead.summary.id, moveNotice.leftBy(first!.member.handle, title), {
        always: true,
      })
    // The lead an undo rejoins leads the terminal again.
    const rejoined =
      first!.ledBy === null
        ? undefined
        : [...host.records().values()].find(
            (each) => each.summary.sessionId === target && each.summary.handle === first!.ledBy,
          )
    if (rejoined)
      messaging.notice(rejoined.summary.id, moveNotice.leadsAgain(first!.handle, title), {
        always: true,
      })
    placed.forEach(({ member, handle, ledBy }, index) => {
      if (!member.record) return
      const text =
        index === 0 && left !== null && ledBy === null
          ? moveNotice.left(left, renames)
          : index === 0 && ledBy !== null
            ? leadNotice.nowLed(ledBy) + (renames.length === 0 ? "" : " " + changes(renames))
            : renames.length > 0
              ? moveNotice.renamed(handle, renames)
              : placed.length === 1
                ? moveNotice.alone()
                : undefined
      if (text !== undefined) messaging.notice(member.id, text, { always: true })
    })
  }
}
