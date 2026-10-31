import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@novadeck/harness-agy/decode"
import { agy } from "@novadeck/harness-agy/index"
import type { ActivityEvent, HarnessEvent } from "@novadeck/harness-core/events"
import { silentFor, type Launchers, type Machine } from "@novadeck/harness-core/harness"
import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"

import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { apply, started } from "./activity.js"

type Hook = { event: string; in?: Report["payload"] }
const { scenarios } = loadProbe(adapterFolder("agy"), "ask.probe.json") as {
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
    // Beside the session, only the call it reports and the model it names, as every
    // hook's model name is.
    expect(decode(report("PreToolUse", payload))).toMatchObject([
      { type: "session-observed" },
      { type: "tool-called", toolName: "run_command", kind: "work" },
      { type: "telemetry-observed" },
    ])
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

// As Antigravity runs it on Windows: `cmd /c "<command>"`, its double quotes escaped as
// `\"`, which cmd keeps (probed 2026-10-11, 1.2.14); verbatim, as Node escapes otherwise.
const cmdRun = (env: NodeJS.ProcessEnv, event = "PreToolUse") => {
  const run = spawnSync(
    process.env.COMSPEC ?? "cmd.exe",
    ["/c", `"${agy.hook("win32", event).replaceAll('"', String.raw`\"`)}"`],
    {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        ...env,
      },
      encoding: "utf8",
      windowsVerbatimArguments: true,
    },
  )
  return { status: run.status, stdout: run.stdout.trim() }
}

describe("Antigravity's PreToolUse answer", () => {
  it("is ask wherever it prints one: Novadeck's runner, its launcher, and the hook command alone", () => {
    expect(JSON.parse(silentFor(agy.messaging, "PreToolUse"))).toEqual({ decision: "ask" })
    // Never one that asks the runner, which could wait on it.
    expect(Object.keys(agy.messaging.asks)).not.toContain("PreToolUse")
    expect(agy.hook("linux", "PreToolUse")).toContain(`[ -x "$NOVADECK_HOOK" ]`)
    expect(agy.hook("linux", "PreToolUse")).toContain(`else echo '{"decision":"ask"}'; fi`)
    // cmd's hold no double quote, which Antigravity escapes where cmd keeps the escape, and
    // PreToolUse's prints nothing without a runnable launcher and always exits 0: an answer
    // that isn't JSON there, or a non-zero exit, let the tool run unasked, where none leaves
    // it to the person's policy.
    expect(agy.hook("win32", "PreToolUse")).toBe(
      "cmd /d /c if defined NOVADECK_HOOK (if exist %NOVADECK_HOOK% (%NOVADECK_HOOK% agy PreToolUse)) & exit /b 0",
    )
    expect(agy.hook("win32", "Stop")).toBe(
      "if defined NOVADECK_HOOK (if exist %NOVADECK_HOOK% (%NOVADECK_HOOK% agy Stop) else (echo {})) else (echo {})",
    )
    for (const event of ["PreToolUse", "PreInvocation", "Stop", "PostToolUse"])
      expect(agy.hook("win32", event)).not.toContain('"')
    expect(agy.hook("linux", "Stop")).toContain(`else echo '{}'; fi`)
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

  // Antigravity runs it in cmd there, and on no answer asks as the person's policy says.
  it.runIf(process.platform === "win32")(
    "is nothing from cmd, exiting 0, when its launcher is unset, missing or named with a space",
    ({ resources }) => {
      const nothing = { status: 0, stdout: "" }
      expect(cmdRun({})).toEqual(nothing)
      expect(cmdRun({ NOVADECK_HOOK: String.raw`C:\nonexistent\hook.exe` })).toEqual(nothing)
      // A space breaks the inner line, as an `&` does the outer one too; it still exits 0.
      expect(cmdRun({ NOVADECK_HOOK: String.raw`C:\Program Files\x\hook.exe` })).toEqual(nothing)
      expect(cmdRun({ NOVADECK_HOOK: String.raw`C:\Users\a&b\hook.exe` })).toEqual(nothing)
      // A launcher's own answer passes through.
      const folder = mkdtempSync(join(tmpdir(), "novadeck-agy-hook-"))
      resources.defer(() => rmSync(folder, { recursive: true, force: true }))
      const launcher = join(folder, "launcher.cmd")
      writeFileSync(launcher, '@echo {"decision":"ask","by":"launcher"}')
      expect(cmdRun({ NOVADECK_HOOK: launcher })).toEqual({
        status: 0,
        stdout: '{"decision":"ask","by":"launcher"}',
      })
      // The other events' empty answer is JSON as cmd prints it.
      expect(cmdRun({}, "Stop")).toEqual({ status: 0, stdout: "{}" })
    },
  )

  it("is registered for every tool, with PostToolUse for the three that matter", () => {
    const launchers: Launchers = { mcp: { command: "/data/shell/mcp" } }
    const hooks = (platform: NodeJS.Platform, machine?: Machine) =>
      (
        JSON.parse(
          agy.files(platform, launchers, machine).find(({ path }) => path === "hooks.json")!
            .content,
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
        "write_file",
        "edit_file",
        "write_to_file",
        "replace_file_content",
        "ask_question",
      ])
    }
  })

  it("is the relay alone on Windows where a path names it, and unregistered where none does", () => {
    const relay = {
      command: String.raw`C:\Users\a\AppData\Roaming\Novadeck\shell\novadeck-relay.exe`,
      args: ["hook", "--config", String.raw`C:\Users\a\AppData\Roaming\Novadeck\shell\relay.json`],
    }
    const files = (launchers: Launchers, machine?: Machine) =>
      JSON.parse(
        agy.files("win32", launchers, machine).find(({ path }) => path === "hooks.json")!.content,
      ) as { novadeck: { [event: string]: { hooks: { command: string; timeout: number }[] }[] } }
    const command = `${relay.command} hook --config ${relay.args[2]} agy PreToolUse`
    expect(agy.hook("win32", "PreToolUse", { mcp: { command: "mcp" }, hook: relay })).toBe(command)
    const registered = files({ mcp: { command: "mcp" }, hook: relay }).novadeck
    expect(Object.keys(registered)).toEqual(["PreInvocation", "Stop", "PreToolUse", "PostToolUse"])
    expect(registered.PreToolUse).toMatchObject([
      { matcher: "*", hooks: [{ command, timeout: 30 }] },
    ])
    // The relay is the whole command: no cmd, no quote, nothing but a path and words.
    expect(command).not.toMatch(/cmd|["&|<>^%]/i)
    // Its other events keep cmd's line with the fallback.
    expect(registered.Stop?.[0]).toMatchObject({ command: agy.hook("win32", "Stop") })
    // No path cmd reads as it is: nothing registered, as in Antigravity's own policy.
    expect(Object.keys(files({ mcp: { command: "mcp" } }).novadeck)).toEqual([
      "PreInvocation",
      "Stop",
      "PostToolUse",
    ])
    // Elsewhere the relay's command line plays no part.
    expect(agy.hook("linux", "PreToolUse", { mcp: { command: "mcp" }, hook: relay })).toBe(
      agy.hook("linux", "PreToolUse"),
    )
  })

  it("is left unregistered on Windows where cmd prints first, so Antigravity's policy asks", () => {
    // No answer after an AutoRun's output reads as JSON, which let every tool run unasked
    // (probed 2026-10-11, 1.2.14), and the relay alone is no safer until a probe shows
    // Antigravity does not wrap it in cmd.
    expect(eventsWhereCmdPrints("win32")).toEqual(["PreInvocation", "Stop", "PostToolUse"])
    // Elsewhere hooks run in sh, where cmd's AutoRun has no part.
    expect(eventsWhereCmdPrints("linux")).toContain("PreToolUse")
  })
})

// The events Antigravity's plugin registers where cmd prints before every command.
const eventsWhereCmdPrints = (platform: NodeJS.Platform) =>
  Object.keys(
    (
      JSON.parse(
        agy
          .files(
            platform,
            { mcp: { command: "mcp" }, hook: { command: String.raw`C:\r.exe`, args: ["hook"] } },
            { cmdPrints: true },
          )
          .find(({ path }) => path === "hooks.json")!.content,
      ) as { novadeck: object }
    ).novadeck,
  )
