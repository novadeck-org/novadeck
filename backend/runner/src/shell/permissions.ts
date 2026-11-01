import { posix, win32 } from "node:path"

import {
  lexCall,
  matchCall,
  type FsLookups,
  type GitLookups,
  type GrantScope,
  type ShellCall,
} from "@novadeck/harness-core/grants"
import { silentFor, type MessagingProfile } from "@novadeck/harness-core/harness"
import type { Report } from "@novadeck/harness-core/report"

import { harnesses } from "../harnesses/registry.js"
import { cut } from "../text.js"
import { Armed } from "./armed.js"
import type { Permission } from "./hook.js"
import type { Narrowing } from "./narrowing.js"
import type { PermissionAnswer } from "./reports.js"

type NarrowedAnswers = NonNullable<MessagingProfile["permission"]["narrowed"]>

/** A live grant covering a terminal, as the check needs it (a protocol `Grant` is one). */
export type CoveringGrant = GrantScope & { readonly id: string }

/** What the check asks of the grants service (`messaging/grants.ts`). */
export type PermissionGrants = {
  /** The live grants covering the terminal now, read from memory at each check. */
  readonly covering: (terminalId: string) => readonly CoveringGrant[]
  /** Records that `grantId` let `command` through in the terminal. */
  readonly recordUse: (grantId: string, terminalId: string, command: string) => void
}

/**
 * Whether every entry of the agent's PATH is an absolute folder: a relative or empty entry (`.`,
 * `./node_modules/.bin`, `::`) lets its shell run a program of the name a grant covers from the
 * call's own folder, which the agent may have written there. A PATH the hook did not give is no
 * answer. `;` separates entries on Windows, `:` elsewhere.
 */
export const pathIsAbsolute = (
  path: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  if (path === null) return false
  if (platform !== "win32") return path.split(":").every((entry) => posix.isAbsolute(entry))
  return path.split(";").every((entry) => {
    const folder = entry.replace(/^"(.*)"$/, "$1")
    return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(folder) && win32.isAbsolute(folder)
  })
}

/** The terminal a permission hook came from, as the runner keeps it. */
export type PermissionTerminal = {
  readonly token: string
  readonly exiting: boolean
  /** The project folder it lies in; a call's folder must lie inside it. */
  readonly projectFolder: string | undefined
  /** The folder the terminal's shell is in: where a command it starts runs, for the same-name check. */
  readonly folder?: string | undefined
  /** Its agent is planning (Codex's Plan Mode, which its hooks don't name): no grant applies. */
  readonly planning?: boolean
}

export type PermissionsHost = {
  /** The terminal, if it still runs. */
  readonly terminal: (terminalId: string) => PermissionTerminal | undefined
  readonly sameToken: (a: string, b: string) => boolean
  readonly grants: PermissionGrants
  readonly narrowing: Narrowing
  readonly git: GitLookups
  readonly fs: FsLookups
  readonly now: () => number
  /** The machine the runner runs on, for how a PATH reads; the process's when omitted. */
  readonly platform?: NodeJS.Platform
}

// The most of a command a use keeps: the grant's last use is one short line.
const useChars = 512

/**
 * The runner's answer to a harness's permission hook, made from the genuine payload at once
 * (never from the pruned report, never behind the terminal's report queue):
 * - Claude Code's PreToolUse (Bash) and Codex's PermissionRequest are allowed when a grant
 *   covering the terminal matches the call; Claude Code never in `plan` mode, and, with
 *   nothing matching, `ask` once for a command its auto mode refused (path B);
 * - Antigravity's PreToolUse, in a terminal started narrowed, is `deny_unless_prior_grant`
 *   for a matching command of its launch set, `ask` for a tool known to run none, and
 *   `force_ask` for everything else; outside such a terminal it answers as always.
 * Anything not known to match is the harness's own check's.
 */
export class Permissions {
  private readonly armed = new Armed()

  constructor(private readonly host: PermissionsHost) {}

  /** A command Claude Code's own check refused: armed for the terminal, once, for ten minutes. */
  denied(report: Report, command: string): void {
    if (this.terminal(report)) this.armed.arm(report.terminalId, command, this.host.now())
  }

  /** Forgets a terminal's arms, as it closes. */
  forget(terminalId: string): void {
    this.armed.forget(terminalId)
  }

  async answer(
    report: Report,
    permission: Permission,
    deadline: number,
  ): Promise<PermissionAnswer> {
    const { messaging } = harnesses[report.agent]
    const profile = messaging.permission
    // What the hook prints with nothing to say: the harness's own, or, in a narrowed
    // terminal, the closed answer.
    const unsaid: PermissionAnswer = {
      stdout: silentFor(messaging, report.event, permission.narrow),
      report: profile.reported,
    }
    const terminal = this.terminal(report)
    if (!terminal) return unsaid
    if (profile.narrowed !== undefined)
      return permission.narrow
        ? this.narrowed(report, permission, terminal, deadline, profile.narrowed)
        : unsaid
    return this.allowing(report, permission, terminal, deadline, unsaid)
  }

