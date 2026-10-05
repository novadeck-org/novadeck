import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import type { Report } from "../shell/reports.js"
import { describe, expect, it } from "../test.js"
import type { HarnessEvent } from "./events.js"
import {
  continuationPrompt,
  doorbellLine,
  doorbellNonce,
  hookSeconds,
  promptStart,
  withoutDoorbell,
  type Launchers,
  silentFor,
} from "./harness.js"
import { harnesses } from "./registry.js"

const delivery =
  '<novadeck-messages note="…">\n<message id="m-1">"hi" & bye</message>\n</novadeck-messages>'

// Each answer is one line of JSON the harness reads.
const line = (text: string): unknown => {
  expect(text.endsWith("\n")).toBe(true)
  expect(text.slice(0, -1)).not.toContain("\n")
  return JSON.parse(text)
}

// What a turn left running, as its decoder counts it.
const counted = (agents: number, tasks: number) => [{ background: { agents, tasks } }]

describe("each harness's hook answers", () => {
  it("continue a Claude Code or Codex Stop with a block, and add prompt-time context", () => {
    for (const agent of ["claude", "codex"] as const) {
      const answers = harnesses[agent].messaging
      expect(answers.asks).toEqual({ Stop: "stop", UserPromptSubmit: "prompt" })
      expect(line(answers.stop(delivery))).toEqual({ decision: "block", reason: delivery })
      expect(line(answers.prompt(delivery))).toEqual({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: delivery },
      })
      // With nothing to deliver they print nothing, as without Novadeck.
      expect(silentFor(answers, "Stop")).toBe("")
      expect(silentFor(answers, "UserPromptSubmit")).toBe("")
    }
  })

  it("continue an Antigravity Stop, inject at its model calls, and always print JSON", () => {
    const answers = harnesses.agy.messaging
    expect(answers.asks).toEqual({ Stop: "stop", PreInvocation: "prompt" })
    expect(line(answers.stop(delivery))).toEqual({ decision: "continue", reason: delivery })
    expect(line(answers.prompt(delivery))).toEqual({
      injectSteps: [{ ephemeralMessage: delivery }],
    })
    expect(line(silentFor(answers, "Stop"))).toEqual({})
    expect(line(silentFor(answers, "PreInvocation"))).toEqual({})
    // An answer without a decision denies the tool.
    expect(line(silentFor(answers, "PreToolUse"))).toEqual({ decision: "ask" })
  })
})

describe("each harness's messaging profile", () => {
  it("says how each harness's root, queued prompts and per-call injections behave", () => {
    expect(harnesses.claude.messaging).toMatchObject({
      reinjectPerCall: false,
      root: "binding",
      silentOnFailure: false,
    })
    expect(harnesses.claude.messaging.queueKey).toBeUndefined()
    expect(harnesses.codex.messaging).toMatchObject({
      reinjectPerCall: false,
      root: "binding",
      queueKey: "\t",
      silentOnFailure: true,
    })
    expect(harnesses.agy.messaging).toMatchObject({
      reinjectPerCall: true,
      root: "status-line",
      silentOnFailure: false,
    })
  })
})

describe("a continuation's prompt", () => {
  it("is a Stop hook's or a delivery's, never the person's", () => {
    expect(continuationPrompt("<hook_prompt>go on</hook_prompt>")).toBe(true)
    expect(continuationPrompt(`text\n${delivery}`)).toBe(true)
    expect(continuationPrompt("Review the Novadeck notice")).toBe(false)
  })
})

