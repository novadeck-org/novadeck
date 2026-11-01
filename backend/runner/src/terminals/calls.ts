import { resolve as resolvePath } from "node:path"

import type { Effort, Install, Model } from "@novadeck/harness-core/harness"
import { doorbellLine, quotedLine } from "@novadeck/harness-core/prompts"
import type { AgentName, GrantRepoChoice } from "@novadeck/protocol"
import type { Trees } from "@novadeck/terminal/pty"
import { freshNonce } from "@novadeck/tui-input"

import { agents, harnesses } from "../harnesses/registry.js"
import type { Feedback } from "../messaging/feedback.js"
import { proposalOf, readProposal } from "../messaging/grant-proposals.js"
import type { Inbox } from "../messaging/inbox.js"
import { agentLabel } from "../messaging/messages.js"
import type { AgentsAnswer, SendAnswer, TeamAnswer } from "../messaging/sending.js"
import { unansweredCalls, type Call } from "../shell/reports.js"
import { list } from "../text.js"
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
import { peerOf } from "./peers-host.js"
import type { Record } from "./record.js"
import { resumeRefusal, type Claims } from "./resumes.js"
import { nobodyToRun, runNotice, waitingToRun } from "./runs.js"
import { shellBusy } from "./sampling.js"
import { readSummarizeRequest, type SummarizeAnswer } from "./summarize-request.js"
import { cleanSummary, summarized, summaryRefusal } from "./titles.js"

// Characters that reorder how text is drawn, which a command shown for approval must not hold.
const bidiControl = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/

// A command line for the words: every word but a quoted line is a plain word, and a line
// holds nothing a shell expands.
const commandLine = (argv: readonly string[]): string =>
  argv.map((word) => (/^[\w./-]+$/.test(word) ? word : quotedLine(word))).join(" ")

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

