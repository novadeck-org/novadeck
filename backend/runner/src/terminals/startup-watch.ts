import type { ScreenText } from "@novadeck/emulator/headless"
import {
  isAgentName,
  type AgentName,
  type StartupScreen,
  type TerminalSummary,
} from "@novadeck/protocol"
import type { Terminal } from "@novadeck/terminal/host"
import type { Launch } from "@novadeck/terminal/shell"
import type { BoxProfile } from "@novadeck/tui-input/box"

import { harnesses } from "../harnesses/registry.js"
import { coalesced } from "./coalesce.js"
import { sessionLaunch } from "./commands.js"
import type { Record } from "./record.js"
import { programOf } from "./sampling.js"

/** What the watch reads of a terminal's record, and what it keeps there. */
export type WatchedRecord = Pick<
  Record,
  "summary" | "startupScreen" | "bound" | "signedOut" | "promptedAt"
> & {
  readonly terminal: Pick<Terminal, "run" | "pty">
}

/** How often the terminals expecting an agent are looked at, in milliseconds. */
export const startupPollMs = 1_000

/**
 * How long a screen stays still before it counts as holding its agent for the person. Windows
 * starts agents far slower than the rest: the doorbell gives a ring there five times as long.
 */
export const startupDelayMs = (platform: NodeJS.Platform): number =>
  platform === "win32" ? 15_000 : 5_000

/**
 * How many delays an agent's box stands before the watch leaves it alone. Codex draws its
 * prompt first and may raise its hooks review or update screen over it a few seconds later.
 */
const promptedDelays = 6

/**
 * For how many delays a session's prompt is looked at once it binds, for a harness whose
 * prompt can say it isn't signed in (Claude Code's footer draws with the prompt), and after
 * that only while it says so, or did lately (`signedOutLingerMs`).
 */
const signedOutDelays = 3

/**
 * How long a prompt that said it isn't signed in is still looked at once it no longer does:
 * Claude Code's `/login` covers its footer while the person signs in, and they may leave it
 * with Escape, or their sign-in fail, back at the prompt that says so again.
 */
const signedOutLingerMs = 10 * 60_000

/**
 * What a screen says of the agent expected there: its own `box`, which it takes prompts in;
 * a `screen` it drew with none, which can only be waiting on the person; or `nothing` of it
 * yet. Until an agent takes the terminal for itself, turning on bracketed paste, what shows is
 * the shell's: the shell runs a startup command before its line editor ever turns that on, so
 * however long an agent takes to load, what its shell printed doesn't count until then. Codex
 * turns it on about 0.2 s before it first draws (dev-docs/agent-messaging.md, "Startup screens").
 * The screens of the three harnesses are probed in `startup-watch.test.ts`.
 */
export type StartupLook = "box" | "screen" | "nothing"

export const lookAt = (screen: ScreenText, box: BoxProfile): StartupLook => {
  if (!screen.bracketedPaste || screen.rows.every((row) => row.trim() === "")) return "nothing"
  const text = box.read(screen)
  // A picker's row starts with the box's marker too (`❯ 1. Yes`): not a box.
  return text && !box.overlay(screen) && !/^\d+[.)]\s/.test(text.text.trimStart())
    ? "box"
    : "screen"
}

/** What the watch keeps of a screen between looks. */
export type Track = {
  readonly text: string | null
  /** Since when `text` has stood. */
  readonly still: number
  /** Since when it has changed at every look; null while it stands. */
  readonly moving: number | null
  /** Whether it counts as holding its agent for the person. */
  readonly held: boolean
  /** Since when its agent's box has stood; null while none does. */
  readonly box: number | null
  /** Its box stood long enough: the agent is past any startup screen, and is left alone. */
  readonly prompted: boolean
  /** Its box stood a delay since the shell ran it: it started, whatever shows over it since. */
  readonly started: boolean
  /** Which screen its text says it is, where its harness tells (`Harness.heldScreen`). */
  readonly screen?: StartupScreen | undefined
  /**
   * When its harness was last asked whether Novadeck's hooks run, once its box stood a delay;
   * asked again a delay later while it couldn't answer.
   */
  readonly asked?: number | undefined
  /** Since when a session was seen bound there, for the looks at its prompt. */
  readonly bound?: number | undefined
  /** When the bound session's prompt last said it isn't signed in. */
  readonly signedOut?: number | undefined
}

export const freshTrack = (now: number): Track => ({
  text: null,
  still: now,
  moving: null,
  held: false,
  box: null,
  prompted: false,
  started: false,
})

