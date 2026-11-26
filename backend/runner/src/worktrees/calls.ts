import { existsSync } from "node:fs"

import type { PullRequest } from "@novadeck/forges"
import { z } from "zod"

import { keysOfBranch } from "../checkouts/home.js"
import { noticeText } from "../messaging/notice-format.js"
import { unansweredCalls, type Call } from "../shell/reports.js"
import type { ApprovalOutcome } from "../terminals/approvals.js"
import { callerOf } from "../terminals/callers.js"
import { bareHandle, mention } from "../terminals/handles.js"
import type { LeadsHost } from "../terminals/leads.js"
import { peerOf } from "../terminals/peers-host.js"
import type { Record } from "../terminals/record.js"
import { titleRefusal } from "../terminals/titles.js"
import type { WorktreeRecord } from "./records.js"
import { homeSaid, type OriginBranch, type Worktrees } from "./worktrees.js"

/** What the worktree calls need of the runner. */
export type WorktreeCallsHost = Pick<
  LeadsHost,
  "records" | "stopping" | "messaging" | "peers" | "approvals" | "agentMode" | "sleepers"
> & {
  /** The service; none where the runner keeps no ownership (some tests). */
  readonly worktrees: () => Worktrees | undefined
  /**
   * Whether agent worktrees are on for the terminal: the person left them on (Preferences,
   * Agents), or it is one of the tour's (`Wiring.enabled`).
   */
  readonly enabled: (terminalId: string) => boolean
  /** The project a session belongs to. */
  readonly projectOf: (sessionId: string) => string
}

/** The service the runner hands its terminals, with whether the person has worktrees on. */
export type WorktreesWiring = {
  readonly service: Worktrees
  /**
   * Whether agent worktrees are on: the person's setting, or for a terminal of the tour's
   * (`terminalId`), always, so the tour works the same whatever the person chose.
   */
  readonly enabled: (terminalId?: string) => boolean
  /**
   * Whether an agent process started at that time can use worktrees (`RootFolder.ready`); a
   * tour terminal's (`terminalId`) needs only the folder.
   */
  readonly ready: (startedAt: number | undefined, relists: boolean, terminalId?: string) => boolean
  /** Whether a folder is in a git repository, from the files alone (`repositoryKnown`). */
  readonly inRepository?: (folder: string, wait: boolean) => Promise<boolean | undefined>
  /** A branch's pull request, where a forge found one (`Forges`). */
  readonly pullRequest?: (commonDir: string, branch: string) => PullRequest | undefined
}

/** The worktrees a terminal owns, oldest first, each with its branch's pull request. */
export const ownedWorktrees = (
  wiring: WorktreesWiring | undefined,
  terminalId: string,
): readonly (WorktreeRecord & { readonly pullRequest?: PullRequest | undefined })[] =>
  (wiring?.service.ownedRows(terminalId) ?? []).map((row) => {
    const pullRequest = wiring?.pullRequest?.(row.commonDir, row.branch)
    return pullRequest ? { ...row, pullRequest } : row
  })

/** The worktree calls' host entries for a terminal manager's `Calls`. */
export const worktreeHost = (
  wiring: WorktreesWiring | undefined,
  projectOf: (sessionId: string) => string,
): Pick<WorktreeCallsHost, "worktrees" | "enabled" | "projectOf"> => ({
  worktrees: () => wiring?.service,
  enabled: (terminalId) => wiring?.enabled(terminalId) ?? false,
  projectOf,
})

/** What an agent hears when agent worktrees are off. */
export const offRefusal =
  "Agent worktrees are off: the user can turn them on in Novadeck's Preferences, under " +
  "Agents. Work in your terminal's own checkout."

// A worktree's title is read as a terminal's own is, then checked by `titleRefusal`.
const titleText = z.string().max(4096)
const openRequest = z.strictObject({
  repo: z.string().min(1).optional(),
  branch: z.string().min(1).max(255),
  title: titleText,
  from: z.string().min(1).max(255).optional(),
  group: z.string().min(1).max(80).optional(),
  home: z.string().min(1).max(255).optional(),
})
const takeRequest = z.strictObject({
  path: z.string().min(1),
  home: z.string().min(1).max(255).optional(),
  title: titleText.optional(),
})
const closeRequest = z.strictObject({ path: z.string().min(1), force: z.boolean().optional() })
const giveRequest = z.strictObject({
  path: z.string().min(1),
  to: z.string().min(1).max(65).transform(bareHandle),
})

