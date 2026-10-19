import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { PromptShown } from "@novadeck/harness-core/events"
import type { Install } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"
import { foregroundProcess, openFiles, processSetting, type Pty } from "@novadeck/terminal/pty"

import { agents, harnesses } from "../../harnesses/registry.js"
import type { Messaging } from "../../messaging/messaging.js"
import type { Record } from "../record.js"
import type { Typing } from "../typing.js"
import type { Bindings } from "./facts.js"

/** How long after the person's last key an untrusted agent's hooks are asked about again. */
export const trustRecheckMs = 1000

export type ShownHost = {
  readonly messaging: () => Messaging
  readonly bindings: () => Bindings
  readonly typing: () => Typing
  /** Runs a terminal's work in turn with its reports, after those before it; a failure gives `fallback`. */
  readonly queue: <T>(terminalId: string, work: () => Promise<T>, fallback: T) => Promise<T>
  /** Whether `agent` is connected; false without one, or when that cannot be told. */
  readonly connected: (agent: AgentName | undefined) => Promise<boolean>
  /** Where a harness lives on this machine. */
  readonly install: (agent: AgentName) => Promise<Install | undefined>
  /** The environment shells start from. */
  readonly env: () => NodeJS.ProcessEnv
  /** The runner's options: whether Novadeck's hooks run for a harness in a folder, where it was told how to ask. */
  readonly options: () => {
    readonly hooksTrusted:
      | ((agent: AgentName, cwd: string) => Promise<boolean | undefined>)
      | undefined
  }
  /** Whether process `pid` still runs. */
  readonly alive: (pid: string) => boolean
}

/**
 * An agent's own prompt as its harness shows it, before or between the sessions it binds:
 * the terminal's title that tells it, whether Novadeck's hooks run for it there (trust),
 * and what its showing changes. Asked of the harness in the terminal's foreground, in turn
 * with the terminal's reports.
 */
export class Shown {
  constructor(readonly host: ShownHost) {}

