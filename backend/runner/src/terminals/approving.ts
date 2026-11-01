import { userRules } from "@novadeck/harness-agy/settings"
import type { Install } from "@novadeck/harness-core/harness"
import type { Report } from "@novadeck/harness-core/report"
import type { AgentName, Grant, GrantRepoChoice } from "@novadeck/protocol"

import type { GrantSources } from "../messaging/grant-sources.js"
import { systemSources } from "../messaging/grant-sources.js"
import type { GrantOptions } from "../messaging/grants.js"
import type { Messaging } from "../messaging/messaging.js"
import { fsLookups } from "../shell/fs-lookups.js"
import { gitLookups } from "../shell/git-lookups.js"
import { Narrowing, startsAgy, startsAgyInPlan, type Launching } from "../shell/narrowing.js"
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
  /**
   * Told when no Novadeck terminal runs `agent` any more, as the last one closes: a plugin
   * change a running terminal held can go in.
   */
  agentIdle?: (agent: AgentName) => void
  /**
   * Where Antigravity keeps the person's settings (its install, as the plugin's): their own
   * allow rules are kept in a launch grant. Without it none are read, and none are kept.
   */
  install?: (agent: AgentName) => Promise<Install | undefined>
  /** Whether the installed Antigravity takes launch grants (version 1.4.10 or later). */
  agyTakesGrants?: () => Promise<boolean>
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
    readonly activity: (report: Report) => void
  }

  constructor(private readonly host: ApprovingHost) {
    // Read when a terminal starts, once its lead is registered.
    this.narrowing = new Narrowing({
      grants: { launchPrograms: (id) => host.messaging().grants.launchPrograms(id) },
      verified: host.options.narrowVerified ?? (() => Promise.resolve(false)),
      ...(host.options.install && {
        userRules: async () => {
          const install = await host.options.install!("agy")
          return install
            ? userRules(install)
            : { ok: false as const, reason: "Antigravity has no install" }
        },
      }),
      readable: (readable) => host.messaging().grants.agySettings(readable),
    })
    this.permissions = new Permissions({
      terminal: (id) => {
        const record = host.records().get(id)
        return (
          record && {
            token: record.token,
            exiting: record.terminal.exiting,
            projectFolder: host.projectFolder(record.summary.sessionId),
            folder: record.summary.cwd,
            planning: record.bound?.activity.planning === true,
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
      activity: (report) => this.heard(report),
    }
  }

  /**
   * A hook was heard from a terminal: its grants count the activity, if its token is the
   * terminal's own, so a stranger can't keep a grant alive.
   */
  private heard(report: Report): void {
    const record = this.host.records().get(report.terminalId)
    if (record && !record.terminal.exiting && sameToken(record.token, report.token))
      this.host.messaging().grants.activity(report.terminalId)
  }

  /** Whether Antigravity may start under a grant; asked before the shell starts. */
  verify(directory: string | undefined): Promise<Launching> {
    return this.narrowing.verify(directory)
  }

  /**
   * Gives the terminal's launch grants for the `command` its shell is about to run (none, or
   * false, where it resumes no agent).
   */
  launch(terminalId: string, verified: Launching, command: string | false | undefined): void {
    const plan = command !== undefined && command !== false && startsAgyInPlan(command)
    // First: the grants covering the terminal, and so its launch grant, depend on it.
    this.host.messaging().grants.planned(terminalId, plan)
    this.narrowing.launch(
      terminalId,
      verified,
      command !== undefined && command !== false && startsAgy(command),
      plan,
    )
  }

  /** The git repos a Grant card offers for the project the Novadeck session belongs to. */
  repos(sessionId: string): Promise<readonly GrantRepoChoice[]> {
    const folder = this.host.projectFolder(sessionId)
    if (folder === undefined) return Promise.resolve([])
    return (this.host.options.grantSources ?? systemSources).repos(folder)
  }

  /**
   * What a Grant card is made from beside the proposal: the repos when it offers push or pr, and
   * whether the installed Antigravity is older than the first that takes a launch grant (an
   * unknown version counts as new enough, as the gate does).
   */
  async facts(
    sessionId: string,
    repos: boolean,
  ): Promise<{
    readonly repos: readonly GrantRepoChoice[]
    readonly agyOutdated: boolean
    /** Whether the terminal's Antigravity was started in plan mode. */
    readonly startedInPlan: (terminalId: string) => boolean
  }> {
    const takes = this.host.options.agyTakesGrants
    const [found, current] = await Promise.all([
      repos ? this.repos(sessionId) : Promise.resolve([]),
      takes ? takes().catch(() => true) : Promise.resolve(true),
    ])
    return {
      repos: found,
      agyOutdated: !current,
      startedInPlan: (terminalId) => this.narrowing.startedInPlan(terminalId),
    }
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
    this.host.messaging().grants.planned(terminalId, false)
    this.narrowing.forget(terminalId)
    this.permissions.forget(terminalId)
    // The terminal may still be listed, closed or on its way out: it is not running anything.
    const record = this.host.records().get(terminalId)
    const wasAgy =
      record === undefined ||
      record.summary.agent === "agy" ||
      record.bound?.binding.agent === "agy" ||
      record.expecting === "agy"
    if (wasAgy && this.running("agy").length === 0) this.host.options.agentIdle?.("agy")
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
