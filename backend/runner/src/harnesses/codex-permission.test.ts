import { decode } from "@novadeck/harness-codex/decode"
import { rolloutEvents } from "@novadeck/harness-codex/rollout"

import { describe, expect, it } from "../test.js"
import { apply, started, type Activity } from "./activity.js"

const binding = { agent: "codex" as const, sessionId: "s", instance: "7" }
const requested = (command: string, at: number, actor: string | null = null) =>
  decode({
    terminalId: "t",
    token: "0".repeat(48),
    agent: "codex",
    event: "PermissionRequest",
    seq: at,
    instance: binding.instance,
    env: { cursor: false },
    payload: {
      session_id: binding.sessionId,
      agent_id: actor,
      tool_name: "Bash",
      tool_input: { command, description: "Run outside the sandbox" },
    },
  }).find((event) => event.type === "attention-requested")!

const completed = (command: string, at: number) =>
  rolloutEvents(
    JSON.stringify({
      timestamp: new Date(at).toISOString(),
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: ["/bin/bash", "-lc", command],
          status: "completed",
          source: "unified_exec_startup",
        },
      },
    }),
    binding,
  ).find((event) => event.type === "attention-resolved")!

const working = (): Activity =>
  apply(started(0), binding, {
    type: "turn-started",
    ...binding,
    startedAt: 1,
    cause: "prompt",
  })!

describe("a Codex command whose approval hook never resolves", () => {
  it("settles its completed command while the model's turn continues", () => {
    const held = apply(working(), binding, requested("sleep 3; echo done", 10))!
    const next = apply(held, binding, completed("sleep 3; echo done", 20))!
    expect(held.pending).toHaveLength(1)
    expect(next.pending).toEqual([])
    expect(next.state).toBe("working")
  })

  it("keeps a newer request for the same command when an older completion arrives late", () => {
    const held = apply(working(), binding, requested("echo same", 30))!
    expect(apply(held, binding, completed("echo same", 20))).toBeUndefined()
    expect(held.pending).toHaveLength(1)
  })

  it("keeps another command's request and the same command asked by a subagent", () => {
    const requests = [
      requested("echo root", 10),
      requested("echo other", 11),
      requested("echo root", 12, "a1"),
    ]
    const held = requests.reduce((activity, event) => apply(activity, binding, event)!, working())
    const next = apply(held, binding, completed("echo root", 20))!
    expect(next.pending.map(({ actor, subject }) => ({ actor, subject }))).toEqual([
      { actor: null, subject: "echo other" },
      { actor: "a1", subject: "echo root" },
    ])
  })
})
