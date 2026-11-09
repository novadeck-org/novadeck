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

/** How many looks in a row that could not tell end the command shown: no evidence, no busy. */
export const unknownLooks = 2

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

/** A shell-mode Enter, with what its looks learned: each keeps its own. */
type Attempt = {
  readonly command: string
  readonly at: number
  /** Whether its harness runs a command at once while a turn works (Codex), not after it. */
  readonly runs: boolean
  /** When the turn it waited out ended, if it waited. */
  readonly ended?: number
  /** When a turn first started after it: that turn's tools' processes are not the command. */
  cutoff: number | undefined
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
  poll: NodeJS.Timeout | undefined
  /** How many polls in a row could not tell. */
  unknown: number
  /** How many looks and polls are awaiting the system: none may be left behind by a settle. */
  inflight: number
  /** The latest Enter that came while a turn worked (a harness that queues it, or runs it), until that turn ends. */
  pending: Omit<Attempt, "ended" | "cutoff" | "seen"> | undefined
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
 * (or since the end of the turn it waited out), less Novadeck's helpers, what they run and
 * the shells they run under, and with the bound agent as the parent of each top one, are
 * the command, once seen live a second apart. Once one is found it is looked at every
 * second, and shown until none is left, or the system twice could not tell.
 */
export class ShellCommands<R extends ShellRecord> {
  private readonly watches = new Map<R, Watch>()

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
        else this.begin(record, run, pid, { ...entry, cutoff: undefined, seen: new Map() })
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
  }

  /**
   * The record's activity changed: a turn that ended brings the looks for the command waiting
   * on it, and one that started cuts off the attempts then looking.
   */
  changed(record: R): void {
    const watch = this.watches.get(record)
    if (!watch) return
    const working = record.summary.activity?.state === "working"
    if (working) {
      // Each attempt has its own cutoff: the turn's tools are not what they look for.
      const now = Date.now()
      for (const attempt of watch.attempts) attempt.cutoff ??= now
      return
    }
    if (!watch.pending) return
    const { pending } = watch
    watch.pending = undefined
    this.begin(record, watch.run, watch.pid, {
      ...pending,
      ended: Date.now(),
      cutoff: undefined,
      seen: new Map(),
    })
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
        poll: undefined,
        unknown: 0,
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
    if (watch.look !== undefined || watch.attempts.length === 0) return
    watch.look = setTimeout(() => {
      watch.look = undefined
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
      watch.poll === undefined &&
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
    if (watch.poll) clearTimeout(watch.poll)
    watch.poll = undefined
    if (this.watches.get(record) === watch) this.watches.delete(record)
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
        const shown = record.summary.shellCommand
        if (shown == null || shown.since !== attempt.at || shown.command !== attempt.command) {
          record.summary = {
            ...record.summary,
            shellCommand: { command: attempt.command, since: attempt.at },
          }
          this.host.announce(record)
        }
        this.polling(record, watch)
      }
    } finally {
      // The windows that have closed are over; the others look again.
      const now = Date.now()
      watch.attempts = watch.attempts.filter(({ at, ended }) => now - (ended ?? at) < findMs)
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
    { at, ended, runs, cutoff }: Attempt,
    agent: number | undefined,
  ): readonly Spawn[] {
    const res = this.host.resolutionMs?.() ?? startResolutionMs()
    // After a turn's end: what started since it (a harness that queues the command), or
    // too what started right after the Enter (one that runs it at once, Codex); never what
    // the turn's tools started between.
    const candidates = spawns.filter(
      ({ startedMs }) =>
        (cutoff === undefined || startedMs < cutoff) &&
        (startedMs >= (ended ?? at) - res ||
          (ended !== undefined && runs && startedMs >= at - res && startedMs <= at + midTurnMs)),
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
    if (watch.poll !== undefined) return
    watch.poll = setTimeout(() => {
      watch.poll = undefined
      this.run(record, watch, () => this.poll(record, watch))
    }, pollMs)
    watch.poll.unref()
  }

  private async poll(record: R, watch: Watch): Promise<void> {
    const spawns = await this.under(watch.pid)
    if (!this.alive(record, watch)) return
    if (spawns === undefined) watch.unknown += 1
    else watch.unknown = 0
    const over =
      spawns === undefined
        ? watch.unknown >= unknownLooks
        : !spawns.some(({ key }) => watch.held.has(key))
    if (over) {
      // Attempts still looking may find the next command.
      watch.held.clear()
      this.hide(record, true)
    } else this.polling(record, watch)
  }
}