type Failure = { readonly ok: false; readonly reason: string }
const refused = (reason: string): Failure => ({ ok: false, reason })

/** A worktree's title as kept, trimmed; or why it can't be (see `titleRefusal`). */
export const worktreeTitle = (
  said: string,
): { readonly ok: true; readonly title: string } | Failure => {
  const kept = said.trim()
  const why = titleRefusal(kept)
  return why === undefined ? { ok: true, title: kept } : refused(`Worktree: ${why}`)
}

const read = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  usage: string,
): { readonly ok: true; readonly request: T } | Failure => {
  const parsed = schema.safeParse(value)
  return parsed.success ? { ok: true, request: parsed.data } : refused(usage)
}

/** What agents are told when a worktree's ownership changes hands. */
export const worktreeNotice = {
  taken: (path: string, branch: string, untitled = false): string =>
    noticeText("Worktrees", {
      facts: `The user approved: you now own the worktree on branch ${branch}.`,
      details: [path],
      ...(untitled && { actions: ["It has no title: take_worktree with title gives it one."] }),
    }),
  lost: (taker: string, path: string, branch: string): string =>
    noticeText("Worktrees", {
      facts: `The user let ${mention(taker)} take your worktree on branch ${branch}. It is no longer yours.`,
      details: [path],
      actions: ["Don't change files there, and don't close it."],
    }),
  declined: (path: string): string =>
    noticeText("Worktrees", {
      facts: "The user did not let you take the worktree: it stays with its owner.",
      details: [path],
    }),
  off: (path: string): string =>
    noticeText("Worktrees", {
      facts:
        "Nothing changed: agent worktrees were turned off before the user answered the ask to take this worktree.",
      details: [path],
    }),
  gone: (path: string): string =>
    noticeText("Worktrees", {
      facts:
        "Nothing changed: Novadeck's window went away before the user answered the ask to take " +
        "the worktree.",
      details: [path],
      actions: ["Ask again if it still should."],
    }),
  vanished: (path: string): string =>
    noticeText("Worktrees", {
      facts:
        "You or the worktree's owner closed before the user answered, so it didn't change hands.",
      details: [path],
    }),
  moved: (path: string): string =>
    noticeText("Worktrees", {
      facts: "The user approved, but nothing changed: the worktree changed owner meanwhile.",
      details: [path],
    }),
  // Where agents decide for themselves (Swarm), nobody approved it: its owner hears of it so.
  lostNow: (taker: string, path: string, branch: string): string =>
    noticeText("Worktrees", {
      facts: `${mention(taker)} took your worktree on branch ${branch}. It is no longer yours.`,
      details: [path],
      actions: ["Don't change files there, and don't close it."],
    }),
  given: (giver: string, path: string, branch: string, home?: string): string =>
    noticeText("Worktrees", {
      facts:
        `${mention(giver)} gave you its worktree on branch ${branch}` +
        (home === undefined ? "" : `, home ${home}`) +
        ". It's yours now.",
      details: [path],
      actions: ["Work there with absolute paths and git -C."],
    }),
}

/** The sentence a taken worktree is answered with, or the ask. */
export type WorktreeAnswer =
  | {
      readonly ok: true
      readonly path: string
      readonly branch: string
      /** open_worktree: the branch existed and was checked out. */
      readonly existing?: boolean
      /** open_worktree: what origin has of a branch only origin had (see `OriginBranch`). */
      readonly origin?: OriginBranch
      /** open_worktree: the new branch tracks origin's. */
      readonly tracking?: boolean
      /** open_worktree: instruction files at its top. */
      readonly instructions?: readonly string[]
      /** open_worktree and take_worktree: the branch its work belongs on. */
      readonly home?: string
      /** take_worktree: home was given but stays as it was (the worktree isn't yours yet). */
      readonly homeKept?: true
      /** open_worktree and take_worktree: its title; absent where it has none. */
      readonly title?: string
      /** take_worktree: a title was given but the worktree has one, which stays. */
      readonly titleKept?: true
      /** take_worktree, asked: the title given is set on a yes, as the worktree has none. */
      readonly titleOnYes?: true
      /** take_worktree: it was yours already. */
      readonly already?: true
      /** take_worktree: the person was asked; the worktree isn't yours yet. */
      readonly asked?: true
      /** take_worktree: another terminal owned it; it is yours now, and the handle of its former owner. */
      readonly from?: string
      /** The handle of the terminal asked about, or given to. */
      readonly owner?: string
      /** close_worktree: where the uncommitted work was kept. */
      readonly kept?: string
      /** close_worktree: where commits only HEAD reached were kept. */
      readonly keptHead?: string
      readonly branchDeleted?: boolean
    }
  | Failure