  // Claude Code and Codex: a match is allowed, at once, with no dialog.
  private async allowing(
    report: Report,
    { call, command, mode, path }: Permission,
    terminal: PermissionTerminal,
    deadline: number,
    unsaid: PermissionAnswer,
  ): Promise<PermissionAnswer> {
    const { allow, ask, planMode } = harnesses[report.agent].messaging.permission
    // Plan mode takes no grant, where an allow might step past its limits; a mode the
    // payload doesn't name, where it should, is none either.
    if (planMode !== undefined && (mode === null || mode === planMode)) return unsaid
    // Codex's hooks say `default` even in Plan Mode: its rollout says whether it plans.
    if (terminal.planning === true) return unsaid
    if (typeof call === "object" && allow !== undefined) {
      const grant = await this.match(report, call, terminal, path)
      if (grant !== undefined && this.live(deadline)) {
        this.use(report, grant, call.command)
        // Nothing waits on a dialog once a grant lets the call through.
        return { stdout: allow, report: false }
      }
    }
    // A command the harness's own check refused, tried again with no grant to cover it: its
    // own dialog opens, which the Inbox lists, instead of another refusal.
    if (
      ask !== undefined &&
      command !== null &&
      this.armed.take(report.terminalId, command, this.host.now())
    )
      return { stdout: ask, report: unsaid.report }
    return unsaid
  }

  // Antigravity started narrowed (design B2): one handler decides, and fails closed.
  private async narrowed(
    report: Report,
    { call, tool, path }: Permission,
    terminal: PermissionTerminal,
    deadline: number,
    answers: NarrowedAnswers,
  ): Promise<PermissionAnswer> {
    const closed: PermissionAnswer = { stdout: answers.closed, report: true }
    // A tool known to run no command keeps today's ask.
    if (tool === "plain") return { stdout: answers.notCommand, report: true }
    if (tool !== "shell" || typeof call !== "object") return closed
    // Only a program the launch settings allow can run unasked, so only one in this
    // terminal's launch set is answered so; any other asks (a program the grant names
    // applies after a restart).
    // A command the person's own rules may deny is refused: `closed` would put a dialog over
    // their denial. Rules that can't be read close the call.
    // Rules that can't be read are refused too: the person's denials may be among them.
    const denies = await this.host.narrowing.mayDeny(call.command)
    if (denies !== false) return { stdout: answers.denied, report: true }
    const lexed = lexCall(call)
    const program = lexed.ok ? lexed.argv[0] : undefined
    if (program === undefined || !this.host.narrowing.launchSet(report.terminalId)?.has(program))
      return closed
    const grant = await this.match(report, call, terminal, path)
    if (grant === undefined || !this.live(deadline)) return closed
    this.use(report, grant, call.command)
    return { stdout: answers.run, report: true }
  }

  // The terminal a report came from, when it still runs and the report carries its token.
  private terminal(report: Report): PermissionTerminal | undefined {
    const terminal = this.host.terminal(report.terminalId)
    return terminal && !terminal.exiting && this.host.sameToken(terminal.token, report.token)
      ? terminal
      : undefined
  }

  // Whether the hook can still print what it decides: past the deadline the relay has given up.
  private live(deadline: number): boolean {
    return this.host.now() < deadline
  }

  // The id of the first grant covering the terminal that the call matches.
  private async match(
    report: Report,
    call: ShellCall,
    terminal: PermissionTerminal,
    path: string | null,
  ): Promise<string | undefined> {
    const grants = this.host.grants.covering(report.terminalId)
    if (grants.length === 0 || terminal.projectFolder === undefined) return undefined
    // A PATH that can search the call's folder runs a same-name program the agent wrote there.
    if (!pathIsAbsolute(path, this.host.platform)) return undefined
    const found = await matchCall(
      call,
      grants,
      this.host.git,
      terminal.projectFolder,
      this.host.fs,
      terminal.folder,
    )
    const id = found === null ? undefined : grants[found.scope]?.id
    // The matching awaited the git and file lookups: a done, release or exit meanwhile ended the
    // coverage, so the grant must still cover the terminal now, right before it lets a call run.
    return id !== undefined &&
      this.host.grants.covering(report.terminalId).some((each) => each.id === id)
      ? id
      : undefined
  }

  private use(report: Report, grantId: string, command: string): void {
    this.host.grants.recordUse(grantId, report.terminalId, cut(command, useChars))
  }
}
