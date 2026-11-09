import {
  processesUnder,
  startResolutionMs,
  type ProcessTrees,
  type Spawn,
} from "@novadeck/terminal/pty"
import { isEmpty, type BoxProfile } from "@novadeck/tui-input/box"

import { agentProcess } from "./ending.js"
import type { Record } from "./record.js"

/** How often, while an Enter's find window is open, the shell's processes are looked at. */
export const lookEveryMs = 500

/** How long after its anchor (the Enter, or the end of the turn it waited out) an attempt looks. */
export const findMs = 5_000

/**
 * How long a process must have been seen live, between two looks, before it counts: a
 * helper that passes through never shows. A second apart, less what timers' jitter takes.
 */
export const confirmMs = 900

/** How often a command shown running is looked at again, in milliseconds. */
export const pollMs = 1_000

/** How long polls that could not tell, one after another, take before they hide the command shown: no evidence, no busy. */
export const unknownMs = 5_000

/** How many turn ends re-arm an unconfirmed attempt (a continued Stop makes two): then it is dropped. */
export const rearmMax = 2

/** How long after an Enter mid-turn a command that the harness runs at once (Codex) starts, in ms. */
export const midTurnMs = 2_000

/** What the shell commands read of a terminal's record, and the summary field they keep there. */
export type ShellRecord = Pick<Record, "summary" | "terminal" | "hibernating" | "closed" | "bound">

export type ShellCommandsHost<R extends ShellRecord> = {
  /** The harness box of the agent in the record's terminal, if it runs one. */
  readonly profile: (record: R) => BoxProfile | undefined
  /** Reports the record's summary to every watcher. */
  readonly announce: (record: R) => void
  /** The relay's trees, which Windows reads the processes under a shell from. */
  readonly trees: () => Pick<ProcessTrees, "read">
  /** Tests: the live processes under `pid`, or undefined where the system can't tell. */
  readonly under?: (pid: number) => Promise<readonly Spawn[] | undefined>
  /** Tests: how coarse a process's start time is here, in milliseconds. */
  readonly resolutionMs?: () => number
  readonly stopping: () => boolean
}

/** The start times a process may have to be an attempt's command: `from` on, until `to` if it ends. */
type Interval = { readonly from: number; to?: number }

/** A shell-mode Enter, with what its looks learned: each keeps its own. */
type Attempt = {
  readonly command: string
  readonly at: number
  /** Whether its harness runs a command at once while a turn works (Codex), not after it. */
  readonly runs: boolean
  /** When a process of the command may have started (a platform's resolution counted). */
  intervals: Interval[]
  /** Whether a turn started while it was unconfirmed, so a queued command may run after it. */
  cut: boolean
  /** Whether it found its process: its intervals are closed then, and later turns change nothing. */
  confirmed: boolean
  /** How many turn ends re-armed it: past `rearmMax` it is dropped. */
  rearms: number
  /** Whether its window passed during a turn: it looks no more until that turn ends. */
  waiting: boolean
  /** When its find window closes. */
  deadline: number
  /** When each candidate was first seen live, by `Spawn.key`; only those still listed stay. */
  seen: Map<string, number>
}

type Watch = {
  readonly run: number
  readonly pid: number
  /** The processes the command started, top-level, by `Spawn.key`. */
  readonly held: Set<string>
  /** The Enters whose find window is open. */
  attempts: Attempt[]
  /** The one timer of their looks. */
  look: NodeJS.Timeout | undefined
  /** Whether a look is under way: one at a time, so a staler snapshot never resets `seen`. */
  looking: boolean
  /** Whether a poll of it is under way. */
  pollBusy: boolean
  /** Whether the shared tick polls it: a command is shown. */
  polling: boolean
  /** When the polls that could not tell began, until one could. */
  unknownSince: number | undefined
  /** How many looks and polls are awaiting the system: none may be left behind by a settle. */
  inflight: number
  /** The latest Enter that came while a turn worked (a harness that queues it, or runs it), until that turn ends. */
  pending: { readonly command: string; readonly at: number; readonly runs: boolean } | undefined
}

