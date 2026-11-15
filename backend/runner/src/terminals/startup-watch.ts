import type { ScreenText } from "@novadeck/emulator/headless"
import type { AgentName, StartupScreen, TerminalSummary } from "@novadeck/protocol"
import type { Terminal } from "@novadeck/terminal/host"
import type { BoxProfile } from "@novadeck/tui-input/box"

import { harnesses } from "../harnesses/registry.js"
import { coalesced } from "./coalesce.js"
import type { Record } from "./record.js"

/** What the watch reads of a terminal's record, and what it keeps there. */
export type WatchedRecord = Pick<Record, "summary" | "startupScreen" | "bound" | "signedOut"> & {
  readonly terminal: Pick<Terminal, "run">
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
 * that only while it says so.
 */
const signedOutDelays = 3

/**
 * What a screen says of the agent expected there: its own `box`, which it takes prompts in;
 * a `screen` it drew with none, which can only be waiting on the person; or `nothing` of it
 * yet. Until an agent takes the terminal for itself, turning on bracketed paste, what shows is
 * the shell's: the shell runs a startup command before its line editor ever turns that on, so
 * however long an agent takes to load, what its shell printed doesn't count until then. Codex
 * turns it on about 0.2 s before it first draws (docs/agent-messaging.md, "Startup screens").
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
  /** Which screen its text says it is, where its harness tells (`Harness.heldScreen`). */
  readonly screen?: StartupScreen | undefined
  /** Whether its harness was asked if Novadeck's hooks run, once its box stood a delay. */
  readonly asked?: boolean | undefined
  /** Since when a session was seen bound there, for the looks at its prompt. */
  readonly bound?: number | undefined
}

export const freshTrack = (now: number): Track => ({
  text: null,
  still: now,
  moving: null,
  held: false,
  box: null,
  prompted: false,
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
    return { ...freshTrack(now), text, box, prompted, asked: track.asked }
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

export type StartupHost<R extends WatchedRecord> = {
  readonly stopping: () => boolean
  readonly records: () => Iterable<R>
  readonly messaging: () => {
    /** The agent expected in the terminal, which neither bound nor showed its prompt yet. */
    readonly expected: (terminalId: string) => AgentName | null
    /** The agent whose hooks were found not to run there, with no session bound, if any. */
    readonly untrustedAgent: (terminalId: string) => AgentName | undefined
  }
  readonly shown: () => {
    /**
     * The expected agent's own box stood a delay with no session bound: whether Novadeck's
     * hooks run for it there is asked, which marks it in `untrustedAgent` where they don't.
     */
    readonly boxStood: (record: R, agent: AgentName) => Promise<void>
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
 * Tells which terminals an agent is expected in are held at one of its own screens for the
 * person, as a folder-trust, update, sign-in or onboarding screen, where no harness reports
 * anything Novadeck binds on; which hold an agent whose hooks Novadeck found off, asking the
 * harness once its own box has stood a while; and which hold a bound session whose prompt says
 * it isn't signed in. It looks only while one is expected, a session just bound, or a mark
 * stands.
 */
export class StartupWatch<R extends WatchedRecord> {
  private timer: ReturnType<typeof setInterval> | undefined
  private looking = false
  /** By terminal and run: a restart's new shell starts over. */
  private tracks = new Map<string, Track>()
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

  /** An agent is expected in some terminal. */
  start(): void {
    if (this.timer || this.host.stopping()) return
    this.timer = setInterval(() => this.schedule("tick"), this.pollMs)
    this.timer.unref()
  }

  stop(): void {
    this.pause()
    this.tracks.clear()
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
        const agent = this.host.messaging().expected(id)
        const known = this.tracks.get(key)
        if (record.bound) {
          // eslint-disable-next-line no-await-in-loop -- One terminal's screen at a time.
          tracks.set(key, await this.lookBound(record, known))
        } else if (known?.prompted) tracks.set(key, known)
        else if (agent) {
          // eslint-disable-next-line no-await-in-loop -- One terminal's screen at a time.
          const track = await this.look(key, id, agent)
          if (track) tracks.set(key, track)
          if (track?.asked && !known?.asked)
            this.host
              .shown()
              .boxStood(record, agent)
              .catch((error: unknown) => {
                console.error("Novadeck couldn't ask whether its hooks run:", error)
              })
          // A session bound during the look: nothing here may mark it again.
          if (this.host.messaging().expected(id) === agent && !record.bound)
            this.show(record, agent, track?.held === true, track?.screen)
        }
      }
      this.tracks = tracks
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
      else if (!this.host.messaging().expected(record.summary.id)) this.show(record, null, false)
      else if (!track?.prompted) looking = true
      if (record.summary.startup) looking = true
    }
    if (!looking) this.pause()
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
    return {
      ...next,
      screen: look === "screen" ? harness.heldScreen?.(screen.rows) : undefined,
      // Its box stood a delay: its hooks may be off, which nothing but its harness tells.
      asked: next.asked || (next.box !== null && now - next.box >= this.delayMs),
    }
  }

  // Whether a bound session's prompt is still looked at: for a while once it binds, and for
  // as long as it says it isn't signed in.
  private looksBound(record: R, track: Track | undefined): boolean {
    const { bound } = record
    if (!bound || !harnesses[bound.binding.agent].signedOut) return false
    if (record.signedOut === bound.binding) return true
    return track?.bound === undefined || this.now() - track.bound < this.delayMs * signedOutDelays
  }

  private async lookBound(record: R, known: Track | undefined): Promise<Track> {
    const track = { ...(known ?? freshTrack(this.now())), bound: known?.bound ?? this.now() }
    const { bound } = record
    const signedOut = bound && harnesses[bound.binding.agent].signedOut
    if (bound && signedOut && this.looksBound(record, track)) {
      const screen = await this.host.screen(record.summary.id)
      if (screen && record.bound === bound)
        record.signedOut = signedOut(screen.rows) ? bound.binding : undefined
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
    if (startup === record.summary.startup) return
    record.summary = { ...record.summary, startup }
    this.host.changed(record)
  }
}