/**
 * The calls agents make to open, take, give and close git worktrees, each answered only with
 * the shell's own token, and only while the person has agent worktrees on.
 */
export class WorktreeCalls {
  constructor(private readonly host: WorktreeCallsHost) {}

  /** The caller, the service, and the caller's project; or why the call can't go. */
  private context(
    call: Call,
    unanswered: Failure,
  ):
    | { readonly record: Record; readonly service: Worktrees; readonly projectId: string }
    | Failure {
    const record = callerOf(this.host.records(), call)
    if (!record) return unanswered
    if (!this.host.enabled(call.terminalId)) return refused(offRefusal)
    const service = this.host.worktrees()
    if (!service) return refused("Novadeck keeps no worktrees here.")
    return { record, service, projectId: this.host.projectOf(record.summary.sessionId) }
  }

  /** Whether the call is still the caller's to answer: it and the runner still stand. */
  private standing(call: Call, record: Record): boolean {
    return !this.host.stopping() && this.host.records().get(call.terminalId) === record
  }

  /** Whether the tools are offered: the caller is one of Novadeck's terminals, and the setting is on. */
  listed(call: Call): { readonly ok: boolean; readonly on?: boolean; readonly reason?: string } {
    if (!callerOf(this.host.records(), call)) return unansweredCalls.worktrees
    return { ok: true, on: this.host.enabled(call.terminalId) }
  }

  async open(call: Call): Promise<WorktreeAnswer> {
    const context = this.context(call, unansweredCalls.openWorktree)
    if ("ok" in context) return context
    const { record, service, projectId } = context
    const read1 = read(
      openRequest,
      call.request,
      "open_worktree needs branch and title, and takes only repo, from, group and home besides.",
    )
    if (!read1.ok) return read1
    const { request } = read1
    const titled = worktreeTitle(request.title)
    if (!titled.ok) return titled
    const opened = await service.open({
      projectId,
      terminalId: call.terminalId,
      cwd: record.summary.cwd,
      repo: request.repo,
      branch: request.branch,
      from: request.from,
      group: request.group,
      home: request.home,
      title: titled.title,
    })
    if (!opened.ok) return opened
    return {
      ok: true,
      path: opened.path,
      branch: opened.branch,
      existing: opened.existing,
      ...(opened.origin !== undefined && { origin: opened.origin }),
      ...(opened.tracking !== undefined && { tracking: opened.tracking }),
      instructions: opened.instructions,
      ...(opened.home !== undefined && { home: opened.home }),
      ...(opened.title !== undefined && { title: opened.title }),
    }
  }