// `LeadsHost` holds the runner's records and stop, its messaging, peers, approvals,
// bindings, and whether a terminal is closing.
export type CallsHost = LeadsHost & {
  readonly inbox: () => Inbox
  /** The git repos a Grant card offers for a Novadeck session's project (`Approving.repos`). */
  readonly grantFacts: (
    sessionId: string,
    repos: boolean,
  ) => Promise<{ readonly repos: readonly GrantRepoChoice[]; readonly agyOutdated: boolean }>
  readonly feedback: () => Feedback
  /** Agents' requests for a new terminal, on their way to the client. */
  readonly opens: () => OpenRequests
  readonly companion: () => Companion
  readonly launcher: () => Launcher
  /** Windows' process trees, which tell whether a shell has a job under it. */
  readonly trees: () => Pick<Trees, "read">
  /** The sessions given out to resume, one to a terminal. */
  readonly claims: () => Claims
  /** Where a harness lives on this machine, which says how it may start with a task. */
  readonly install: (agent: AgentName) => Promise<Install | undefined>
  /** The models a harness can start with here, none where that can't be told. */
  readonly models: (agent: AgentName) => Promise<readonly Model[]>
  // A close, in the manager's steps: `closePeer` checks the runner's stop between them.
  readonly closeForGood: (record: Record) => void
  readonly terminate: (record: Record) => Promise<void>
  readonly remove: (record: Record) => void
  readonly forget: (terminalId: string) => void
  /** Saves what restores the terminal, without its screen. */
  readonly save: (record: Record) => void
  /** Tells murmur the terminal's agent summarized its work. */
  readonly summarized: (terminalId: string) => void
  readonly send: (call: Call) => Promise<SendAnswer | TeamAnswer>
  readonly agents: (call: Call) => Promise<AgentsAnswer>
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

  constructor(
    /** How long an agent's request for a new terminal waits for the client's answer. */
    private readonly openMs: number,
    readonly host: CallsHost,
  ) {
    this.leads = new Leads(host)
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
    const record = callerOf(this.host.records(), call)
    if (!record) return unansweredCalls.open
    const read = readOpenRequest(call.request)
    if (!read.ok) return read
    const { request } = read
    const choice = {
      ...(request.model !== undefined && { model: request.model }),
      ...(request.effort !== undefined && { effort: request.effort }),
    }
    if (request.agent !== undefined) {
      const unfit = await this.unfitChoice(request.agent, choice)
      if (unfit) return refused(unfit)
    }
    // Starting an agent is open_agent's: it alone says who leads the agent, and with what task.
    const session = request.command === undefined ? null : sessionLaunch(request.command)
    if (session !== null) return refused(sessionCommandRefusal(session))
    // What the person is asked to approve must read as it runs: no direction controls.
    if (request.command !== undefined && bidiControl.test(request.command))
      return refused("The command holds text-direction control characters, which aren't run.")
    const starts = request.command !== undefined || request.agent !== undefined
    // Every check `send` would refuse the task for, before anything starts.
    if (request.agent !== undefined && request.message !== undefined) {
      const refusal = this.host.messaging().refusal(call.terminalId, request.message, request.agent)
      if (refusal) return refused(refusal)
    }
    if (request.agent !== undefined && !(await this.host.launcher().connected(request.agent)))
      return refused(
        `Novadeck isn't connected to ${agentLabel(request.agent)}, so its hooks couldn't ` +
          `${request.message === undefined ? "report its sessions" : "take the task"}; the user ` +
          "can connect it in Novadeck's preferences.",
      )
    // The session a terminal that doesn't exist yet would resume, judged as it would be then.
    const resuming =
      request.agent !== undefined && request.resume !== undefined
        ? this.host.claims().check("", request.agent, request.resume, true, choice)
        : undefined
    if (request.agent !== undefined && resuming && !resuming.ok)
      return refused(resumeRefusal(request.agent, resuming.reason))
    const { briefOnly, leads } = openedLead(request)
    if (starts && !(await this.host.launcher().startsCommands()))
      return refused(
        "Novadeck's shells can't start a command as they open here, as its shell integration " +
          "isn't loaded, so no terminal opened.",
      )
    const folder = request.cwd ?? "."
    const cwd = await this.host
      .launcher()
      .directory(resolvePath(record.summary.cwd, folder))
      .catch(() => undefined)
    if (cwd === undefined) return refused(`${folder} isn't a folder a terminal can open in.`)
    // A command is the person's to approve: with no one to ask, or one question already
    // waiting from this terminal, nothing is charged or asked.
    if (request.command !== undefined) {
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
            : await this.taskCommand(request.agent, cwd, choice, request.message !== undefined)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      return refused("The agent's start line holds a character no shell quotes safely.")
    }
    const { command } = started
    // Closed, or the runner stopped, while the folder was looked at.
    if (this.host.stopping() || this.host.records().get(call.terminalId) !== record)
      return unansweredCalls.open
    // Another question may have been asked meanwhile, from here or about this terminal.
    if (request.command !== undefined) {
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
    if (request.command !== undefined)
      return this.askToRun(record, charged, { cwd, command: request.command, request })
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
        by: record.summary.handle,
        ...(request.title !== undefined && { title: request.title }),
        ...(command !== undefined && { command }),
        // Led from the start, so a brief carries the lead mark, until it lands if the lead
        // ends with it.
        leads: leads || briefOnly,
        ...(request.agent !== undefined &&
          request.resume !== undefined &&
          resuming?.ok && { resume: { agent: request.agent, session: request.resume } }),
      },
    )
    let task: SendAnswer | undefined
    if (asked.type === "answered" && "terminalId" in asked.answer) {
      this.openers.set(asked.answer.terminalId, charged)
      const opened = this.host.records().get(asked.answer.terminalId)
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
    const answer = this.opening(asked, cwd, command)
    if (!answer.ok) return answer
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
            const asked = await this.host
              .opens()
              .request(
                { from: id, sessionId, cwd, command, focus: request.focus === true },
                this.openMs,
                {
                  by: handle,
                  ...(request.title !== undefined && { title: request.title }),
                  command,
                  leads: false,
                },
              )
            if (this.host.stopping() || this.host.records().get(id) !== caller) return
            if (asked.type === "answered" && "terminalId" in asked.answer)
              this.openers.set(asked.answer.terminalId, charged)
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
      this.leads.releaseAfterBrief(id, lead.summary.handle, task.id)
    else this.host.bindings().endLead(led, true, "released")
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
   * it may not take one (Antigravity in a folder it doesn't trust), when the task arrives
   * once the person trusts the folder and its prompt shows, rung as any message is. Without
   * a task, it just starts at its prompt, with the model and effort chosen.
   */
  private async taskCommand(
    agent: AgentName,
    cwd: string,
    choice: { readonly model?: string; readonly effort?: Effort },
    withTask: boolean,
  ): Promise<{ readonly command: string; readonly prompted: boolean; readonly nonce?: string }> {
    const { launch } = harnesses[agent]
    const install = withTask ? await this.host.install(agent).catch(() => undefined) : undefined
    const nonce = freshNonce()
    const prompted = withTask
      ? await launch.initialPrompt(doorbellLine(nonce), { install, cwd }).catch(() => undefined)
      : undefined
    const [program = "", ...rest] = prompted ?? launch.start
    // Right after the program, so before a flag like Antigravity's `-i` that takes the line.
    const command = commandLine([program, ...launch.choose(choice), ...rest])
    return { command, prompted: prompted !== undefined, ...(withTask && { nonce }) }
  }

  /** What the agent learns of the client's answer. */
  private opening(asked: Asked, cwd: string, command: string | undefined): OpenAnswer {
    if (asked.type !== "answered") return refused(unopened[asked.type])
    const { answer } = asked
    if ("reason" in answer) return refused(answer.reason)
    const opened = this.host.records().get(answer.terminalId)
    if (!opened) return unansweredCalls.open
    return {
      ok: true,
      terminalId: answer.terminalId,
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
    const closing = this.host.records().get(target.terminalId)
    if (this.host.stopping() || this.host.records().get(call.terminalId) !== record || !closing)
      return unansweredCalls.close
    // Already on its way out, as another close ended its shell: nothing more to charge.
    if (this.host.closingNow(closing.summary.id) || closing.closed)
      return refused(`${mention(target.handle)} is already closing.`)
    const leadsIt = this.host.messaging().leadOf(target.terminalId) === record.summary.handle
    const way = closeWay({ leads: leadsIt, agent: target.agent, busy })
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
    if (!(await this.end(closing))) return unansweredCalls.close
    const gone = this.host.messaging().goneFrom(call.terminalId)
    return {
      ok: true,
      handle: target.handle,
      title: closing.summary.title,
      ...(agent !== null && { ran: agentLabel(agent) }),
      ...(gone.length > 0 && { gone }),
      ...(others > 0 && { others }),
      ...(coming.length > 0 && { coming }),
    }
  }

  /**
   * The close steps the person's close takes: the shell ends, then the terminal is
   * forgotten. False when the runner began to stop meanwhile, the terminal closed all the same.
   */
  private async end(record: Record): Promise<boolean> {
    this.host.closeForGood(record)
    await this.host.terminate(record)
    if (this.host.stopping()) return false
    this.host.remove(record)
    this.host.forget(record.summary.id)
    return true
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
      void this.end(record).catch(() => undefined)
    }, selfCloseMs).unref()
    return { ok: true, self: true, handle, title }
  }

  /**
   * Asks the person, through the client that follows `approvals`, to confirm closing a
   * terminal that runs an agent the caller doesn't lead. The call doesn't wait for them:
   * it answers `asked` at once, and the caller hears the outcome as a notice.
   */
  private requestClose(caller: Record, closing: Record, agent: AgentName | null): CloseAnswer {
    const { id, handle, title, sessionId } = closing.summary
    const ran = agent === null ? undefined : agentLabel(agent)
    this.host
      .approvals()
      .request(
        { from: caller.summary.id, terminalId: id, sessionId, action: { type: "close" } },
        (outcome) => {
          void this.closeRequested(caller.summary.id, closing, ran, outcome).catch(() => undefined)
        },
      )
    return { ok: true, asked: true, handle, title, ...(ran !== undefined && { ran }) }
  }

  /** The caller hears how its request to close a terminal went. */
  private async closeRequested(
    callerId: string,
    closing: Record,
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
    else if (this.host.records().get(id) !== closing || closing.closed || this.host.closingNow(id))
      tell(closeNotice.vanished(handle))
    else {
      // Told before the close, so the notice names what still comes after it.
      const coming = onTheWay(this.host.messaging().onTheWay(id, callerId))
      if (await this.end(closing))
        tell(closeNotice.confirmed(handle, closing.summary.title, ran, coming))
    }
  }

  /**
   * A lead's proposal of a team grant, as `propose_grant` makes it: put in the person's
   * Inbox as a Grant card the runner fills itself (the repos it read, who it covers now),
   * never from the agent's text. Refused for a terminal that has a lead of its own and
   * leads nobody (a teammate's proposal would grant its peers), for a command the matcher
   * would refuse, and past the limits (one waiting, three an hour).
   */
  async proposeGrant(call: Call): Promise<unknown> {
    const record = callerOf(this.host.records(), call)
    if (!record) return unansweredCalls.proposeGrant
    const { messaging, inbox } = { messaging: this.host.messaging(), inbox: this.host.inbox() }
    const terminalId = record.summary.id
    const read = readProposal(call.request)
    if (!read.ok) return { ok: false, reason: read.reason }
    const team = messaging.grants.teamOf(terminalId)
    if (messaging.grants.isLed(terminalId) && team.length === 0)
      return {
        ok: false,
        reason:
          "Only an agent that leads others can propose a grant for its team. Ask the user with the ask tool (the approval shape) for yourself.",
      }
    const limit = inbox.proposalLimit(terminalId)
    if (limit) return { ok: false, reason: limit }
    const facts = await this.host.grantFacts(record.summary.sessionId, read.presets.length > 0)
    if (this.host.stopping()) return unansweredCalls.proposeGrant
    // The team may have changed while the repos were read.
    return inbox.propose(
      terminalId,
      proposalOf(read, facts.repos, messaging.grants.teamOf(terminalId), facts.agyOutdated),
    )
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
      case "ask":
      case "tell":
      case "done": {
        if (!callerOf(this.host.records(), call)) return Promise.resolve(unansweredCalls[call.type])
        const answer = this.host.inbox().call(call.terminalId, call.type, call.request)
        // Done only narrows: this terminal's grants stop covering it, for good, whether or not
        // the Inbox kept the report.
        if (call.type === "done") this.host.messaging().grants.coverageEnds(call.terminalId, "done")
        return Promise.resolve(answer)
      }
      case "proposeGrant":
        return this.proposeGrant(call)
      case "feedback":
        if (!callerOf(this.host.records(), call)) return Promise.resolve(unansweredCalls.feedback)
        return Promise.resolve(this.host.feedback().call(call.terminalId, call.request))
      case "send":
        return this.host.send(call)
      case "agents":
        return this.host.agents(call)
      case "summarize":
        return this.summarize(call)
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
   * Summarizes the caller's own terminal, as its agent asked through Novadeck's MCP
   * server: the summary of its work `agents()` lists. It names nothing: titles are the
   * person's, murmur's and the opener's, so an agent has no way to set one. The call
   * tells murmur to look at the terminal again, now that its agent said what it works on.
   * A call without the shell's own token learns nothing more.
   */
  async summarize(call: Call): Promise<SummarizeAnswer> {
    const record = callerOf(this.host.records(), call)
    if (!record) return unansweredCalls.summarize
    const read = readSummarizeRequest(call.request)
    if (!read.ok) return read
    const summary = cleanSummary(read.request.summary)
    const refusal = summaryRefusal(summary)
    if (refusal) return refused(refusal)
    // Drift is measured from where its work is now.
    const facts = await this.host.peers().facts(peerOf(record))
    if (this.host.stopping() || this.host.records().get(call.terminalId) !== record)
      return unansweredCalls.summarize
    record.naming = summarized(record.naming, summary)
    record.nudges = afterSummary(record.nudges, facts)
    this.host.save(record)
    this.host.summarized(record.summary.id)
    return { ok: true }
  }
}
