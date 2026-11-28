import { rmSync } from "node:fs"

import type { Choice } from "@novadeck/harness-core/harness"
import { doorbell } from "@novadeck/harness-core/prompts"
import { novaProgram } from "@novadeck/harness-nova/launcher"
import type { AgentName } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { resumeAvailability, type UnavailableReason } from "../harnesses/eligibility.js"
import type { Nova } from "../harnesses/nova.js"
import { harnesses } from "../harnesses/registry.js"
import { agentLabel, agentLabelOf } from "../messaging/messages.js"
import { sessionFolder } from "../worktrees/root.js"
import { expectedAgent } from "./commands.js"
import type { Record } from "./record.js"
import { hasRun, type SavedTerminal } from "./saved-terminals.js"

/**
 * The task a worker lost before its agent's first session starts with again: the command
 * it was opened with, which starts that agent (with the task's doorbell line, as
 * `open_agent` opens it), while it is still led and no session of any agent ever reported
 * there, as one a reboot ended behind its trust screen. An agent that exited first, or a
 * startup the person's typing cancelled, ended the lead already. The line's nonce comes
 * with it, as the agent's first typed entry. Undefined otherwise: a terminal whose agent
 * ran resumes it or comes back a shell.
 */
export const restartedTask = (
  saved: Pick<SavedTerminal, "agents" | "command"> | undefined,
  ledBy: string | null | undefined,
): { readonly command: string; readonly nonce: string | undefined } | undefined => {
  const command = saved?.command
  if (!command || !ledBy || hasRun(saved.agents)) return undefined
  if (expectedAgent(command, undefined) === null) return undefined
  return { command, nonce: new RegExp(doorbell.source).exec(command)?.slice(1).find(Boolean) }
}

/**
 * Removes a resume command the shell has not taken yet, so it never runs; true when
 * one was still waiting.
 */
export const cancelResume = (record: Pick<Record, "resumeFile">): boolean => {
  const file = record.resumeFile
  if (!file) return false
  record.resumeFile = undefined
  try {
    rmSync(file)
    // The claim stays: the session's standing reports are read through it (`savedSession`).
    return true
  } catch {
    // Taken meanwhile, or unremovable; the shell removes it as it reads it.
    return false
  }
}

/** No agent is expected in the terminal: its resume was cancelled or came to nothing. */
export const endExpecting = (
  record: Pick<Record, "expecting" | "summary">,
  messaging: { expect(terminalId: string, agent: null): void },
  murmur: { released(terminalId: string): void } | undefined,
): void => {
  record.expecting = null
  messaging.expect(record.summary.id, null)
  // A description that waited for the agent is asked for now, prompt or none.
  murmur?.released(record.summary.id)
}

/** The agent as its sentences call it: Nova for a session of Nova's (`nova`), else its own. */
export const labelOf = (agent: AgentName, nova = false): string => agentLabelOf(agent, nova)

/**
 * Why an agent can't be started on a session an agent asked to resume, in a sentence for it;
 * `nova` where the session is Nova's.
 */
export const resumeRefusal = (
  agent: AgentName,
  reason: UnavailableReason,
  asleep = false,
  nova = false,
): string => {
  const label = labelOf(agent, nova)
  switch (reason) {
    case "not-connected":
      return `Novadeck isn't connected to ${label}, so it can't resume its sessions.`
    case "unsupported":
      return `${label} can't resume a session by its id here.`
    case "no-session":
    case "invalid-session":
      return `That isn't a ${label} session id: give the id of a past session, as ${label} shows it.`
    case "in-use":
      return asleep
        ? `That ${label} session belongs to a terminal where the agent is asleep: one session ` +
            "runs in one terminal. Message that agent to wake it, or close that terminal first, " +
            "or start a new agent."
        : `That ${label} session is already open in a terminal, or given to one that is starting: ` +
            "one session runs in one terminal. Close that terminal first, or start a new agent."
    case "conversation-gone":
      return `That ${label} conversation is gone: ${label} no longer has it.`
  }
}

/**
 * Why a sleeping agent could not be woken for the messages waiting for it, in a sentence
 * for their senders: they are gone, and the terminal stays asleep as it was. `nova` where the
 * session is Nova's.
 */
