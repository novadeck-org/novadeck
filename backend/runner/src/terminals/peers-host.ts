import { basename, isAbsolute, relative } from "node:path"

import type { CompanionItem, TerminalMessages } from "@novadeck/protocol"

import { planTitle } from "../companions/content.js"
import { secrets } from "../companions/secrets.js"
import { DomainError } from "../errors.js"
import type { Activity } from "../harnesses/activity.js"
import type { Messaging } from "../messaging/messaging.js"
import {
  standingDone,
  waitsOnNote,
  type Git,
  type Happening,
  type Waiting,
  type Whereabouts,
} from "../messaging/peers.js"
import type { AgentsAnswer, PeerAnswer, SendAnswer, TeamAnswer } from "../messaging/sending.js"
import { unansweredCalls, type Ack, type Call } from "../shell/reports.js"
import { shorten } from "../text.js"
import type { HintFacts } from "../voice/hint.js"
import { gitBranch, gitCheckout } from "./branch.js"
import { GitStates } from "./git-state.js"
import type { Facts } from "./nudges.js"
import type { Bound, Record } from "./record.js"
import { shownCommand } from "./shown-command.js"
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
  /**
   * What the agent session bound in a terminal told the person, and how its turns ended,
   * from the report log; with `bodies`, what its reports said at length too.
   */
  readonly happenings: (terminalId: string, bodies: boolean) => readonly Happening[]
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
        since: oldest.askedAt,
      }
    : null
}

/** How long a folder's git branch, or its checkout, is trusted once read, in milliseconds. */
const branchMs = 5_000

/**
 * What the terminal manager answers agents messaging each other, and the runner API about
 * their messages: it reads where each terminal is (its git checkout, branch and state) only
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
  /** Each checkout's commits ahead and uncommitted changes, read by `git status` now and then. */
  private readonly states: GitStates

  constructor(
    private readonly options: PeersOptions,
    states?: GitStates,
  ) {
    this.states = states ?? new GitStates()
  }

  /**
   * Sends another terminal's agent a message, as an agent asked through Novadeck's MCP
   * server: from the terminal and its agent session, never a name the model passes. A
   * call without the shell's own token learns nothing more.
   */
  async send(call: Call): Promise<SendAnswer | TeamAnswer> {
    const { messaging } = this.options
    const caller = this.options.caller(call.terminalId, call.token)
    if (!caller) return unansweredCalls.send
    // Where `to` is a handle there, nothing needs describing: no branches or plans read.
    if (!messaging.describes(call.terminalId, call.request))
      return messaging.sendAny(call.terminalId, call.request)
    const about = await this.whereabouts(caller.summary.sessionId)
    return messaging.sendAny(call.terminalId, call.request, (id) => about.get(id))
  }

  /**
   * The other terminals in the caller's project and session, each described by what
   * Novadeck knows of it, and the caller's messages yet to arrive.
   */
  async agents(call: Call): Promise<AgentsAnswer> {
    const caller = this.options.caller(call.terminalId, call.token)
    if (!caller) return unansweredCalls.agents
    const about = await this.whereabouts(caller.summary.sessionId)
    return this.options.messaging.agents(call.terminalId, (id) => about.get(id))
  }

  /**
   * The caller's team in its project and session, each member described as `agents`
   * describes it, with what happened since the caller last asked.
   */
  async team(call: Call): Promise<AgentsAnswer> {
    const caller = this.options.caller(call.terminalId, call.token)
    if (!caller) return unansweredCalls.team
    const about = await this.whereabouts(caller.summary.sessionId, true)
    return this.options.messaging.team(call.terminalId, (id) => about.get(id), call.request)
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
   * its title and its agent's summary; the git checkout its agent works in now, with its
   * branch, commits ahead and uncommitted changes; when its agent's turn last started or
   * ended; what it waits on; what its agent session told the person; and what its shell runs.
   * A report's body is read only with `bodies`, as `team` quotes it.
   */
  private async whereabouts(sessionId: string, bodies = false): Promise<Map<string, Whereabouts>> {
    // Read once, and only where a `done` needs it.
    let delivered: ReadonlyMap<string, number> | undefined
    const entries = await Promise.all(
      this.options
        .running(sessionId)
        .map(peerOf)
        .map(async (terminal) => {
          const { cwd, activity } = terminal.summary
          // Where its agent works now, when that is another checkout than its terminal's.
          const now = terminal.activity ? await this.current(terminal.work, cwd) : null
          const happenings = this.options.happenings(terminal.summary.id, bodies)
          const done = happenings.findLast((each) => each.kind === "done")
          const where: Whereabouts = {
            title: terminal.summary.title,
            summary: terminal.naming.summary,
            git: await this.git(now ?? cwd),
            working: activity?.state === "working" || terminal.summary.shellCommand != null,
            // A sleeper has no process to tell: its summary keeps when its last turn ended.
            since:
              activity?.lastTurn?.at ?? terminal.activity?.turnAt ?? terminal.summary.lastTurnAt,
            waiting: waitingOf(terminal.activity),
            waitsOn: activity?.waiting ? waitsOnNote(activity.waiting, Date.now()) : null,
            startup: terminal.summary.startup?.screen ?? null,
            happenings,
            standing:
              done !== undefined &&
              standingDone(
                { tell: null, done: { subject: "", at: done.at } },
                terminal.work?.personAt,
                (delivered ??= this.options.messaging.deliveredAt()).get(terminal.summary.id) ??
                  null,
              ) !== null,
            shell: {
              running: terminal.summary.busy,
              command: terminal.summary.busy ? shownCommand(terminal.summary.process?.argv) : null,
            },
          }
          return [terminal.summary.id, where] as const
        }),
    )
    return new Map(entries)
  }

  /**
   * The git checkout a folder is in, as listings name it: its top folder's name, its
   * branch, and its state as last read (see `GitStates`); null outside a checkout.
   */
  private async git(folder: string): Promise<Git | null> {
    const top = await this.checkout(folder)
    if (top === null) return null
    const [branch, state] = await Promise.all([this.branch(folder), this.states.of(top)])
    return { repo: basename(top), branch, state }
  }

  /**
   * What tells whether a terminal's work drifted from where its agent last described it: its root's own
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
   * hold secrets, judged by the person's environment `env`; the runner's own when omitted.
   */
  async hint(
    terminal: PeerTerminal,
    shown: readonly Pick<CompanionItem, "kind" | "path" | "secret">[],
    env?: NodeJS.ProcessEnv,
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
    const held = secrets(env)
    return {
      cwd,
      branch: await this.branch(cwd),
      folders: busiestFolders(terminal.work?.folders ?? {})
        .map(({ folder }) => inside(folder))
        .filter((path) => path !== undefined),
      files: files.filter((path) => inside(path) && !held(path)).map((path) => basename(path)),
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

  /**
   * The top of the git checkout a terminal works in: where its agent works now when that is
   * another than its folder's (`current`), else its folder's; null outside any. Without an
   * agent bound its folder is all there is to go by.
   */
  async workingCheckout(cwd: string, work: Work | null, agent: boolean): Promise<string | null> {
    return (agent ? await this.current(work, cwd) : null) ?? (await this.checkout(cwd))
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