// Novadeck's own helpers, which an agent's status line or hooks start beside a command: the
// relay and the hook's launcher (its posix fallback keeps its comm `hook`), and what they
// run, as a status line's own command.
const helpers = new Set(["novadeck-relay", "hook"])
const bare = (spawn: Spawn): string => (spawn.name ?? "").toLowerCase().replace(/\.exe$/, "")
const helper = (spawn: Spawn): boolean => helpers.has(bare(spawn))

// The wrappers a status line runs its helper under: only these count as part of it.
const shells = new Set(["sh", "bash", "dash", "zsh", "fish", "cmd", "powershell", "pwsh"])

/**
 * The commands a person runs in an agent's own shell mode (`!sleep 15`), which fire no hook:
 * the terminal shows one as running while a process it started lives (`shellCommand`),
 * and none of it is a turn.
 *
 * An Enter that reaches an agent's terminal while its box (read as it stood before the
 * Enter) is in shell mode and holds a command opens a window of five seconds in which the
 * shell's processes are looked at every half second. The processes started since the Enter
 * (and, where a turn came between, since its end, for a harness that queues the command),
 * less Novadeck's helpers, what they run and
 * the shells they run under, and with the bound agent as the parent of each top one, are
 * the command, once seen live a second apart. Once one is found it is looked at every
 * second, and shown until none is left, or the system could not tell for about five seconds.
 */
export class ShellCommands<R extends ShellRecord> {
  private readonly watches = new Map<R, Watch>()
  /** The one tick that polls every watch with a command shown, so their listings are one. */
  private ticker: NodeJS.Timeout | undefined

  constructor(private readonly host: ShellCommandsHost<R>) {}

  // A look that fails is one that can't tell.
  private async under(pid: number): Promise<readonly Spawn[] | undefined> {
    try {
      return await (
        this.host.under ?? ((root) => processesUnder(root, { trees: this.host.trees() }))
      )(pid)
    } catch {
      return undefined
    }
  }

  /** The records with a look or a poll pending; none for terminals that run nothing. */
  get watching(): number {
    return this.watches.size
  }

  /** The keys reached the record's terminal: one that is Enter in a shell-mode box starts a command. */
  entered(record: R): void {
    if (this.host.stopping() || record.terminal.exit !== null || record.hibernating) return
    const profile = this.host.profile(record)
    if (!profile) return
    const at = Date.now()
    const { terminal } = record
    const run = terminal.run
    const pid = terminal.pty.pid
    if (pid === undefined) return
    // Queued now, before the Enter is written: it reads the box as it stood before the
    // Enter's effect is drawn, behind the draws already queued.
    terminal.readScreen().then(
      (screen) => {
        const box = profile.read(screen)
        if (box?.mode !== "shell" || isEmpty(box) || profile.overlay(screen)) return
        const command = box.text.trim().slice(0, 4096)
        if (command === "") return
        const entry = { command, at, runs: profile.shell.midTurn === "runs" }
        // Mid-turn the harness queues the command until the turn ends (Claude Code,
        // Antigravity) or runs it at once (Codex), and the turn's own tools start processes
        // too: it is looked for once the turn has ended (`changed`).
        if (record.summary.activity?.state === "working") this.hold(record, run, pid, entry)
        else
          this.begin(record, run, pid, this.attempt(entry, [{ from: at - this.resolution() }], at))
      },
      () => undefined,
    )
  }

  /** Ends what is shown and watched for the record (its agent left, or it restarted). */
  end(record: R, announce = true): void {
    const watch = this.watches.get(record)
    if (watch) this.drop(record, watch)
    this.hide(record, announce)
  }