  async take(call: Call): Promise<WorktreeAnswer> {
    const context = this.context(call, unansweredCalls.takeWorktree)
    if ("ok" in context) return context
    const { record, service, projectId } = context
    const read1 = read(
      takeRequest,
      call.request,
      "take_worktree needs path, and takes only home and title besides.",
    )
    if (!read1.ok) return read1
    const { home } = read1.request
    const titled =
      read1.request.title === undefined ? undefined : worktreeTitle(read1.request.title)
    if (titled && !titled.ok) return titled
    const title = titled?.title
    const taken = await service.take({
      projectId,
      terminalId: call.terminalId,
      cwd: record.summary.cwd,
      path: read1.request.path,
      home,
      title,
    })
    if (!taken.ok) return taken
    if ("approval" in taken) {
      const row = taken.approval
      // Another's worktree keeps its home, and its title where it has one: the title given names
      // one that has none, once it is the caller's.
      const hasTitle =
        title !== undefined &&
        existsSync(row.path) &&
        (await keysOfBranch(row.path, row.branch)).title !== undefined
      const given = hasTitle ? undefined : title
      const kept = {
        ...(home !== undefined && { homeKept: true as const }),
        ...(hasTitle && { titleKept: true as const }),
      }
      if (this.host.agentMode() !== "swarm") {
        const asked = this.ask(call, record, service, row, given)
        return asked.ok
          ? { ...asked, ...kept, ...(given !== undefined && { titleOnYes: true as const }) }
          : asked
      }
      const now = await this.takeNow(call, record, service, taken.approval)
      if (!now.ok) return now
      // Its own now: taken again, with home where given and the title where it had none, which
      // sets them as for one's own, and reads its title for the answer.
      const again = await service.take({
        projectId,
        terminalId: call.terminalId,
        cwd: record.summary.cwd,
        path: row.path,
        home,
        title: given,
      })
      return again.ok && !("approval" in again)
        ? {
            ...now,
            ...(again.home !== undefined && { home: again.home }),
            ...(again.title !== undefined && { title: again.title }),
            ...(hasTitle && { titleKept: true as const }),
          }
        : { ...now, ...kept }
    }
    return {
      ok: true,
      path: taken.path,
      branch: taken.branch,
      ...(taken.already && { already: true as const }),
      ...(taken.home !== undefined && { home: taken.home }),
      ...(taken.title !== undefined && { title: taken.title }),
    }
  }

  /** The terminal that owns a worktree, running or asleep: a message to a sleeper wakes it. */
  private ownerOf(
    ownerId: string,
  ): { readonly summary: { readonly id: string; readonly handle: string } } | undefined {
    return this.host.records().get(ownerId) ?? this.host.sleepers().peer(ownerId)
  }

  /**
   * Where agents decide for themselves (Swarm), the caller takes a worktree another terminal
   * owns at once; the owner, if it still runs, is told.
   */
  private async takeNow(
    call: Call,
    caller: Record,
    service: Worktrees,
    row: WorktreeRecord,
  ): Promise<WorktreeAnswer> {
    const ownerId = row.terminalId!
    const { path, branch } = row
    if (!(await service.transfer(path, ownerId, call.terminalId)))
      return refused(`The worktree ${path} changed owner meanwhile, so nothing changed.`)
    const owner = this.ownerOf(ownerId)
    if (owner) {
      // A sleeping owner hears of it when the notice wakes it.
      this.host
        .messaging()
        .notice(ownerId, worktreeNotice.lostNow(caller.summary.handle, path, branch), {
          always: true,
        })
      // The notice names the taker, and the answer the owner: each handle is the other's to use.
      this.host.peers().introduce(ownerId, call.terminalId)
      this.host.peers().introduce(call.terminalId, ownerId)
    }
    return {
      ok: true,
      path,
      branch,
      ...(owner && { from: owner.summary.handle }),
    }
  }

  /**
   * Asks the person to let the caller take a worktree another terminal owns. The call
   * doesn't wait for them: it answers `asked` at once, and both agents hear the outcome as a notice.
   */
  private ask(
    call: Call,
    caller: Record,
    service: Worktrees,
    row: WorktreeRecord,
    /** The title it takes on a yes, as it has none. */
    title?: string,
  ): WorktreeAnswer {
    const ownerId = row.terminalId!
    const waiting = this.host.approvals().refusal(ownerId)
    if (waiting)
      return refused(
        waiting === "nobody"
          ? "Novadeck isn't open to ask the user, so nothing changed."
          : "A question about that worktree's owner is still waiting for the user's answer, so " +
              "nothing changed. Try again once it is answered.",
      )
    const owner = this.ownerOf(ownerId)
    const tell = (id: string, text: string) =>
      this.host.messaging().notice(id, text, { always: true })
    const { path, branch } = row
    this.host.approvals().request(
      {
        from: call.terminalId,
        terminalId: ownerId,
        sessionId: caller.summary.sessionId,
        action: { type: "take", path, branch },
      },
      (outcome: ApprovalOutcome) => {
        void (async () => {
          if (this.host.stopping()) return
          if (outcome === "declined") return tell(call.terminalId, worktreeNotice.declined(path))
          if (outcome === "gone") return tell(call.terminalId, worktreeNotice.gone(path))
          if (outcome === "withdrawn") return tell(call.terminalId, worktreeNotice.vanished(path))
          // The setting may have gone off while the person decided: nothing moves then.
          if (!this.host.enabled(call.terminalId))
            return tell(call.terminalId, worktreeNotice.off(path))
          if (!(await service.transfer(path, ownerId, call.terminalId)))
            return tell(call.terminalId, worktreeNotice.moved(path))
          if (title !== undefined)
            await service.retitle({
              terminalId: call.terminalId,
              cwd: caller.summary.cwd,
              path,
              title,
            })
          const untitled =
            existsSync(path) && (await keysOfBranch(path, branch)).title === undefined
          tell(call.terminalId, worktreeNotice.taken(path, branch, untitled))
          // Its old owner's agent, if it still runs or sleeps, learns on its next turn or wake.
          if (this.ownerOf(ownerId)) {
            tell(ownerId, worktreeNotice.lost(caller.summary.handle, path, branch))
            // The notice names the taker, so its handle is the old owner's to use.
            this.host.peers().introduce(ownerId, call.terminalId)
          }
        })().catch(() => undefined)
      },
    )
    // The answer names the owner, so its handle is the caller's to use.
    if (owner) this.host.peers().introduce(call.terminalId, owner.summary.id)
    return {
      ok: true,
      path,
      branch,
      asked: true,
      ...(owner && { owner: owner.summary.handle }),
    }
  }

