import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { Report } from "../../shell/reports.js"
import { describe, expect, it } from "../../test.js"
import { apply, started } from "../activity.js"
import type { ActivityEvent, HarnessEvent } from "../events.js"
import { silentFor, type Launchers } from "../harness.js"
import { decode } from "./decode.js"
import { agy } from "./index.js"

type Hook = { event: string; in?: Report["payload"] }
const { scenarios } = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "ask.probe.json"), "utf8"),
) as {
  scenarios: {
    command: { pending: { hooks: Hook[] } }
    ask_question: { pending: { hooks: Hook[] } }
  }
}
// The fixture's payload, in a conversation with an id a session can have.
const pre = (
  scenario: { pending: { hooks: Hook[] } },
  conversationId = "3bc11b00-fd34-4791-a10c-855d7414bc04",
): Report["payload"] => ({
  ...scenario.pending.hooks.find(({ event }) => event === "PreToolUse")!.in!,
  conversationId,
})

const report = (event: string, payload: Report["payload"], seq = 10): Report => ({
  terminalId: "t",
  token: "0".repeat(48),
  agent: "agy",
  event,
  seq,
  instance: "7",
  env: { cursor: false },
  payload,
})
const attention = (events: readonly HarnessEvent[]) =>
  events.filter(({ type }) => type.startsWith("attention-"))

describe("Antigravity's PreToolUse", () => {
  it("is a question the person is asked, for ask_question, resolved by its PostToolUse", () => {
    const payload = pre(scenarios.ask_question)
    const asked = attention(decode(report("PreToolUse", payload)))
    expect(asked).toEqual([
      {
        type: "attention-requested",
        agent: "agy",
        sessionId: payload.conversationId,
        instance: "7",
        startedAt: 10,
        requestId: "ask_question:2",
        actor: null,
        toolName: "ask_question",
        kind: "question",
        subject: "Which colour?",
        choices: ["Red", "Green", "Blue"],
        // The call as the hook gave it, for the dialog adapter to check its screen against.
        input: payload.toolCall,
      },
    ])
    const answered = attention(decode(report("PostToolUse", payload, 20)))
    expect(answered).toEqual([
      expect.objectContaining({
        type: "attention-resolved",
        requestId: "ask_question:2",
        toolName: "ask_question",
        loose: false,
        outcome: "allowed",
      }),
    ])
    // Through the activity: pending until its result, never settled by anything of its own.
    const binding = {
      agent: "agy" as const,
      sessionId: payload.conversationId as string,
      instance: "7",
    }
    const run = (events: HarnessEvent[]) =>
      events.reduce(
        (state, event) => apply(state, binding, event as ActivityEvent) ?? state,
        started(0),
      )
    expect(run([...attention(decode(report("PreToolUse", payload)))]).pending).toMatchObject([
      { kind: "question", subject: "Which colour?" },
    ])
    expect(
      run([
        ...attention(decode(report("PreToolUse", payload))),
        ...attention(decode(report("PostToolUse", payload, 20))),
      ]).pending,
    ).toEqual([])
  })

  it("asks nothing for any other call, which the person's policy may allow", () => {
    const payload = pre(scenarios.command)
    expect(attention(decode(report("PreToolUse", payload)))).toEqual([])
    expect(decode(report("PreToolUse", payload))).toMatchObject([{ type: "session-observed" }])
    expect(attention(decode(report("PreToolUse", { conversationId: "c" })))).toEqual([])
  })

  it("makes each call's confirmation a request of its own, all settled loosely", () => {
    const first = pre(scenarios.command, "3bc11b00-fd34-4791-a10c-855d7414bc06")
    const status = {
      conversation_id: first.conversationId,
      agent_state: "tool_use",
      tool_confirmation_pending: true,
    }
    const id = (events: readonly HarnessEvent[]) =>
      (attention(events)[0] as { requestId: string }).requestId
    decode(report("PreToolUse", first))
    const one = id(decode(report("StatusLine", status)))
    decode(report("PreToolUse", { ...first, stepIdx: 5 }))
    const two = id(decode(report("StatusLine", status)))
    expect(one).not.toBe(two)
    expect(
      attention(
        decode(
          report("StatusLine", {
            ...status,
            agent_state: "working",
            tool_confirmation_pending: false,
          }),
        ),
      ),
    ).toMatchObject([{ type: "attention-resolved", toolName: "confirmation", loose: true }])
  })

  it("gives the confirmation its status line shows the call its conversation's latest names", () => {
    const payload = pre(scenarios.command, "3bc11b00-fd34-4791-a10c-855d7414bc05")
    const status = {
      conversation_id: payload.conversationId,
      agent_state: "tool_use",
      tool_confirmation_pending: true,
    }
    const confirming = (events: readonly HarnessEvent[]) =>
      attention(events).find(({ type }) => type === "attention-requested")
    // Before its hook, or for a conversation no hook named, it knows no call.
    expect(
      confirming(decode({ ...report("StatusLine", status), agent: "agy" })),
    ).not.toHaveProperty("input")
    decode(report("PreToolUse", payload))
    expect(confirming(decode(report("StatusLine", status)))).toMatchObject({
      // One request for each call it is about.
      requestId: "confirmation:run_command:2",
      kind: "permission",
      input: payload.toolCall,
    })
    // A later call replaces it.
    decode(
      report("PreToolUse", {
        ...payload,
        toolCall: { name: "run_command", args: { CommandLine: "ls" } },
      }),
    )
    expect(confirming(decode(report("StatusLine", status)))).toMatchObject({
      input: { name: "run_command", args: { CommandLine: "ls" } },
    })
    expect(
      confirming(
        decode(
          report("StatusLine", {
            ...status,
            conversation_id: "3bc11b00-fd34-4791-a10c-855d7414bc99",
          }),
        ),
      ),
    ).not.toHaveProperty("input")
  })
})

