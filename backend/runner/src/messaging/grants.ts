import { randomUUID } from "node:crypto"

import {
  maxGrantEnded,
  type AgentName,
  type Grant,
  type GrantCommand,
  type GrantEndWhy,
  type GrantHolder,
  type GrantLifetime,
  type GrantPreset,
  type GrantRepo,
} from "@novadeck/protocol"
import { Latest } from "@novadeck/wire/server"

import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import type { CmdNote } from "./grant-text.js"
import type { Live } from "./live.js"
import type { Relays } from "./relays.js"
import type { Sessions } from "./sessions.js"

const log = logs.for("grants")

/**
 * A grant ends when no terminal it covers has been heard from for this long: a day, in
 * milliseconds. It keeps an abandoned lead from holding a grant for days.
 */
export const idleGrantMs = 24 * 60 * 60_000
const hourMs = 60 * 60_000
/** How seldom activity is written to the records; memory holds it exactly. */
export const activitySaveMs = 5 * 60_000

/** Where grants are kept: the workspace's store, so a restart keeps them as it keeps leads. */
export type GrantRecords = {
  grants(): readonly Grant[]
  saveGrant(grant: Grant): void
  removeGrants(ids: readonly string[]): void
}

/** Grants kept in memory only, for a runner without a store. */
export const memoryGrants = (): GrantRecords => {
  const kept = new Map<string, Grant>()
  return {
    grants: () => [...kept.values()],
    saveGrant: (grant) => void kept.set(grant.id, grant),
    removeGrants(ids) {
      for (const id of ids) kept.delete(id)
    },
  }
}

/** What the Grants service asks of the rest of messaging. */
/** A closed terminal's kept handle and session, for one whose shell exited before it closed. */
export type SavedScope = { readonly sessionId: string; readonly handle: string }

export type GrantsHost = {
  readonly sessions: Sessions
  readonly now: () => number
  /**
   * Tells a covered terminal of a grant made or ended: queues Novadeck's message there,
   * which `wrap` renders from the grant itself (`Relays.grantNotice`).
   */
  readonly notify: (terminalId: string, grantId: string) => void
  /** Whether cmd prints before every command, which no Antigravity grant reaches past. */
  readonly cmdPrints: () => CmdNote
}

/** The grants' share of `MessagingOptions`. */
export type GrantOptions = {
  /** Where the person's grants are kept; in memory when omitted. */
  readonly grants?: GrantRecords
  /** How often grants past their time end, in milliseconds; 0 for never. */
  readonly grantsMs?: number
  /**
   * Whether cmd prints text of its own before every command (Windows, `cmdPrints` in
   * shell/install.ts), which a grant's note tells Antigravity of; no, when omitted.
   */
  readonly cmdPrints?: () => CmdNote
}

/** The grants service for messaging's `options`, its notices going through `relays`. */
export const grantsOf = (
  host: Omit<GrantsHost, "notify" | "cmdPrints"> & { readonly relays: Pick<Relays, "grantNotice"> },
  options: GrantOptions,
): Grants =>
  new Grants(
    {
      ...host,
      notify: (terminalId, grantId) => host.relays.grantNotice(terminalId, grantId),
      cmdPrints: options.cmdPrints ?? (() => false),
    },
    options.grants ?? memoryGrants(),
    { sweepMs: options.grantsMs ?? 30_000 },
  )

/** What the person's click on a card made: the Inbox's answers pass it, nothing else does. */
export type MakeGrant = {
  readonly projectId: string
  readonly workspaceSessionId: string
  readonly holder: GrantHolder
  readonly presets: readonly GrantPreset[]
  readonly commands: readonly GrantCommand[]
  readonly repos: readonly GrantRepo[]
  readonly entryId: string
  readonly proposedBy: string
  readonly lifetime: GrantLifetime
}

/** The programs a harness may be given a launch grant for: `git` for push, `gh` for pr. */
const presetPrograms: { readonly [preset in GrantPreset]: string } = { push: "git", pr: "gh" }

/**
 * The person's grants (docs/agent-messaging.md, "Grants"): what a lead's team, or one
 * terminal, may run without asking again. A grant is made only by `make`, which only the
 * Inbox's answers to a Grant card or an approval ask call. It lasts until the agent it
 * covers reports done, its lead releases it or it exits (each ends the coverage of that
 * terminal only), or, for an hour grant, the hour; a day without activity ends any. This
 * service keeps them, tells who they cover, and tells the covered terminals when one is
 * made or ends; the harnesses' permission hooks read `covering` and match the call against
 * it (`@novadeck/harness-core/grants`).
 */
