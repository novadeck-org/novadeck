import { resolve as resolvePath } from "node:path"

import type { Choice, Effort, Install, Model } from "@novadeck/harness-core/harness"
import { commandLine, startLine } from "@novadeck/harness-core/prompts"
import { isAgentName, type AgentName } from "@novadeck/protocol"
import type { Trees } from "@novadeck/terminal/pty"
import { freshNonce } from "@novadeck/tui-input"

import { agents, harnesses } from "../harnesses/registry.js"
import type { Feedback } from "../messaging/feedback.js"
import type { Inbox } from "../messaging/inbox.js"
import { agentLabel, agentLabelOf } from "../messaging/messages.js"
import type { AgentsAnswer, SendAnswer, TeamAnswer } from "../messaging/sending.js"
import { openCallMs, unansweredCalls, type Call } from "../shell/reports.js"
import type { Shipping } from "../shipping/service.js"
import { list } from "../text.js"
import { WorktreeCalls, type WorktreeCallsHost } from "../worktrees/calls.js"
import { closeWay, type ApprovalOutcome } from "./approvals.js"
import { callerOf } from "./callers.js"
import {
  allowClose,
  closeLimit,
  leadCloseLimit,
  onTheWay,
  readCloseRequest,
  closeNotice,
  nobodyRefusal,
  runnerCloseLimit,
  selfCloseMs,
  spentRefusal,
  waitingRefusal,
  type CloseAnswer,
} from "./closes.js"
import { sessionLaunch } from "./commands.js"
import type { Companion } from "./companion.js"
import { readDescribeRequest, waitingForOf, type DescribeAnswer } from "./describe-request.js"
import { mention } from "./handles.js"
import type { Launcher } from "./launching.js"
import { Leads, leadNotice, type LeadsHost } from "./leads.js"
import { afterSummary } from "./nudges.js"
import {
  allowOpen,
  leadOpenLimit,
  openLimit,
  prune,
  runnerOpenLimit,
  readOpenRequest,
  refused,
  sessionCommandRefusal,
  type Asked,
  type OpenAnswer,
  type OpenRequests,
} from "./opens.js"
import type { OpenPolicy } from "./options.js"
import { peerOf } from "./peers-host.js"
import type { Record } from "./record.js"
import { folderFor, launchFor, resumeRefusal, transcriptFor, type Claims } from "./resumes.js"
import { nobodyToRun, runNotice, waitingToRun } from "./runs.js"
import { shellBusy } from "./sampling.js"
import type { Sleeper, Sleepers } from "./sleepers.js"
import { Teams } from "./teams.js"
import { cleanSummary, described, summaryRefusal, titleRefusal } from "./titles.js"

/**
 * Who leads the agent an `open_agent` starts: its opener, with a brief by default and
 * without one otherwise, as `lead` says either way (`leads`); or, with a brief and `lead`
 * false, only until that brief is delivered (`briefOnly`): the brief goes with the lead
 * mark, as the person's decision that it is the agent's task and no peer's request.
 */
const openedLead = (request: {
  readonly agent?: AgentName | undefined
  readonly message?: string | undefined
  readonly lead?: boolean | undefined
}): { readonly leads: boolean; readonly briefOnly: boolean } => {
  const leads = request.agent !== undefined && (request.lead ?? request.message !== undefined)
  const briefOnly =
    request.agent !== undefined && request.message !== undefined && request.lead === false
  return { leads, briefOnly }
}

// Why a request for a new terminal went unanswered.
const unopened = {
  nobody: "Novadeck isn't open to show a new terminal.",
  // Its window may still open it, so the agent should look before asking again.
  gone: "Novadeck's window went away while opening the terminal; it may still open, so check before asking again.",
  late: "Novadeck didn't confirm the new terminal in time; it may still open, so check before asking again.",
}

// How long before an open call's own limit (`openCallMs`) the runner stops waiting for its
// terminal, to answer in time.
const answerMarginMs = 2_000

// What an agent asked to start with a task hears when no terminal was made for it in time.
const untasked =
  "Its task wasn't sent: if the terminal opens, send the task there with send, as nothing waits for it."