export const wakeRefusal = (agent: AgentName, reason: UnavailableReason, nova = false): string => {
  const label = labelOf(agent, nova)
  const why = {
    "not-connected": `Novadeck isn't connected to ${label}`,
    unsupported: `${label} can't resume a session by its id here`,
    "no-session": `Novadeck has no ${label} session saved for it`,
    "invalid-session": `the ${label} session saved for it isn't one it can run`,
    "in-use": `that ${label} session is open in another terminal`,
    "conversation-gone": `${label} no longer has that conversation`,
  }[reason]
  return `${label} was asleep there and could not be woken: ${why}.`
}

/** Why a sleeping Nova can't be woken now, as `stuckReason` says it of a harness. */
export const novaOffReason =
  "Nova is switched off (the user turns it on in Novadeck's Preferences > Experimental)"

/**
 * Why a sleeping agent can't be woken now, its harness not being connected, in words for its
 * messages' senders, which wait for it: what the person does about it.
 */
export const stuckReason = (agent: AgentName): string => {
  const label = agentLabel(agent)
  return `Novadeck isn't connected to ${label} (the user connects it again in Novadeck's Preferences, under Agents)`
}

/**
 * What a restored terminal's screen says when the agent that ran there was not resumed, in
 * a sentence for the person; undefined when it was, or none was asked to be. `took` is
 * whether the new shell was given the resume command.
 */
export const resumeNote = (
  checked: ResumeCheck | undefined,
  agent: AgentName | undefined,
  took: boolean,
): string | undefined => {
  if (!checked || !agent) return undefined
  const label = labelOf(agent, !checked.ok && checked.nova === true)
  const why = checked.ok
    ? took
      ? undefined
      : "this shell can't run the command that resumes it"
    : {
        "not-connected": `Novadeck isn't connected to ${label}`,
        unsupported: `${label} can't resume a session by its id here`,
        "no-session": `Novadeck has no ${label} session saved for this terminal`,
        "invalid-session": `the ${label} session saved for this terminal isn't one it can run`,
        "in-use": `that ${label} session is already open in another terminal`,
        "conversation-gone": `${label} no longer has that conversation`,
      }[checked.reason]
  return why && `${label} was running here, but wasn't resumed: ${why}.`
}

/**
 * Whether a session may resume now: its command and claim, or why not, with `nova` where the
 * session is Nova's, which the sentences saying why call it.
 */
export type ResumeCheck =
  | {
      readonly ok: true
      readonly argv: readonly string[]
      readonly key: string
    }
  | { readonly ok: false; readonly reason: UnavailableReason; readonly nova?: true }

/**
 * Whether a terminal other than `terminalId` has the agent's session: bound, or, where the
 * root is a conversation the status line names (Antigravity) and so differs from the bound
 * session's id, the session its agent works in.
 */
export const sessionHeldElsewhere = (
  records: Iterable<Pick<Record, "summary" | "bound" | "root">>,
  terminalId: string,
  agent: AgentName,
  session: string | undefined,
): boolean => {
  for (const other of records) {
    if (other.summary.id === terminalId) continue
    if (other.bound?.binding.agent === agent && other.bound.binding.sessionId === session)
      return true
    if (other.root?.agent === agent && other.root.sessionId === session) return true
  }
  return false
}

/**
 * The folder a terminal resuming its agent's session (`resume`, with no `command` of its own,
 * as `Claims.judge` reads it) starts in: where that session bound, which its harness keys the
 * conversation's project by, or undefined where it has none (or only the bare folder of agents'
 * worktrees, `root`). Not the terminal's own last folder, which follows every report's: Claude
 * Code's Bash tool keeps a `cd`, and its compact's SessionStart names that folder, so a
 * session resumed there would take that folder's project, memory and instructions (probed
 * 2026-11-17, e2e/probes/session-cwd.e2e.ts; Codex's and Antigravity's commands keep none).
 */
export const resumeFolder = (
  saved: Pick<SavedTerminal, "agents"> | undefined,
  {
    resume,
    command,
  }: { readonly resume?: AgentName | undefined; readonly command?: string | undefined },
  root: string | undefined,
): string | undefined =>
  resume && command === undefined ? sessionFolder(saved?.agents[resume]?.cwd, root) : undefined

