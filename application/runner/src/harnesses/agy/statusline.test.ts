import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Report } from "../../shell/reports.js"
import { describe, expect, it as base } from "../../test.js"
import { loadProbe } from "../../testing/probes.js"
import { apply as applyActivity, started, summary } from "../activity.js"
import type { ActivityEvent } from "../events.js"
import type { Install } from "../harness.js"
import { decode, shown } from "./decode.js"
import { statusLineCommand, statusLineSettings } from "./settings.js"

const { payloads } = loadProbe(import.meta.dirname, "statusline.probe.json") as {
  payloads: Report["payload"][]
}
const report = (payload: Report["payload"], seq = 5): Report => ({
  terminalId: "t",
  token: "0".repeat(48),
  agent: "agy",
  event: "StatusLine",
  seq,
  instance: "7",
  env: { cursor: false },
  payload,
})
const activity = (payload: Report["payload"]) =>
  decode(report(payload)).filter(
    ({ type }) => !["session-observed", "telemetry-observed", "mode-observed"].includes(type),
  )
const telemetry = (payload: Report["payload"]) =>
  decode(report(payload)).find(({ type }) => type === "telemetry-observed")

describe("Antigravity's status line, as captured", () => {
  it("says nothing before a conversation starts", () => {
    for (const payload of payloads.slice(0, 3)) expect(decode(report(payload))).toEqual([])
  })

  it("shows its prompt, before any conversation, only once it says idle", () => {
    const [authenticating, initializing, idle] = payloads
    expect(shown(report(authenticating!))).toBeUndefined()
    expect(shown(report(initializing!))).toBeUndefined()
    expect(shown(report(idle!))).toEqual({
      type: "prompt-shown",
      agent: "agy",
      instance: "7",
      startedAt: 5,
    })
    // Another hook, or a conversation it names, is no such prompt.
    expect(shown({ ...report(idle!), event: "Stop" })).toBeUndefined()
    expect(shown(report(payloads[5]!))).toBeUndefined()
  })

  it("names a conversation at its prompt only while it says idle", () => {
    const atPrompt = (payload: Report["payload"]) =>
      decode(report(payload)).find(({ type }) => type === "session-observed")
    const [, , , working, , idle] = payloads
    expect(atPrompt(idle!)).toMatchObject({ atPrompt: true, root: true })
    expect(atPrompt(working!)).not.toHaveProperty("atPrompt")
  })

  it("tells a confirmation waiting on the person, and its answer", () => {
    const [, , , working, confirming, idle] = payloads
    const conversation = { agent: "agy", sessionId: working!.conversation_id, instance: "7" }
    expect(decode(report(working!))[0]).toEqual({
      type: "session-observed",
      ...conversation,
      startedAt: 5,
      evidence: "conversation-observed",
      cwd: "/home/user/project",
      // The status line names the root conversation; hooks name subagents' alike.
      root: true,
    })
    // Working never starts a turn, as it may come just after the turn's Stop: it resumes
    // only one an older idle ended, and settles a confirmation the turn waited on.
    expect(activity(working!)).toEqual([
      { type: "turn-working", ...conversation, startedAt: 5 },
      {
        type: "attention-resolved",
        ...conversation,
        startedAt: 5,
        requestId: "confirmation",
        actor: null,
        toolName: "confirmation",
        loose: true,
        outcome: "allowed",
      },
    ])
    expect(activity(confirming!)).toEqual([
      { type: "turn-working", ...conversation, startedAt: 5 },
      {
        type: "attention-requested",
        ...conversation,
        startedAt: 5,
        requestId: "confirmation",
        actor: null,
        toolName: "confirmation",
        kind: "permission",
        subject: null,
        choices: [],
        // Only a turn asks for one: a snapshot showing it after the turn's Stop is stale.
        midTurn: true,
      },
    ])
    // Denied: the turn ends, and no hook says so; idle reads the same after a completed
    // turn, so it is never taken for one.
    expect(activity(idle!)).toEqual([
      { type: "turn-idle", ...conversation, startedAt: 5, background: { agents: 0, tasks: 0 } },
    ])
  })

  it("gives the context window's share in use, and each quota window left", () => {
    const idle = payloads.at(-1)!
    const window = idle.context_window as { context_window_size: number; used_percentage: number }
    expect(telemetry(idle)).toMatchObject({
      context: {
        occupied: Math.round((window.context_window_size * window.used_percentage) / 100),
        capacity: window.context_window_size,
      },
      limits: [
        { minutes: 10_080, used: 0, resetsAt: Date.parse("2026-10-07T00:35:50Z") },
        {
          minutes: 10_080,
          used: expect.closeTo(1 - 0.8638056, 6),
          resetsAt: Date.parse("2026-10-06T21:00:32Z"),
        },
      ],
    })
  })

  it("says whether the agent plans, by the mode it names only when not the default", () => {
    const { cycleMode } = loadProbe(import.meta.dirname, "modes.probe.json") as {
      cycleMode: Record<string, string | null>
    }
    const conversation = payloads.at(-1)!.conversation_id
    const planning = (mode: string | null) =>
      decode(
        report({ conversation_id: conversation, ...(mode === null ? {} : { cycle_mode: mode }) }),
      ).find(({ type }) => type === "mode-observed")
    expect(planning(cycleMode.plan!)).toMatchObject({ planning: true })
    expect(planning(cycleMode["accept-edits"]!)).toMatchObject({ planning: false })
    expect(planning(cycleMode.default!)).toMatchObject({ planning: false })
  })

  it("leaves out what it does not know, and never reads the person's account", () => {
    const conversation = payloads.at(-1)!.conversation_id
    const sparse = { conversation_id: conversation, email: "person@example.com" }
    expect(telemetry(sparse)).toEqual({
      type: "telemetry-observed",
      agent: "agy",
      sessionId: conversation,
      instance: "7",
      startedAt: 5,
    })
    const quota = { soon: { remaining_fraction: 0.5, reset_time: "never" } }
    expect(telemetry({ ...sparse, quota })).toMatchObject({
      limits: [{ minutes: null, used: 0.5, resetsAt: null }],
    })
    expect(JSON.stringify(decode(report(sparse)))).not.toContain("person@example.com")
  })

  it("keep a terminal's activity true to the agent, whatever order their hooks start in", () => {
    const [, , , working, confirming, idle] = payloads
    const conversationId = working!.conversation_id as string
    const binding = { agent: "agy", sessionId: conversationId, instance: "7" } as const
    // Its hooks in the same conversation, each started at `seq`.
    const preInvocation = (seq: number): Report => ({
      ...report({ conversationId, invocationNum: 0 }, seq),
      event: "PreInvocation",
    })
    const stop = (seq: number): Report => ({
      ...report({ conversationId, fullyIdle: true }, seq),
      event: "Stop",
    })
    const run = (reports: Report[]) =>
      summary(
        reports
          .flatMap((reported) => decode(reported))
          .filter((event): event is ActivityEvent =>
            [
              "turn-started",
              "turn-ended",
              "turn-idle",
              "turn-working",
              "attention-requested",
              "attention-resolved",
            ].includes(event.type),
          )
          .reduce((state, event) => applyActivity(state, binding, event) ?? state, started(0)),
      )
    const quiet = {
      attention: { pending: 0, kind: null },
      subagents: [],
      planning: false,
      background: null,
    }
    // Its status line may still say working just after the Stop: the turn stays over.
    expect(run([preInvocation(1), stop(2), report(working!, 3)])).toEqual({
      state: "idle",
      ...quiet,
      lastTurn: { outcome: "completed", reply: null, at: expect.any(Number) },
    })
    expect(run([preInvocation(1), report(confirming!, 2)])).toEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
      background: null,
      lastTurn: null,
    })
    // Drawn just after the Stop, a snapshot still showing the turn's confirmation asks
    // nothing: only a turn running, or one a working resumed, waits on one.
    expect(run([preInvocation(1), stop(2), report(confirming!, 3)])).toEqual({
      state: "idle",
      ...quiet,
      lastTurn: { outcome: "completed", reply: null, at: expect.any(Number) },
    })
    expect(run([preInvocation(1), report(idle!, 2), report(confirming!, 3)])).toEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
      background: null,
      lastTurn: null,
    })
    // Working again: the confirmation was answered, and the turn goes on.
    expect(run([preInvocation(1), report(confirming!, 2), report(working!, 3)])).toEqual({
      state: "working",
      ...quiet,
      lastTurn: null,
    })
    // An idle snapshot whose hook started before the turn's does not end it.
    expect(run([report(idle!, 1), preInvocation(2)])).toMatchObject({ state: "working" })
    expect(run([preInvocation(2), report(idle!, 1)])).toMatchObject({ state: "working" })
    // A stale idle snapshot mid-turn: the working one after it says the turn goes on.
    expect(run([preInvocation(1), report(idle!, 2), report(working!, 3)])).toEqual({
      state: "working",
      ...quiet,
      lastTurn: null,
    })
    // As after a Stop, working after an idle that followed the Stop resumes nothing.
    expect(run([preInvocation(1), stop(2), report(idle!, 3), report(working!, 4)])).toMatchObject({
      state: "idle",
    })
  })

  it("keeps a turn the person's Esc ended over against a working snapshot older than its idle", () => {
    const [, , , working, , idle] = payloads
    const conversationId = working!.conversation_id as string
    const binding = { agent: "agy", sessionId: conversationId, instance: "7" } as const
    const preInvocation: Report = {
      ...report({ conversationId, invocationNum: 0 }, 1),
      event: "PreInvocation",
    }
    const run = (reports: Report[]) =>
      reports
        .flatMap((reported) => decode(reported))
        .filter((event): event is ActivityEvent =>
          ["turn-started", "turn-idle", "turn-working"].includes(event.type),
        )
        .reduce((state, event) => applyActivity(state, binding, event) ?? state, started(0)).state
    // An Esc shows only as idle; a working snapshot drawn before it, arriving after,
    // resumes nothing.
    expect(run([preInvocation, report(idle!, 3), report(working!, 2)])).toBe("idle")
    expect(run([preInvocation, report(idle!, 3), report(working!, 3)])).toBe("idle")
    // One drawn after it is taken at its word, as the idle may have been the stale one.
    expect(run([preInvocation, report(idle!, 3), report(working!, 4)])).toBe("working")
  })
})
type Fixture = { root: string; install: Install; settings: string }

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-agy-settings-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const home = join(root, "antigravity-cli")
    mkdirSync(home)
    const plugin = join(root, "shell", "plugins", "agy")
    mkdirSync(plugin, { recursive: true })
    const install: Install = { env: {}, home: root, platform: "linux", plugin }
    await use({ root, install, settings: join(home, "settings.json") })
  },
})