  /**
   * Titles a worktree the caller owns, for `describe`: `path` its folder, absolute or relative to
   * the caller's, `said` the title. Why not, where it can't be.
   */
  async retitle(
    call: Call,
    path: string,
    said: string,
  ): Promise<{ readonly ok: true; readonly branch: string; readonly title: string } | Failure> {
    const context = this.context(call, unansweredCalls.describe)
    if ("ok" in context) return context
    const { record, service } = context
    const titled = worktreeTitle(said)
    if (!titled.ok) return titled
    const done = await service.retitle({
      terminalId: call.terminalId,
      cwd: record.summary.cwd,
      path,
      title: titled.title,
    })
    return done.ok ? { ok: true, branch: done.row.branch, title: titled.title } : done
  }

  async close(call: Call): Promise<WorktreeAnswer> {
    const context = this.context(call, unansweredCalls.closeWorktree)
    if ("ok" in context) return context
    const { record, service } = context
    const read1 = read(
      closeRequest,
      call.request,
      "close_worktree needs path, and takes only force besides.",
    )
    if (!read1.ok) return read1
    const closed = await service.closeOwned({
      terminalId: call.terminalId,
      cwd: record.summary.cwd,
      path: read1.request.path,
      force: read1.request.force === true,
    })
    if (!closed.ok) return closed
    return {
      ok: true,
      path: closed.path,
      branch: closed.branch,
      branchDeleted: closed.branchDeleted,
      ...(closed.kept !== undefined && { kept: closed.kept }),
      ...(closed.keptHead !== undefined && { keptHead: closed.keptHead }),
    }
  }

  async give(call: Call): Promise<WorktreeAnswer> {
    const context = this.context(call, unansweredCalls.giveWorktree)
    if ("ok" in context) return context
    const { record, service } = context
    const read1 = read(
      giveRequest,
      call.request,
      "give_worktree needs path and to, the receiving terminal's handle.",
    )
    if (!read1.ok) return read1
    const { path, to } = read1.request
    if (to === record.summary.handle) return refused("That worktree is yours already.")
    const target = await this.host.peers().target(peerOf(record), to)
    if (!target.ok) return target
    // Closed, or the runner stopped, while the terminals were described.
    if (!this.standing(call, record)) return unansweredCalls.giveWorktree
    const given = await service.give({
      terminalId: call.terminalId,
      cwd: record.summary.cwd,
      path,
      to: target.terminalId,
    })
    if (!given.ok) return given
    const { row } = given
    this.host
      .messaging()
      .notice(
        target.terminalId,
        worktreeNotice.given(
          record.summary.handle,
          row.path,
          row.branch,
          existsSync(row.path) ? await homeSaid(row.path, row.branch) : undefined,
        ),
        {
          always: true,
        },
      )
    // The notice names the giver, so its handle is the receiver's to use.
    this.host.peers().introduce(target.terminalId, call.terminalId)
    return { ok: true, path: row.path, branch: row.branch, owner: target.handle }
  }
}
