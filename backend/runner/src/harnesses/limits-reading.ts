import { spawn } from "node:child_process"
import { tmpdir } from "node:os"

import type { LimitsCover } from "@novadeck/harness-core/events"
import type { Install, LimitsReading } from "@novadeck/harness-core/harness"
import type { AgentName, AgentTelemetry } from "@novadeck/protocol"

import { logs } from "../log.js"
import { cmdPath, killTree } from "../programs.js"
import { harnesses } from "./registry.js"
import { cmdLine, locate } from "./service.js"

type Limits = AgentTelemetry["limits"]

const log = logs.for("harnesses")

// The most of its output read for the answer, so a program that never gives one can't
// fill the runner's memory.
const maxOutput = 1 << 20

/**
 * Asks a harness's program for its windows as `reading` says (`LimitsReading`): run from
 * the system's temporary folder, which is no project's, with `env`, its input written and
 * closed at once, so it answers and ends by itself (Claude Code does, probed 2026-11-13,
 * 2.1.323). Its answer, or null where it gave none: it failed, ended first, or took longer
 * than `timeoutMs`, past which it ends with all it started. Through cmd on Windows for an
 * agent installed as a .cmd file, as its plugin commands are run.
 */
export type Ask = (
  program: string,
  reading: LimitsReading,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  timeoutMs: number,
) => Promise<Limits | null>

// How long a program that answered may take to end by itself before it is ended.
const lingerMs = 5_000

export const askProgram: Ask = (program, reading, env, platform, timeoutMs) =>
  new Promise((resolve) => {
    const script = platform === "win32" && /\.(cmd|bat)$/i.test(program)
    const child = script
      ? spawn(cmdPath(env), ["/d", "/s", "/c", `"${cmdLine([program, ...reading.args])}"`], {
          cwd: tmpdir(),
          env,
          stdio: ["pipe", "pipe", "ignore"],
          windowsVerbatimArguments: true,
          windowsHide: true,
        })
      : spawn(program, reading.args, {
          cwd: tmpdir(),
          env,
          stdio: ["pipe", "pipe", "ignore"],
          // Its own group, so the time limit ends what it started too.
          detached: platform !== "win32",
          windowsHide: true,
        })
    let output = ""
    let settled = false
    let exited = false
    // One that answered and lingers is ended all the same, so none is left behind.
    let linger: NodeJS.Timeout | undefined
    const settle = (limits: Limits | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy()
      if (!exited) {
        linger = setTimeout(() => killTree(child.pid, platform), lingerMs)
        linger.unref()
      }
      resolve(limits)
    }
    const timer = setTimeout(() => {
      killTree(child.pid, platform)
      settle(null)
    }, timeoutMs)
    child.on("error", () => settle(null))
    child.on("close", () => {
      exited = true
      clearTimeout(linger)
      settle(null)
    })
    child.stdin.on("error", () => {})
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      output += chunk
      for (let end = output.indexOf("\n"); end >= 0; end = output.indexOf("\n")) {
        const answer = reading.read(output.slice(0, end))
        output = output.slice(end + 1)
        if (answer !== undefined) return settle(answer)
      }
      if (output.length > maxOutput) settle(null)
    })
    child.stdin.end(reading.input)
  })