/**
 * The folder `session` of `agent` bound in, as any of the terminals' rows kept it, live, saved
 * or closed in History (the newest report of it that names one): where an agent's `open_agent`
 * resumes it when it names no folder of its own (`resumeFolder` says why). Undefined where none
 * kept one, or kept only the bare folder of agents' worktrees, `root`.
 */
export const folderFor = (
  rows: Iterable<Pick<SavedTerminal, "agents">>,
  agent: AgentName,
  session: string,
  root: string | undefined,
): string | undefined => {
  let found: { readonly seq: number; readonly cwd: string } | undefined
  for (const row of rows) {
    const report = row.agents[agent]
    if (report?.sessionId !== session || report.cwd === undefined) continue
    if (!found || report.seq > found.seq) found = { seq: report.seq, cwd: report.cwd }
  }
  return sessionFolder(found?.cwd, root)
}

/**
 * The flags `session` of `agent` was launched with, as any of the terminals' rows kept them
 * (`AgentReport.launch`), live or saved: for a resume asked by an agent, in a terminal that
 * has no row of its own for the session yet. The newest report of the session wins.
 */
export const launchFor = (
  rows: Iterable<Pick<SavedTerminal, "agents">>,
  agent: AgentName,
  session: string,
): readonly string[] | undefined => {
  let found: { readonly seq: number; readonly launch: readonly string[] } | undefined
  for (const row of rows) {
    const report = row.agents[agent]
    if (report?.sessionId !== session || !report.launch) continue
    if (!found || report.seq > found.seq) found = { seq: report.seq, launch: report.launch }
  }
  return found?.launch
}

/**
 * The transcript path `session` of `agent` was bound with, as any of the terminals' rows kept it
 * (`AgentReport.transcript`): for a resume asked by an agent, as `launchFor`. The newest report wins.
 */
export const transcriptFor = (
  rows: Iterable<Pick<SavedTerminal, "agents">>,
  agent: AgentName,
  session: string,
): string | undefined => {
  let found: { readonly seq: number; readonly transcript: string } | undefined
  for (const row of rows) {
    const report = row.agents[agent]
    if (report?.sessionId !== session || !report.transcript) continue
    if (!found || report.seq > found.seq) found = { seq: report.seq, transcript: report.transcript }
  }
  return found?.transcript
}

export type ClaimsHost = {
  /** Whether another terminal than this one has the agent's session bound. */
  readonly boundElsewhere: (
    terminalId: string,
    agent: AgentName,
    session: string | undefined,
  ) => boolean
  /**
   * Nova (`Nova`, the runner's harnesses/nova.ts): whether a session, by its transcript, is its
   * (`owns`), which resumes on Nova (`novaProgram`) with no connection of the person's; whether
   * it may start in a terminal now (`starts`); and its switch's changes (`followSwitch`). No session is
   * its where omitted.
   */
  readonly nova?: Pick<Nova, "owns" | "starts" | "followSwitch">
}

/**
 * Sessions given out to resume, as agent:session, and the terminal each went to: one
 * session resumes in one terminal, until that terminal closes.
 */
export class Claims {
  private readonly claims = new Map<string, string>()

  constructor(readonly host: ClaimsHost) {}

  /**
   * The command that resumes `agent`'s `session` in the terminal, and the claim to
   * record once a shell runs it; undefined when it may not (see `resumeAvailability`).
   * One session resumes in one terminal: not while another terminal has it bound, nor
   * once another terminal claimed it, until that terminal closes.
   */
  resumable(
    terminalId: string,
    agent: AgentName,
    session: string | undefined,
    connected: boolean,
  ): { argv: readonly string[]; key: string } | undefined {
    const found = this.check(terminalId, agent, session, connected)
    return found.ok ? { argv: found.argv, key: found.key } : undefined
  }