describe("a doorbell prompt", () => {
  const base = { agent: "codex", sessionId: "s", instance: "1", startedAt: 1 } as const
  const bell = doorbellLine("k3f9q2")

  it("is a prompt that is exactly the doorbell line, with its nonce", () => {
    expect(doorbellNonce(bell)).toBe("k3f9q2")
    expect(doorbellNonce(` ${bell}\n`)).toBe("k3f9q2")
    expect(doorbellNonce(`fix it ${bell}`)).toBeUndefined()
    expect(doorbellNonce("[Novadeck: automatic notice, agent messages waiting]")).toBeUndefined()
    expect(promptStart(base, bell)).toEqual({
      type: "turn-started",
      ...base,
      cause: "doorbell",
      nonce: "k3f9q2",
    })
  })

  it("keeps a prompt the person's when it only holds a stale line, recorded without it", () => {
    expect(promptStart(base, `${bell}fix the build`)).toEqual({
      type: "turn-started",
      ...base,
      cause: "prompt",
      prompt: "fix the build",
    })
    expect(withoutDoorbell(`half ${bell} typed`)).toBe("half typed")
    expect(promptStart(base, "<hook_prompt>go on</hook_prompt>")).toMatchObject({
      cause: "harness",
    })
    expect(promptStart(base, "anything", true)).toMatchObject({ cause: "harness" })
  })

  it("starts each harness with the doorbell line as its first prompt, Antigravity only where trusted", async ({
    resources,
  }) => {
    const place = { install: undefined, cwd: "/work" }
    await expect(harnesses.claude.messaging.initialPrompt(bell, place)).resolves.toEqual([
      "claude",
      bell,
    ])
    await expect(harnesses.codex.messaging.initialPrompt(bell, place)).resolves.toEqual([
      "codex",
      bell,
    ])
    // Without its settings, Antigravity trusts nothing.
    await expect(harnesses.agy.messaging.initialPrompt(bell, place)).resolves.toBeUndefined()
    const home = mkdtempSync(join(tmpdir(), "novadeck-agy-"))
    resources.defer(() => rmSync(home, { recursive: true, force: true }))
    const trusted = join(home, "trusted")
    mkdirSync(trusted)
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true })
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ trustedWorkspaces: [trusted] }),
    )
    const install = { env: {}, home, platform: process.platform, plugin: join(home, "plugin") }
    await expect(
      harnesses.agy.messaging.initialPrompt(bell, { install, cwd: trusted }),
    ).resolves.toEqual(["agy", "-i", bell])
    await expect(
      harnesses.agy.messaging.initialPrompt(bell, { install, cwd: home }),
    ).resolves.toBeUndefined()
    // The same path, written another way, is trusted; a link to it isn't, failing safe.
    await expect(
      harnesses.agy.messaging.initialPrompt(bell, { install, cwd: `${trusted}/./` }),
    ).resolves.toEqual(["agy", "-i", bell])
    symlinkSync(trusted, join(home, "linked"))
    await expect(
      harnesses.agy.messaging.initialPrompt(bell, { install, cwd: join(home, "linked") }),
    ).resolves.toBeUndefined()
    expect(harnesses.agy.messaging.start).toEqual(["agy"])
  })
})

const launchers: Launchers = { mcp: { command: "/data/shell/mcp" } }
const file = (agent: AgentName, path: string) =>
  JSON.parse(
    harnesses[agent].files("linux", launchers).find((each) => each.path === path)!.content,
  ) as { hooks?: object; novadeck?: object }

// Every handler a hooks.json registers, however its harness nests them.
const handlers = (value: unknown): { command: string; timeout?: number }[] => {
  if (Array.isArray(value)) return value.flatMap(handlers)
  if (typeof value !== "object" || value === null) return []
  if ("command" in value) return [value as { command: string; timeout?: number }]
  return Object.values(value).flatMap(handlers)
}

describe("each harness's hook registrations", () => {
  it("set a timeout well above the hook's own limit, as a slower hook is dropped silently", () => {
    expect(hookSeconds).toBeGreaterThan(5)
    const registered = [
      ...handlers(file("claude", join("novadeck", "hooks", "hooks.json")).hooks),
      ...handlers(file("codex", join("novadeck", "hooks", "hooks.json")).hooks),
      ...handlers(file("agy", "hooks.json").novadeck),
    ]
    expect(registered.length).toBeGreaterThan(15)
    for (const handler of registered) expect(handler.timeout).toBe(hookSeconds)
  })

  it("register every event that asks", () => {
    expect(Object.keys(file("claude", join("novadeck", "hooks", "hooks.json")).hooks!)).toEqual(
      expect.arrayContaining(Object.keys(harnesses.claude.messaging.asks)),
    )
    expect(Object.keys(file("codex", join("novadeck", "hooks", "hooks.json")).hooks!)).toEqual(
      expect.arrayContaining(Object.keys(harnesses.codex.messaging.asks)),
    )
    expect(Object.keys(file("agy", "hooks.json").novadeck!)).toEqual(
      expect.arrayContaining(Object.keys(harnesses.agy.messaging.asks)),
    )
  })
})