const hookRun = (env: NodeJS.ProcessEnv) =>
  spawnSync("sh", ["-c", agy.hook("linux", "PreToolUse")], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  }).stdout.trim()

describe("Antigravity's PreToolUse answer", () => {
  it("is ask wherever it prints one: Novadeck's runner, its launcher, and the hook command alone", () => {
    expect(JSON.parse(silentFor(agy.messaging, "PreToolUse"))).toEqual({ decision: "ask" })
    // Never one that asks the runner, which could wait on it.
    expect(Object.keys(agy.messaging.asks)).not.toContain("PreToolUse")
    expect(agy.hook("linux", "PreToolUse")).toContain(`[ -x "$NOVADECK_HOOK" ]`)
    expect(agy.hook("linux", "PreToolUse")).toContain(`else echo '{"decision":"ask"}'; fi`)
    // cmd's hold no double quote, which the agents' spawning escapes where cmd can't read it.
    expect(agy.hook("win32", "PreToolUse")).toBe(
      `if defined NOVADECK_HOOK (if exist %NOVADECK_HOOK% (%NOVADECK_HOOK% agy PreToolUse) else (echo {"decision":"ask"})) else (echo {"decision":"ask"})`,
    )
    expect(agy.hook("win32", "Stop")).toBe(
      "if defined NOVADECK_HOOK (%NOVADECK_HOOK% agy Stop) else (echo {})",
    )
    expect(agy.hook("win32", "PreToolUse")).toMatch(/else \(echo \{"decision":"ask"\}\)$/)
    expect(agy.hook("linux", "Stop")).toContain(`else echo '{}'; fi`)
    expect(agy.hook("win32", "Stop")).toContain("else (echo {})")
  })

  it.skipIf(process.platform === "win32")(
    "is ask from the shell when its launcher is unset, missing or not runnable",
    () => {
      expect(hookRun({})).toBe('{"decision":"ask"}')
      expect(hookRun({ NOVADECK_HOOK: "" })).toBe('{"decision":"ask"}')
      expect(hookRun({ NOVADECK_HOOK: "/nonexistent/hook" })).toBe('{"decision":"ask"}')
      expect(hookRun({ NOVADECK_HOOK: "/etc/hostname" })).toBe('{"decision":"ask"}')
    },
  )

  it("is registered for every tool off Windows, with PostToolUse for the two that matter", () => {
    const launchers: Launchers = { mcp: { command: "/data/shell/mcp" } }
    const hooks = (platform: NodeJS.Platform) =>
      (
        JSON.parse(
          agy.files(platform, launchers).find(({ path }) => path === "hooks.json")!.content,
        ) as {
          novadeck: { [event: string]: { matcher?: string; hooks: { command: string }[] }[] }
        }
      ).novadeck
    for (const platform of ["linux", "darwin"] as const) {
      const registered = hooks(platform)
      expect(Object.keys(registered)).toEqual([
        "PreInvocation",
        "Stop",
        "PreToolUse",
        "PostToolUse",
      ])
      expect(registered.PreToolUse).toMatchObject([
        { matcher: "*", hooks: [{ command: agy.hook(platform, "PreToolUse") }] },
      ])
      expect(registered.PostToolUse?.map(({ matcher }) => matcher)).toEqual([
        "write_to_file",
        "ask_question",
      ])
    }
    // Windows is unprobed: no PreToolUse, which would deny every tool if its command
    // printed nothing, and so no ask_question to detect.
    const windows = hooks("win32")
    expect(Object.keys(windows)).toEqual(["PreInvocation", "Stop", "PostToolUse"])
    expect(windows.PostToolUse?.map(({ matcher }) => matcher)).toEqual(["write_to_file"])
  })
})
