import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { loadProbe } from "../testing/probes.js"

// Sanitized payloads captured from real harness runs; docs/harness-coverage.md rests on
// what they show, so these checks keep the two in step.
type Payload = { readonly [key: string]: unknown }
const fixture = <T>(harness: string, name: string): T =>
  loadProbe(join(import.meta.dirname, harness), name) as T

const claude = fixture<{
  hookEnvironment: string[]
  events: { event: string; payload: Payload }[]
}>("claude", "hooks.probe.json")
const named = (name: string) => claude.events.filter(({ event }) => event === name)

describe("Claude Code's hooks, as captured", () => {
  it("name the session and its transcript in every payload", () => {
    for (const { payload } of claude.events) {
      expect(payload.session_id).toEqual(expect.any(String))
      expect(payload.transcript_path).toEqual(expect.any(String))
    }
    expect(named("SessionStart")[0]?.payload.source).toBe("startup")
  })

  it("name the Claude Code process in the hook's environment", () => {
    expect(claude.hookEnvironment).toContain("CLAUDE_PID")
  })

  it("ask for permission without a request id, right after the tool call that has one", () => {
    const index = claude.events.findIndex(({ event }) => event === "PermissionRequest")
    const request = claude.events[index]!.payload
    expect(request).not.toHaveProperty("tool_use_id")
    const before = claude.events[index - 1]!
    expect(before.event).toBe("PreToolUse")
    expect(before.payload.tool_use_id).toEqual(expect.any(String))
    // Print mode denies the call itself: no PostToolUse, but PostToolBatch lists it.
    const answered = claude.events.filter(
      ({ event, payload }) =>
        event.startsWith("PostToolUse") && payload.tool_use_id === before.payload.tool_use_id,
    )
    expect(answered).toEqual([])
    const batch = claude.events.find(({ event }) => event === "PostToolBatch")
    expect(batch?.payload.tool_calls).toContainEqual(
      expect.objectContaining({ tool_use_id: before.payload.tool_use_id }),
    )
  })

  it("attribute a subagent's tool calls to it, under the root's session", () => {
    const [start] = named("SubagentStart")
    const agent = start!.payload.agent_id
    const inside = claude.events.filter(
      ({ event, payload }) => event === "PreToolUse" && payload.agent_id === agent,
    )
    expect(inside).not.toEqual([])
    expect(inside[0]!.payload.session_id).toBe(start!.payload.session_id)
    expect(named("SubagentStop")[0]?.payload.agent_transcript_path).toEqual(expect.any(String))
  })
})

const exec = fixture<{ events: Payload[] }>("codex", "exec.probe.json")
const rollout = fixture<{ records: { type: string; payload: Payload }[] }>(
  "codex",
  "rollout.probe.json",
)

describe("Codex's rollout, as captured", () => {
  it("names the same thread in its session record and its exec events", () => {
    const thread = exec.events.find(({ type }) => type === "thread.started")?.thread_id
    const meta = rollout.records.find(({ type }) => type === "session_meta")?.payload
    expect(meta?.id).toBe(thread)
    expect(meta?.session_id).toBe(thread)
  })

  it("reports rate limit windows as a percentage with an absolute reset in seconds", () => {
    const count = rollout.records.find(
      ({ type, payload }) => type === "event_msg" && payload.type === "token_count",
    )?.payload as { rate_limits: { primary: Payload }; info: Payload }
    const { used_percent, window_minutes, resets_at } = count.rate_limits.primary
    expect(used_percent).toBeGreaterThanOrEqual(0)
    expect(used_percent).toBeLessThanOrEqual(100)
    expect(window_minutes).toEqual(expect.any(Number))
    // Epoch seconds: ten digits until 2286.
    expect(String(resets_at)).toMatch(/^\d{10}$/)
    expect(count.info.model_context_window).toEqual(expect.any(Number))
  })

  it("keeps the turn and item records the coverage doc lists", () => {
    const kinds = rollout.records.map(({ type, payload }) => `${type}:${payload.type ?? ""}`)
    for (const kind of [
      "event_msg:task_started",
      "event_msg:item_completed",
      "event_msg:token_count",
      "event_msg:task_complete",
    ])
      expect(kinds).toContain(kind)
  })
})