const settingsOf = (fixture: Fixture) =>
  statusLineSettings(() => join(fixture.root, "antigravity-cli"))
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>

describe("connecting Antigravity's status line", () => {
  it("puts Novadeck's in place beside Antigravity's own, and takes it out again", async ({
    fixture,
  }) => {
    writeFileSync(fixture.settings, JSON.stringify({ trustedWorkspaces: ["/w"] }))
    const { apply, revert } = settingsOf(fixture)
    await apply(fixture.install)
    await apply(fixture.install)
    expect(read(fixture.settings)).toEqual({
      trustedWorkspaces: ["/w"],
      statusLine: {
        enabled: true,
        stack_with_default: true,
        type: "command",
        command: statusLineCommand(undefined),
      },
    })
    await revert(fixture.install)
    await revert(fixture.install)
    expect(read(fixture.settings)).toEqual({ trustedWorkspaces: ["/w"] })
  })

  it("gives the person's own status line back from the settings alone", async ({ fixture }) => {
    const own = { type: "command", command: "printf '%s' \"it's\"\n# mine", enabled: true }
    writeFileSync(fixture.settings, JSON.stringify({ statusLine: own }))
    const { apply, revert } = settingsOf(fixture)
    await apply(fixture.install)
    expect(read(fixture.settings).statusLine).toEqual({
      ...own,
      command: statusLineCommand(own.command),
    })
    // Another Novadeck connected it too; what the person changed meanwhile stays.
    await apply({ ...fixture.install, plugin: join(fixture.root, "elsewhere") })
    const connected = read(fixture.settings)
    writeFileSync(
      fixture.settings,
      JSON.stringify({ statusLine: { ...(connected.statusLine as object), enabled: false } }),
    )
    await revert({ ...fixture.install, plugin: join(fixture.root, "elsewhere") })
    expect(read(fixture.settings)).toEqual({ statusLine: { ...own, enabled: false } })
    await revert(fixture.install)
    expect(read(fixture.settings)).toEqual({ statusLine: { ...own, enabled: false } })
  })

  it("keeps what the person had without a command of theirs", async ({ fixture }) => {
    const { apply, revert } = settingsOf(fixture)
    const cases = [
      [{ enabled: false }, { enabled: false }],
      [{ command: "echo untyped" }, { type: "command", command: "echo untyped" }],
      [
        { type: "", command: "echo empty" },
        { type: "command", command: "echo empty" },
      ],
      [{ type: "command", command: "", padding: 3 }, { padding: 3 }],
      [
        { type: "static", command: "echo typed" },
        { type: "command", command: "echo typed" },
      ],
      [null, undefined],
    ] as const
    for (const [own, back] of cases) {
      writeFileSync(fixture.settings, JSON.stringify({ statusLine: own }))
      // eslint-disable-next-line no-await-in-loop -- Each case rewrites the same file.
      await apply(fixture.install)
      const command = (read(fixture.settings).statusLine as { command: string }).command
      if (own && "command" in own && own.command) expect(command).toContain(own.command)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await revert(fixture.install)
      expect(read(fixture.settings).statusLine).toEqual(back)
    }
  })

  it("leaves settings it cannot read as they are, and still disconnects", async ({ fixture }) => {
    writeFileSync(fixture.settings, "{ not json")
    const { apply, revert } = settingsOf(fixture)
    await expect(apply(fixture.install)).rejects.toThrow("not valid settings")
    await revert(fixture.install)
    expect(readFileSync(fixture.settings, "utf8")).toBe("{ not json")
  })

  it("leaves Windows as it is", async ({ fixture }) => {
    const own = JSON.stringify({ statusLine: { type: "command", command: "echo mine" } })
    writeFileSync(fixture.settings, own)
    const { apply, revert } = settingsOf(fixture)
    await apply({ ...fixture.install, platform: "win32" })
    expect(readFileSync(fixture.settings, "utf8")).toBe(own)
    await apply(fixture.install)
    await revert({ ...fixture.install, platform: "win32" })
    expect(read(fixture.settings).statusLine).toMatchObject({
      command: statusLineCommand("echo mine"),
    })
  })
})