// `LeadsHost` holds the runner's records and stop, its messaging, peers, approvals,
// bindings, and whether a terminal is closing.
export type CallsHost = LeadsHost &
  WorktreeCallsHost & {
    readonly inbox: () => Inbox
    readonly feedback: () => Feedback
    /** The shipping gate, where the runner offers it. */
    readonly shipping: () => Shipping | undefined
    /** Agents' requests for a new terminal, on their way to the client. */
    readonly opens: () => OpenRequests
    readonly companion: () => Companion
    readonly launcher: () => Launcher
    /** Windows' process trees, which tell whether a shell has a job under it. */
    readonly trees: () => Pick<Trees, "read">
    /** The sessions given out to resume, one to a terminal. */
    readonly claims: () => Claims
    /** The terminals whose agents sleep. */
    readonly sleepers: () => Sleepers
    /** Every terminal's sessions, running or saved, which a resume reads its kept launch flags from. */
    readonly rows: () => Iterable<{ readonly agents: Record["agents"] }>
    /** History's closed terminals' sessions, which a resume reads its session's folder from too. */
    readonly closedRows: () => Iterable<{ readonly agents: Record["agents"] }>
    /** Closes a terminal for good, the person's close: one with no shell is forgotten as its row. */
    readonly close: (terminalId: string, closedBy: string | null) => Promise<void>
    /** Where a harness lives on this machine, which says how it may start with a task. */
    readonly install: (agent: AgentName) => Promise<Install | undefined>
    /** The models a harness can start with here, none where that can't be told. */
    readonly models: (agent: AgentName) => Promise<readonly Model[]>
    /** What the caller's `open_agent` is subject to: a refusal. */
    readonly openPolicy: (terminalId: string) => OpenPolicy
    /** Saves what restores the terminal, without its screen. */
    readonly save: (record: Record) => void
    /** Shows the terminal's title after what names it changed (see `titleOf`), as `Names.retitle`. */
    readonly retitle: (record: Record) => void
    /** Tells murmur the terminal's agent described its work. */
    readonly summarized: (terminalId: string) => void
    readonly send: (call: Call) => Promise<SendAnswer | TeamAnswer>
    readonly agents: (call: Call) => Promise<AgentsAnswer>
    readonly team: (call: Call) => Promise<AgentsAnswer>
  }

/**
 * The tool calls agents make through Novadeck's MCP server in their terminals' shells,
 * each answered only with the shell's own token: what they show beside the terminal, the
 * Inbox's asks and tells, messages, summaries, and the terminals they open and close, a
 * few at most each minute per chain of terminals and across the runner.
 */
export class Calls {
  /**
   * When each chain's agents opened terminals lately, for `openLimit`. A chain's times
   * outlive the terminal that began it, until they pass out of the window, so the
   * terminals it opened can't start afresh by closing it; `prune` lets them go then.
   */
  private readonly opened = new Map<string, readonly number[]>()
  // Which terminal a terminal opened on request is charged to: the one that began the
  // chain, so terminals opening terminals share one budget rather than each get theirs.
  private readonly openers = new Map<string, string>()
  // Every request's time, for the runner's own limit across all chains.
  private allOpened: readonly number[] = []
  /**
   * When each chain's agents closed terminals lately, for `closeLimit`: charged as opens
   * are, to the terminal that began the chain, from a budget apart from theirs, and kept
   * as theirs are.
   */
  private readonly closed = new Map<string, readonly number[]>()
  // Every close's time, for the runner's own limit across all chains.
  private allClosed: readonly number[] = []
  // The terminals closing themselves a moment after they said so.
  private readonly selfClosing = new Set<string>()

  /** Leads formed and ended after the fact. */
  readonly leads: Leads
  /** Joining, leaving and handing on a team, by its members and leads. */
  private readonly teams: Teams
  /** The git worktrees agents open, take, give and close. */
  private readonly worktrees: WorktreeCalls

  constructor(
    /** How long an agent's request for a new terminal waits for the client's answer. */
    private readonly openMs: number,
    readonly host: CallsHost,
  ) {
    this.leads = new Leads(host)
    this.teams = new Teams(host, this.leads)
    this.worktrees = new WorktreeCalls(host)
  }

  /**
   * Which chain the terminal belongs to goes, as it closes or is let go; the chain's times
   * stay. Requests to close it, or by it, are taken back: there is nothing left to confirm.
   */
  forgetOpener(terminalId: string): void {
    this.openers.delete(terminalId)
    this.host.approvals().withdraw(terminalId)
  }

  /** Whether the session's terminal with this handle is closing, its shell not yet ended. */
  private closingHere(sessionId: string, handle: string): boolean {
    return [...this.host.records().values()].some(
      ({ closed, summary }) =>
        closed && summary.sessionId === sessionId && summary.handle === handle,
    )
  }