// The person's environment with an account's variables: a value set, an undefined one unset.
const environment = (
  base: NodeJS.ProcessEnv,
  account: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv => {
  const env = { ...base }
  for (const [name, value] of Object.entries(account))
    if (value === undefined) delete env[name]
    else env[name] = value
  return env
}

/** What the readings need of the runner. */
export type LimitsHost<R> = {
  /** Where the agent's harness lives, with the person's login environment. */
  readonly install: (agent: AgentName) => Promise<Install | undefined>
  /**
   * Gives a session of the account the reading's windows, which replace those `cover`
   * names, read at `at`; the record is the terminal it was wanted for, which may hold
   * another session by now.
   */
  readonly apply: (
    record: R,
    agent: AgentName,
    limits: Limits,
    cover: LimitsCover,
    at: number,
  ) => void
}

export type LimitsOptions = {
  readonly ask?: Ask
  /** Where the agent's program is, by its absolute path; undefined where it isn't. */
  readonly program?: (agent: AgentName, install: Install) => Promise<string | undefined>
  /** How long after one ask an account is asked again, at least. */
  readonly everyMs?: number
  /** The same, after a turn that ran into a limit, which wants its windows sooner. */
  readonly soonMs?: number
  readonly timeoutMs?: number
  readonly now?: () => number
}

// One account's readings: the terminals whose sessions it serves, when it was last asked,
// whether it is being asked, what it last said, how to ask it again, and an ask a turn that
// ran into a limit wanted sooner than the wait allowed, set for when it does (`soon`), or
// for when the ask under way ends (`again`).
type Account<R> = {
  readonly agent: AgentName
  readonly records: Set<R>
  askedAt: number
  asking: boolean
  latest?: { readonly limits: Limits; readonly at: number }
  ask?: () => Promise<void>
  soon: NodeJS.Timeout | undefined
  again: boolean
}

/**
 * The windows a harness tells only when asked (`Harness.limitsReading`), as Claude Code's
 * model windows: asked once per account however many terminals run it, while its sessions
 * report limits of their own (a subscription's), and at most every `everyMs`, so a busy
 * session asks every few minutes and an idle one, whose status line runs no more, not at
 * all, but for the one ask a turn that ran into a limit sets `soonMs` after the last. A
 * terminal joining an account gets its latest reading at once.
 */
export class LimitsReadings<R> {
  private readonly accounts = new Map<string, Account<R>>()
  // The account each terminal's session is of, by its id in `accounts`, and the transcript
  // it was found from, as one named later may move it to another.
  private readonly of = new Map<R, { readonly id: string; readonly transcript: string | null }>()
  // Each terminal's latest want, so a want answered after the terminal was forgotten, or
  // wanted again, is dropped.
  private readonly wants = new Map<R, number>()
  private wanting = 0
  // When an agent's install was last not found, so a lookup that fails isn't made again
  // with every status line, only after the wait.
  private readonly missing = new Map<AgentName, number>()
  private readonly ask: Ask
  private readonly program: (agent: AgentName, install: Install) => Promise<string | undefined>
  private readonly everyMs: number
  private readonly soonMs: number
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(
    private readonly host: LimitsHost<R>,
    options: LimitsOptions = {},
  ) {
    this.ask = options.ask ?? askProgram
    this.program = options.program ?? ((agent, install) => locate(agent, harnesses[agent], install))
    this.everyMs = options.everyMs ?? 5 * 60_000
    this.soonMs = options.soonMs ?? 60_000
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.now = options.now ?? Date.now
  }

  /**
   * The session `record` holds, of `agent`, whose transcript is `transcript`, reported
   * limits of its own: its account is asked unless it was within `everyMs`. With `soon`, as
   * after a turn that ran into a limit, within `soonMs`, and if it was, it is asked once the
   * wait is over. Nothing for a harness that tells all its windows itself.
   */
  wanted(record: R, agent: AgentName, transcript: string | null, soon = false): void {
    const reading = harnesses[agent].limitsReading
    if (!reading) return
    if (this.now() - (this.missing.get(agent) ?? Number.NEGATIVE_INFINITY) < this.everyMs) return
    // Most reports come well within the wait, and need no lookup.
    const joined = this.of.get(record)
    const held = joined?.transcript === transcript ? this.accounts.get(joined.id) : undefined
    if (held?.agent === agent && !this.due(held, soon)) return
    const want = ++this.wanting
    this.wants.set(record, want)
    void this.host
      .install(agent)
      .then((install) => {
        if (this.wants.get(record) !== want) return
        if (!install) return void this.missing.set(agent, this.now())
        const { key, env } = reading.account(install, transcript ?? undefined)
        const account = this.join(record, agent, `${agent}\n${key}`, transcript)
        const ask = (account.ask = () =>
          this.read(account, reading, install, environment(install.env, env)))
        if (this.due(account, soon)) return ask()
      })
      .catch((error: unknown) => {
        this.missing.set(agent, this.now())
        log.warn("harnesses.limits-failed", `Novadeck could not ask ${agent} for its limits`, {
          data: { agent },
          err: error,
        })
      })
  }

  /** The terminal's session ended, or the terminal closed: its account serves it no more. */
  forget(record: R): void {
    this.wants.delete(record)
    this.leave(record)
  }

  // Whether the account is to be asked now; one not yet, wanted `soon`, is asked once it is.
  private due(account: Account<R>, soon: boolean): boolean {
    const since = this.now() - account.askedAt
    if (!account.asking && since >= (soon ? this.soonMs : this.everyMs)) return true
    if (!soon || account.soon) return false
    if (account.asking) {
      account.again = true
      return false
    }
    this.later(account)
    return false
  }

  // Asks the account again once `soonMs` has passed since its last ask.
  private later(account: Account<R>): void {
    if (account.soon) return
    const wait = Math.max(0, account.askedAt + this.soonMs - this.now())
    account.soon = setTimeout(() => {
      account.soon = undefined
      if (account.records.size > 0) void account.ask?.()
    }, wait)
    account.soon.unref()
  }

  // Puts the terminal in the account `id`, out of any other, and gives it the account's
  // latest reading where it is new there.
  private join(record: R, agent: AgentName, id: string, transcript: string | null): Account<R> {
    const known = this.accounts.get(id)
    const account = known ?? {
      agent,
      records: new Set<R>(),
      askedAt: Number.NEGATIVE_INFINITY,
      asking: false,
      soon: undefined,
      again: false,
    }
    if (!known) this.accounts.set(id, account)
    if (this.of.get(record)?.id === id) {
      this.of.set(record, { id, transcript })
      return account
    }
    this.leave(record)
    this.of.set(record, { id, transcript })
    account.records.add(record)
    const { latest } = account
    const cover = harnesses[agent].limitsReading?.cover
    if (latest && cover) this.host.apply(record, agent, latest.limits, cover, latest.at)
    return account
  }

  private leave(record: R): void {
    const id = this.of.get(record)?.id
    if (id === undefined) return
    this.of.delete(record)
    const account = this.accounts.get(id)
    account?.records.delete(record)
    // An account no terminal holds is forgotten, unless it is being asked, which forgets it then.
    if (account && account.records.size === 0 && !account.asking) this.drop(id, account)
  }

  private drop(id: string, account: Account<R>): void {
    clearTimeout(account.soon)
    if (this.accounts.get(id) === account) this.accounts.delete(id)
  }

  private async read(
    account: Account<R>,
    reading: LimitsReading,
    install: Install,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    account.asking = true
    account.askedAt = this.now()
    try {
      const program = await this.program(account.agent, install)
      const limits = program
        ? await this.ask(program, reading, env, install.platform, this.timeoutMs)
        : null
      if (limits === null) return
      const at = this.now()
      account.latest = { limits, at }
      for (const record of account.records)
        this.host.apply(record, account.agent, limits, reading.cover, at)
    } finally {
      account.asking = false
      if (account.again) {
        account.again = false
        this.later(account)
      }
      if (account.records.size === 0)
        for (const [id, each] of this.accounts) if (each === account) this.drop(id, account)
    }
  }
}