describe.skipIf(process.platform === "win32")("Novadeck's status line for Antigravity", () => {
  it("hands its input to Novadeck's hook, then shows the person's own", ({ fixture }) => {
    const hook = join(fixture.root, "hook")
    const log = join(fixture.root, "hook.log")
    writeFileSync(hook, `#!/bin/sh\necho "$1 $2 $(cat)" > "${log}"\necho noise\n`, { mode: 0o755 })
    const own = `cat | tr a-z A-Z; echo; echo "it's mine"`
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync("sh", ["-c", statusLineCommand(own)], {
        input: '{"a":1}',
        encoding: "utf8",
        env: { ...process.env, ...env },
      }).stdout
    expect(run({ NOVADECK_HOOK: hook })).toBe(`{"A":1}\nit's mine\n`)
    expect(readFileSync(log, "utf8")).toBe('agy StatusLine {"a":1}\n')
    rmSync(log)
    expect(run({ NOVADECK_HOOK: "" })).toBe(`{"A":1}\nit's mine\n`)
    expect(() => readFileSync(log)).toThrow()
  })

  it("stays quiet when Novadeck's hook cannot run", ({ fixture }) => {
    const result = spawnSync("sh", ["-c", statusLineCommand(undefined)], {
      input: "{}",
      encoding: "utf8",
      env: { ...process.env, NOVADECK_HOOK: join(fixture.root, "missing") },
    })
    expect(result).toMatchObject({ status: 0, stdout: "" })
  })
})