  /**
   * Opens a new terminal beside the caller's, as an agent asked through Novadeck's MCP
   * server in one of the terminal's shells: in a folder, from the terminal's directory,
   * optionally starting a command at its first prompt, or an agent: at its prompt or with
   * a task, a model and effort, a past session to resume, and led by the caller or not
   * (see `openedLead`). A command that would start an agent session is refused, as
   * `open_agent` starts those. The client that lays terminals out opens it (see
   * `requests`), so without one nothing opens. A terminal's agents
   * open a few at most each minute. A call without the shell's own token learns nothing
   * more.
   */
  async open(call: Call): Promise<OpenAnswer> {
    // A terminal being made past the window's deadline is waited for only while this call can
    // still answer: a task never goes after the agent heard nothing opened.
    const until = Date.now() + openCallMs - answerMarginMs
    const record = callerOf(this.host.records(), call)
    if (!record) return unansweredCalls.open
    const read = readOpenRequest(call.request)
    if (!read.ok) return read
    const { request } = read
    const policy: OpenPolicy =
      request.agent !== undefined ? this.host.openPolicy(call.terminalId) : {}
    // A new agent starts on the model and effort its policy pins for the folder it asks for, if
    // any, whatever the call names. A resume keeps its session's model, and an effort alone is
    // refused as for every call (it needs a model).
    const pinned =
      request.agent !== undefined && request.resume === undefined
        ? policy.pinned?.(request.agent, resolvePath(record.summary.cwd, request.cwd ?? "."))
        : undefined
    const named = pinned
      ? { model: pinned.model, ...(pinned.effort !== undefined && { effort: pinned.effort }) }
      : {
          ...(request.model !== undefined && { model: request.model }),
          ...(request.effort !== undefined && { effort: request.effort }),
        }
    // A call that names neither starts a caller's own harness on the caller's model and effort,
    // read off the flags it was launched with. A model its harness no longer offers falls back
    // to the user's defaults, where one asked for would be refused.
    const inherited =
      request.agent !== undefined &&
      request.resume === undefined &&
      !pinned &&
      request.model === undefined &&
      request.effort === undefined &&
      record.summary.agent === request.agent
        ? this.inheritedChoice(request.agent, record.agents[request.agent]?.launch)
        : {}
    const choice =
      request.agent !== undefined && !(await this.unfitChoice(request.agent, inherited))
        ? { ...named, ...inherited }
        : named
    if (request.agent !== undefined) {
      if (policy.refusal) return refused(policy.refusal)
      const barred = policy.refuseAgent?.(
        request.agent,
        resolvePath(record.summary.cwd, request.cwd ?? "."),
      )
      if (barred) return refused(barred)
      const unfit = pinned ? undefined : await this.unfitChoice(request.agent, choice)
      if (unfit) return refused(unfit)
    }
    // Starting an agent is open_agent's: it alone says who leads the agent, and with what task.
    const session = request.command === undefined ? null : sessionLaunch(request.command)
    if (session !== null) return refused(sessionCommandRefusal(session))
    const starts = request.command !== undefined || request.agent !== undefined
    // Every check `send` would refuse the task for, before anything starts.
    if (request.agent !== undefined && request.message !== undefined) {
      const refusal = this.host.messaging().refusal(call.terminalId, request.message, request.agent)
      if (refusal) return refused(refusal)
    }
    // A program of Novadeck's own for the folder it asks for needs no connection of the person's,
    // nor does a session of Nova to resume (`Claims.own`).
    const word =
      request.agent !== undefined && request.resume === undefined
        ? policy.program?.(request.agent, resolvePath(record.summary.cwd, request.cwd ?? "."))
        : undefined
    const ownSession =
      request.agent !== undefined &&
      request.resume !== undefined &&
      this.host
        .claims()
        .own(request.agent, transcriptFor(this.host.rows(), request.agent, request.resume))
    if (
      request.agent !== undefined &&
      word === undefined &&
      !ownSession &&
      !(await this.host.launcher().connected(request.agent))
    )
      return refused(
        `Novadeck isn't connected to ${agentLabel(request.agent)}, so its hooks couldn't ` +
          `${request.message === undefined ? "report its sessions" : "take the task"}; the user ` +
          "can connect it in Novadeck's preferences.",
      )
    // The session a terminal that doesn't exist yet would resume, judged as it would be then.
    const resuming =
      request.agent !== undefined && request.resume !== undefined
        ? this.host
            .claims()
            .check(
              "",
              request.agent,
              request.resume,
              true,
              choice,
              launchFor(this.host.rows(), request.agent, request.resume),
              transcriptFor(this.host.rows(), request.agent, request.resume),
            )
        : undefined
    if (request.agent !== undefined && resuming && !resuming.ok)
      return refused(resumeRefusal(request.agent, resuming.reason, false, resuming.nova === true))
    // A session a sleeping agent rests on is as taken as one running.
    if (request.agent !== undefined && request.resume !== undefined) {
      const holder = this.host.messaging().holder(request.agent, request.resume)
      if (holder !== undefined) return refused(resumeRefusal(request.agent, "in-use", true))
    }
    const { briefOnly, leads } = openedLead(request)
    if (starts && !(await this.host.launcher().startsCommands()))
      return refused(
        "Novadeck's shells can't start a command as they open here, as its shell integration " +
          "isn't loaded, so no terminal opened.",
      )
    const folder = request.cwd ?? "."
    // A resume it names no folder for runs where its session bound, while that is there, as a
    // restore's does (`resumeFolder`); else in the caller's folder.
    const own =
      request.agent !== undefined && request.resume !== undefined && request.cwd === undefined
        ? folderFor(
            [...this.host.rows(), ...this.host.closedRows()],
            request.agent,
            request.resume,
            this.host.worktrees()?.root,
          )
        : undefined
    const at = (path: string) =>
      this.host
        .launcher()
        .directory(path)
        .catch(() => undefined)
    const cwd =
      (own === undefined ? undefined : await at(own)) ??
      (await at(resolvePath(record.summary.cwd, folder)))
    if (cwd === undefined)
      return refused(`${request.cwd ?? record.summary.cwd} isn't a folder a terminal can open in.`)
    // A command is the person's to approve, in every mode: with no one to ask, or one question
    // already waiting from this terminal, nothing is charged or asked.
    const asks = request.command !== undefined
    if (asks) {
      const waiting = this.host.approvals().refusal(call.terminalId)
      if (waiting) return refused(waiting === "nobody" ? nobodyToRun : waitingToRun)
    }
    let started: { command?: string | undefined; prompted: boolean; nonce?: string }
    try {
      started =
        request.agent === undefined
          ? { command: request.command, prompted: true }
          : resuming?.ok
            ? { command: commandLine(resuming.argv), prompted: true }
            : await this.taskCommand(
                request.agent,
                cwd,
                choice,
                request.message !== undefined,
                policy.flags?.(request.agent, cwd),
                word,
              )
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      return refused("The agent's start line holds a character no shell quotes safely.")
    }
    const { command } = started
    // Closed, or the runner stopped, while the folder was looked at.
    if (this.host.stopping() || this.host.records().get(call.terminalId) !== record)
      return unansweredCalls.open
    // Another question may have been asked meanwhile, from here or about this terminal.
    if (asks) {
      const waiting = this.host.approvals().refusal(call.terminalId)
      if (waiting) return refused(waiting === "nobody" ? nobodyToRun : waitingToRun)
    }
    const now = Date.now()
    const charged = this.openers.get(call.terminalId) ?? call.terminalId
    prune(this.opened, now, openLimit.windowMs)
    const times = allowOpen(this.opened.get(charged) ?? [], now, leads ? leadOpenLimit : openLimit)
    const all = allowOpen(this.allOpened, now, runnerOpenLimit)
    if (!times || !all)
      return refused(
        "Agents opened as many terminals as they may in the last minute; try again shortly.",
      )
    this.opened.set(charged, times)
    this.allOpened = all
    if (asks && request.command !== undefined)
      return this.askToRun(record, charged, { cwd, command: request.command, request })
    let task: SendAnswer | undefined
    let adopted = false
    const adopt = (terminalId: string): void => {
      if (adopted) return
      adopted = true
      this.openers.set(terminalId, charged)
      // The opening result names it, so its handle is the caller's to use.
      this.host.peers().introduce(call.terminalId, terminalId)
      const opened = this.host.records().get(terminalId)
      if (opened) {
        // The task goes to the first session of the agent it starts there, from the opener,
        // which leads that terminal: it is the lead's first message. Its first typed entry
        // is the launch line, where a transcript tells its prompts.
        if (request.message !== undefined && started.prompted && started.nonce)
          opened.startedWith = started.nonce
        if (request.message !== undefined) {
          this.host.save(opened)
          // Only a brief-only lead's brief is held as its one marked message: an ordinary
          // lead's later messages carry the mark too.
          // The row the agent's start prompt shows is drawn as this task.
          if (started.prompted && started.nonce)
            this.host
              .messaging()
              .noteStart(opened.summary.id, started.nonce, record.summary.handle, request.message)
          const brief = { to: opened.summary.handle, text: request.message }
          task = briefOnly
            ? this.host.messaging().sendBrief(call.terminalId, brief)
            : this.host.messaging().send(call.terminalId, brief)
        } else if (leads)
          // With no task to say so, the agent is told who leads it.
          this.host
            .messaging()
            .notice(opened.summary.id, leadNotice.openedLed(record.summary.handle), {
              always: true,
            })
        if (briefOnly) this.endLeadAfter(record, opened, task)
      } else if (request.message !== undefined)
        task = { ok: false, reason: "the new terminal closed before the task could be sent." }
    }
    const asked = await this.host.opens().request(
      {
        from: call.terminalId,
        sessionId: record.summary.sessionId,
        cwd,
        ...(command !== undefined && { command }),
        focus: request.focus === true,
      },
      this.openMs,
      // The title it asked for is its own, never the person's: the terminal takes it as
      // the client creates it for this request.
      {
        by: record.summary.id,
        handle: record.summary.handle,
        ...(request.title !== undefined && { title: request.title }),
        ...(command !== undefined && { command }),
        // Led from the start, so a brief carries the lead mark, until it lands if the lead
        // ends with it.
        leads: leads || briefOnly,
        ...(request.agent !== undefined &&
          request.resume !== undefined &&
          resuming?.ok && { resume: { agent: request.agent, session: request.resume } }),
      },
      // Taken up as soon as the runner makes it, before the client confirms it: the agent
      // there may submit its start prompt, which asks for its task, before that.
      adopt,
      until,
    )
    // A client that confirmed a terminal the runner never told of, as a stand-in may.
    if (asked.type === "answered" && "terminalId" in asked.answer) adopt(asked.answer.terminalId)
    const answer = this.opening(asked, cwd, command)
    if (!answer.ok)
      return request.message !== undefined &&
        !adopted &&
        (asked.type === "late" || asked.type === "gone")
        ? refused(`${answer.reason} ${untasked}`)
        : answer
    return {
      ...answer,
      ...(request.agent !== undefined && { led: leads }),
      ...(resuming?.ok && request.resume !== undefined && { resumed: request.resume }),
      ...(task && { task, ...(!started.prompted && { taskWaits: true as const }) }),
    }
  }

