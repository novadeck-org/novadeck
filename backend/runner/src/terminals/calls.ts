import { resolve as resolvePath } from "node:path"

import { doorbellLine, quotedLine, type Install } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"
import { freshNonce } from "@novadeck/tui-input"

import { harnesses } from "../harnesses/registry.js"
import type { Asks } from "../messaging/asks.js"
import { agentLabel } from "../messaging/mailbox.js"
import type { AgentsAnswer, Messaging, SendAnswer } from "../messaging/messaging.js"
import { unansweredCalls, type Call } from "../shell/reports.js"
import { callerOf } from "./callers.js"
import {
  allowClose,
  closeLimit,
  readCloseRequest,
  runnerCloseLimit,
  selfRefusal,
  spentRefusal,
  type CloseAnswer,
} from "./closes.js"
import type { Companion } from "./companion.js"
import { mention } from "./handles.js"
import type { Launcher } from "./launching.js"
import { cleanSummary, summarized, summaryRefusal } from "./naming.js"
import { afterSummary } from "./nudges.js"
import {
  allowOpen,
  openLimit,
  prune,
  runnerOpenLimit,
  readOpenRequest,
  refused,
  type Asked,
  type OpenAnswer,
  type OpenRequests,
} from "./opens.js"
import { peerOf, type TerminalPeers } from "./peers.js"
import type { Record } from "./record.js"
import { readSummarizeRequest, type SummarizeAnswer } from "./summarize.js"

// Why a request for a new terminal went unanswered.
const unopened = {
  nobody: "Novadeck isn't open to show a new terminal.",
  // Its window may still open it, so the agent should look before asking again.
  gone: "Novadeck's window went away while opening the terminal; it may still open, so check before asking again.",
  late: "Novadeck didn't confirm the new terminal in time; it may still open, so check before asking again.",
}