  /**
   * What a create judges of the session the app asks to resume in a restored terminal,
   * with `saved` its saved row: undefined unless it asks, and none for a command given.
   * Its command carries the flags the session was launched with (`AgentReport.launch`).
   */
  judge(
    input: {
      readonly id: string
      readonly command?: string | undefined
      readonly resume?: AgentName | undefined
    },
    saved: Pick<SavedTerminal, "agents"> | undefined,
    connected: boolean,
  ): ResumeCheck | undefined {
    const { id, command, resume } = input
    if (command !== undefined || !resume) return undefined
    const report = saved?.agents[resume]
    return this.check(
      id,
      resume,
      report?.sessionId,
      connected,
      undefined,
      report?.launch,
      report?.transcript,
    )
  }

  /**
   * The same judgment as `resumable`, saying why when it may not, and starting with the
   * model and effort in `choice`, as an agent opening a terminal asks, then the flags the
   * session was launched with that its harness keeps (`launch`, an `AgentReport.launch`),
   * but for the model and effort `choice` sets itself. `terminalId` is the terminal the
   * session is for, or an empty one while there is none yet.
   */
  check(
    terminalId: string,
    agent: AgentName,
    session: string | undefined,
    connected: boolean,
    choice?: Choice,
    launch?: readonly string[],
    transcript?: string,
  ): ResumeCheck {
    const { resume } = harnesses[agent].launch
    const nova = this.isNova(agent, transcript)
    const key = `${agent}:${session}`
    const claimant = this.claims.get(key)
    const bound = this.host.boundElsewhere(terminalId, agent, session)
    const inUse = (claimant !== undefined && claimant !== terminalId) || bound
    const availability = resumeAvailability({
      agent,
      resumes: resume !== undefined,
      connected: connected || nova,
      session,
      inUse,
    })
    const marked = nova ? { nova: true as const } : {}
    if (availability.state !== "ready") return { ok: false, reason: availability.reason, ...marked }
    if (!resume || session === undefined) return { ok: false, reason: "unsupported", ...marked }
    const [program = "", ...rest] = resume(session, choice, launch, transcript)
    return { ok: true, argv: [nova ? novaProgram : program, ...rest], key }
  }

  /** Whether the agent's session, by its transcript, resumes on Nova. */
  isNova(agent: AgentName, transcript: string | undefined): boolean {
    return this.host.nova?.owns(agent, transcript) === true
  }

  /**
   * Whether the session is Nova's and Nova can't start in `terminalId` now, as it is switched
   * off: its launcher would refuse the resume.
   */
  novaOff(terminalId: string, agent: AgentName, transcript: string | undefined): boolean {
    return this.isNova(agent, transcript) && this.host.nova?.starts() === false
  }

  /** Calls `listener` as Nova is switched on or off; the returned function stops it. */
  followNova(listener: () => void): () => void {
    return this.host.nova?.followSwitch(listener) ?? (() => {})
  }

  /**
   * The claim to record for the terminal once its shell runs the session an agent asked
   * to resume there, judged again as it is created (another terminal may have taken it
   * since the agent asked): undefined for none; a `CONFLICT` where it is taken.
   */
  recheck(
    terminalId: string,
    resume: { readonly agent: AgentName; readonly session: string } | undefined,
  ): string | undefined {
    if (!resume) return undefined
    const found = this.check(terminalId, resume.agent, resume.session, true)
    if (!found.ok)
      throw new DomainError(
        "CONFLICT",
        resumeRefusal(resume.agent, found.reason, false, found.nova === true),
      )
    return found.key
  }

  /** The terminal that claimed the session `key` for a resume, if one did. */
  claimant(key: string): string | undefined {
    return this.claims.get(key)
  }

  /** Records the session `key` as the terminal's, once its shell runs the resume. */
  claim(key: string, terminalId: string): void {
    this.claims.set(key, terminalId)
  }

  /** Gives back the session `key`, if it is still the terminal's, as its resume was cancelled. */
  cancel(key: string | undefined, terminalId: string): void {
    if (key && this.claims.get(key) === terminalId) this.claims.delete(key)
  }

  /** Gives back every session the terminal claimed, as it closes. */
  release(terminalId: string): void {
    for (const [key, claimant] of this.claims) if (claimant === terminalId) this.claims.delete(key)
  }

  /** Forgets every session `agent` claimed, as once it is disconnected. */
  forgetAgent(agent: AgentName): void {
    for (const key of this.claims.keys()) if (key.startsWith(`${agent}:`)) this.claims.delete(key)
  }
}