  /**
   * Asks the person, through the client that follows `approvals`, to let a terminal start
   * `command` in `cwd`. The call doesn't wait for them, as some harnesses time a tool call out:
   * it answers `asked` at once, the terminal opens only if they confirm, and the caller hears
   * the outcome as a notice.
   */
  private askToRun(
    caller: Record,
    charged: string,
    run: {
      readonly cwd: string
      readonly command: string
      readonly request: {
        readonly title?: string | undefined
        readonly focus?: boolean | undefined
      }
    },
  ): OpenAnswer {
    const { cwd, command, request } = run
    const { id, sessionId, handle } = caller.summary
    const tell = (text: string) => this.host.messaging().notice(id, text, { always: true })
    this.host
      .approvals()
      .request(
        { from: id, terminalId: id, sessionId, action: { type: "run", command, cwd } },
        (outcome) => {
          void (async () => {
            if (this.host.stopping() || this.host.records().get(id) !== caller) return
            if (outcome === "declined") return tell(runNotice.declined(command))
            if (outcome !== "confirmed") return tell(runNotice.gone(command))
            const adopt = (terminalId: string) => {
              this.openers.set(terminalId, charged)
              this.host.peers().introduce(id, terminalId)
            }
            const asked = await this.host.opens().request(
              { from: id, sessionId, cwd, command, focus: request.focus === true },
              this.openMs,
              {
                by: id,
                handle,
                ...(request.title !== undefined && { title: request.title }),
                command,
                leads: false,
              },
              adopt,
            )
            if (this.host.stopping() || this.host.records().get(id) !== caller) return
            if (asked.type === "answered" && "terminalId" in asked.answer)
              adopt(asked.answer.terminalId)
            const answer = this.opening(asked, cwd, command)
            tell(
              answer.ok && "handle" in answer && answer.handle !== undefined
                ? runNotice.opened(answer.handle, command)
                : runNotice.refused(command, answer.ok ? "it did not open." : answer.reason),
            )
          })().catch(() => undefined)
        },
      )
    return { ok: true, asked: true, cwd, command }
  }

