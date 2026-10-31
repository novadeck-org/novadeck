import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, relative } from "node:path"

import type { CompanionItem, TerminalMessages } from "@novadeck/protocol"

import { planTitle } from "../companions/content.js"
import { secret } from "../companions/secrets.js"
import { DomainError } from "../errors.js"
import type { Activity } from "../harnesses/activity.js"
import type { Messaging } from "../messaging/messaging.js"
import { waitsOnNote, type Reports, type Waiting, type Whereabouts } from "../messaging/peers.js"
import type { AgentsAnswer, PeerAnswer, SendAnswer } from "../messaging/sending.js"
import { unansweredCalls, type Ack, type Call } from "../shell/reports.js"
import { shorten } from "../text.js"
import { tail } from "../text.js"
import type { HintFacts } from "../voice/hint.js"
import { gitBranch, gitCheckout } from "./branch.js"
import type { Facts } from "./nudges.js"
import type { Bound, Record } from "./record.js"
import type { AgentSummary } from "./summary.js"
import type { Naming } from "./titles.js"
import { busiestFolders, currentCheckout, type Work } from "./work.js"

/** What the terminal manager tells of a terminal, for its agent to message others. */
export type PeerTerminal = {
  /** Its summary as the agent layer keeps it: what its host keeps, as its size, isn't read. */
  readonly summary: AgentSummary
  readonly naming: Naming
  readonly work: Work | null
  readonly activity: Activity | null
  /** The handle of the terminal whose agent opened it; null otherwise. */
  readonly openedBy: string | null
}

/** What peers read of a terminal's record, as the terminal manager keeps it. */
export type PeerRecord = Pick<Record, "summary" | "naming" | "work" | "openedBy"> & {
  readonly bound: Pick<Bound, "activity"> | null
}

/**
 * The terminal a record is, as peers read it: read through to the record, so what is read
 * after a wait, as for its branch, is the record's then.
 */
export const peerOf = (record: PeerRecord): PeerTerminal => ({
  get summary() {
    return record.summary
  },
  get naming() {
    return record.naming
  },
  get work() {
    return record.work
  },
  get activity() {
    return record.bound?.activity ?? null
  },
  get openedBy() {
    return record.openedBy
  },
})

export type PeersOptions = {
  readonly messaging: Messaging
  /** The running terminal whose shell's own token this is; undefined for any other. */
  readonly caller: (terminalId: string, token: string) => PeerRecord | undefined
  /** A terminal the runner holds, running or exited. */
  readonly terminal: (terminalId: string) => PeerRecord | undefined
  /** The running terminals of a session. */
  readonly running: (sessionId: string) => readonly PeerRecord[]
  /** The folder of the project a session belongs to, when one is known. */
  readonly projectFolder: (sessionId: string) => string | undefined
  /** The latest reports of the agent session bound in a terminal. */
  readonly reports: (terminalId: string) => Reports
  /** Whether the runner is stopping. */
  readonly stopping: () => boolean
}

/**
 * What of a request's subject other agents may read. A permission's is often a command, an
 * address or a path, any of which may hold a secret in a form no rule can recognise, so
 * peers learn only its tool, never its subject.
 */
const shareable = (kind: Waiting["kind"], subject: string | null): string | null =>
  kind === "permission" ? null : subject

/** The oldest request an agent waits on the person for, with how many wait after it. */
export const waitingOf = (activity: Pick<Activity, "pending"> | null): Waiting | null => {
  const [oldest, ...rest] = activity?.pending ?? []
  return oldest
    ? {
        kind: oldest.kind,
        tool: oldest.toolName,
        subject: shareable(oldest.kind, oldest.subject),
        more: rest.length,
      }
    : null
}

/** A folder with its links resolved, or as it is where that fails. */
const real = (folder: string): Promise<string> => realpath(folder).catch(() => folder)

/** A path inside the person's home folder as `~/…`, which names no account; others as they are. */
const homeShort = (path: string): string => {
  const home = homedir()
  const inside = relative(home, path)
  return home && inside && !inside.startsWith("..") && !isAbsolute(inside) ? `~/${inside}` : path
}