  private hide(record: R, announce: boolean): void {
    if (record.summary.shellCommand == null) return
    record.summary = { ...record.summary, shellCommand: null }
    if (announce) this.host.announce(record)
  }

  /** Stops every look and poll: the runner is shutting down. */
  stop(): void {
    for (const [record, watch] of this.watches) this.drop(record, watch)
    this.disarm()
  }

  private resolution(): number {
    return this.host.resolutionMs?.() ?? startResolutionMs()
  }

  private attempt(
    entry: { readonly command: string; readonly at: number; readonly runs: boolean },
    intervals: Interval[],
    anchor: number,
  ): Attempt {
    return {
      ...entry,
      intervals,
      cut: false,
      confirmed: false,
      rearms: 0,
      waiting: false,
      deadline: anchor + findMs,
      seen: new Map(),
    }
  }

  /**
   * The record's activity changed. A turn that started closes the open start interval of
   * each attempt still unconfirmed, at its start less the platform's resolution (a start
   * time may read that much early, so what a turn's tools started is left out rather than
   * taken for the command: no busy on no evidence), and it waits out the turn. A turn that
   * ended opens a new interval for a command its harness queued, from its end, and a find
   * window of its own; a command run at once (Codex) is in the first interval. A held Enter's
   * attempt begins at that end.
   */
  changed(record: R): void {
    const watch = this.watches.get(record)
    if (!watch) return
    const now = Date.now()
    const res = this.resolution()
    if (record.summary.activity?.state === "working") {
      for (const attempt of watch.attempts) {
        // Confirmed or not: what a turn starts is none of its command.
        for (const interval of attempt.intervals) interval.to ??= now
        if (!attempt.confirmed) attempt.cut = true
      }
      return
    }
    watch.attempts = watch.attempts.filter((attempt) => {
      if (attempt.confirmed || !attempt.cut) return true
      // Chained turns around a command that never runs (Esc on a queued one): give up.
      if (attempt.rearms >= rearmMax) return false
      attempt.rearms += 1
      attempt.cut = false
      attempt.waiting = false
      attempt.deadline = now + findMs
      if (!attempt.runs) attempt.intervals.push({ from: now - res })
      return true
    })
    const { pending } = watch
    if (pending) {
      watch.pending = undefined
      // At once (Codex): what started in the first moments after its Enter; queued: since the end.
      const intervals = pending.runs
        ? [{ from: pending.at - res, to: pending.at + midTurnMs }]
        : [{ from: now - res }]
      watch.attempts.push(this.attempt(pending, intervals, now))
    }
    this.looking(record, watch)
  }

  private watchOf(record: R, run: number, pid: number): Watch | undefined {
    if (!this.current(record, run, pid)) return undefined
    let watch = this.watches.get(record)
    if (watch && (watch.run !== run || watch.pid !== pid)) {
      this.end(record, false)
      watch = undefined
    }
    if (!watch) {
      watch = {
        run,
        pid,
        held: new Set(),
        attempts: [],
        look: undefined,
        looking: false,
        polling: false,
        pollBusy: false,
        unknownSince: undefined,
        inflight: 0,
        pending: undefined,
      }
      this.watches.set(record, watch)
    }
    return watch
  }

  private hold(record: R, run: number, pid: number, entry: NonNullable<Watch["pending"]>): void {
    const watch = this.watchOf(record, run, pid)
    if (watch) watch.pending = entry
  }

  private begin(record: R, run: number, pid: number, attempt: Attempt): void {
    const watch = this.watchOf(record, run, pid)
    if (!watch) return
    watch.attempts.push(attempt)
    this.looking(record, watch)
  }

  /** Arms the watch's one look timer, if an attempt's window is open and none is. */
  private looking(record: R, watch: Watch): void {
    if (
      watch.look !== undefined ||
      watch.looking ||
      !watch.attempts.some(({ waiting }) => !waiting)
    )
      return
    watch.look = setTimeout(() => {
      watch.look = undefined
      watch.looking = true
      this.run(record, watch, () => this.look(record, watch))
    }, lookEveryMs)
    watch.look.unref()
  }