type Scenario = { events: { event: string; payload: Report["payload"] }[] }
const scenario = (agent: AgentName, name: string): Scenario =>
  (
    JSON.parse(
      readFileSync(join(import.meta.dirname, agent, "fixtures", "interactive.probe.json"), "utf8"),
    ) as { scenarios: { [name: string]: Scenario } }
  ).scenarios[name]!

const decode = (agent: AgentName, event: string, payload: Report["payload"]) =>
  harnesses[agent].decode({
    terminalId: "t",
    token: "0".repeat(48),
    agent,
    event,
    seq: 1,
    instance: "7",
    env: { cursor: false },
    payload,
  })

// The turn facts among what a harness decoded.
const turns = (events: readonly HarnessEvent[]) =>
  events.filter(({ type }) => type.startsWith("turn-"))

describe("root turns, as each harness reports them", () => {
  it("start an Antigravity turn at its first model call, never taken for the person's prompt", () => {
    const { events } = scenario("agy", "confirm")
    const calls = events
      .filter(({ event }) => event === "PreInvocation")
      .map(({ event, payload }) => turns(decode("agy", event, payload))[0])
    // A subagent's message wakes it alike, so whether the person prompted can't be told.
    expect(calls.map((call) => call?.type === "turn-started" && call.cause)).toEqual([
      "harness",
      "call",
      "harness",
      "harness",
      "call",
    ])
    // Without a number, it may be any call: never taken for the first.
    expect(turns(decode("agy", "PreInvocation", { conversationId: "c" }))).toMatchObject([
      { cause: "call" },
    ])
  })

  it("end an Antigravity turn at its Stop, saying whether background work still runs", () => {
    const stops = scenario("agy", "confirm")
      .events.filter(({ event }) => event === "Stop")
      .map(({ event, payload }) => turns(decode("agy", event, payload)))
    expect(stops).toMatchObject([
      [{ type: "turn-ended", outcome: "completed", background: { agents: 0, tasks: 0 } }],
      // It says only that something runs on, uncounted.
      [
        {
          type: "turn-ended",
          outcome: "completed",
          background: { agents: 0, tasks: 0, more: true },
        },
      ],
    ])
    expect(
      turns(decode("agy", "Stop", { conversationId: "c", error: "quota", fullyIdle: true })),
    ).toMatchObject([{ outcome: "failed" }])
  })

  it("never take Antigravity's idle status line for a completed turn", () => {
    const idle = decode("agy", "StatusLine", { conversation_id: "c", agent_state: "idle" })
    expect(turns(idle)).toEqual([
      {
        type: "turn-idle",
        agent: "agy",
        sessionId: "c",
        instance: "7",
        startedAt: 1,
        background: { agents: 0, tasks: 0 },
      },
    ])
    // Its subagents still running keep the turn's work going, each counted.
    const running = (subagents: unknown) =>
      turns(decode("agy", "StatusLine", { conversation_id: "c", agent_state: "idle", subagents }))
    expect(running([{ id: "s1" }])).toMatchObject(counted(1, 0))
    expect(
      running([
        { name: "self", status: "running" },
        { name: "self", status: "running" },
        { name: "self", status: "completed" },
      ]),
    ).toMatchObject(counted(2, 0))
    expect(running([{ id: "s1", status: "completed" }])).toMatchObject(counted(0, 0))
    expect(running([])).toMatchObject(counted(0, 0))
    expect(idle[0]).toMatchObject({ type: "session-observed", root: true })
    // Its hooks name subagents' conversations alike, so none of theirs is the root's word.
    expect(decode("agy", "PreInvocation", { conversationId: "c" })[0]).not.toHaveProperty("root")
  })

  it("tell a Claude Code turn it started by itself, and background tasks still running", () => {
    const prompt = (text: string) =>
      turns(decode("claude", "UserPromptSubmit", { session_id: "s", prompt: text }))
    expect(prompt("Review a.ts")).toMatchObject([
      { type: "turn-started", cause: "prompt", prompt: "Review a.ts" },
    ])
    expect(prompt("<task-notification>\n<task-id>b1</task-id>")).toMatchObject([
      { cause: "harness" },
    ])
    const stop = (tasks: unknown) =>
      turns(decode("claude", "Stop", { session_id: "s", background_tasks: tasks }))
    expect(stop([{ id: "b1", type: "shell", status: "running" }])).toMatchObject(counted(0, 1))
    // Its subagents apart from the rest, and only a running one counts.
    expect(
      stop([
        { id: "a1", type: "subagent", status: "running" },
        { id: "a2", type: "subagent", status: "running" },
        { id: "b1", type: "shell", status: "running" },
        { id: "b2", type: "shell", status: "completed" },
        { id: "b3" },
      ]),
    ).toMatchObject(counted(2, 1))
    expect(stop([])).toMatchObject(counted(0, 0))
    expect(stop(undefined)).toMatchObject(counted(0, 0))
  })

  it("never take a Stop hook's continuation for the person's prompt", () => {
    for (const agent of ["claude", "codex"] as const)
      for (const prompt of [
        "<hook_prompt>Stop hook feedback</hook_prompt>",
        '<novadeck-messages note="…">\n<message id="m-1">hi</message>\n</novadeck-messages>',
      ])
        expect(turns(decode(agent, "UserPromptSubmit", { session_id: "s", prompt }))).toEqual([
          {
            type: "turn-started",
            agent,
            sessionId: "s",
            instance: "7",
            startedAt: 1,
            cause: "harness",
          },
        ])
  })

  it("leave a subagent's prompt out of the root's turns", () => {
    for (const agent of ["claude", "codex"] as const)
      expect(
        turns(decode(agent, "UserPromptSubmit", { session_id: "s", agent_id: "a", prompt: "x" })),
      ).toEqual([])
    expect(turns(decode("codex", "UserPromptSubmit", { session_id: "s" }))).toMatchObject([
      { cause: "prompt" },
    ])
  })
})

