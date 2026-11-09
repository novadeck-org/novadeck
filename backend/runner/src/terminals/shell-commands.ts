import {
  processesUnder,
  startResolutionMs,
  type ProcessTrees,
  type Spawn,
} from "@novadeck/terminal/pty"
import { isEmpty, type BoxProfile } from "@novadeck/tui-input/box"

import type { Record } from "./record.js"

/**
 * When, after an Enter in a harness's shell mode, the shell's processes are looked at for
 * the command it started: a command takes the harness a moment to spawn, and a slow one
 * (a wrapper that sources a snapshot first) a little more.
 */
export const lookMs: readonly number[] = [750, 2_000]

/** How often a command shown running is looked at again, in milliseconds. */
export const pollMs = 1_000

/** How many looks in a row that could not tell end the command shown: no evidence, no busy. */
export const unknownLooks = 2

/** What the shell commands read of a terminal's record, and the summary field they keep there. */
export type ShellRecord = Pick<Record, "summary" | "terminal" | "hibernating" | "closed">

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

/** A shell-mode Enter at `at`; `ended` is when the turn it waited out ended, if it did. */
type Attempt = { readonly command: string; readonly at: number; readonly ended?: number }

/** How long after an Enter mid-turn a command that the harness runs at once (Codex) starts, in ms. */
export const midTurnMs = 2_000

type Watch = {
  readonly run: number
  readonly pid: number
  /** The processes the command started, top-level, by `Spawn.key`. */
  readonly held: Set<string>
  /** The looks still to come after an Enter. */
  readonly looks: Set<NodeJS.Timeout>
  poll: NodeJS.Timeout | undefined
  /** How many looks in a row could not tell. */
  unknown: number
  /** The latest Enter that came while a turn worked, until that turn ends. */
  pending: Attempt | undefined
}

// Novadeck's own helper, which an agent's status line or hooks start beside a command.
const helper = (spawn: Spawn): boolean =>
  (spawn.name ?? "").toLowerCase().replace(/\.exe$/, "") === "novadeck-relay"

/**
 * The commands a person runs in an agent's own shell mode (`!sleep 15`), which fire no hook:
 * the terminal shows one as running while a process it started lives (`shellCommand`),
 * and none of it is a turn.
 *
 * An Enter that reaches an agent's terminal while its box (read as it stood before the
 * Enter) is in shell mode and holds a command starts two looks at the shell's processes; those
 * started since the Enter, less Novadeck's helpers and what they run under, are the command. Once
 * one is found it is looked at every second, and shown until none is left, or the system
 * twice could not tell.
 */
export class ShellCommands<R extends ShellRecord> {
  private readonly watches = new Map<R, Watch>()

  constructor(private readonly host: ShellCommandsHost<R>) {}

  private under(pid: number): Promise<readonly Spawn[] | undefined> {
    return (this.host.under ?? ((root) => processesUnder(root, { trees: this.host.trees() })))(pid)
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
        const attempt = { command, at }
        // Mid-turn Codex runs the command at once, Claude Code and Antigravity queue it until
        // the turn ends; the turn's own tools start processes too, so it is looked for
        // once the turn has ended (`changed`).
        if (record.summary.activity?.state === "working") this.hold(record, run, pid, attempt)
        else this.begin(record, run, pid, attempt)
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
    if (record.summary.shellCommand === null) return
    record.summary = { ...record.summary, shellCommand: null }
    if (announce) this.host.announce(record)
  }

  /** Stops every look and poll: the runner is shutting down. */
  stop(): void {
    for (const [record, watch] of this.watches) this.drop(record, watch)
  }