  /** Whether the record is the same running shell, and not on its way out. */
  private current(record: R, run: number, pid: number): boolean {
    const { terminal } = record
    return (
      !this.host.stopping() &&
      !record.closed &&
      !record.hibernating &&
      !terminal.exiting &&
      terminal.exit === null &&
      terminal.run === run &&
      terminal.pty.pid === pid
    )
  }

  private alive(record: R, watch: Watch): boolean {
    return this.watches.get(record) === watch && this.current(record, watch.run, watch.pid)
  }

  /** Runs a look or poll, counted until it ends, then settles the watch. */
  private run(record: R, watch: Watch, work: () => Promise<void>): void {
    watch.inflight += 1
    void work()
      .catch(() => undefined)
      .finally(() => {
        watch.inflight -= 1
        this.settle(record, watch)
      })
  }

  /** Lets go of a watch no look or poll of which is left. */
  private settle(record: R, watch: Watch): void {
    if (this.watches.get(record) !== watch) return
    if (!this.alive(record, watch)) this.end(record)
    else if (
      watch.inflight === 0 &&
      watch.look === undefined &&
      !watch.polling &&
      watch.attempts.length === 0 &&
      !watch.pending
    ) {
      // Nothing left to see it end: a command still shown would never clear.
      this.end(record)
    }
  }

  private drop(record: R, watch: Watch): void {
    if (watch.look) clearTimeout(watch.look)
    watch.look = undefined
    watch.polling = false
    if (this.watches.get(record) === watch) this.watches.delete(record)
    if (![...this.watches.values()].some(({ polling }) => polling)) this.disarm()
  }

  private disarm(): void {
    if (this.ticker) clearTimeout(this.ticker)
    this.ticker = undefined
  }

  /** One look at the shell's processes, for every attempt whose window is open. */
  private async look(record: R, watch: Watch): Promise<void> {
    try {
      const spawns = await this.under(watch.pid)
      if (!this.alive(record, watch) || spawns === undefined) return
      const now = Date.now()
      const agent = agentProcess(record)
      // The newest attempt first: a process is the latest Enter's it can be.
      const claimed = new Set<string>()
      let shown = false
      for (const attempt of watch.attempts.toReversed()) {
        const found = this.started(spawns, attempt, agent)
        const before = attempt.seen
        attempt.seen = new Map(found.map(({ key }) => [key, before.get(key) ?? now]))
        const fresh = found.filter(
          ({ key }) =>
            !claimed.has(key) &&
            !watch.held.has(key) &&
            now - (attempt.seen.get(key) ?? now) >= confirmMs,
        )
        for (const { key } of found) claimed.add(key)
        if (fresh.length === 0) continue
        for (const { key } of fresh) watch.held.add(key)
        attempt.confirmed = true
        // Later processes are none of its command: its intervals end here.
        for (const interval of attempt.intervals) interval.to ??= now
        // Two confirmed in one look, or an older one after a newer: the newest is shown.
        const was = record.summary.shellCommand
        if (!shown && (was == null || attempt.at >= was.since)) {
          shown = true
          if (was == null || was.since !== attempt.at || was.command !== attempt.command) {
            record.summary = {
              ...record.summary,
              shellCommand: { command: attempt.command, since: attempt.at },
            }
            this.host.announce(record)
          }
        }
        this.polling(record, watch)
      }
    } finally {
      watch.looking = false
      // The windows that have closed are over, but an unconfirmed attempt whose window
      // closed in a turn waits for that turn's end, when a queued command runs.
      const now = Date.now()
      const working = record.summary.activity?.state === "working"
      watch.attempts = watch.attempts.filter((attempt) => {
        if (now < attempt.deadline) return true
        if (attempt.confirmed || !attempt.cut || !working) return false
        attempt.waiting = true
        return true
      })
      if (this.alive(record, watch)) this.looking(record, watch)
    }
  }