  /**
   * The terminal's title changed: a harness that tells by its title that its prompt shows,
   * as Codex through Novadeck's shim, may say so. Anything can set a title, so it counts
   * only while a process of that harness's name runs in the terminal's foreground, in turn
   * with the terminal's reports.
   */
  screenTitled(record: Record, child: Pty, title: string): void {
    // Any newer title, including Working or a shell's, retires a pending prompt check.
    const seq = (record.titles = (record.titles ?? 0) + 1)
    if (record.readyEntered && agents.some((agent) => harnesses[agent].titleWorking?.(title)))
      record.readyTurned = true
    for (const agent of agents) {
      const shown = harnesses[agent].title?.(title, Date.now())
      if (!shown) continue
      const { binding } = record
      const prefix = shown.sessionPrefix
      // Its bound session at its prompt again, as after each turn: nothing to ask.
      if (binding?.agent === agent && prefix !== undefined && binding.sessionId.startsWith(prefix))
        continue
      // As for a report: Windows tells no foreground, so only once a line was entered.
      if (process.platform === "win32" && !record.submitted) continue
      // As it came: the session it may replace, and whether a turn ran, as a spawned
      // agent's thread is made only within one.
      const replaced = binding?.agent === agent ? binding.sessionId : undefined
      const delivery = this.host.messaging().delivery(record.summary.id)
      const turning = delivery?.state === "working"
      // A session bound, a binding ended or a root turn started since makes it stale.
      const epoch = delivery?.epoch
      // Asked before it joins the terminal's queue, so a slow answer from the harness
      // never holds the terminal's reports up.
      // Still the terminal's latest title, from the same process, with no session bound, no
      // binding ended and no root turn started since, nor the shell's prompt back. Only the
      // binding it found, ended since as its process was found gone (by a ring's check or a
      // report while this asked), and nothing after: its prompt shows as from no binding.
      const current = () => {
        if (record.titles !== seq || record.terminal.pty !== child || record.terminal.exiting)
          return false
        const now = this.host.messaging().delivery(record.summary.id)?.epoch
        if (now === epoch) return true
        return (
          binding !== null &&
          epoch !== undefined &&
          now === epoch + 1 &&
          record.left === binding &&
          record.binding === null
        )
      }
      void (async () => {
        // A transient helper failure must not consume the only Ready observation. Ask at
        // most three times, checking the foreground and staleness anew; Unknown never
        // grants readiness or claims that the hooks are untrusted.
        let found: Awaited<ReturnType<Shown["harnessIn"]>> = null
        let trust: Awaited<ReturnType<Shown["promptTrust"]>> = "unknown"
        let pid: number | undefined
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (attempt > 0)
            // eslint-disable-next-line no-await-in-loop -- Bounded recovery of this one prompt observation.
            await sleep(trustRecheckMs, undefined, { ref: false })
          if (!current()) return
          // eslint-disable-next-line no-await-in-loop -- Each retry checks the current foreground.
          found = await this.harnessIn(record, child, agent)
          if (!found || !current()) return
          if (attempt === 0) pid = found.pid
          else if (found.pid !== pid) return
          // eslint-disable-next-line no-await-in-loop -- Unknown is retried only within this bounded observation.
          trust = await this.promptTrust(record, agent, found.where)
          if (!current()) return
          if (trust !== "unknown") break
        }
        if (!found) return
        // The helper (or a preceding queued report) may have waited while the harness
        // exited into a chained command, without any new title, key or shell prompt.
        // Check at the commit too, keeping the same harness process where the OS tells.
        const inForeground = async () => {
          if (!current()) return false
          const now = await foregroundProcess(child.pid, agent)
          return current() && now !== null && now?.pid === pid
        }
        // Hooks its harness says don't run there: no message can reach it, as long as this
        // title still stands. A late answer marks no terminal the agent has left.
        if (trust === "untrusted" && !binding)
          return this.host.queue(
            record.summary.id,
            async () => {
              if ((await inForeground()) && shown.startedAt > (record.promptedAt ?? 0))
                this.host.messaging().untrusted(record.summary.id, agent)
            },
            undefined,
          )
        if (trust !== "counts") return
        // The bound agent left unseen, as its own process is gone: this prompt is another's.
        const exited = binding?.instance ? !this.host.alive(binding.instance) : false
        // Another session's id ends the bound one only once the harness says it started
        // it as a new root; otherwise that session's own hooks tell, at its first prompt.
        if (binding && !exited) {
          if (replaced === undefined || prefix === undefined || turning) return
          const started = await harnesses[agent].startedSession?.(
            found.where,
            prefix,
            shown.startedAt,
            (path) => this.held(found.group, path),
          )
          if (started !== true) return
        }
        await this.host.queue(
          record.summary.id,
          async () => {
            if (!(await inForeground())) return
            // Ended in turn with the reports, so a session bound since is never touched.
            if (exited && record.binding === binding) this.host.bindings().endExited(record)
            this.showPrompt(record, shown, exited ? undefined : replaced)
          },
          undefined,
        )
      })().catch((error: unknown) => console.error("Novadeck could not read a title:", error))
    }
  }

  /**
   * Where the harness runs in the terminal, as its hooks would be asked about there: its
   * own program and the variables its adapter names, where the platform tells them
   * (Linux), else the person's login's, else the shells'; and the processes of the
   * foreground group it runs in (`group`). Null when none of its name holds the
   * foreground, so nothing of it shows there.
   */
  async harnessIn(
    record: Record,
    child: Pty,
    agent: AgentName,
  ): Promise<{
    readonly where: Install & { readonly program?: string }
    readonly group: readonly number[]
    readonly pid: number | undefined
  } | null> {
    const found = await foregroundProcess(child.pid, agent)
    if (found === null || record.terminal.pty !== child) return null
    const install = await this.host.install(agent)
    const own = found ? processSetting(found.pid, harnesses[agent].environment ?? []) : undefined
    const env = { ...this.host.env(), ...install?.env, ...own?.env }
    // Its own program, unless what holds that name is a script, as a wrapper may be.
    const program = own?.program && basename(own.program) === agent ? own.program : undefined
    return {
      where: {
        env,
        home: env.HOME ?? install?.home ?? homedir(),
        platform: process.platform,
        plugin: install?.plugin ?? "",
        ...(program !== undefined && { program }),
      },
      group: found?.group ?? [],
      pid: found?.pid,
    }
  }

  /**
   * Whether one of the processes holds the file open; undefined where the platform
   * doesn't tell, or none of them could be read.
   */
  async held(pids: readonly number[], path: string): Promise<boolean | undefined> {
    const real = await realpath(path).catch(() => path)
    let told = false
    for (const pid of pids) {
      // eslint-disable-next-line no-await-in-loop -- A foreground group holds few processes.
      const files = await openFiles(pid)
      if (!files) continue
      told = true
      if (files.includes(real)) return true
    }
    return told ? false : undefined
  }

  /**
   * Whether a prompt the harness shows counts: it is connected, and Novadeck's hooks run
   * for it there, as `where` (see `harnessIn`) asks it. `untrusted` only when the harness
   * answered that they don't run there, as nothing could deliver to that agent; `unknown`
   * when it couldn't answer, or nothing could ask it.
   */
  async promptTrust(
    record: Record,
    agent: AgentName,
    where?: Install & { readonly program?: string },
  ): Promise<"counts" | "untrusted" | "unknown"> {
    if (!(await this.host.connected(agent))) return "unknown"
    const trusted = await this.hooksTrustedIn(record, agent, where).catch(() => undefined)
    return trusted === true ? "counts" : trusted === false ? "untrusted" : "unknown"
  }

  /** Whether Novadeck's hooks run for the agent in the terminal's folder; undefined unknown. */
  hooksTrustedIn(
    record: Record,
    agent: AgentName,
    where?: Install & { readonly program?: string },
  ): Promise<boolean | undefined> {
    const { cwd } = record.summary
    const options = this.host.options()
    if (options.hooksTrusted) return options.hooksTrusted(agent, cwd)
    const trusted = harnesses[agent].hooksTrusted
    if (!trusted) return Promise.resolve(true)
    return where ? trusted(where, cwd) : Promise.resolve(undefined)
  }

  /**
   * A connected harness's own empty prompt shows, before a session it names in full binds,
   * and Novadeck's hooks run for it there (`promptTrust`; see docs/agent-messaging.md,
   * "States"): messages wait for the session it starts there, and the doorbell may ring
   * it. One the shell's prompt came after is stale: the agent left. With a session of
   * that agent bound, it changes nothing, unless it `replaces` it, as the harness started
   * a new root session (Codex's /clear), which binds only with its first prompt: the bound
   * one's binding ends, the state the new prompt gives staying.
   */
  showPrompt(record: Record, shown: PromptShown, replaced?: string): void {
    const { agent, sessionPrefix } = shown
    if (shown.startedAt <= (record.promptedAt ?? 0)) return
    const { binding } = record
    const id = record.summary.id
    if (!binding) {
      this.host.messaging().shown(id, agent, sessionPrefix ?? null)
      record.readyEntered = false
      this.host.bindings().publishAgent(record, false)
      return
    }
    // Only the session it was shown to replace, still bound: one bound since, as the new
    // session's own first prompt binds it, stays.
    if (replaced === undefined || binding.sessionId !== replaced) return
    if (sessionPrefix !== undefined && binding.sessionId.startsWith(sessionPrefix)) return
    // Judged as the title came, not after what was asked since.
    this.host
      .messaging()
      .shown(id, agent, sessionPrefix ?? null, true, shown.startedAt, shown.firedAt)
    this.host.bindings().endBinding(record, replaced)
    this.host.typing().settleBox(record)
  }

  /**
   * The person may trust the agent's hooks in the agent itself (Codex's `/hooks`), which
   * sets no new title (probed with Codex 0.159.3): once their keys pause, the latest title
   * is read again, asking about the hooks afresh.
   */
  recheckTrust(record: Record): void {
    if (record.recheck) clearTimeout(record.recheck)
    const child = record.terminal.pty
    record.recheck = setTimeout(() => {
      record.recheck = undefined
      const { title } = record
      if (
        title === undefined ||
        record.terminal.pty !== child ||
        record.terminal.exiting ||
        !this.host.messaging().untrustedAgent(record.summary.id)
      )
        return
      this.screenTitled(record, child, title)
    }, trustRecheckMs)
    record.recheck.unref()
  }
}