export type CallsHost = {
  /** Every terminal the runner holds, by id. */
  readonly records: () => ReadonlyMap<string, Record>
  /** The runner is stopping: no call is answered any more. */
  readonly stopping: () => boolean
  readonly messaging: () => Messaging
  readonly asks: () => Asks
  readonly peers: () => TerminalPeers
  /** Agents' requests for a new terminal, on their way to the client. */
  readonly opens: () => OpenRequests
  readonly companion: () => Companion
  readonly launcher: () => Launcher
  /** Where a harness lives on this machine, which says how it may start with a task. */
  readonly install: (agent: AgentName) => Promise<Install | undefined>
  /** Whether the terminal host is closing the terminal, its shell not yet ended. */
  readonly closingNow: (terminalId: string) => boolean
  // A close, in the manager's steps: `closePeer` checks the runner's stop between them.
  readonly closeForGood: (record: Record) => void
  readonly terminate: (record: Record) => Promise<void>
  readonly remove: (record: Record) => void
  readonly forget: (terminalId: string) => void
  /** Saves what restores the terminal, without its screen. */
  readonly save: (record: Record) => void
  /** Tells murmur the terminal's agent summarized its work. */
  readonly summarized: (terminalId: string) => void
  readonly send: (call: Call) => Promise<SendAnswer>
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

  constructor(
    /** How long an agent's request for a new terminal waits for the client's answer. */
    private readonly openMs: number,
    readonly host: CallsHost,
  ) {}

  /** Which chain the terminal belongs to goes, as it closes or is let go; the chain's times stay. */
  forgetOpener(terminalId: string): void {
    this.openers.delete(terminalId)
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
   * optionally starting a command at its first prompt. The client that lays terminals
   * out opens it (see `requests`), so without one nothing opens. A terminal's agents
   * open a few at most each minute. A call without the shell's own token learns nothing
   * more.
   */
  async open(call: Call): Promise<OpenAnswer> {
    const record = callerOf(this.host.records(), call)
    if (!record) return unansweredCalls.open
    const read = readOpenRequest(call.request)
    if (!read.ok) return read
    const { request } = read
    const starts = request.command !== undefined || request.agent !== undefined
    // Every check `send` would refuse the task for, before anything starts.
    if (request.agent !== undefined && request.message !== undefined) {
      const refusal = this.host.messaging().refusal(call.terminalId, request.message, request.agent)
      if (refusal) return refused(refusal)
    }
    if (request.agent !== undefined && !(await this.host.launcher().connected(request.agent)))
      return refused(
        `Novadeck isn't connected to ${agentLabel(request.agent)}, so its hooks couldn't take ` +
          "the task; the user can connect it in Novadeck's preferences.",
      )
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
    const started: { command?: string | undefined; prompted: boolean; nonce?: string } =
      request.agent === undefined
        ? { command: request.command, prompted: true }
        : await this.taskCommand(request.agent, cwd)
    const { command } = started
    // Closed, or the runner stopped, while the folder was looked at.
    if (this.host.stopping() || this.host.records().get(call.terminalId) !== record)
      return unansweredCalls.open
    const now = Date.now()
    const charged = this.openers.get(call.terminalId) ?? call.terminalId
    prune(this.opened, now, openLimit.windowMs)
    const times = allowOpen(this.opened.get(charged) ?? [], now)
    const all = allowOpen(this.allOpened, now, runnerOpenLimit)
    if (!times || !all)
      return refused(
        "Agents opened as many terminals as they may in the last minute; try again shortly.",
      )
    this.opened.set(charged, times)
    this.allOpened = all
    const asked = await this.host.opens().ask(
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
        // Only an agent opened with a brief is led by the one that opened it.
        withBrief: request.agent !== undefined,
      },
    )
    let task: SendAnswer | undefined
    if (asked.type === "answered" && "terminalId" in asked.answer) {
      this.openers.set(asked.answer.terminalId, charged)
      const opened = this.host.records().get(asked.answer.terminalId)
      // The task goes to the first session of the agent it starts there, from the opener,
      // which leads that terminal: it is the lead's first message.
      if (opened && request.message !== undefined) {
        // Its first typed entry is this line, where a transcript tells its prompts.
        if (started.prompted && started.nonce) opened.startedWith = started.nonce
        this.host.save(opened)
        task = this.host.messaging().send(call.terminalId, {
          to: opened.summary.handle,
          text: request.message,
        })
      }
    }
    const answer = this.opening(asked, cwd, command)
    if (!answer.ok || !task) return answer
    return { ...answer, task, ...(!started.prompted && { taskWaits: true as const }) }
  }

  /**
   * The command that starts `agent` with a task: the doorbell's line, with its `nonce`, as
   * its command-line prompt, which it submits once past its startup screens; plain where
   * it may not take one (Antigravity in a folder it doesn't trust), when the task arrives
   * once the person trusts the folder and its prompt shows, rung as any message is.
   */
  private async taskCommand(
    agent: AgentName,
    cwd: string,
  ): Promise<{ readonly command: string; readonly prompted: boolean; readonly nonce: string }> {
    const { messaging } = harnesses[agent]
    const install = await this.host.install(agent).catch(() => undefined)
    const nonce = freshNonce()
    const prompted = await messaging
      .initialPrompt(doorbellLine(nonce), { install, cwd })
      .catch(() => undefined)
    const argv = prompted ?? messaging.start
    // Every word but the line is a plain word; the line holds nothing a shell expands.
    const command = argv
      .map((word) => (/^[\w./-]+$/.test(word) ? word : quotedLine(word)))
      .join(" ")
    return { command, prompted: prompted !== undefined, nonce }
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
   * Closes another terminal of the caller's project and session, as an agent asked
   * through Novadeck's MCP server by the terminal's exact handle: as the person's close
   * does, it ends the shell, then forgets the terminal, whatever window controls it, and
   * messages still waiting for it are gone. Never the caller's own terminal; a handle
   * not there is refused with every terminal there described. A chain of terminals'
   * agents close a few at most each minute, and all agents a few more. A call without
   * the shell's own token learns nothing more.
   */
  async closePeer(call: Call): Promise<CloseAnswer> {
    const record = callerOf(this.host.records(), call)
    if (!record) return unansweredCalls.close
    const read = readCloseRequest(call.request)
    if (!read.ok) return read
    const { to } = read.request
    if (to === record.summary.handle) return refused(selfRefusal(to))
    // Already on its way out, and forgotten, as another close ended its shell.
    if (this.closingHere(record.summary.sessionId, to))
      return refused(`${mention(to)} is already closing.`)
    const target = await this.host.peers().target(peerOf(record), to)
    if (!target.ok) return target
    // Closed, or the runner stopped, while the terminals were described.
    const closing = this.host.records().get(target.terminalId)
    if (this.host.stopping() || this.host.records().get(call.terminalId) !== record || !closing)
      return unansweredCalls.close
    // Already on its way out, as another close ended its shell: nothing more to charge.
    if (this.host.closingNow(closing.summary.id) || closing.closed)
      return refused(`${mention(target.handle)} is already closing.`)
    const now = Date.now()
    const charged = this.openers.get(call.terminalId) ?? call.terminalId
    prune(this.closed, now, closeLimit.windowMs)
    const times = allowClose(this.closed.get(charged) ?? [], now)
    const all = allowClose(this.allClosed, now, runnerCloseLimit)
    if (!times || !all) return refused(spentRefusal)
    this.closed.set(charged, times)
    this.allClosed = all
    const { agent } = target
    const others = this.host.messaging().waitingFor(target.terminalId, call.terminalId)
    this.host.closeForGood(closing)
    await this.host.terminate(closing)
    // The runner began to stop meanwhile: the terminal is closed all the same, but the
    // caller is going too.
    if (this.host.stopping()) return unansweredCalls.close
    this.host.remove(closing)
    this.host.forget(target.terminalId)
    const gone = this.host.messaging().goneFrom(call.terminalId)
    return {
      ok: true,
      handle: target.handle,
      title: closing.summary.title,
      ...(agent !== null && { ran: agentLabel(agent) }),
      ...(gone.length > 0 && { gone }),
      ...(others > 0 && { others }),
    }
  }

  /** A tool call from Novadeck's MCP server, to the operation it names. */
  call(call: Call): Promise<unknown> {
    switch (call.type) {
      case "present":
        return this.host.companion().present(call)
      case "showing":
        return Promise.resolve(this.host.companion().showing(call))
      case "dismiss":
        return this.host.companion().dismiss(call)
      case "open":
        return this.open(call)
      case "close":
        return this.closePeer(call)
      case "ask":
      case "tell":
      case "done": {
        if (!callerOf(this.host.records(), call)) return Promise.resolve(unansweredCalls[call.type])
        return Promise.resolve(this.host.asks().call(call.terminalId, call.type, call.request))
      }
      case "send":
        return this.host.send(call)
      case "agents":
        return this.host.agents(call)
      case "summarize":
        return this.summarize(call)
    }
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
