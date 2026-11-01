import type { AgentName, Grant, GrantRepoChoice } from "@novadeck/protocol"

import type { GrantSources } from "../messaging/grant-sources.js"
import { systemSources } from "../messaging/grant-sources.js"
import type { GrantOptions } from "../messaging/grants.js"
import type { Messaging } from "../messaging/messaging.js"
import { fsLookups } from "../shell/fs-lookups.js"
import { gitLookups } from "../shell/git-lookups.js"
import { Narrowing, startsAgy } from "../shell/narrowing.js"
import { Permissions } from "../shell/permissions.js"
import { sameToken } from "./callers.js"
import type { Record } from "./record.js"

/** The grants' share of `TerminalOptions`; `Terminals` passes it on as it is. */
export type ApprovingOptions = GrantOptions & {
  /**
   * Whether Antigravity's installed plugin is verified (connected, as this Novadeck renders
   * it, no reinstall pending), waiting behind the harnesses' queue: only then is a terminal
   * started under a grant (approvals-design.md, B1). Never verified when omitted.
   */
  narrowVerified?: () => Promise<boolean>
  /** Where a Grant card's repos are read from; the real git and gh when omitted. */
  grantSources?: GrantSources
}

export type ApprovingHost = {
  readonly messaging: () => Messaging
  readonly records: () => ReadonlyMap<string, Record>
  readonly projectFolder: (sessionId: string) => string | undefined
  readonly options: ApprovingOptions
}

/**
 * The person's grants at the harnesses' permission hooks (approvals-design.md): the runner's
 * answers to them, and the Antigravity terminals started under a grant.
 */
export class Approving {
  readonly narrowing: Narrowing
  readonly permissions: Permissions
  /** The permission hooks' handlers, for the hook endpoint (`Launcher`). */
  readonly handlers: {
    readonly permit: Permissions["answer"]
    readonly denied: Permissions["denied"]
  }

  constructor(private readonly host: ApprovingHost) {
    // Read when a terminal starts, once its lead is registered.
    this.narrowing = new Narrowing({
      grants: { launchPrograms: (id) => host.messaging().grants.launchPrograms(id) },
      verified: host.options.narrowVerified ?? (() => Promise.resolve(false)),
    })
    this.permissions = new Permissions({
      terminal: (id) => {
        const record = host.records().get(id)
        return (
          record && {
            token: record.token,
            exiting: record.terminal.exiting,
            projectFolder: host.projectFolder(record.summary.sessionId),
          }
        )
      },
      sameToken,
      grants: {
        covering: (id) => host.messaging().grants.covering(id),
        recordUse: (grant, id, command) => host.messaging().grants.recordUse(grant, id, command),
      },
      narrowing: this.narrowing,
      git: gitLookups,
      fs: fsLookups,
      now: () => Date.now(),
    })
    this.handlers = {
      permit: (report, permission, deadline) =>
        this.permissions.answer(report, permission, deadline),
      denied: (report, command) => this.permissions.denied(report, command),
    }
  }

  /** Whether Antigravity may start under a grant; asked before the shell starts. */
  verify(directory: string | undefined): Promise<boolean> {
    return this.narrowing.verify(directory)
  }

  /**
   * Gives the terminal's launch grants for the `command` its shell is about to run (none, or
   * false, where it resumes no agent).
   */
  launch(terminalId: string, verified: boolean, command: string | false | undefined): void {
    this.narrowing.launch(
      terminalId,
      verified,
      command !== undefined && command !== false && startsAgy(command),
    )
  }

  /** The git repos a Grant card offers for the project the Novadeck session belongs to. */
  repos(sessionId: string): Promise<readonly GrantRepoChoice[]> {
    const folder = this.host.projectFolder(sessionId)
    if (folder === undefined) return Promise.resolve([])
    return (this.host.options.grantSources ?? systemSources).repos(folder)
  }

  /** The grants in force, then again on each change. */
  watchGrants(signal?: AbortSignal): AsyncGenerator<Grant[]> {
    return this.host.messaging().grants.watch(signal)
  }

  /** The person ends a grant. */
  revokeGrant(id: string): void {
    this.host.messaging().grants.revoke(id)
  }

  /** Forgets what is kept of a terminal, as it closes. */
  forget(terminalId: string): void {
    this.narrowing.forget(terminalId)
    this.permissions.forget(terminalId)
  }

  /** The handles of the running terminals whose agent is `agent`: showing, bound or expected. */
  running(agent: AgentName): readonly string[] {
    return [...this.host.records().values()]
      .filter(
        (record) =>
          !record.closed &&
          !record.terminal.exiting &&
          (record.summary.agent === agent ||
            record.bound?.binding.agent === agent ||
            record.expecting === agent),
      )
      .map((record) => record.summary.handle)
  }

  /**
   * Tells each running terminal of `agent` the grants that cover it again, so the note they
   * carry is the one that holds now (cmd's AutoRun was silenced, or put back).
   */
  announceAgain(agent: AgentName): void {
    const grants = this.host.messaging().grants
    for (const [id, record] of this.host.records()) {
      const runs =
        !record.closed &&
        !record.terminal.exiting &&
        (record.summary.agent === agent ||
          record.bound?.binding.agent === agent ||
          record.expecting === agent)
      if (runs) grants.adopted(id)
    }
  }

  /** The handles of the running terminals whose Antigravity was started under a grant. */
  narrowed(): readonly string[] {
    return this.narrowing.narrowed().flatMap((id) => {
      const record = this.host.records().get(id)
      return record && !record.closed ? [record.summary.handle] : []
    })
  }
}
