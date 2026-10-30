import { maxTurnError, turnError } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import {
  callId,
  errorText,
  firedFacts,
  maxPlan,
  planText,
  shortName,
  withMode,
  withRequestCwd,
} from "./decode.js"
import type { HarnessEvent } from "./events.js"

const base = { agent: "claude", sessionId: "s1", instance: "7", startedAt: 10 } as const
const started: HarnessEvent = { ...base, type: "turn-started", cause: "prompt" }
const asked: HarnessEvent = {
  ...base,
  type: "attention-requested",
  requestId: "r1",
  actor: null,
  toolName: "Bash",
  kind: "permission",
  subject: "ls",
  choices: [],
}
const bidi = String.fromCodePoint(0x202e)
const zeroWidth = String.fromCodePoint(0x200b)

describe("a failed turn's error", () => {
  it("keeps its lines, and drops escapes, controls and reordering marks", () => {
    expect(errorText(`\x1b[31mrate limited\x1b[0m\nretry\x00 at ${bidi}noon\t `)).toBe(
      "rate limited\nretry  at  noon",
    )
  })

  it("is cut to what the protocol takes", () => {
    const error = errorText("x".repeat(maxTurnError * 2 + 1))
    expect(error).toHaveLength(maxTurnError)
    expect(turnError.safeParse(error).success).toBe(true)
  })

  it("is nothing when nothing is left, or it isn't text", () => {
    expect(errorText(" \x1b[0m ")).toBeUndefined()
    expect(errorText(42)).toBeUndefined()
  })
})

describe("a short name a harness gives", () => {
  it("is taken trimmed", () => {
    expect(shortName("  opus  ", 20)).toBe("opus")
  })

  it("is refused blank, too long, or holding a control or invisible character", () => {
    expect(shortName("   ", 20)).toBeUndefined()
    expect(shortName("a".repeat(21), 20)).toBeUndefined()
    expect(shortName(`op${zeroWidth}us`, 20)).toBeUndefined()
    expect(shortName("op\nus", 20)).toBeUndefined()
    expect(shortName(7, 20)).toBeUndefined()
  })
})

describe("a hook's permission mode", () => {
  it("adds whether the root agent plans after its facts", () => {
    expect(withMode([started], { permission_mode: "plan" })).toEqual([
      started,
      { ...base, type: "mode-observed", planning: true },
    ])
    expect(withMode([started], { permission_mode: "default" })[1]).toMatchObject({
      planning: false,
    })
  })

  it("adds nothing for a subagent's hook, a hook with no mode, or no facts", () => {
    expect(withMode([started], { permission_mode: "plan", agent_id: "a1" })).toEqual([started])
    expect(withMode([started], {})).toEqual([started])
    expect(withMode([], { permission_mode: "plan" })).toEqual([])
  })
})

describe("a request's directory", () => {
  it("is the absolute one its hook named, where it has none", () => {
    expect(withRequestCwd([started, asked], { cwd: "/work" })).toEqual([
      started,
      { ...asked, cwd: "/work" },
    ])
  })

  it("is left as it is for a relative directory, or one it already has", () => {
    expect(withRequestCwd([asked], { cwd: "work" })).toEqual([asked])
    const own = { ...asked, cwd: "/own" }
    expect(withRequestCwd([own], { cwd: "/work" })).toEqual([own])
  })
})

describe("when a hook was fired", () => {
  it("is given to the facts its hook told, not those read since", () => {
    const read = { ...started, startedAt: 4 }
    expect(firedFacts([started, read], { seq: 10, firedAt: 8 })).toEqual([
      { ...started, firedAt: 8 },
      read,
    ])
  })

  it("is given to none where the relay couldn't tell", () => {
    expect(firedFacts([started], { seq: 10 })).toEqual([started])
  })
})

describe("a plan's text", () => {
  it("is kept whole within the protocol's bound", () => {
    expect(planText("the plan")).toEqual({ text: "the plan", truncated: false })
  })

  it("is cut at the bound, a character left whole", () => {
    expect(planText("x".repeat(maxPlan + 1))).toEqual({
      text: "x".repeat(maxPlan),
      truncated: true,
    })
    expect(planText(`${"x".repeat(maxPlan - 1)}😀`)).toEqual({
      text: "x".repeat(maxPlan - 1),
      truncated: true,
    })
  })
})

describe("a permission request's call id", () => {
  it("is the same whatever order its input's keys come in", () => {
    expect(callId(null, "Bash", { command: "ls", timeout: 5 })).toBe(
      callId(null, "Bash", { timeout: 5, command: "ls" }),
    )
  })

  it("differs by actor, tool and input", () => {
    const root = callId(null, "Bash", { command: "ls" })
    expect(callId("a1", "Bash", { command: "ls" })).not.toBe(root)
    expect(callId(null, "Read", { command: "ls" })).not.toBe(root)
    expect(callId(null, "Bash", { command: "pwd" })).not.toBe(root)
  })
})