/**
 * The track after a look. A screen holds its agent once it stood for `delayMs`, and stops
 * only at a box, or once it moved for as long: a key the person presses at it moves it for a
 * look, so its mark doesn't flicker, and a spinner after they answer does end it. A box that
 * stands for `promptedDelays` ends the watch: an agent that never binds, its hooks silent, may
 * open a dialog of its own much later. Only standing does: Codex's logo reads as a box for a
 * moment, right before its trust question.
 */
export const nextTrack = (
  track: Track,
  look: StartupLook,
  text: string,
  now: number,
  delayMs: number,
): Track => {
  if (look === "box") {
    const box = track.box ?? now
    const prompted = now - box >= delayMs * promptedDelays
    const started = track.started || now - box >= delayMs
    return { ...freshTrack(now), text, box, prompted, started, asked: track.asked }
  }
  if (look === "screen" && text === track.text)
    return { ...track, moving: null, held: track.held || now - track.still >= delayMs, box: null }
  const moving = track.moving ?? now
  return {
    ...track,
    text,
    still: now,
    moving,
    held: track.held && now - moving < delayMs,
    box: null,
  }
}

const trackKey = ({ summary, terminal }: WatchedRecord): string => `${summary.id}/${terminal.run}`

/** The agent a terminal's foreground program is (see `typedAgent`). */
const foregroundAgent = ({ summary }: WatchedRecord): AgentName | undefined => {
  const program = summary.process ? programOf(summary.process) : undefined
  return isAgentName(program) ? program : undefined
}

export type StartupHost<R extends WatchedRecord> = {
  readonly stopping: () => boolean
  readonly records: () => Iterable<R>
  readonly messaging: () => {
    /** The agent expected in the terminal, which neither bound nor showed its prompt yet. */
    readonly expected: (terminalId: string) => AgentName | null
    /** The agent whose hooks were found not to run there, with no session bound, if any. */
    readonly untrustedAgent: (terminalId: string) => AgentName | undefined
    /** The agent whose own empty prompt shows there, before any session bound. */
    readonly shownAgent: (terminalId: string) => AgentName | undefined
  }
  readonly shown: () => {
    /**
     * The expected agent's own box stood a delay with no session bound: whether Novadeck's
     * hooks run for it there is asked, which marks it in `untrustedAgent` where they don't.
     * Whether its harness answered: one that couldn't is asked again a delay later.
     */
    readonly boxStood: (record: R, agent: AgentName) => Promise<boolean>
  }
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /** The terminal's summary changed. */
  readonly changed: (record: R) => void
}

/**
 * What holds the terminal's agent for the person, as the summary shows it: a bound session
 * whose prompt says it isn't signed in; else an agent whose hooks Novadeck found off
 * (`hooksOff`); else the screen `held` names, of the agent expected there. The summary's own
 * value where it says the same.
 */
export const startupOf = (
  record: WatchedRecord,
  hooksOff: AgentName | undefined,
  held: { readonly agent: AgentName; readonly screen: StartupScreen } | null,
): TerminalSummary["startup"] => {
  const { bound, summary } = record
  const next = bound
    ? record.signedOut === bound.binding
      ? { agent: bound.binding.agent, screen: "sign-in" as const }
      : null
    : hooksOff
      ? { agent: hooksOff, screen: "hooks" as const }
      : held
  const shown = summary.startup
  return shown?.agent === next?.agent && shown?.screen === next?.screen ? shown : next
}

/**
 * Tells which terminals an agent is expected in, or was typed in by the person, are held at
 * one of its own screens for the person, as a folder-trust, update, sign-in or onboarding
 * screen, where no harness reports anything Novadeck binds on; which hold an agent whose hooks
 * Novadeck found off, asking the harness once its own box has stood a while; and which hold a
 * bound session whose prompt says it isn't signed in. It looks only while one is expected or
 * typed, a session just bound, or a mark stands; a summary that changes (`noticed`) wakes it.
 */
export class StartupWatch<R extends WatchedRecord> {
  private timer: ReturnType<typeof setInterval> | undefined
  private looking = false
  /** By terminal and run: a restart's new shell starts over. */
  private tracks = new Map<string, Track>()
  /** The tracks whose harness answered whether Novadeck's hooks run there. */
  private answered = new Set<string>()
  /** By terminal and run: the agent a shim there said it starts, and when. */
  private launches = new Map<string, { readonly agent: AgentName; readonly at: number }>()
  private readonly schedule = coalesced(
    () => this.tick(),
    "Novadeck's startup watch failed:",
    "startup-watch.failed",
  )