type HookProbe = {
  hookAncestry: string[]
  hookEnvironment: string[]
  events: { event: string; payload: Payload }[]
}
const codexHooks = fixture<HookProbe>("codex", "hooks.probe.json")

describe("Codex's hooks, as captured", () => {
  it("run as children of the Codex process, which identifies its instance", () => {
    expect(codexHooks.hookAncestry).toEqual(["codex"])
  })

  it("attribute a subagent's tool calls to it, under the root's session", () => {
    const root = codexHooks.events[0]!.payload.session_id
    for (const { payload } of codexHooks.events) expect(payload.session_id).toBe(root)
    const agent = codexHooks.events.find(({ event }) => event === "SubagentStart")?.payload.agent_id
    const inside = codexHooks.events.filter(
      ({ event, payload }) => event === "PreToolUse" && payload.agent_id === agent,
    )
    expect(inside).not.toEqual([])
    expect(inside[0]!.payload.turn_id).not.toBe(codexHooks.events[1]!.payload.turn_id)
  })

  it("mark turns with a turn id, and end the session with a reason", () => {
    const prompt = codexHooks.events.find(({ event }) => event === "UserPromptSubmit")
    expect(prompt?.payload.turn_id).toEqual(expect.any(String))
    expect(codexHooks.events.at(-1)).toMatchObject({
      event: "SessionEnd",
      payload: { reason: "other" },
    })
  })
})

const agyHooks = fixture<HookProbe>("agy", "hooks.probe.json")

describe("Antigravity's hooks, as captured", () => {
  it("run through sh, whose parent is the Antigravity process", () => {
    expect(agyHooks.hookAncestry).toEqual(["sh", "agy"])
  })

  it("name the conversation in the payload and the environment", () => {
    for (const { payload } of agyHooks.events)
      expect(payload.conversationId).toEqual(expect.any(String))
    expect(agyHooks.hookEnvironment).toContain("ANTIGRAVITY_CONVERSATION_ID")
  })

  it("fire no PostToolUse for a tool its PreToolUse hook denied", () => {
    expect(agyHooks.events.some(({ event }) => event === "PreToolUse")).toBe(true)
    expect(agyHooks.events.some(({ event }) => event === "PostToolUse")).toBe(false)
  })

  it("end with Stop, naming why in its own upper-case terms", () => {
    const stop = agyHooks.events.at(-1)!
    expect(stop.event).toBe("Stop")
    expect(stop.payload).toMatchObject({ terminationReason: "NO_TOOL_CALL", fullyIdle: true })
  })
})

type Event = { event: string; payload: Payload; harnessProcess?: string | null }
type Interactive = { scenarios: { [name: string]: { events: Event[] } } }
const scenario = (harness: string, name: string) =>
  fixture<Interactive>(harness, "interactive.probe.json").scenarios[name]!.events
const after = (events: Event[], index: number) => events.slice(index + 1).map(({ event }) => event)
const indexOf = (events: Event[], event: string, tool?: string) =>
  events.findIndex((each) => each.event === event && (!tool || each.payload.tool_name === tool))

