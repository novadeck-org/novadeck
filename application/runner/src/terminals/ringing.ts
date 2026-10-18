import type { ScreenText } from "@novadeck/emulator/headless"
import type { AgentName } from "@novadeck/protocol"
import type { Terminal } from "@novadeck/terminal/host"
import { foregroundRuns, processGroup, terminalForeground } from "@novadeck/terminal/pty"
import type { TypingTarget } from "@novadeck/tui-input"
import { isEmpty, type BoxProfile } from "@novadeck/tui-input/box"

import type { Activity } from "../harnesses/activity.js"
import type { Binding } from "../harnesses/bindings.js"
import { harnesses } from "../harnesses/registry.js"
import { tracer, type DoorbellHost } from "../messaging/doorbell.js"
import type { Messaging } from "../messaging/messaging.js"
import { leftoverNonce } from "./leftover.js"

/** What the doorbell reads of a running terminal's record. */
export type RingRecord = {
  readonly terminal: Terminal
  readonly binding: Binding | null
  readonly activity: Activity | null
}

/** The harness box of the agent bound to a terminal, or shown at its prompt before one binds. */
export const profileOf = (
  binding: Binding | null,
  shown: () => AgentName | undefined,
): BoxProfile | undefined => {
  const agent = binding?.agent ?? shown()
  return agent === undefined ? undefined : harnesses[agent].box
}

export type TargetHost<R extends RingRecord> = {
  /** The record of a terminal that is running, if it is. */
  readonly live: (terminalId: string) => R | undefined
  /** The screen of a running terminal once it has drawn what its shell already sent. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /** The agent whose prompt shows in the terminal before any session binds, if any. */
  readonly shownAgent: (terminalId: string) => AgentName | undefined
  /** Whether process `pid` still runs. */
  readonly alive: (pid: string) => boolean
  /** The bound agent left unseen: its binding ends, in turn with the reports. */
  readonly exited: (terminalId: string, record: R, binding: Binding) => void
}

/**
 * What the typist types into: a running terminal, guarded by the manager's check that it
 * still is one, so each answers as a gone terminal does once it exits or is replaced.
 */
export const typingTarget = <R extends RingRecord>(
  terminalId: string,
  host: TargetHost<R>,
): TypingTarget => ({
  type: (data) => {
    const record = host.live(terminalId)
    if (!record) return false
    record.terminal.type(data)
    return true
  },
  screen: () => host.screen(terminalId),
  get resizedAt() {
    return host.live(terminalId)?.terminal.resizedAt ?? 0
  },
  // Known wart: this query ends the binding of an agent found gone (`exited`), which a pure
  // read would not; a follow-up splits it into the read and an agent-gone hook.
  holdsForeground: async () => {
    const record = host.live(terminalId)
    if (!record) return undefined
    // A prompt shown before any session bound: its agent must still hold the
    // terminal, as the shell's prompt may have come back unseen (a nested shell).
    const shown = record.binding ? undefined : host.shownAgent(terminalId)
    if (shown) return foregroundRuns(record.terminal.pty.pid, shown)
    const { binding } = record
    const instance = binding?.instance
    if (!instance) return undefined
    // The bound agent left unseen: no ring for its session, whatever holds the terminal
    // now, and its binding ends, in turn with the reports.
    if (!host.alive(instance)) {
      host.exited(terminalId, record, binding)
      return false
    }
    const [held, own] = await Promise.all([
      terminalForeground(record.terminal.pty.pid),
      processGroup(Number(instance)),
    ])
    return held === undefined || own === undefined ? undefined : held === own
  },
})

export type RingHost<R extends RingRecord> = TargetHost<R> & {
  readonly messaging: Messaging
  /** Whether the activity says a turn or subagents run, where that outweighs what messaging knows. */
  readonly working: (terminalId: string, activity: Activity | null) => boolean
  readonly stopping: () => boolean
}