  /** The record's activity changed: a turn that ended brings the looks for the command waiting on it. */
  changed(record: R): void {
    const watch = this.watches.get(record)
    if (!watch?.pending || record.summary.activity?.state === "working") return
    const attempt = { ...watch.pending, ended: Date.now() }
    watch.pending = undefined
    this.schedule(record, watch, attempt)
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
        looks: new Set(),
        poll: undefined,
        unknown: 0,
        pending: undefined,
      }
      this.watches.set(record, watch)
    }
    return watch
  }

  private hold(record: R, run: number, pid: number, attempt: Attempt): void {
    const watch = this.watchOf(record, run, pid)
    if (watch) watch.pending = attempt
  }

  private begin(record: R, run: number, pid: number, attempt: Attempt): void {
    const watch = this.watchOf(record, run, pid)
    if (watch) this.schedule(record, watch, attempt)
  }

  private schedule(record: R, watch: Watch, attempt: Attempt): void {
    for (const ms of lookMs) {
      const look = setTimeout(() => {
        watch.looks.delete(look)
        void this.look(record, watch, attempt).finally(() => this.settle(record, watch))
      }, ms)
      look.unref()
      watch.looks.add(look)
    }
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

  /** Lets go of a watch no look or poll of which is left. */
  private settle(record: R, watch: Watch): void {
    if (this.watches.get(record) !== watch) return
    if (!this.alive(record, watch)) this.end(record)
    else if (watch.looks.size === 0 && watch.poll === undefined && !watch.pending)
      this.watches.delete(record)
  }

  private drop(record: R, watch: Watch): void {
    for (const look of watch.looks) clearTimeout(look)
    watch.looks.clear()
    if (watch.poll) clearTimeout(watch.poll)
    watch.poll = undefined
    if (this.watches.get(record) === watch) this.watches.delete(record)
  }

  private async look(record: R, watch: Watch, attempt: Attempt): Promise<void> {
    const spawns = await this.under(watch.pid)
    if (!this.alive(record, watch) || spawns === undefined) return
    const fresh = this.started(spawns, attempt).filter(({ key }) => !watch.held.has(key))
    if (fresh.length === 0) return
    for (const { key } of fresh) watch.held.add(key)
    const shown = record.summary.shellCommand
    if (shown === null || shown.since !== attempt.at || shown.command !== attempt.command) {
      record.summary = {
        ...record.summary,
        shellCommand: { command: attempt.command, since: attempt.at },
      }
      this.host.announce(record)
    }
    this.polling(record, watch)
  }

  /** The top-level processes started since `at`, less Novadeck's helpers and what runs them. */
  private started(spawns: readonly Spawn[], { at, ended }: Attempt): readonly Spawn[] {
    const res = this.host.resolutionMs?.() ?? startResolutionMs()
    // After a turn's end: what started right after the Enter (Codex runs it at once), or
    // since the turn ended (the others queue it); not what the turn's tools started between.
    const candidates = spawns.filter(
      ({ startedMs }) =>
        startedMs >= (ended ?? at) - res ||
        (ended !== undefined && startedMs >= at - res && startedMs <= at + midTurnMs),
    )
    const byPid = new Map(candidates.map((spawn) => [spawn.pid, spawn]))
    const excluded = new Set<number>()
    for (const spawn of candidates.filter(helper)) {
      // The helper and the wrapper processes above it that are candidates themselves.
      for (
        let up: Spawn | undefined = spawn, steps = 0;
        up && steps < 64;
        up = up.parent === null ? undefined : byPid.get(up.parent), steps += 1
      )
        excluded.add(up.pid)
    }
    const kept = candidates.filter(({ pid }) => !excluded.has(pid))
    const pids = new Set(kept.map(({ pid }) => pid))
    return kept.filter(({ parent }) => parent === null || !pids.has(parent))
  }

  private polling(record: R, watch: Watch): void {
    if (watch.poll !== undefined) return
    watch.poll = setTimeout(() => {
      watch.poll = undefined
      void this.poll(record, watch).finally(() => this.settle(record, watch))
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
      // Looks after a later Enter stay: they may find the next command.
      watch.held.clear()
      this.hide(record, true)
    } else this.polling(record, watch)
  }
}
