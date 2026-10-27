import { rmSync } from "node:fs"

import { doorbell, type Choice } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { resumeAvailability, type UnavailableReason } from "../harnesses/eligibility.js"
import { harnesses } from "../harnesses/registry.js"
import { agentLabel } from "../messaging/messages.js"
import { expectedAgent } from "./commands.js"
import type { Record } from "./record.js"
import { hasRun, type SavedTerminal } from "./records.js"

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
  return { command, nonce: new RegExp(doorbell.source).exec(command)?.[1] }
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
    return true
  } catch {
    // Taken meanwhile, or unremovable; the shell removes it as it reads it.
    return false
  }
}

/** Why an agent can't be started on a session an agent asked to resume, in a sentence for it. */
export const resumeRefusal = (agent: AgentName, reason: UnavailableReason): string => {
  const label = agentLabel(agent)
  switch (reason) {
    case "not-connected":
      return `Novadeck isn't connected to ${label}, so it can't resume its sessions.`
    case "unsupported":
      return `${label} can't resume a session by its id here.`
    case "no-session":
    case "invalid-session":
      return `That isn't a ${label} session id: give the id of a past session, as ${label} shows it.`
    case "in-use":
      return (
        `That ${label} session is already open in a terminal, or given to one that is starting: ` +
        "one session runs in one terminal. Close that terminal first, or start a new agent."
      )
  }
}

/** Whether a session may resume now: its command and claim, or why not. */
export type ResumeCheck =
  | {
      readonly ok: true
      readonly argv: readonly string[]
      readonly key: string
    }
  | { readonly ok: false; readonly reason: UnavailableReason }

export type ClaimsHost = {
  /** Whether another terminal than this one has the agent's session bound. */
  readonly boundElsewhere: (
    terminalId: string,
    agent: AgentName,
    session: string | undefined,
  ) => boolean
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
   * The same judgment as `resumable`, saying why when it may not, and starting with the
   * model and effort in `choice`, as an agent opening a terminal asks. `terminalId` is
   * the terminal the session is for, or an empty one while there is none yet.
   */
  check(
    terminalId: string,
    agent: AgentName,
    session: string | undefined,
    connected: boolean,
    choice?: Choice,
  ): ResumeCheck {
    const { resume } = harnesses[agent]
    const key = `${agent}:${session}`
    const claimant = this.claims.get(key)
    const bound = this.host.boundElsewhere(terminalId, agent, session)
    const inUse = (claimant !== undefined && claimant !== terminalId) || bound
    const availability = resumeAvailability({
      agent,
      resumes: resume !== undefined,
      connected,
      session,
      inUse,
    })
    if (availability.state !== "ready") return { ok: false, reason: availability.reason }
    if (!resume || session === undefined) return { ok: false, reason: "unsupported" }
    return { ok: true, argv: resume(session, choice), key }
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
    if (!found.ok) throw new DomainError("CONFLICT", resumeRefusal(resume.agent, found.reason))
    return found.key
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