describe("Claude Code in a terminal, as captured", () => {
  it("fires nothing when Esc interrupts a running tool", () => {
    const events = scenario("claude", "interrupt")
    expect(after(events, indexOf(events, "PreToolUse", "Bash"))).toEqual(["SessionEnd"])
  })

  it("fires nothing after a denied permission, not even Stop", () => {
    const events = scenario("claude", "deny")
    expect(after(events, indexOf(events, "PermissionRequest"))).toEqual(["SessionEnd"])
    expect(events.at(-1)?.payload.reason).toBe("prompt_input_exit")
  })

  it("follows an allowed permission with the tool's own result", () => {
    const events = scenario("claude", "allow")
    const request = indexOf(events, "PermissionRequest")
    expect(events[request - 1]?.event).toBe("PreToolUse")
    expect(events[request + 1]).toMatchObject({
      event: "PostToolUse",
      payload: { tool_use_id: events[request - 1]!.payload.tool_use_id },
    })
  })

  it("asks a question through a permission request, and answers it in the tool response", () => {
    const events = scenario("claude", "question")
    expect(indexOf(events, "PermissionRequest", "AskUserQuestion")).toBeGreaterThan(-1)
    const answered = events[indexOf(events, "PostToolUse", "AskUserQuestion")]!
    expect((answered.payload.tool_response as Payload).answers).toEqual({
      "Which color?": expect.any(String),
    })
  })

  it("marks planning on its hooks, and reviews the plan through ExitPlanMode", () => {
    const events = scenario("claude", "plan")
    const review = indexOf(events, "PermissionRequest", "ExitPlanMode")
    expect(Object.keys(events[review]!.payload.tool_input as Payload).toSorted()).toEqual([
      "plan",
      "planFilePath",
    ])
    const moded = events.filter((each) => "permission_mode" in each.payload)
    for (const { payload } of moded) expect(payload.permission_mode).toBe("plan")
    // Rejecting the plan fires nothing, as a denied tool does.
    expect(after(events, review)).toEqual(["SessionEnd"])
  })
})

describe("Codex in a terminal, as captured", () => {
  it("follows an approved request with the tool's own result", () => {
    const events = scenario("codex", "approve")
    const request = indexOf(events, "PermissionRequest")
    expect(events[request + 1]).toMatchObject({
      event: "PostToolUse",
      payload: { tool_use_id: events[request - 1]!.payload.tool_use_id },
    })
  })

  it("reports a denial and an interrupt alike, as Interrupt for that turn", () => {
    const events = scenario("codex", "deny-then-interrupt")
    const request = indexOf(events, "PermissionRequest")
    expect(events[request + 1]).toMatchObject({
      event: "Interrupt",
      payload: { turn_id: events[request]!.payload.turn_id },
    })
    const sleeping = events.findLastIndex(({ event }) => event === "PreToolUse")
    expect(after(events, sleeping)).toEqual(["Interrupt", "SessionEnd"])
  })
})

describe("Antigravity in a terminal, as captured", () => {
  it("starts a new conversation on /clear in the same process", () => {
    const events = scenario("agy", "clear")
    expect(new Set(events.map(({ payload }) => payload.conversationId)).size).toBe(2)
    expect(new Set(events.map(({ harnessProcess }) => harnessProcess))).toEqual(
      new Set(["process-1"]),
    )
  })

  it("fires nothing after Esc, in a reply or a running command", () => {
    const events = scenario("agy", "interrupt")
    const reply = indexOf(events, "PreInvocation")
    expect(events[reply + 1]?.event).toBe("PreInvocation")
    expect(after(events, indexOf(events, "PreToolUse"))).toEqual([])
    expect(events.some(({ event }) => event === "Stop" || event === "PostInvocation")).toBe(false)
  })

  it("follows an approved tool with PostToolUse, and a denied one with nothing", () => {
    const events = scenario("agy", "confirm")
    const tools = events.filter(({ event }) => event === "PreToolUse")
    const done = (step: unknown) =>
      events.some(({ event, payload }) => event === "PostToolUse" && payload.stepIdx === step)
    expect(done(tools[0]!.payload.stepIdx)).toBe(true)
    expect(done(tools[1]!.payload.stepIdx)).toBe(false)
    // The denied turn ends without Stop: the next event is the next prompt's invocation.
    expect(after(events, events.indexOf(tools[1]!))[0]).toBe("PreInvocation")
  })
})

describe("Claude Code closed with its terminal, as captured", () => {
  it("ends the session with reason other", () => {
    expect(scenario("claude", "hangup").at(-1)).toMatchObject({
      event: "SessionEnd",
      payload: { reason: "other" },
    })
  })
})