export class Grants {
  private readonly byId = new Map<string, Grant>()
  private readonly readers = new Set<Latest<Grant[]>>()
  /** When each grant was last written, for the activity that is saved only now and then. */
  private readonly savedAt = new Map<string, number>()
  private readonly sweeper: ReturnType<typeof setInterval> | undefined
  private closed = false

  /** Whether cmd prints before every command (`GrantOptions.cmdPrints`). */
  cmdPrints(): CmdNote {
    return this.host.cmdPrints()
  }

  constructor(
    private readonly host: GrantsHost,
    private readonly records: GrantRecords = memoryGrants(),
    { sweepMs = 30_000 }: { readonly sweepMs?: number } = {},
  ) {
    // A grant past its hour, or idle for a day, is dropped at load, as a revoked one is.
    const ended: string[] = []
    let stored: readonly Grant[] = []
    this.save(() => {
      stored = records.grants()
    })
    const now = host.now()
    for (const grant of stored) {
      if (!this.inForce(grant, now)) ended.push(grant.id)
      else {
        this.byId.set(grant.id, grant)
        this.savedAt.set(grant.id, now)
      }
    }
    if (ended.length > 0) this.save(() => records.removeGrants(ended))
    if (sweepMs > 0) {
      this.sweeper = setInterval(() => this.sweep(), sweepMs)
      this.sweeper.unref()
    }
  }

  /** Whether the grant is in force at `now`: not revoked, inside its hour, not idle for a day. */
  private inForce(grant: Grant, now: number): boolean {
    return (
      grant.revokedAt === null &&
      (grant.endsAt === null || grant.endsAt > now) &&
      grant.lastActivityAt + idleGrantMs > now
    )
  }

  /** Whether the grant is in force now. */
  private live(grant: Grant): boolean {
    return this.inForce(grant, this.host.now())
  }

  /**
   * The grant if it is in force: what `wrap` renders as `<grant>`, never an ended one. With a
   * terminal, only if the grant still covers it: one whose coverage ended is no grant to it.
   */
  get(id: string, terminalId?: string): Grant | undefined {
    const grant = this.byId.get(id)
    if (!grant || !this.live(grant)) return undefined
    if (terminalId === undefined) return grant
    const live = this.host.sessions.get(terminalId)
    return live && this.covers(grant, live) ? grant : undefined
  }

  /** Why the grant's coverage of the terminal ended, if it did: `<grant-ended>` says so. */
  endedWhy(id: string, terminalId: string): GrantEndWhy | undefined {
    return this.byId.get(id)?.ended.find((each) => each.terminalId === terminalId)?.why
  }

  /** Every grant in force, oldest first. */
  list(): Grant[] {
    return [...this.byId.values()].filter((each) => this.live(each)).toSorted(byMade)
  }

  /**
   * Whether the grant covers the running terminal: in its project and Novadeck session, and
   * held by it. A team grant covers the terminals its lead leads directly, now and later,
   * while that lead is running; the lead itself only if `withLead`. Read at each call, so a
   * teammate released or gone, or opened later, counts at once.
   */
  private covers(grant: Grant, live: Live): boolean {
    if (live.projectId !== grant.projectId || live.sessionId !== grant.workspaceSessionId)
      return false
    // Coverage that ended is gone for good, whoever leads the terminal later.
    if (grant.ended.some((each) => each.terminalId === live.terminalId)) return false
    const { holder } = grant
    if (holder.kind === "terminal") return live.handle === holder.handle
    if (holder.withLead && live.handle === holder.lead) return true
    // The running lead: a terminal of the same project and session with that handle.
    return (
      live.ledBy === holder.lead &&
      this.host.sessions.scoped(live).some((peer) => peer.handle === holder.lead)
    )
  }

  /** The grants in force that cover a running terminal; none for an unknown one. */
  covering(terminalId: string): readonly Grant[] {
    const live = this.host.sessions.get(terminalId)
    if (!live || this.closed) return []
    return this.list().filter((grant) => this.covers(grant, live))
  }

  /**
   * The programs a harness is given launch grants for in the terminal: `git` when a
   * covering grant has push, `gh` for pr, and the first word of each granted command.
   */
  launchPrograms(terminalId: string): readonly string[] {
    const programs = new Set<string>()
    for (const grant of this.covering(terminalId)) {
      for (const preset of grant.presets) programs.add(presetPrograms[preset])
      for (const command of grant.commands) if (command.argv[0]) programs.add(command.argv[0])
    }
    return [...programs]
  }