  /**
   * A lead that lasts only for its brief: the brief, once sent, ends the lead when it is
   * delivered. One that wasn't sent as the lead's has no delivery to wait for, so the lead
   * ends now.
   */
  private endLeadAfter(lead: Record, led: Record, task: SendAnswer | undefined): void {
    const { id } = led.summary
    if (task?.ok && this.host.messaging().briefOf(id) === task.id)
      this.leads.releaseAfterBrief(id, lead.summary.id, task.id)
    else this.host.bindings().endLead(led)
  }

  /** The model and effort `agent` was launched with, from the kept words its report holds. */
  private inheritedChoice(agent: AgentName, launch: readonly string[] | undefined): Choice {
    return launch === undefined ? {} : (harnesses[agent].launch.chosen?.(launch) ?? {})
  }

  /**
   * Why the model and effort asked for can't start `agent`, in a sentence the agent can
   * act on; undefined when they can, or none was asked for. An effort needs a model, as
   * which efforts a model takes depends on it.
   */
  private async unfitChoice(
    agent: AgentName,
    { model, effort }: { readonly model?: string; readonly effort?: Effort },
  ): Promise<string | undefined> {
    if (model === undefined && effort === undefined) return undefined
    const label = agentLabel(agent)
    if (model === undefined)
      return `Give a model with effort: ${label}'s efforts depend on the model.`
    const models = await this.host.models(agent).catch((): readonly Model[] => [])
    if (models.length === 0)
      return `${label}'s models can't be listed here, so leave the model out and it starts with its own.`
    const found = models.find(({ id }) => id === model)
    if (!found)
      return `${label} has no model "${model}" here: give one of ${list(
        models.map(({ id }) => id),
        "or",
      )}, or leave model out to start on its default.`
    if (effort !== undefined && !found.efforts.includes(effort))
      return found.efforts.length === 0
        ? `${label}'s model "${model}" takes no effort; leave it out.`
        : `${label}'s model "${model}" has no effort "${effort}"; its efforts are ${list(found.efforts)}.`
    return undefined
  }