describe("files an agent wrote, as each harness reports them", () => {
  const touched = (agent: AgentName, event: string, payload: Report["payload"]) =>
    decode(agent, event, payload).filter(({ type }) => type === "file-touched")

  it("come from Claude Code's writers, by their absolute paths", () => {
    const write = (tool: string, input: object) =>
      touched("claude", "PostToolUse", { session_id: "s", tool_name: tool, tool_input: input })
    expect(write("Write", { file_path: "/w/a.ts" })).toMatchObject([
      { path: "/w/a.ts", actor: null },
    ])
    expect(write("Edit", { file_path: "/w/b.ts" })).toMatchObject([{ path: "/w/b.ts" }])
    expect(write("NotebookEdit", { notebook_path: "/w/n.ipynb" })).toMatchObject([
      { path: "/w/n.ipynb" },
    ])
    expect(write("Read", { file_path: "/w/a.ts" })).toEqual([])
    expect(write("Write", { file_path: "relative.ts" })).toEqual([])
  })

  it("come from Codex's patches, from the session's folder", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "*** Add File: /abs/b.ts",
      "*** End Patch",
    ].join("\n")
    expect(
      touched("codex", "PostToolUse", {
        session_id: "s",
        cwd: "/w",
        tool_name: "apply_patch",
        tool_input: { command: patch },
      }).map((event) => event.type === "file-touched" && event.path),
    ).toEqual([resolve("/w", "src/a.ts"), "/abs/b.ts"])
  })

  it("come from Antigravity's write_to_file", () => {
    expect(
      touched("agy", "PostToolUse", {
        conversationId: "c",
        toolCall: { name: "write_to_file", args: { TargetFile: "/w/c.md" } },
      }),
    ).toMatchObject([{ path: "/w/c.md" }])
  })
})

describe("Claude Code's and Codex's decoders", () => {
  const bell = doorbellLine("k3f9q2")

  it("tell a doorbell prompt from the person's, and keep a stale line out of theirs", () => {
    for (const agent of ["claude", "codex"] as const) {
      const turn = (prompt: string) =>
        decode(agent, "UserPromptSubmit", { session_id: "s1", prompt }).find(
          (event) => event.type === "turn-started",
        )
      expect(turn(bell)).toMatchObject({ cause: "doorbell", nonce: "k3f9q2" })
      expect(turn(`fix the build ${bell}`)).toMatchObject({
        cause: "prompt",
        prompt: "fix the build",
      })
    }
  })
})
