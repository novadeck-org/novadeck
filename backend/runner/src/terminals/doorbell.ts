import type { ScreenText } from "@novadeck/emulator/headless"
import type { AgentName } from "@novadeck/protocol"
import type { Terminal } from "@novadeck/terminal/host"
import { foregroundRuns, processGroup, terminalForeground } from "@novadeck/terminal/pty"
import type { TypingTarget } from "@novadeck/tui-input"
import { isEmpty, type BoxProfile } from "@novadeck/tui-input/box"

import { blocking } from "../harnesses/activity.js"
import type { Binding } from "../harnesses/bindings.js"
import { harnesses } from "../harnesses/registry.js"
import { doorbellLog } from "../messaging/doorbell-log.js"
import { tracer, type DoorbellHost } from "../messaging/doorbell.js"
import type { Messaging } from "../messaging/messaging.js"
import { busy } from "./busy.js"
import { leftoverNonce } from "./leftover.js"
import type { Bound } from "./record.js"

/** What the doorbell reads of a running terminal's record. */
export type DoorbellRecord = {
  readonly terminal: Terminal
  readonly bound: DoorbellBound | null
}

/** What the doorbell reads of the session bound to a terminal (`Record.bound`). */
export type DoorbellBound = Pick<Bound, "binding" | "activity">

/**
 * Whether the activity says the agent bound there works (`busy`, for its harness), where
 * that outweighs what messaging knows: a Settled or Ready terminal made so by a Stop or a
 * session's start stands against an activity that lingers; every other, and any made so
 * by the screen alone, does not. `bound` is the session bound to the terminal, null without
 * one, and undefined for a terminal not running.
 */
export const agentWorking = (
  messaging: Pick<Messaging, "delivery" | "byScreen">,
  terminalId: string,
  bound: DoorbellBound | null | undefined,
): boolean => {
  const state = messaging.delivery(terminalId)?.state
  const known = (state === "settled" || state === "ready") && !messaging.byScreen(terminalId)
  return (
    !known &&
    busy(
      bound?.activity ?? null,
      bound != null && harnesses[bound.binding.agent].messaging.promptsInBackground,
    )
  )
}

/** The harness box of the agent bound to a terminal, or shown at its prompt before one binds. */
export const profileOf = (
  binding: Binding | null,
  shown: () => AgentName | undefined,
): BoxProfile | undefined => {
  const agent = binding?.agent ?? shown()
  return agent === undefined ? undefined : harnesses[agent].box
}

export type TypingTargetHost<R extends DoorbellRecord> = {
  /** The record of a terminal that is running, if it is. */
  readonly live: (terminalId: string) => R | undefined
  /** The screen of a running terminal once it has drawn what its shell already sent. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /** The agent whose prompt shows in the terminal before any session binds, if any. */
  readonly shownAgent: (terminalId: string) => AgentName | undefined
  /** Whether process `pid` still runs. */
  readonly alive: (pid: string) => boolean
}

/**
 * What the typist types into: a running terminal, guarded by the manager's check that it
 * still is one, so each answers as a gone terminal does once it exits or is replaced.
 */
export const typingTarget = <R extends DoorbellRecord>(
  terminalId: string,
  host: TypingTargetHost<R>,
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
  holdsForeground: async () => {
    const record = host.live(terminalId)
    if (!record) return undefined
    // A prompt shown before any session bound: its agent must still hold the
    // terminal, as the shell's prompt may have come back unseen (a nested shell).
    const shown = record.bound ? undefined : host.shownAgent(terminalId)
    if (shown) return foregroundRuns(record.terminal.pty.pid, shown)
    const instance = record.bound?.binding.instance
    if (!instance) return undefined
    // The bound agent left unseen: no ring for its session, whatever holds the terminal now.
    if (!host.alive(instance)) return false
    const [held, own] = await Promise.all([
      terminalForeground(record.terminal.pty.pid),
      processGroup(Number(instance)),
    ])
    return held === undefined || own === undefined ? undefined : held === own
  },
})

export type DoorbellTerminals<R extends DoorbellRecord> = TypingTargetHost<R> & {
  /** Runs `work` in the terminal's turn, after what is queued there. */
  readonly queued: (terminalId: string, work: () => void) => void
  /** Ends the binding of an agent known to have exited. */
  readonly endExited: (record: R) => void
  readonly messaging: Messaging
  /** Whether the activity says the agent works, where that outweighs what messaging knows. */
  readonly working: (terminalId: string, bound: DoorbellBound | null) => boolean
  readonly stopping: () => boolean
}