  /**
   * The command that starts `agent`: with a task, the doorbell's line, with its `nonce`, as
   * its command-line prompt, which it submits once past its startup screens; plain where
   * it may not take one (Antigravity, whose prompt would start a turn before Novadeck's
   * tools load, or behind its trust dialog), when the task arrives once its prompt shows,
   * rung as any message is. Without a task, it just starts at its prompt, with the model
   * and effort chosen. `flags` are the policy's, for this launch only, right after them.
   */
  private async taskCommand(
    agent: AgentName,
    cwd: string,
    choice: { readonly model?: string; readonly effort?: Effort },
    withTask: boolean,
    flags: readonly string[] = [],
    // The word it starts by in place of its harness's own (`OpenPolicy.program`).
    word?: string,
  ): Promise<{ readonly command: string; readonly prompted: boolean; readonly nonce?: string }> {
    const { launch } = harnesses[agent]
    const install = withTask ? await this.host.install(agent).catch(() => undefined) : undefined
    const nonce = freshNonce()
    const prompted = withTask
      ? await launch.initialPrompt(startLine(nonce), { install, cwd }).catch(() => undefined)
      : undefined
    const [program = "", ...rest] = prompted ?? launch.start
    // Right after the program, so before any flag of a prompt's that takes the line.
    const command = commandLine([word ?? program, ...launch.choose(choice), ...flags, ...rest])
    return { command, prompted: prompted !== undefined, ...(withTask && { nonce }) }
  }

  /** What the agent learns of the client's answer. */
  private opening(asked: Asked, cwd: string, command: string | undefined): OpenAnswer {
    if (asked.type !== "answered" && asked.type !== "made") return refused(unopened[asked.type])
    // Made, though the client hasn't confirmed it yet: it opened all the same.
    const made = asked.type === "made" ? asked : asked.answer
    if ("reason" in made) return refused(made.reason)
    const { terminalId } = made
    const opened = this.host.records().get(terminalId)
    if (!opened) return unansweredCalls.open
    return {
      ok: true,
      terminalId,
      handle: opened.summary.handle,
      title: opened.summary.title,
      cwd,
      ...(command !== undefined && { command }),
    }
  }

  /**
   * Closes a terminal of the caller's project and session, as an agent asked through
   * Novadeck's MCP server by the terminal's exact handle: as the person's close does, it
   * ends the shell, then forgets the terminal, whatever window controls it, and messages
   * still waiting for it are gone. The caller's own terminal closes a moment after the
   * answer. A teammate the caller leads, and a terminal that runs no agent, close at
   * once; any other terminal that runs an agent closes only if the person confirms (see
   * `requestClose`). A handle not there is refused with every terminal there described. A
   * chain of terminals' agents close a few at most each minute, and all agents a few
   * more. A call without the shell's own token learns nothing more.
   */
  async closePeer(call: Call): Promise<CloseAnswer> {
    const record = callerOf(this.host.records(), call)
    if (!record) return unansweredCalls.close
    const read = readCloseRequest(call.request)
    if (!read.ok) return read
    const { to } = read.request
    if (to === record.summary.handle) return this.closeSelf(record)
    // Already on its way out, and forgotten, as another close ended its shell.
    if (this.closingHere(record.summary.sessionId, to))
      return refused(`${mention(to)} is already closing.`)
    const target = await this.host.peers().target(peerOf(record), to)
    if (!target.ok) return target
    // A program in the shell's foreground, a line entered whose prompt hasn't come back, or a
    // job in the background: only read for a terminal that runs no agent.
    const closingRecord = this.host.records().get(target.terminalId)
    const busy =
      target.agent === null && closingRecord
        ? await shellBusy(closingRecord, this.host.trees())
        : false
    // Closed, or the runner stopped, while the terminals were described.
    const closing =
      this.host.records().get(target.terminalId) ?? this.host.sleepers().peer(target.terminalId)
    if (this.host.stopping() || this.host.records().get(call.terminalId) !== record || !closing)
      return unansweredCalls.close
    // Already on its way out, as another close ended its shell: nothing more to charge.
    if (this.host.closingNow(closing.summary.id) || ("closed" in closing && closing.closed))
      return refused(`${mention(target.handle)} is already closing.`)
    const leadsIt =
      this.host.messaging().leadOf(target.terminalId)?.terminalId === record.summary.id
    // `openedBy` is null for a terminal the person opened; any other was opened by an agent.
    const way = closeWay({
      leads: leadsIt,
      agent: target.agent,
      busy,
      byPerson: closing.openedBy === null,
      swarm: this.host.agentMode() === "swarm",
    })
    if (way === "request") {
      const waiting = this.host.approvals().refusal(target.terminalId)
      if (waiting)
        return refused(waiting === "nobody" ? nobodyRefusal : waitingRefusal(target.handle))
    }
    const now = Date.now()
    const charged = this.openers.get(call.terminalId) ?? call.terminalId
    prune(this.closed, now, closeLimit.windowMs)
    const times = allowClose(
      this.closed.get(charged) ?? [],
      now,
      leadsIt ? leadCloseLimit : closeLimit,
    )
    const all = allowClose(this.allClosed, now, runnerCloseLimit)
    if (!times || !all) return refused(spentRefusal)
    this.closed.set(charged, times)
    this.allClosed = all
    const { agent } = target
    if (way === "request") return this.requestClose(record, closing, agent)
    const others = this.host.messaging().waitingFor(target.terminalId, call.terminalId)
    const coming = onTheWay(this.host.messaging().onTheWay(target.terminalId, call.terminalId))
    // The runner began to stop meanwhile: the terminal is closed all the same, but the
    // caller is going too.
    if (!(await this.end(closing, record.summary.handle))) return unansweredCalls.close
    const gone = this.host.messaging().goneFrom(call.terminalId)
    return {
      ok: true,
      handle: target.handle,
      title: closing.summary.title,
      ...(agent !== null && { ran: agentLabelOf(agent, closing.summary.nova) }),
      ...(gone.length > 0 && { gone }),
      ...(others > 0 && { others }),
      ...(coming.length > 0 && { coming }),
    }
  }