  constructor(
    private readonly host: StartupHost<R>,
    private readonly pollMs = startupPollMs,
    private readonly delayMs = startupDelayMs(process.platform),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A terminal's summary changed: the watch looks again where that may need it, as at an
   * agent the person typed in its shell, a session that bound, or an agent found with its
   * hooks off.
   */
  noticed(record: R): void {
    if (this.timer || this.host.stopping()) return
    const track = this.tracks.get(trackKey(record))
    const wanted = record.bound
      ? this.looksBound(record, track)
      : (this.agentIn(record) !== undefined && !track?.prompted) ||
        (this.host.messaging().untrustedAgent(record.summary.id) !== undefined &&
          record.summary.startup?.screen !== "hooks")
    if (wanted) this.start()
  }

  /**
   * A shim in the terminal's shell said it starts `launch.program`'s session (see `launchCode`
   * in libraries/terminal): that agent is the one typed there until the shell's prompt shows
   * again, where the platform doesn't name its program. Only one meant for this terminal, from
   * its current run, with no session bound; and only the first since the prompt, as an agent's
   * own tool shell may start another, which a cmd shim can't tell from the person's. Where the
   * foreground program names another agent, the last one ended with no prompt to say so, as in
   * a nested shell, and the next one counts.
   */
  launched(record: R, run: unknown, launch: Launch): void {
    const { program } = launch
    if (run !== record.terminal.pty || launch.terminal !== record.summary.id) return
    if (record.bound || !isAgentName(program) || this.liveLaunch(record) !== undefined) return
    this.launches.set(trackKey(record), { agent: program, at: this.now() })
    this.tell(record)
    this.noticed(record)
  }

  /** An agent is expected in some terminal. */
  start(): void {
    if (this.timer || this.host.stopping()) return
    this.timer = setInterval(() => this.schedule("tick"), this.pollMs)
    this.timer.unref()
  }

  stop(): void {
    this.pause()
    this.tracks.clear()
    this.answered.clear()
    this.launches.clear()
  }

  private pause(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    if (this.looking) return
    this.looking = true
    try {
      const tracks = new Map<string, Track>()
      for (const record of this.host.records()) {
        const { id } = record.summary
        const key = trackKey(record)
        const agent = this.agentIn(record)
        const known = this.tracks.get(key)
        if (record.bound) {
          // eslint-disable-next-line no-await-in-loop -- One terminal's screen at a time.
          tracks.set(key, await this.lookBound(record, known))
        } else if (known?.prompted) tracks.set(key, known)
        else if (agent) {
          // eslint-disable-next-line no-await-in-loop -- One terminal's screen at a time.
          const track = await this.look(key, id, agent)
          if (track) tracks.set(key, track)
          if (track?.asked !== undefined && track.asked !== known?.asked)
            this.host
              .shown()
              .boxStood(record, agent)
              .then(
                (answered) => {
                  if (answered && this.tracks.has(key)) this.answered.add(key)
                },
                (error: unknown) => {
                  console.error("Novadeck couldn't ask whether its hooks run:", error)
                },
              )
          // A session bound during the look: nothing here may mark it again.
          if (this.agentIn(record) === agent && !record.bound)
            this.show(record, agent, track?.held === true, track?.screen)
        }
      }
      this.tracks = tracks
      for (const key of this.answered) if (!tracks.has(key)) this.answered.delete(key)
      this.forgetLaunches()
      this.settle()
    } finally {
      this.looking = false
    }
  }

  // Once the looks are done, all at once, as any expectation may have ended during them:
  // none that did keeps its mark, and with nothing left to look at the watch rests.
  // A mark that stands keeps the watch looking, so it ends with what made it: an agent whose
  // hooks are off leaving, or a session's prompt signed in.
  private settle(): void {
    let looking = false
    for (const record of this.host.records()) {
      const track = this.tracks.get(trackKey(record))
      if (record.bound) looking ||= this.looksBound(record, track)
      else if (!this.agentIn(record)) this.show(record, null, false)
      else if (!track?.prompted) looking = true
      // Past its box, as the looks found it now.
      this.tell(record)
      if (record.summary.startup) looking = true
    }
    if (!looking) this.pause()
  }

  /**
   * Shows in the summary the agent starting in the terminal (`TerminalSummary.expecting`): the
   * one it was opened or woken to run for a session, else one its shim said the person typed,
   * until a session binds, its prompt is known to show, or its own box has stood a delay, as for
   * an agent whose harness tells neither. Its prompt or a session ends it at once too
   * (`Bindings.publishAgent`).
   */
  private tell(record: R): void {
    const expecting = this.starting(record)
    if ((record.summary.expecting ?? null) === expecting) return
    record.summary = { ...record.summary, expecting }
    this.host.changed(record)
  }

  /** The agent starting in the terminal, as the summary tells it (see `tell`). */
  starting(record: R): AgentName | null {
    const { bound, summary } = record
    const track = this.tracks.get(trackKey(record))
    if (bound || track?.prompted || track?.started) return null
    if (this.host.messaging().shownAgent(summary.id) !== undefined) return null
    // The one it was opened or woken to run, for a session: an agent's other commands, as
    // `codex login`, start none. Else one its shim said the person typed, which it says only
    // of a session.
    const expected = this.host.messaging().expected(summary.id)
    const { command } = summary
    if (expected && (!command || sessionLaunch(command) === expected)) return expected
    return this.liveLaunch(record) ?? null
  }

  // The agent the watch looks for in a terminal: the one Novadeck expects there, else one the
  // person typed in its shell.
  private agentIn(record: R): AgentName | undefined {
    return this.host.messaging().expected(record.summary.id) ?? this.typedAgent(record)
  }

  /**
   * The agent the person typed in a terminal's shell, which Novadeck didn't launch and so
   * expects nowhere, with no session bound: its foreground program, where the platform names
   * that, else the one its shim said it starts.
   */
  private typedAgent(record: R): AgentName | undefined {
    return record.bound ? undefined : (foregroundAgent(record) ?? this.liveLaunch(record))
  }

  /**
   * The agent a shim said it starts in the terminal's run, unless the shell's prompt showed
   * since (a launch in the prompt's own moment, typed ahead, still counts), or the foreground
   * program names another agent.
   */
  private liveLaunch(record: R): AgentName | undefined {
    const launch = this.launches.get(trackKey(record))
    if (!launch || launch.at < (record.promptedAt ?? -Infinity)) return undefined
    const foreground = foregroundAgent(record)
    return foreground === undefined || foreground === launch.agent ? launch.agent : undefined
  }

  // A launch ends with its run, once the shell's prompt shows again, or once another agent runs.
  private forgetLaunches(): void {
    const live = new Set<string>()
    for (const record of this.host.records())
      if (this.liveLaunch(record) !== undefined) live.add(trackKey(record))
    for (const key of this.launches.keys()) if (!live.has(key)) this.launches.delete(key)
  }

  private async look(
    key: string,
    terminalId: string,
    agent: AgentName,
  ): Promise<Track | undefined> {
    const screen = await this.host.screen(terminalId)
    if (!screen) return undefined
    const now = this.now()
    const harness = harnesses[agent]
    const track = this.tracks.get(key) ?? freshTrack(now)
    const look = lookAt(screen, harness.box)
    const next = nextTrack(track, look, screen.rows.join("\n"), now, this.delayMs)
    // Its box stood a delay: its hooks may be off, which nothing but its harness tells.
    // Asked once it answers, else again each delay, until the watch leaves it alone.
    const due =
      next.box !== null &&
      now - next.box >= this.delayMs &&
      !this.answered.has(key) &&
      (next.asked === undefined || now - next.asked >= this.delayMs)
    return {
      ...next,
      screen: look === "screen" ? harness.heldScreen?.(screen.rows) : undefined,
      asked: due ? now : next.asked,
    }
  }

  // Whether a bound session's prompt is still looked at: for a while once it binds, for as
  // long as it says it isn't signed in, and for a while after it last did.
  private looksBound(record: R, track: Track | undefined): boolean {
    const { bound } = record
    if (!bound || !harnesses[bound.binding.agent].signedOut) return false
    if (record.signedOut === bound.binding || track?.bound === undefined) return true
    const now = this.now()
    if (track.signedOut !== undefined && now - track.signedOut < signedOutLingerMs) return true
    return now - track.bound < this.delayMs * signedOutDelays
  }

  private async lookBound(record: R, known: Track | undefined): Promise<Track> {
    let track: Track = {
      ...(known ?? freshTrack(this.now())),
      bound: known?.bound ?? this.now(),
    }
    const { bound } = record
    const signedOut = bound && harnesses[bound.binding.agent].signedOut
    if (bound && signedOut && this.looksBound(record, track)) {
      const screen = await this.host.screen(record.summary.id)
      if (screen && record.bound === bound) {
        const says = signedOut(screen.rows)
        record.signedOut = says ? bound.binding : undefined
        if (says) track = { ...track, signedOut: this.now() }
      }
    }
    this.show(record, null, false)
    return track
  }

  private show(
    record: R,
    agent: AgentName | null,
    held: boolean,
    screen?: StartupScreen | undefined,
  ): void {
    const startup = startupOf(
      record,
      this.host.messaging().untrustedAgent(record.summary.id),
      agent && held ? { agent, screen: record.startupScreen?.screen ?? screen ?? "startup" } : null,
    )
    const expecting = this.starting(record)
    if (startup === record.summary.startup && expecting === (record.summary.expecting ?? null))
      return
    record.summary = { ...record.summary, startup, expecting }
    this.host.changed(record)
  }
}
