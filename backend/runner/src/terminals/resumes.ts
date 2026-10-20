import { rmSync } from "node:fs"

import type { AgentName } from "@novadeck/protocol"

import { resumeAvailability } from "../harnesses/eligibility.js"
import { harnesses } from "../harnesses/registry.js"
import type { Record } from "./record.js"

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
    if (availability.state !== "ready" || !resume || session === undefined) return undefined
    return { argv: resume(session), key }
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