  /**
   * Closes the terminal, with no answer to its caller if the runner began stopping meanwhile.
   */
  private async end(record: Record | Sleeper, closedBy: string | null): Promise<boolean> {
    await this.host.close(record.summary.id, closedBy)
    return !this.host.stopping()
  }

  /**
   * An agent closing its own terminal: answered first, so its harness has the result, then
   * closed a moment later, unless the runner is stopping or the terminal is already closed
   * or replaced by then. A terminal closes itself once, so no budget is charged.
   */
  private closeSelf(record: Record): CloseAnswer {
    const { id, handle, title } = record.summary
    if (this.host.stopping()) return unansweredCalls.close
    if (record.closed || this.host.closingNow(id) || this.selfClosing.has(id))
      return refused(`${mention(handle)} is already closing.`)
    this.selfClosing.add(id)
    setTimeout(() => {
      this.selfClosing.delete(id)
      if (this.host.stopping() || this.host.records().get(id) !== record) return
      if (record.closed || this.host.closingNow(id)) return
      // Its own agent closing it is no other's doing: the row names nobody.
      void this.end(record, null).catch(() => undefined)
    }, selfCloseMs).unref()
    return { ok: true, self: true, handle, title }
  }

  /**
   * Asks the person, through the client that follows `approvals`, to confirm closing a
   * terminal that runs an agent the caller doesn't lead. The call doesn't wait for them:
   * it answers `asked` at once, and the caller hears the outcome as a notice.
   */
  private requestClose(
    caller: Record,
    closing: Record | Sleeper,
    agent: AgentName | null,
  ): CloseAnswer {
    const { id, handle, title, sessionId } = closing.summary
    const ran = agent === null ? undefined : agentLabelOf(agent, closing.summary.nova)
    this.host
      .approvals()
      .request(
        { from: caller.summary.id, terminalId: id, sessionId, action: { type: "close" } },
        (outcome) => {
          void this.closeRequested(
            caller.summary.id,
            caller.summary.handle,
            closing,
            ran,
            outcome,
          ).catch(() => undefined)
        },
      )
    return { ok: true, asked: true, handle, title, ...(ran !== undefined && { ran }) }
  }

  /** Whether the terminal is still the one that was asked about, and not closed. */
  private present(closing: Record | Sleeper): boolean {
    const { id } = closing.summary
    return "terminal" in closing
      ? this.host.records().get(id) === closing && !closing.closed
      : this.host.records().get(id) === undefined && this.host.sleepers().resting(id) !== undefined
  }

  /** The caller hears how its request to close a terminal went. */
  private async closeRequested(
    callerId: string,
    callerHandle: string,
    closing: Record | Sleeper,
    ran: string | undefined,
    outcome: ApprovalOutcome,
  ): Promise<void> {
    if (this.host.stopping()) return
    const { id, handle, title } = closing.summary
    // An outcome is news the agent has no other way to learn: it is queued all the same.
    const tell = (text: string) => this.host.messaging().notice(callerId, text, { always: true })
    if (outcome === "declined") tell(closeNotice.declined(handle, title))
    else if (outcome === "gone") tell(closeNotice.gone(handle))
    else if (outcome === "withdrawn") tell(closeNotice.vanished(handle))
    // Confirmed: closed as the person's close does, unless it closed meanwhile.
    else if (!this.present(closing) || this.host.closingNow(id)) tell(closeNotice.vanished(handle))
    else {
      // Told before the close, so the notice names what still comes after it.
      const coming = onTheWay(this.host.messaging().onTheWay(id, callerId))
      if (await this.end(closing, callerHandle))
        tell(closeNotice.confirmed(handle, closing.summary.title, ran, coming))
    }
  }