  /**
   * The top-level processes the attempt's Enter started, less Novadeck's helpers, what they
   * run and the shells they run under. With `agent`, the bound agent's process, a top one is
   * its child: what it left running before (a dev server's watcher restarting its own
   * child) is not the command.
   */
  private started(
    spawns: readonly Spawn[],
    { intervals, seen }: Attempt,
    agent: number | undefined,
  ): readonly Spawn[] {
    const res = this.resolution()
    // Started before an interval's end if a look that ran before it saw it, or if even the
    // latest its start time may truly be (the platform's resolution on) falls before it.
    const candidates = spawns.filter(({ key, startedMs }) =>
      intervals.some(
        ({ from, to }) =>
          startedMs >= from &&
          (to === undefined || startedMs + res < to || (seen.get(key) ?? Infinity) <= to),
      ),
    )
    const all = new Map(spawns.map((spawn) => [spawn.pid, spawn]))
    const byPid = new Map(candidates.map((spawn) => [spawn.pid, spawn]))
    const excluded = new Set<number>()
    for (const spawn of candidates) {
      // The console host, as itself alone.
      if (bare(spawn) === "conhost") excluded.add(spawn.pid)
      if (!helper(spawn)) continue
      excluded.add(spawn.pid)
      // The wrappers above it, while they are shells: a status line's `sh -c`.
      for (
        let up = spawn.parent === null ? undefined : byPid.get(spawn.parent), steps = 0;
        up && shells.has(bare(up)) && steps < 64;
        up = up.parent === null ? undefined : byPid.get(up.parent), steps += 1
      )
        excluded.add(up.pid)
    }
    // What a helper runs: any process with one above it.
    for (const spawn of candidates) {
      for (
        let up = spawn.parent === null ? undefined : all.get(spawn.parent), steps = 0;
        up && steps < 64;
        up = up.parent === null ? undefined : all.get(up.parent), steps += 1
      )
        if (helper(up)) excluded.add(spawn.pid)
    }
    const kept = candidates.filter(({ pid }) => !excluded.has(pid))
    const pids = new Set(kept.map(({ pid }) => pid))
    return kept.filter(
      ({ parent }) =>
        parent === null || (!pids.has(parent) && (agent === undefined || parent === agent)),
    )
  }

  private polling(record: R, watch: Watch): void {
    watch.polling = true
    this.tick()
  }

  /** Arms the shared tick, if none is. */
  private tick(): void {
    if (this.ticker !== undefined) return
    this.ticker = setTimeout(() => {
      this.ticker = undefined
      const due = [...this.watches].filter(([, { polling, pollBusy }]) => polling && !pollBusy)
      // Every watch's poll starts at once: the system lists its processes once for them all.
      for (const [record, watch] of due) {
        watch.pollBusy = true
        this.run(record, watch, () => this.poll(record, watch))
      }
      if ([...this.watches.values()].some(({ polling }) => polling)) this.tick()
    }, pollMs)
    this.ticker.unref()
  }

  private async poll(record: R, watch: Watch): Promise<void> {
    try {
      const spawns = await this.under(watch.pid)
      if (!this.alive(record, watch)) return
      const now = Date.now()
      if (spawns === undefined) watch.unknownSince ??= now
      else watch.unknownSince = undefined
      const over =
        spawns === undefined
          ? now - (watch.unknownSince ?? now) >= unknownMs
          : !spawns.some(({ key }) => watch.held.has(key))
      if (over) {
        // Attempts still looking may find the next command; those that found this one are done.
        watch.held.clear()
        watch.attempts = watch.attempts.filter(({ confirmed }) => !confirmed)
        watch.polling = false
        this.hide(record, true)
      }
    } finally {
      watch.pollBusy = false
    }
  }
}
