import { randomUUID } from "node:crypto"

import type {
  AgentName,
  Grant,
  GrantCommand,
  GrantHolder,
  GrantPreset,
  GrantRepo,
} from "@novadeck/protocol"
import { Latest } from "@novadeck/wire/server"

import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import type { CmdNote } from "./grant-text.js"
import type { Live } from "./live.js"
import type { Relays } from "./relays.js"
import type { Sessions } from "./sessions.js"

const log = logs.for("grants")

/** A grant lasts at most this long, whatever the card said: a day, in milliseconds. */
export const maxGrantMs = 24 * 60 * 60_000
const hourMs = 60 * 60_000

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
  readonly hours: number
}

/** The programs a harness may be given a launch grant for: `git` for push, `gh` for pr. */
const presetPrograms: { readonly [preset in GrantPreset]: string } = { push: "git", pr: "gh" }

/**
 * The person's grants (docs/agent-messaging.md, "Grants"): what a lead's team, or one
 * terminal, may run without asking again. A grant is made only by `make`, which only the
 * Inbox's answers to a Grant card or an approval ask call, and lives at most a day. This
 * service keeps them, tells who they cover, and tells the covered terminals when one is
 * made or ends; the harnesses' permission hooks read `covering` and match the call against
 * it (`@novadeck/harness-core/grants`).
 */
export class Grants {
  private readonly byId = new Map<string, Grant>()
  private readonly readers = new Set<Latest<Grant[]>>()
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
    // An ended grant is dropped at load, and one stored with more than a day is cut to it.
    const ended: string[] = []
    let stored: readonly Grant[] = []
    this.save(() => {
      stored = records.grants()
    })
    const now = host.now()
    for (const grant of stored) {
      if (grant.revokedAt !== null || grant.endsAt <= now) ended.push(grant.id)
      else this.byId.set(grant.id, this.capped(grant))
    }
    if (ended.length > 0) this.save(() => records.removeGrants(ended))
    if (sweepMs > 0) {
      this.sweeper = setInterval(() => this.sweep(), sweepMs)
      this.sweeper.unref()
    }
  }

  /** Whether the grant is in force now. */
  private live(grant: Grant): boolean {
    return grant.revokedAt === null && grant.endsAt > this.host.now()
  }

  private capped(grant: Grant): Grant {
    const latest = grant.madeAt + maxGrantMs
    return grant.endsAt > latest ? { ...grant, endsAt: latest } : grant
  }

  /** The grant if it is in force: what `wrap` renders as `<grant>`, never an ended one. */
  get(id: string): Grant | undefined {
    const grant = this.byId.get(id)
    return grant && this.live(grant) ? grant : undefined
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
    this.save(() => this.records.saveGrant(next))
    this.publish()
  }

  /**
   * Makes a grant, as the person's click on a card said, and tells the terminals it covers.
   * Only the Inbox's answers call this; `hours` is cut to a day.
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
      endsAt: madeAt + Math.min(Math.max(input.hours, 0), 24) * hourMs,
      revokedAt: null,
      lastUse: null,
    }
    // Saved before it counts, so a failure refuses the person's click and nothing covers.
    this.records.saveGrant(grant)
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

  /** Ends the grants whose time is up, telling the terminals they covered. */
  sweep(): void {
    if (this.closed) return
    const now = this.host.now()
    for (const grant of this.byId.values())
      if (grant.revokedAt === null && grant.endsAt <= now) this.end(grant)
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

  /** Ends a grant: nothing covers from now, and those it covered are told. */
  private end(grant: Grant): void {
    const covered = this.coveredBy(grant)
    const ended = { ...grant, revokedAt: this.host.now() }
    this.byId.set(ended.id, ended)
    this.save(() => this.records.saveGrant(ended))
    for (const live of covered) this.host.notify(live.terminalId, grant.id)
    this.publish()
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
