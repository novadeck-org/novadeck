import type { HarnessEvent } from "@novadeck/harness-core/events"

/**
 * What each terminal's agent did between two moments, for the loop hold
 * (docs/agent-messaging.md, Guards, "Loops"): whether it worked, so a message sent while
 * neither end of its thread did is idle. Fed every harness event a terminal's session
 * reports, as it reaches the runner, and each send the terminal makes; kept in memory only,
 * so a runner restart forgets it.
 */
export class Loops {
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Harness events the terminal's session reported, root and subagents, as they reached the
   * runner at `at`: `tool-called` reports, subagents starting and stopping, turns starting
   * and ending (and what they leave in the background), requests waiting on the person, and
   * prompts the person typed.
   */
  observe(terminalId: string, events: readonly HarnessEvent[], at: number = this.now()): void {
    void terminalId
    void events
    void at
    throw new Error("Loops.observe: not built yet")
  }

  /**
   * The terminal sent a message at `at`: counted as its own call reported just after it,
   * whatever its harness reports of the `send`, so a turn that only sent never passes for
   * one at work.
   */
  sent(terminalId: string, at: number): void {
    void terminalId
    void at
    throw new Error("Loops.sent: not built yet")
  }

  /**
   * Whether the terminal worked after `from` up to `to`: made a call of kind `work`, root or
   * subagent, whose report reached the runner in that time; had a subagent that hadn't
   * aborted, a background task a working call started, or a request waiting on the person,
   * at any moment of it; ran one turn through all of it without any call of its reporting;
   * or the person typed a prompt in it. `"unknown"` where it can't tell: no session bound
   * there, a session that hasn't reported any call yet (its harness may not report them),
   * or `from` before the runner started watching it. The loop hold counts unknown as work.
   */
  worked(terminalId: string, from: number, to: number): boolean | "unknown" {
    void terminalId
    void from
    void to
    throw new Error("Loops.worked: not built yet")
  }

  /** The terminal's session ended or changed: what it did before no longer says anything. */
  reset(terminalId: string): void {
    void terminalId
    throw new Error("Loops.reset: not built yet")
  }

  /** The terminal is gone. */
  forget(terminalId: string): void {
    void terminalId
    throw new Error("Loops.forget: not built yet")
  }
}