/** What the doorbell asks of the terminals and messaging. */
export const doorbellHost = <R extends RingRecord>(
  host: RingHost<R>,
): DoorbellHost & Required<Pick<DoorbellHost, "profile">> => {
  const { live, messaging, working } = host
  const profile = (terminalId: string): BoxProfile | undefined => {
    const record = live(terminalId)
    return record && profileOf(record.binding, () => messaging.shownAgent(terminalId))
  }
  return {
    // A request asked after the turn's Stop waits on the person though messaging has the
    // terminal Settled: the line would land in its dialog.
    ringable: (terminalId) => {
      const record = live(terminalId)
      return (
        record !== undefined &&
        (record.activity?.pending.length ?? 0) === 0 &&
        !working(terminalId, record.activity) &&
        !host.stopping() &&
        messaging.ringable(terminalId)
      )
    },
    settledSince: (terminalId) => messaging.settledSince(terminalId),
    ring: (terminalId, nonce) => {
      const record = live(terminalId)
      return (
        record !== undefined &&
        !working(terminalId, record.activity) &&
        messaging.ring(terminalId, nonce)
      )
    },
    ringing: (terminalId) => messaging.ringing(terminalId),
    ready: (terminalId) => messaging.ready(terminalId),
    // Idle but not Ready by its state, with messages waiting: its screen is looked at.
    // Never while its activity says a turn or subagents run (a spinner is no calm), and
    // for a Settled or Ready one only to say a request waits on the person.
    stalled: (terminalId) => {
      const record = live(terminalId)
      if (!record) return false
      if (working(terminalId, record.activity)) {
        if (messaging.stalled(terminalId) || messaging.idleWaiting(terminalId))
          tracer.sink?.(
            terminalId,
            `not looked at: activity ${record.activity?.state}, ${record.activity?.subagents.length ?? 0} subagents, background ${JSON.stringify(record.activity?.background)}`,
          )
        return false
      }
      return (
        messaging.stalled(terminalId) ||
        ((record.activity?.pending.length ?? 0) > 0 && messaging.idleWaiting(terminalId))
      )
    },
    stamp: (terminalId) => messaging.stamp(terminalId),
    barred: (terminalId) => messaging.queueBar(terminalId),
    // The agent's own box, read by its harness off the calm screen: empty and taking a
    // prompt makes an idle Fresh, Drafting or Unknown terminal Ready (see
    // docs/agent-messaging.md, "The doorbell"); anything else says why it is not.
    reading: (terminalId, screen) => {
      const record = live(terminalId)
      if (!record) return "dialog"
      if ((record.activity?.pending.length ?? 0) > 0) return "asking"
      if (working(terminalId, record.activity)) return "draft"
      const box = profile(terminalId)
      const text = box?.read(screen)
      if (!box || box.overlay(screen)) return "dialog"
      // Before its prompt draws, a new session shows no box yet: nothing to say.
      if (!text) return messaging.delivery(terminalId)?.state === "fresh" ? "starting" : "dialog"
      if (text.mode !== "prompt") return "draft"
      // A picker's row starts with the box's marker too (`❯ 1. Yes`): not a box.
      if (/^\d+[.)]\s/.test(text.text.trimStart())) return "dialog"
      return isEmpty(text) && !box.queued(screen) ? "empty" : "draft"
    },
    // The line a failed ring left, all the box holds, which the person has not touched.
    leftover: (terminalId, screen) => {
      if (!live(terminalId) || !messaging.ours(terminalId)) return undefined
      const box = profile(terminalId)
      const text = box?.read(screen)
      if (!box || !text || text.mode !== "prompt" || box.overlay(screen)) return undefined
      return leftoverNonce(text.text)
    },
    ringLeftover: (terminalId, nonce) => messaging.ringLeftover(terminalId, nonce),
    emptied: (terminalId, readAt) => {
      const delivery = messaging.delivery(terminalId)
      const record = live(terminalId)
      if (delivery && record && !working(terminalId, record.activity))
        messaging.emptied(terminalId, delivery.epoch, readAt)
    },
    blocked: (terminalId, waits) => messaging.blocked(terminalId, waits),
    ringFailed: (terminalId, nonce, ours) => messaging.ringFailed(terminalId, nonce, ours),
    target: (terminalId) => (live(terminalId) ? typingTarget(terminalId, host) : undefined),
    profile,
  }
}