  /**
   * The terminals the terminal leads directly, now, with the harness each runs: who a team
   * grant it proposes would cover today. A terminal with no agent yet is left out.
   */
  teamOf(terminalId: string): { readonly handle: string; readonly agent: AgentName }[] {
    const live = this.host.sessions.get(terminalId)
    if (!live) return []
    return this.host.sessions.scoped(live).flatMap((peer) => {
      const agent = peer.root?.agent ?? peer.shown?.agent ?? peer.expecting
      return peer.ledBy === live.handle && agent ? [{ handle: peer.handle, agent }] : []
    })
  }

  /** Whether another running terminal leads the terminal. */
  isLed(terminalId: string): boolean {
    const live = this.host.sessions.get(terminalId)
    return (
      live !== undefined &&
      live.ledBy !== null &&
      this.host.sessions.scoped(live).some((peer) => peer.handle === live.ledBy)
    )
  }

  /** The terminals now running that a grant covers. */
  private coveredBy(grant: Grant): Live[] {
    return [...this.host.sessions.all()].filter((live) => this.covers(grant, live))
  }

  /**
   * Notes that `command` ran under the grant in a terminal, for the grants list. Nothing
   * for a grant not in force or a terminal it doesn't cover.
   */
  recordUse(grantId: string, terminalId: string, command: string): void {
    const grant = this.get(grantId)
    const live = this.host.sessions.get(terminalId)
    if (!grant || !live || !this.covers(grant, live)) return
    const next: Grant = {
      ...grant,
      lastUse: { at: this.host.now(), handle: live.handle, command: command.slice(0, 512) },
    }
    this.byId.set(next.id, next)
    this.persist(next)
    this.publish()
  }

  /**
   * A covered terminal's agent was heard from (any hook report): each grant covering it
   * counts the activity. Kept exactly in memory and written at most every five minutes, so
   * a restart can end the idle cap that much early. Only a terminal the grant covers
   * renews it, so an agent the grant doesn't reach can't keep it alive.
   */
  activity(terminalId: string): void {
    const covering = this.covering(terminalId)
    if (covering.length === 0) return
    const now = this.host.now()
    for (const grant of covering) {
      const next: Grant = { ...grant, lastActivityAt: now }
      this.byId.set(next.id, next)
      if (now - (this.savedAt.get(next.id) ?? 0) >= activitySaveMs) this.persist(next)
    }
  }

  /**
   * The terminal's agent reported done, its lead released it, or its agent exited: every
   * grant covering it stops covering it, for good, and it is told with `<grant-ended>`.
   * The grants go on for the others, except a grant held by that terminal alone, which
   * ends with its holder. Only narrows: nothing here makes or widens a grant.
   */
  coverageEnds(terminalId: string, why: GrantEndWhy): void {
    const live = this.host.sessions.get(terminalId)
    if (!live || this.closed) return
    for (const grant of this.covering(terminalId)) {
      const entry = { terminalId, handle: live.handle, at: this.host.now(), why }
      // A lead's release is of a team's teammate; a terminal's own grant isn't its lead's.
      if (grant.holder.kind === "terminal") {
        if (why !== "released") this.end(grant, entry)
      }
      // With no room to record it the coverage can't be ended alone, so the grant ends.
      else if (grant.ended.length >= maxGrantEnded) this.end(grant)
      else {
        const next: Grant = { ...grant, ended: [...grant.ended, entry] }
        this.byId.set(next.id, next)
        this.persist(next)
        this.host.notify(terminalId, next.id)
        this.publish()
      }
    }
  }

  /**
   * Makes a grant, as the person's click on a card said, and tells the terminals it covers.
   * Only the Inbox's answers call this.
   */
  make(input: MakeGrant): Grant {
    if (this.closed) throw new DomainError("CLOSING")
    const madeAt = this.host.now()
    const grant: Grant = {
      id: randomUUID(),
      projectId: input.projectId,
      workspaceSessionId: input.workspaceSessionId,
      holder: input.holder,
      presets: [...input.presets],
      commands: input.commands.map(({ argv, rest }) => ({ argv: [...argv], rest })),
      repos: input.repos.map((repo) => ({ ...repo })),
      entryId: input.entryId,
      proposedBy: input.proposedBy,
      madeAt,
      lifetime: input.lifetime,
      endsAt: input.lifetime === "hour" ? madeAt + hourMs : null,
      lastActivityAt: madeAt,
      ended: [],
      revokedAt: null,
      lastUse: null,
    }
    // Saved before it counts, so a failure refuses the person's click and nothing covers.
    this.records.saveGrant(grant)
    this.savedAt.set(grant.id, madeAt)
    this.byId.set(grant.id, grant)
    for (const live of this.coveredBy(grant)) this.host.notify(live.terminalId, grant.id)
    this.publish()
    return grant
  }