  /** A tool call from Novadeck's MCP server, to the operation it names. */
  call(call: Call): Promise<unknown> {
    switch (call.type) {
      case "show":
        return this.host.companion().show(call)
      case "showing":
        return Promise.resolve(this.host.companion().showing(call))
      case "look":
        return this.host.companion().look(call)
      case "closeShown":
        return this.host.companion().closeShown(call)
      case "open":
        return this.open(call)
      case "close":
        return this.closePeer(call)
      case "lead":
        return this.leads.lead(call)
      case "release":
        return this.leads.release(call)
      case "join":
        return this.teams.join(call)
      case "leave":
        return this.teams.leave(call)
      case "handLead":
        return this.teams.hand(call)
      case "worktrees": {
        // Also whether the Experimental shipping gate is on, which lists `request_permit`.
        const listed = this.worktrees.listed(call)
        return Promise.resolve(
          listed.ok ? { ...listed, gate: this.host.shipping()?.enabled() === true } : listed,
        )
      }
      case "permit": {
        const caller = callerOf(this.host.records(), call)
        const shipping = this.host.shipping()
        if (!caller) return Promise.resolve(unansweredCalls.permit)
        if (!shipping?.enabled())
          return Promise.resolve({
            ok: false,
            reason: "The shipping gate is off, so no shipping command needs a permit.",
          })
        const { action, target, said, folder, remote, repo, auto, admin } = call.request as {
          [key: string]: unknown
        }
        return shipping.declare(call.terminalId, {
          action: typeof action === "string" ? action : "",
          ...(typeof target === "string" && { target }),
          ...(typeof said === "string" && { said }),
          ...(typeof folder === "string" && { folder }),
          ...(typeof remote === "string" && { remote }),
          ...(typeof repo === "string" && { repo }),
          ...(auto === true && { auto }),
          ...(admin === true && { admin }),
        })
      }
      case "mode": {
        const caller = callerOf(this.host.records(), call)
        if (!caller) return Promise.resolve(unansweredCalls.mode)
        // Also whether the shipping gate covers this terminal's harness, which the approval
        // rule in the texts says.
        const agent = caller.summary.agent
        return Promise.resolve({
          ok: true,
          mode: this.host.agentMode(),
          gated: isAgentName(agent) && this.host.shipping()?.covers(agent) === true,
        })
      }
      case "openWorktree":
        return this.worktrees.open(call)
      case "takeWorktree":
        return this.worktrees.take(call)
      case "closeWorktree":
        return this.worktrees.close(call)
      case "giveWorktree":
        return this.worktrees.give(call)
      case "ask":
      case "tell":
      case "done": {
        if (!callerOf(this.host.records(), call)) return Promise.resolve(unansweredCalls[call.type])
        return Promise.resolve(this.host.inbox().call(call.terminalId, call.type, call.request))
      }
      case "feedback":
        if (!callerOf(this.host.records(), call)) return Promise.resolve(unansweredCalls.feedback)
        return Promise.resolve(this.host.feedback().call(call.terminalId, call.request))
      case "send":
        return this.host.send(call)
      case "agents":
        return this.host.agents(call)
      case "team":
        return this.host.team(call)
      case "describe":
        return this.describe(call)
      case "models":
        return this.listModels(call)
    }
  }

  /**
   * The models each harness can start with here, as the tools an agent sees list them.
   * A call without the shell's own token learns nothing more.
   */
  private async listModels(call: Call) {
    if (!callerOf(this.host.records(), call)) return unansweredCalls.models
    const lists = await Promise.all(
      agents.map((agent) => this.host.models(agent).catch((): readonly Model[] => [])),
    )
    return { ok: true, models: Object.fromEntries(agents.map((agent, i) => [agent, lists[i]])) }
  }

  /**
   * Describes the caller's own terminal, as its agent asked through Novadeck's MCP
   * server: a title that names its work, which shows where nothing above it names the
   * terminal (see `titleOf`), and the summary `agents()` lists. The call tells murmur to
   * look at the terminal again, now that its agent said what it works on. A call without
   * the shell's own token learns nothing more.
   */
  async describe(call: Call): Promise<DescribeAnswer> {
    const record = callerOf(this.host.records(), call)
    if (!record) return unansweredCalls.describe
    const read = readDescribeRequest(call.request)
    if (!read.ok) return read
    const title = read.request.title.trim()
    const untitled = titleRefusal(title)
    if (untitled) return refused(untitled)
    const summary = cleanSummary(read.request.summary)
    const refusal = summaryRefusal(summary)
    if (refusal) return refused(refusal)
    // A worktree it titles too goes first: refused, nothing of the description changes.
    const { worktree, worktreeTitle } = read.request
    const titled =
      worktree === undefined || worktreeTitle === undefined
        ? undefined
        : await this.worktrees.retitle(call, worktree, worktreeTitle)
    if (titled && !titled.ok) return titled
    // Drift is measured from where its work is now.
    const facts = await this.host.peers().facts(peerOf(record))
    if (this.host.stopping() || this.host.records().get(call.terminalId) !== record)
      return unansweredCalls.describe
    // A summary murmur already named the terminal from says nothing new to it, as when an
    // agent that summarized before agents gave titles describes only to add its title.
    const unchanged = record.naming.summary === summary && record.naming.murmur !== null
    record.naming = described(record.naming, title, summary)
    const waiting = waitingForOf(read.request.waitingFor, Date.now())
    if (waiting !== undefined) record.waitingFor = waiting ?? undefined
    record.nudges = afterSummary(record.nudges, facts)
    this.host.retitle(record)
    this.host.save(record)
    if (!unchanged) this.host.summarized(record.summary.id)
    return titled
      ? { ok: true, worktree: { branch: titled.branch, title: titled.title } }
      : { ok: true }
  }
}
