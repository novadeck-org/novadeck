import { shellEvents, type Calls } from "@novadeck/harness-agy/shells"
import { rolloutEvents, type Commands } from "@novadeck/harness-codex/rollout"
import type { HarnessEvent } from "@novadeck/harness-core/events"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { hookReport } from "@novadeck/harness-core/testing/reports"
import type { AgentName } from "@novadeck/protocol"

import { apply, started, summary } from "../harnesses/activity.js"
import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { backgroundOf } from "./background-shells.js"

// Each harness's own decoder, run over its captured hooks or transcript, into the activity
// the runner keeps, and the shells `agents()` would list from it.

type Hook = { event: string; payload: Record<string, unknown> }

const activityOf = (agent: AgentName, sessionId: string, events: readonly HarnessEvent[]) => {
  const binding = { agent, sessionId, instance: null }
  return summary(
    events.reduce(
      (activity, event) =>
        event.type === "session-observed" || event.type === "telemetry-observed"
          ? activity
          : (apply(activity, binding, event) ?? activity),
      started(0),
    ),
  )
}

const hooked = (agent: AgentName, hooks: readonly Hook[]): HarnessEvent[] =>
  hooks.flatMap(({ event, payload }, index) => [
    ...harnesses[agent].decode(
      hookReport(agent, event, payload, { seq: 1_000 + index * 1_000, instance: null }),
    ),
  ])

describe("Claude Code's shells, from its captured hooks", () => {
  const { scenarios } = loadProbe(adapterFolder("claude"), "shells.probe.json") as {
    scenarios: { "three-shells": { hooks: Hook[] } }
  }
  const { hooks } = scenarios["three-shells"]
  const at = (count: number) =>
    activityOf("claude", "session-1", hooked("claude", hooks.slice(0, count)))

  it("names a shell by the description of the job its Stop lists, by id, and never by command", () => {
    const background = backgroundOf(at(4), 60_000)!
    expect(background.running.map(({ name }) => name)).toEqual([
      expect.not.stringContaining("tick"),
      "Server C",
      "Server A",
    ])
    expect(JSON.stringify(background)).not.toContain("sleep 2")
  })

  it("lists the one that exited with a code lately, and not the one that exited 0", () => {
    const now = 60_000
    const background = backgroundOf(at(hooks.length - 1), now)!
    expect(background.ended).toMatchObject([{ code: 3 }])
    expect(JSON.stringify(background)).not.toContain("tick")
  })
})

describe("Codex's shells, from its captured rollout", () => {
  const lines = (
    loadProbe(adapterFolder("codex"), "shells.probe.json") as {
      scenarios: { "three-shells": { lines: string[] } }
    }
  ).scenarios["three-shells"].lines

  it("lists what the rollout started, and the exit that failed, without a command", () => {
    const commands: Commands = new Map()
    const events = lines.flatMap((line) => [
      ...rolloutEvents(line, { sessionId: "s", instance: null }, commands),
    ])
    const activity = activityOf("codex", "s", events)
    const last = Math.max(...activity.shells!.map(({ exit }) => exit?.at ?? 0))
    const background = backgroundOf(activity, last + 60_000)!
    expect(background.ended).toMatchObject([{ code: 3 }])
    expect(JSON.stringify(background)).not.toMatch(/tick|sleep/)
  })
})

describe("Antigravity's shells, from its captured hooks and transcript", () => {
  const conversation = "60000000-0000-4000-8000-000000000001"
  const waiting = (
    loadProbe(adapterFolder("agy"), "waiting.probe.json") as {
      scenarios: { "background-command": { events: Hook[] } }
    }
  ).scenarios["background-command"].events
  const transcript = (
    loadProbe(adapterFolder("agy"), "shells.probe.json") as {
      scenarios: { "three-shells": { lines: string[] } }
    }
  ).scenarios["three-shells"].lines.map((line) =>
    line.replaceAll("b0000000-0000-4000-8000-000000000001", conversation),
  )

  it("names a shell by its job's description though their ids are written differently", () => {
    // The job's id is `<conversation>:2`, its hook's step; the shell's is `<conversation>/task-2`.
    // Through the status line that says idle, where it reads as waiting on its job.
    const idle = waiting.findIndex(
      ({ event, payload }) => event === "StatusLine" && payload.agent_state === "idle",
    )
    const hooks = hooked("agy", waiting.slice(0, idle + 1))
    const calls: Calls = new Map()
    const first = transcript
      .slice(0, 2)
      .flatMap((line) => [...shellEvents(line, { sessionId: conversation, instance: null }, calls)])
    const activity = activityOf("agy", conversation, [...hooks, ...first])
    expect(activity.waiting?.jobs.map(({ id }) => id)).toEqual([`${conversation}:2`])
    expect(activity.shells?.map(({ id }) => id)).toEqual([`${conversation}/task-2`])
    const background = backgroundOf(activity, Date.now())!
    // The job is the call with another command in this capture; only the id can match them.
    expect(background.running.map(({ name }) => name)).toEqual(["Sleep then echo"])
  })

  it("lists a failed exit from the transcript without its command", () => {
    const calls: Calls = new Map()
    const events = transcript.flatMap((line) => [
      ...shellEvents(line, { sessionId: conversation, instance: null }, calls),
    ])
    const activity = activityOf("agy", conversation, events)
    const last = Math.max(...activity.shells!.map(({ exit }) => exit?.at ?? 0))
    const background = backgroundOf(activity, last + 60_000)!
    expect(background.ended).toMatchObject([{ code: 3 }])
    expect(JSON.stringify(background)).not.toMatch(/tick|sleep/)
  })
})
