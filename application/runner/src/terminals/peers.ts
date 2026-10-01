import { basename, isAbsolute, relative } from "node:path"

import type { AgentName, TerminalMessages, TerminalSummary } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { Activity } from "../harnesses/activity.js"
import { agents } from "../harnesses/registry.js"
import type { AgentsAnswer, Messaging, SendAnswer } from "../messaging/messaging.js"
import type { Whereabouts } from "../messaging/peers.js"
import { unansweredCalls, type Ack, type Call } from "../shell/reports.js"
import { gitBranch } from "./branch.js"
import { planTitle } from "./plans.js"
import { shorten, type Work } from "./work.js"

/** What the terminal manager tells of a terminal, for its agent to message others. */
export type PeerTerminal = {
  readonly summary: TerminalSummary
  readonly titledBy: string | null
  readonly work: Work | null
  readonly activity: Activity | null
}

export type PeersOptions = {
  readonly messaging: Messaging
  /** The running terminal whose shell's own token this is; undefined for any other. */
  readonly caller: (terminalId: string, token: string) => PeerTerminal | undefined
  /** A terminal the runner holds, running or exited. */
  readonly terminal: (terminalId: string) => PeerTerminal | undefined
  /** The running terminals of a session. */
  readonly running: (sessionId: string) => readonly PeerTerminal[]
  /** The folder of the project a session belongs to, when one is known. */
  readonly projectFolder: (sessionId: string) => string | undefined
  /** Whether the runner is stopping. */
  readonly stopping: () => boolean
}

/**
 * The agent a new terminal expects to bind, which messages may be sent to before it has:
 * the one it resumes, or whose program its command runs; null for a plain shell or
 * another program.
 */
export const expectedAgent = (
  command: string | undefined,
  resume: AgentName | undefined,
): AgentName | null => {
  if (resume) return resume
  const program = basename(command?.trim().split(/\s+/)[0] ?? "").replace(/\.(?:exe|cmd)$/i, "")
  return agents.find((agent) => agent === program) ?? null
}

/** How long a folder's git branch is trusted once read, in milliseconds. */
const branchMs = 5_000

/**
 * What the terminal manager answers agents messaging each other, and the runner API about
 * their messages: it reads where each terminal is (its folder, git branch and plan) only
 * when an answer describes the terminals, and passes the rest to messaging.
 */
export class TerminalPeers {
  /** Each folder's git branch, as last read, and when, so agents listing peers read few. */
  private readonly branches = new Map<
    string,
    { readonly branch: string | null; readonly at: number }
  >()

  constructor(private readonly options: PeersOptions) {}

  /**
   * Sends another terminal's agent a message, as an agent asked through NovaDeck's MCP
   * server: from the terminal and its agent session, never a name the model passes. A
   * call without the shell's own token learns nothing more.
   */
  async send(call: Call): Promise<SendAnswer> {
    const { messaging } = this.options
    const caller = this.options.caller(call.terminalId, call.token)
    if (!caller) return unansweredCalls.send
    // Where `to` is a handle there, nothing needs describing: no branches or plans read.
    if (!messaging.describes(call.terminalId, call.request))
      return messaging.send(call.terminalId, call.request)
    const about = await this.whereabouts(caller.summary.sessionId)
    return messaging.send(call.terminalId, call.request, (id) => about.get(id))
  }

  /**
   * The other terminals in the caller's project and session, each described by what
   * NovaDeck knows of it, and the caller's messages yet to arrive.
   */
  async agents(call: Call): Promise<AgentsAnswer> {
    const caller = this.options.caller(call.terminalId, call.token)
    if (!caller) return unansweredCalls.agents
    const about = await this.whereabouts(caller.summary.sessionId)
    return this.options.messaging.agents(call.terminalId, (id) => about.get(id))
  }

  /** A hook printed what a lease delivered; one without the shell's own token is ignored. */
  acknowledge(ack: Ack): void {
    if (this.options.caller(ack.terminalId, ack.token))
      this.options.messaging.acknowledge(ack.terminalId, ack.leaseId)
  }

  /** A terminal's threads and messages with their states. */
  messages(terminalId: string): TerminalMessages {
    if (this.options.stopping()) throw new DomainError("RUNTIME_CLOSING")
    const terminal = this.options.terminal(terminalId)
    if (!terminal) throw new DomainError("TERMINAL_NOT_FOUND")
    return this.options.messaging.list(terminalId, terminal.summary.handle)
  }

  /** Pauses messaging across the whole runner, or resumes it. */
  pause(paused: boolean): void {
    if (this.options.stopping()) throw new DomainError("RUNTIME_CLOSING")
    this.options.messaging.pause(paused)
  }

  /** Releases a thread held for going back and forth too often. */
  release(thread: string): void {
    if (this.options.stopping()) throw new DomainError("RUNTIME_CLOSING")
    this.options.messaging.release(thread)
  }

  /**
   * What NovaDeck knows of each running terminal in a session beyond its agent's hooks:
   * its title and who gave it; its folder, relative to the project when inside it; its
   * git branch; its agent's current plan's title; what its root session worked on; and
   * how to shorten the paths it wrote in.
   */
  private async whereabouts(sessionId: string): Promise<Map<string, Whereabouts>> {
    const project = this.options.projectFolder(sessionId)
    const entries = await Promise.all(
      this.options.running(sessionId).map(async (terminal) => {
        const { cwd } = terminal.summary
        const plans = terminal.activity?.plans ?? []
        const plan = plans.find(({ actor }) => actor === null) ?? plans.at(-1)
        const [branch, title] = await Promise.all([
          this.branch(cwd),
          plan ? planTitle(plan.source) : undefined,
        ])
        const place = (path: string): string => {
          for (const base of [project, cwd]) {
            if (base === undefined) continue
            const inside = relative(base, path)
            if (!inside) return "."
            if (!inside.startsWith("..") && !isAbsolute(inside)) return inside
          }
          return path
        }
        const where: Whereabouts = {
          title: terminal.summary.title,
          titledBy: terminal.titledBy,
          folder: place(cwd),
          branch,
          plan: title === undefined ? null : shorten(title, 120),
          work: terminal.work,
          place: (path) => {
            const shown = place(path)
            return shown.length > 80 ? `…${shown.slice(-79)}` : shown
          },
        }
        return [terminal.summary.id, where] as const
      }),
    )
    return new Map(entries)
  }

  /** The git branch checked out in a folder, read again once what was read is a few seconds old. */
  private async branch(cwd: string): Promise<string | null> {
    const known = this.branches.get(cwd)
    if (known && Date.now() - known.at < branchMs) return known.branch
    const branch = await gitBranch(cwd)
    if (this.branches.size > 256) this.branches.clear()
    this.branches.set(cwd, { branch, at: Date.now() })
    return branch
  }
}
