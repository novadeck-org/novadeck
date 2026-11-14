import { z } from "zod"

import { unansweredCalls, type Call } from "../shell/reports.js"
import type { ApprovalOutcome } from "../terminals/approvals.js"
import { callerOf } from "../terminals/callers.js"
import { notice } from "../terminals/closes.js"
import { bareHandle, mention } from "../terminals/handles.js"
import type { LeadsHost } from "../terminals/leads.js"
import { peerOf } from "../terminals/peers-host.js"
import type { Record } from "../terminals/record.js"
import type { WorktreeRecord } from "./records.js"
import type { Worktrees } from "./worktrees.js"

/** What the worktree calls need of the runner. */
export type WorktreeCallsHost = Pick<
  LeadsHost,
  "records" | "stopping" | "messaging" | "peers" | "approvals"
> & {
  /** The service; none where the runner keeps no ownership (some tests). */
  readonly worktrees: () => Worktrees | undefined
  /** Whether the person turned agent worktrees on (Preferences, Experimental). */
  readonly enabled: () => boolean
  /** The project a session belongs to. */
  readonly projectOf: (sessionId: string) => string
}

/** The service the runner hands its terminals, with whether the person has worktrees on. */
export type WorktreesWiring = {
  readonly service: Worktrees
  readonly enabled: () => boolean
  /** Whether an agent process started at that time can use worktrees (`RootFolder.ready`). */
  readonly ready: (startedAt: number | undefined, relists: boolean) => boolean
}

/** The worktree calls' host entries for a terminal manager's `Calls`. */
export const worktreeHost = (
  wiring: WorktreesWiring | undefined,
  projectOf: (sessionId: string) => string,
): Pick<WorktreeCallsHost, "worktrees" | "enabled" | "projectOf"> => ({
  worktrees: () => wiring?.service,
  enabled: () => wiring?.enabled() ?? false,
  projectOf,
})

/** What an agent hears when agent worktrees are off. */
export const offRefusal =
  "Agent worktrees are off: the user can turn them on in Novadeck's Preferences, under " +
  "Experimental. Work in your terminal's own checkout."

const openRequest = z.strictObject({
  repo: z.string().min(1).optional(),
  branch: z.string().min(1).max(255),
  from: z.string().min(1).max(255).optional(),
  group: z.string().min(1).max(80).optional(),
})
const takeRequest = z.strictObject({ path: z.string().min(1) })
const closeRequest = z.strictObject({ path: z.string().min(1), force: z.boolean().optional() })
const giveRequest = z.strictObject({
  path: z.string().min(1),
  to: z.string().min(1).max(65).transform(bareHandle),
})

type Failure = { readonly ok: false; readonly reason: string }
const refused = (reason: string): Failure => ({ ok: false, reason })

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
  taken: (path: string, branch: string): string =>
    notice + `The user approved: you now own the worktree ${path} on branch ${branch}.`,
  lost: (taker: string, path: string, branch: string): string =>
    notice +
    `The user let ${mention(taker)} take your worktree ${path} (branch ${branch}). It is no ` +
    "longer yours: don't change files there, and don't close it.",
  declined: (path: string): string =>
    notice + `The user did not let you take the worktree ${path}: it stays with its owner.`,
  off: (path: string): string =>
    notice +
    `Nothing changed: agent worktrees were turned off before the user answered the ask to take ${path}.`,
  gone: (path: string): string =>
    notice +
    `Nothing changed: Novadeck's window went away before the user answered the ask to take ` +
    `the worktree ${path}. Ask again if it still should.`,
  vanished: (path: string): string =>
    notice +
    `You or the worktree's owner closed before the user answered, so ${path} didn't change hands.`,
  moved: (path: string): string =>
    notice +
    `The user approved, but nothing changed: the worktree ${path} changed owner meanwhile.`,
  given: (giver: string, path: string, branch: string): string =>
    notice +
    `${mention(giver)} gave you the worktree ${path} on branch ${branch}: you own it now. Work ` +
    "there with absolute paths and git -C.",
}

/** The sentence a taken worktree is answered with, or the ask. */
export type WorktreeAnswer =
  | {
      readonly ok: true
      readonly path: string
      readonly branch: string
      /** open_worktree: the branch existed and was checked out. */
      readonly existing?: boolean
      /** open_worktree: instruction files at its top. */
      readonly instructions?: readonly string[]
      /** take_worktree: it was yours already. */
      readonly already?: true
      /** take_worktree: the person was asked; the worktree isn't yours yet. */
      readonly asked?: true
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
    if (!this.host.enabled()) return refused(offRefusal)
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
    return { ok: true, on: this.host.enabled() }
  }

  async open(call: Call): Promise<WorktreeAnswer> {
    const context = this.context(call, unansweredCalls.openWorktree)
    if ("ok" in context) return context
    const { record, service, projectId } = context
    const read1 = read(
      openRequest,
      call.request,
      "open_worktree needs branch, and takes only repo, from and group besides.",
    )
    if (!read1.ok) return read1
    const { request } = read1
    const opened = await service.open({
      projectId,
      terminalId: call.terminalId,
      cwd: record.summary.cwd,
      repo: request.repo,
      branch: request.branch,
      from: request.from,
      group: request.group,
    })
    if (!opened.ok) return opened
    return {
      ok: true,
      path: opened.path,
      branch: opened.branch,
      existing: opened.existing,
      instructions: opened.instructions,
    }
  }

  async take(call: Call): Promise<WorktreeAnswer> {
    const context = this.context(call, unansweredCalls.takeWorktree)
    if ("ok" in context) return context
    const { record, service, projectId } = context
    const read1 = read(takeRequest, call.request, "take_worktree needs path, and nothing else.")
    if (!read1.ok) return read1
    const taken = await service.take({
      projectId,
      terminalId: call.terminalId,
      cwd: record.summary.cwd,
      path: read1.request.path,
    })
    if (!taken.ok) return taken
    if ("approval" in taken) return this.ask(call, record, service, taken.approval)
    return {
      ok: true,
      path: taken.path,
      branch: taken.branch,
      ...(taken.already && { already: true as const }),
    }
  }

  /**
   * Asks the person to let the caller take a worktree another terminal owns. The call
   * doesn't wait for them: it answers `asked` at once, and both agents hear the outcome as a notice.
   */
  private ask(call: Call, caller: Record, service: Worktrees, row: WorktreeRecord): WorktreeAnswer {
    const ownerId = row.terminalId!
    const waiting = this.host.approvals().refusal(ownerId)
    if (waiting)
      return refused(
        waiting === "nobody"
          ? "Novadeck isn't open to ask the user, so nothing changed."
          : "A question about that worktree's owner is still waiting for the user's answer, so " +
              "nothing changed. Try again once it is answered.",
      )
    const owner = this.host.records().get(ownerId)
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
          if (!this.host.enabled()) return tell(call.terminalId, worktreeNotice.off(path))
          if (!(await service.transfer(path, ownerId, call.terminalId)))
            return tell(call.terminalId, worktreeNotice.moved(path))
          tell(call.terminalId, worktreeNotice.taken(path, branch))
          // Its old owner's agent, if it still runs, learns on its next turn.
          if (this.host.records().has(ownerId)) {
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
        worktreeNotice.given(record.summary.handle, row.path, row.branch),
        {
          always: true,
        },
      )
    // The notice names the giver, so its handle is the receiver's to use.
    this.host.peers().introduce(target.terminalId, call.terminalId)
    return { ok: true, path: row.path, branch: row.branch, owner: target.handle }
  }
}