/** How long a folder's git branch, or its checkout, is trusted once read, in milliseconds. */
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
  /** The top of the git checkout each folder is in, as last read, and when. */
  private readonly checkouts = new Map<
    string,
    { readonly top: string | null; readonly at: number }
  >()

  constructor(private readonly options: PeersOptions) {}

  /**
   * Sends another terminal's agent a message, as an agent asked through Novadeck's MCP
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
   * Novadeck knows of it, and the caller's messages yet to arrive.
   */
  async agents(call: Call): Promise<AgentsAnswer> {
    const caller = this.options.caller(call.terminalId, call.token)
    if (!caller) return unansweredCalls.agents
    const about = await this.whereabouts(caller.summary.sessionId)
    return this.options.messaging.agents(call.terminalId, (id) => about.get(id), call.request)
  }

  /**
   * The terminal an agent named by its handle, among the other running terminals of its
   * project and session, as `send` finds its recipient, with the agent running there; or
   * why none is, with every terminal there described, as `send` refuses an unknown handle.
   */
  async target(caller: PeerTerminal, to: string): Promise<PeerAnswer> {
    const { messaging } = this.options
    const found = messaging.peer(caller.summary.id, to)
    // Where `to` is a handle there, nothing needs describing: no branches or plans read.
    if (found.ok) return found
    const about = await this.whereabouts(caller.summary.sessionId)
    return messaging.peer(caller.summary.id, to, (id) => about.get(id))
  }

  /** A hook printed what a lease delivered; one without the shell's own token is ignored. */
  acknowledge(ack: Ack): void {
    if (this.options.caller(ack.terminalId, ack.token))
      this.options.messaging.acknowledge(ack.terminalId, ack.leaseId)
  }

  /** A terminal's threads and messages with their states. */
  messages(terminalId: string): TerminalMessages {
    if (this.options.stopping()) throw new DomainError("CLOSING")
    const terminal = this.options.terminal(terminalId)
    if (!terminal) throw new DomainError("TERMINAL_NOT_FOUND")
    return this.options.messaging.list(terminalId, terminal.summary.handle)
  }

  /** Pauses messaging across the whole runner, or resumes it. */
  pause(paused: boolean): void {
    if (this.options.stopping()) throw new DomainError("CLOSING")
    this.options.messaging.pause(paused)
  }

  /** Releases a held thread, and its pair's other held threads. */
  release(thread: string): void {
    if (this.options.stopping()) throw new DomainError("CLOSING")
    this.options.messaging.release(thread)
  }

  /** Stops a thread: its messages not yet delivered are gone, and nothing continues it. */
  stop(thread: string): void {
    if (this.options.stopping()) throw new DomainError("CLOSING")
    this.options.messaging.stop(thread)
  }

  /**
   * What Novadeck knows of each running terminal in a session beyond its agent's hooks:
   * its title and who gave it; its folder, relative to the project when inside it; its
   * git branch; its agent's current plan's title; what its root session worked on; its
   * agent's latest reports; and how to shorten the paths it wrote in.
   */
  private async whereabouts(sessionId: string): Promise<Map<string, Whereabouts>> {
    const project = this.options.projectFolder(sessionId)
    // The project as its links resolve too, as a checkout another folder is in is named.
    const realProject = project === undefined ? undefined : await real(project)
    const entries = await Promise.all(
      this.options
        .running(sessionId)
        .map(peerOf)
        .map(async (terminal) => {
          const { cwd } = terminal.summary
          const realCwd = await real(cwd)
          // Where its agent works now, when that is another checkout than its terminal's.
          const now = terminal.activity ? await this.current(terminal.work, cwd) : null
          const [branch, plan] = await Promise.all([this.branch(now ?? cwd), this.plan(terminal)])
          const place = (path: string): string => {
            for (const base of [project, realProject, cwd, realCwd]) {
              if (base === undefined) continue
              const inside = relative(base, path)
              if (!inside) return "."
              if (!inside.startsWith("..") && !isAbsolute(inside)) return inside
            }
            return homeShort(path)
          }
          const where: Whereabouts = {
            title: terminal.summary.title,
            titleSource: terminal.summary.titleSource,
            summary: terminal.naming.summary,
            folder: place(now ?? cwd),
            startedIn: now === null ? null : place(cwd),
            branch,
            plan,
            work: terminal.work,
            openedBy: terminal.openedBy,
            working: terminal.summary.activity?.state === "working",
            waiting: waitingOf(terminal.activity),
            waitsOn: terminal.summary.activity?.waiting
              ? waitsOnNote(terminal.summary.activity.waiting, Date.now())
              : null,
            reports: this.options.reports(terminal.summary.id),
            place: (path) => tail(place(path), 80),
          }
          return [terminal.summary.id, where] as const
        }),
    )
    return new Map(entries)
  }

  /**
   * What tells whether a terminal's work drifted from where its agent last summarized it: its root's own
   * plan's title (never a subagent's), the folder it writes in most, and its git branch.
   */
  async facts(terminal: PeerTerminal): Promise<Facts> {
    const [branch, plan] = await Promise.all([
      this.branch(terminal.summary.cwd),
      this.plan(terminal, true),
    ])
    const [main] = busiestFolders(terminal.work?.folders ?? {}, 1)
    return { plan, folder: main?.folder ?? null, branch }
  }

  /**
   * What a terminal's dictation hint is made of, but its project's name: its folder and
   * git branch, the folders its work wrote in most, as paths inside its project (or its
   * own folder, without one), and the names of the files `shown` in its bar, then of
   * those its work wrote in last. Only what is inside counts, and never a file that may
   * hold secrets.
   */
  async hint(
    terminal: PeerTerminal,
    shown: readonly Pick<CompanionItem, "kind" | "path" | "secret">[],
  ): Promise<Omit<HintFacts, "project" | "handles">> {
    const { cwd, sessionId } = terminal.summary
    const base = this.options.projectFolder(sessionId) ?? cwd
    const inside = (path: string): string | undefined => {
      const within = relative(base, path)
      return within.startsWith("..") || isAbsolute(within) ? undefined : within
    }
    const files = [
      ...shown.flatMap((item) => (item.kind === "file" && !item.secret && item.path) || []),
      ...(terminal.work?.files ?? []),
    ]
    return {
      cwd,
      branch: await this.branch(cwd),
      folders: busiestFolders(terminal.work?.folders ?? {})
        .map(({ folder }) => inside(folder))
        .filter((path) => path !== undefined),
      files: files.filter((path) => inside(path) && !secret(path)).map((path) => basename(path)),
    }
  }

  /**
   * The title of the terminal's agent's current plan, the root's or else, unless `own`,
   * the latest; null without one.
   */
  private async plan(terminal: PeerTerminal, own = false): Promise<string | null> {
    const plans = terminal.activity?.plans ?? []
    const plan = plans.find(({ actor }) => actor === null) ?? (own ? undefined : plans.at(-1))
    const title = plan ? await planTitle(plan.source) : undefined
    return title === undefined ? null : shorten(title, 120)
  }

  /**
   * The git checkout a terminal's agent works in now, from its latest tool calls (see
   * `currentCheckout`), when it is another than the one its terminal's folder is in; null
   * when it is the same, or nothing tells.
   */
  private async current(work: Work | null, cwd: string): Promise<string | null> {
    const places = work?.places ?? []
    if (places.length === 0) return null
    const folders = [...new Set([cwd, ...places])]
    const tops = new Map(
      await Promise.all(
        folders.map(async (folder) => [folder, await this.checkout(folder)] as const),
      ),
    )
    return currentCheckout(places, (folder) => tops.get(folder) ?? null, tops.get(cwd) ?? null)
  }

  /** The top of the git checkout a folder is in, read again once a few seconds old. */
  private async checkout(folder: string): Promise<string | null> {
    const known = this.checkouts.get(folder)
    if (known && Date.now() - known.at < branchMs) return known.top
    const top = await gitCheckout(folder)
    if (this.checkouts.size > 256) this.checkouts.clear()
    this.checkouts.set(folder, { top, at: Date.now() })
    return top
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