  /** The person ends a grant now. NOT_FOUND for an unknown or already ended one. */
  revoke(id: string): void {
    if (this.closed) throw new DomainError("CLOSING")
    const grant = this.get(id)
    if (!grant) throw new DomainError("NOT_FOUND", "That grant has already ended.")
    this.end(grant)
  }

  /**
   * A terminal is closed for good: the team grants it leads, and the grants held by it
   * alone, end with it. A restart of the agent inside a terminal keeps them.
   */
  closedFor(
    scope: { readonly projectId?: string; readonly sessionId: string },
    handle: string,
  ): void {
    for (const grant of this.list()) {
      const { holder } = grant
      if (
        (scope.projectId !== undefined && grant.projectId !== scope.projectId) ||
        grant.workspaceSessionId !== scope.sessionId
      )
        continue
      if (
        (holder.kind === "team" && holder.lead === handle) ||
        (holder.kind === "terminal" && holder.handle === handle)
      )
        this.end(grant)
    }
  }

  /**
   * A terminal closed for good ends the team grants it leads, and its own; then it leaves.
   * One whose shell exited first has no live entry, so `saved`, its kept identity, says
   * its handle and session.
   */
  unregister(terminalId: string, forGood: boolean, saved?: SavedScope): void {
    const live = this.host.sessions.get(terminalId)
    if (forGood) {
      if (live) this.closedFor(live, live.handle)
      else if (saved) this.closedFor(saved, saved.handle)
    }
    this.host.sessions.unregister(terminalId, forGood)
  }

  /** A terminal gained a lead while its agent runs: the grants that now cover it reach it at once. */
  adopted(terminalId: string): void {
    for (const grant of this.covering(terminalId)) this.host.notify(terminalId, grant.id)
  }

  /**
   * Ends the grants whose hour is up or that were idle for a day, telling the terminals they
   * covered. Each looks at the grant's own clocks, so activity re-arms the idle cap.
   */
  sweep(): void {
    if (this.closed) return
    const now = this.host.now()
    for (const grant of this.byId.values())
      if (grant.revokedAt === null && !this.inForce(grant, now)) this.end(grant)
  }

  /** A grant in force, then again on each change; ended ones drop out. */
  async *watch(signal?: AbortSignal): AsyncGenerator<Grant[]> {
    const reader = new Latest<Grant[]>()
    this.readers.add(reader)
    reader.push(this.list())
    const abort = () => reader.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (this.closed || signal?.aborted) reader.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Listings are delivered in order.
        const next = await reader.next()
        if (next === undefined) return
        yield next
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      reader.finish()
      this.readers.delete(reader)
    }
  }

  close(): void {
    this.closed = true
    clearInterval(this.sweeper)
    for (const reader of this.readers) reader.finish()
    this.readers.clear()
  }

  /**
   * Ends a grant: nothing covers from now, and those it covered are told. With `entry`, the
   * coverage of that terminal ended with it, and `<grant-ended>` tells it why.
   */
  private end(grant: Grant, entry?: Grant["ended"][number]): void {
    const covered = this.coveredBy(grant)
    const ended: Grant = {
      ...grant,
      ...(entry && grant.ended.length < maxGrantEnded && { ended: [...grant.ended, entry] }),
      revokedAt: this.host.now(),
    }
    this.byId.set(ended.id, ended)
    this.persist(ended)
    for (const live of covered) this.host.notify(live.terminalId, grant.id)
    this.publish()
  }

  /** Saves a grant, noting when, for the activity that is saved only now and then. */
  private persist(grant: Grant): void {
    this.savedAt.set(grant.id, this.host.now())
    this.save(() => this.records.saveGrant(grant))
  }

  /** Writes to the records; a failure is logged, and the service carries on from memory. */
  private save(work: () => void): void {
    try {
      work()
    } catch (error) {
      log.error("grants.save-failed", "Novadeck could not save its grants", { err: error })
    }
  }

  private publish(): void {
    if (this.readers.size === 0) return
    const listing = this.list()
    const key = JSON.stringify(listing)
    for (const reader of this.readers) reader.push(listing, key)
  }
}

const byMade = (a: Grant, b: Grant): number => a.madeAt - b.madeAt
