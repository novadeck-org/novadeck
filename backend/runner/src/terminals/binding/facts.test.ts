import type { AgentName } from "@novadeck/protocol"
import { vi } from "vitest"

import { describe, expect, it } from "../../test.js"
import type { Record } from "../record.js"
import { Bindings, type BindingsHost } from "./facts.js"

/**
 * Bindings with what the ends of a session use of their host: whose prompt shows as ready
 * there (`shown`), and the announcements, counted.
 */
const bindings = (shown?: AgentName) => {
  const announce = vi.fn<(record: Record) => void>()
  const host = {
    messaging: () => ({ shownAgent: () => shown }),
    rebound: () => {},
    announce,
  } as unknown as BindingsHost
  return { bindings: new Bindings(host), announce }
}

/** A terminal with a Claude Code session bound in its shell, shown as the summary says. */
const record = (summary: Partial<Record["summary"]> = {}) =>
  ({
    summary: { id: "t1", agent: null, ready: null, activity: null, telemetry: null, ...summary },
    agents: {},
    binding: { agent: "claude", sessionId: "s1", instance: "41" },
    activity: null,
    telemetry: null,
    watching: null,
    actorWatches: new Map(),
    transcript: null,
    sourceReaders: new Set(),
    readyEntered: false,
    root: { agent: "claude", sessionId: "s1" },
    suspended: "41",
    seenEntry: { transcript: "/t.jsonl", id: 3 },
  }) as unknown as Record

describe("the ends of a session", () => {
  it("announces the summary its binding's end changed, though it showed no agent", () => {
    // Bound, but not yet shown, as while a Stop's ask waits: the prompt that shows there
    // is ready once the session ends.
    const { bindings: ends, announce } = bindings("claude")
    const bound = record({ agentRan: false })
    expect(ends.endBinding(bound)).toBe(true)
    expect(bound.summary).toMatchObject({ agent: null, ready: "claude" })
    expect(announce).toHaveBeenCalledTimes(1)
  })

  it("announces nothing where a disconnection left the summary as it was", () => {
    const { bindings: ends, announce } = bindings()
    ends.forgotten(record({ agentRan: false }))
    expect(announce).not.toHaveBeenCalled()
  })

  it("keeps what the shell holds while it is still there, as an agent a Ctrl+Z left suspended", () => {
    const { bindings: ends } = bindings()
    for (const end of [
      (bound: Record) => ends.endBinding(bound),
      (bound: Record) => ends.forgotten(bound),
    ]) {
      const bound = record({ agent: "claude", agentRan: true })
      end(bound)
      expect(bound).toMatchObject({ binding: null, suspended: "41", seenEntry: { id: 3 } })
    }
  })

  it("ends what the shell held as it exits, as a restart starts from", () => {
    const { bindings: ends } = bindings()
    const bound = record({ agent: "claude", agentRan: true })
    ends.exited(bound)
    const { binding, activity, telemetry, suspended, root, seenEntry } = ends.restarted()
    expect(bound).toMatchObject({ binding, activity, telemetry, suspended, root })
    expect(bound.seenEntry).toBe(seenEntry)
  })
})