/** What the doorbell asks of the terminals and messaging. */
export const doorbellHost = <R extends DoorbellRecord>(
  host: DoorbellTerminals<R>,
): DoorbellHost & Required<Pick<DoorbellHost, "profile">> => {
  const { live, messaging, working } = host
  const profile = (terminalId: string): BoxProfile | undefined => {
    const record = live(terminalId)
    return (
      record && profileOf(record.bound?.binding ?? null, () => messaging.shownAgent(terminalId))
    )
  }
  return {
    // A request asked after the turn's Stop waits on the person though messaging has the
    // terminal Settled: the line would land in its dialog.
    ringable: (terminalId) => {
      const record = live(terminalId)
      return (
        record !== undefined &&
        blocking(record.bound?.activity.pending).length === 0 &&
        !working(terminalId, record.bound) &&
        !host.stopping() &&
        messaging.ringable(terminalId)
      )
    },
    settledSince: (terminalId) => messaging.settledSince(terminalId),
    ring: (terminalId, nonce) => {
      const record = live(terminalId)
      const rung =
        record !== undefined &&
        !working(terminalId, record.bound) &&
        messaging.ring(terminalId, nonce)
      if (rung) doorbellLog.current?.ring(terminalId, messaging.waitedMs(terminalId))
      return rung
    },
    ringing: (terminalId) => messaging.ringing(terminalId),
    // The doorbell asks before it reads the foreground; the read itself ends nothing.
    agentGone: (terminalId) => {
      const record = live(terminalId)
      const binding = record?.bound?.binding
      const instance = binding?.instance
      // Its binding ends in turn with the reports, if it is still the one found.
      if (record && binding && instance && !host.alive(instance))
        host.queued(terminalId, () => {
          if (record.bound?.binding === binding) host.endExited(record)
        })
    },
    ready: (terminalId) => messaging.ready(terminalId),
    // Idle but not Ready by its state, with messages waiting: its screen is looked at.
    // Never while its activity says the agent works (a spinner is no calm), and
    // for a Settled or Ready one only to say a request waits on the person.
    stalled: (terminalId) => {
      const record = live(terminalId)
      if (!record) return false
      const activity = record.bound?.activity
      if (working(terminalId, record.bound)) {
        if (messaging.stalled(terminalId) || messaging.idleWaiting(terminalId)) {
          tracer.sink?.(
            terminalId,
            `not looked at: activity ${activity?.state}, ${activity?.subagents.length ?? 0} subagents, background ${JSON.stringify(activity?.background)}`,
          )
          // Its hold says so, not what an older look saw.
          messaging.blocked(terminalId, "working")
        }
        return false
      }
      return (
        messaging.stalled(terminalId) ||
        (blocking(activity?.pending).length > 0 && messaging.idleWaiting(terminalId))
      )
    },
    stamp: (terminalId) => messaging.stamp(terminalId),
    barred: (terminalId) => messaging.queueBar(terminalId),
    // The agent's own box, read by its harness off the calm screen: empty and taking a
    // prompt makes an idle Fresh, Drafting or Unknown terminal, or one Working on background
    // work only, Ready (see
    // docs/agent-messaging.md, "The doorbell"); anything else says why it is not.
    reading: (terminalId, screen) => {
      const record = live(terminalId)
      if (!record) return "dialog"
      if (blocking(record.bound?.activity.pending).length > 0) return "asking"
      if (working(terminalId, record.bound)) return "working"
      const box = profile(terminalId)
      const text = box?.read(screen)
      if (!box || box.overlay(screen)) return "dialog"
      // Before its prompt draws, a new session shows no box yet: nothing to say.
      if (!text) return messaging.delivery(terminalId)?.state === "fresh" ? "starting" : "dialog"
      if (text.mode !== "prompt") return "shell"
      // A picker's row starts with the box's marker too (`❯ 1. Yes`): not a box.
      if (/^\d+[.)]\s/.test(text.text.trimStart())) return "dialog"
      if (!isEmpty(text)) return "draft"
      return box.queued(screen) ? "queued" : "empty"
    },
    // A doorbell line all the agent's own box holds, of a ring no doorbell prompt confirmed:
    // Novadeck's, however that ring ended (its paste check rejected, abandoned mid-way, its
    // Enter lost). A confirmed ring's line there is the person's (their Escape put it back,
    // or they recalled it), as is anything beside it, or a prompt queued with it.
    leftover: (terminalId, screen) => {
      if (!live(terminalId)) return undefined
      const box = profile(terminalId)
      const text = box?.read(screen)
      if (!box || !text || text.mode !== "prompt" || box.overlay(screen) || box.queued(screen))
        return undefined
      const nonce = leftoverNonce(text.text)
      return nonce !== undefined && messaging.unconfirmed(terminalId, nonce) ? nonce : undefined
    },
    ringLeftover: (terminalId, nonce) => {
      const rung = messaging.ringLeftover(terminalId, nonce)
      if (rung) doorbellLog.current?.ring(terminalId, messaging.waitedMs(terminalId))
      return rung
    },
    emptied: (terminalId, readAt) => {
      const delivery = messaging.delivery(terminalId)
      const record = live(terminalId)
      if (delivery && record && !working(terminalId, record.bound))
        messaging.emptied(terminalId, delivery.epoch, readAt)
    },
    blocked: (terminalId, waits) => {
      doorbellLog.current?.hold(terminalId, waits)
      messaging.blocked(terminalId, waits)
    },
    ringFailed: (terminalId, nonce) => {
      doorbellLog.current?.ringFailed(terminalId)
      messaging.ringFailed(terminalId, nonce)
    },
    target: (terminalId) => (live(terminalId) ? typingTarget(terminalId, host) : undefined),
    profile,
  }
}
