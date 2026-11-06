import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@novadeck/harness-agy/decode"
import {
  statusLineCommand,
  statusLineLimit,
  statusLineSettings,
  windowsStatusLine,
} from "@novadeck/harness-agy/settings"
import { shown, startupScreen } from "@novadeck/harness-agy/status-line"
import type { ActivityEvent, HarnessEvent } from "@novadeck/harness-core/events"
import type { Install } from "@novadeck/harness-core/harness"
import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it as base } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { apply as applyActivity, started, summary } from "./activity.js"
import { harnesses } from "./registry.js"

const { payloads } = loadProbe(adapterFolder("agy"), "statusline.probe.json") as {
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

  it("names the screen it is at before a conversation, and no other's", () => {
    const [authenticating, initializing, idle] = payloads
    expect(startupScreen(report(authenticating!))).toBe("sign-in")
    expect(startupScreen(report(initializing!))).toBe("startup")
    expect(startupScreen(report(idle!))).toBeUndefined()
    expect(startupScreen(report(payloads[5]!))).toBeUndefined()
    expect(startupScreen({ ...report(authenticating!), event: "Stop" })).toBeUndefined()
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
      { type: "turn-working", ...conversation, startedAt: 5, running: 0 },
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
      { type: "turn-working", ...conversation, startedAt: 5, running: 0 },
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
    const { cycleMode } = loadProbe(adapterFolder("agy"), "modes.probe.json") as {
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

  it("reads the model from every hook, splitting a trailing reasoning level off as the effort", () => {
    const hook = (modelName: string): Report => ({
      ...report({ conversationId: "c1", modelName }),
      event: "PreInvocation",
    })
    const observed = (modelName: string) =>
      decode(hook(modelName)).find(({ type }) => type === "telemetry-observed")
    expect(observed("gemini-3.8-flash-high")).toMatchObject({
      sessionId: "c1",
      model: "gemini-3.8-flash",
      effort: "high",
    })
    // A name without a level clears the last model's.
    expect(observed("gemini-3.8-flash")).toMatchObject({ model: "gemini-3.8-flash", effort: null })
    expect(observed("gemini-3.8-flash-turbo")).toMatchObject({
      model: "gemini-3.8-flash-turbo",
      effort: null,
    })
    // A blank name, or one that could reorder what is shown beside it, is none.
    expect(observed("   ")).toBeUndefined()
    expect(observed("gemini\u202eevil")).toBeUndefined()
    expect(observed("\u200b")).toBeUndefined()
    expect(observed("a\u2028b")).toBeUndefined()
    expect(decode({ ...hook("x"), payload: { conversationId: "c1" } })).not.toContainEqual(
      expect.objectContaining({ type: "telemetry-observed" }),
    )
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
      waiting: null,
    }
    // Its status line may still say working just after the Stop: the turn stays over.
    expect(run([preInvocation(1), stop(2), report(working!, 3)])).toEqual({
      state: "idle",
      ...quiet,
      lastTurn: {
        outcome: "completed",
        reply: null,
        at: expect.any(Number),
        error: null,
        limit: null,
        files: [],
      },
    })
    expect(run([preInvocation(1), report(confirming!, 2)])).toEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
      background: null,
      waiting: null,
      lastTurn: null,
    })
    // Drawn just after the Stop, a snapshot still showing the turn's confirmation asks
    // nothing: only a turn running, or one a working resumed, waits on one.
    expect(run([preInvocation(1), stop(2), report(confirming!, 3)])).toEqual({
      state: "idle",
      ...quiet,
      lastTurn: {
        outcome: "completed",
        reply: null,
        at: expect.any(Number),
        error: null,
        limit: null,
        files: [],
      },
    })
    expect(run([preInvocation(1), report(idle!, 2), report(confirming!, 3)])).toEqual({
      state: "working",
      attention: { pending: 1, kind: "permission" },
      subagents: [],
      planning: false,
      background: null,
      waiting: null,
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
describe("Antigravity's status line, listing its subagents", () => {
  const { payloads: snapshots } = JSON.parse(
    readFileSync(join(adapterFolder("agy"), "fixtures", "subagents.probe.json"), "utf8"),
  ) as { payloads: Report["payload"][] }
  const conversationId = snapshots[0]!.conversation_id as string
  type Bound = { agent: "agy"; sessionId: string; instance: string }
  const binding: Bound = { agent: "agy", sessionId: conversationId, instance: "7" }
  // Snapshots in the order captured: idle, then working with none, one, two running, the
  // list's order flipping; the root's Stop between the 6th and 7th, whose idle lists one
  // still running; a wake turn, in which the other ends; idle.
  const [idle, none, one, two, mixed, flipped, rest, woken, wokenFlipped, done, over] = snapshots
  const hook = (event: string, seq: number, payload: Report["payload"]): Report => ({
    ...report({ conversationId, ...payload }, seq),
    event,
  })
  const preInvocation = (seq: number) => hook("PreInvocation", seq, { invocationNum: 0 })
  const stop = (seq: number, fullyIdle: boolean) => hook("Stop", seq, { fullyIdle })
  // The activity as clients see it after each report, in the order given.
  const activityOf = (reported: Report) =>
    decode(reported).filter((event): event is ActivityEvent =>
      ["turn-started", "turn-ended", "turn-idle", "turn-working"].includes(event.type),
    )
  const seen = (reports: Report[], bound: Bound = binding) =>
    reports.reduce(
      (state, reported) => {
        const next = activityOf(reported).reduce(
          (each, event) => applyActivity(each, bound, event) ?? each,
          state.activity,
        )
        return { activity: next, shown: [...state.shown, summary(next)] }
      },
      { activity: started(0), shown: [] as ReturnType<typeof summary>[] },
    ).shown
  const counts = (reports: Report[], bound: Bound = binding) =>
    seen(reports, bound).map(({ state, background }) => [state, background?.agents ?? null])

  it("counts the subagents running by status, whatever order it lists them in", () => {
    const decoded = (payload: Report["payload"]) =>
      decode(report(payload)).find(({ type }) => type === "turn-working")
    expect(decoded(none!)).toMatchObject({ running: 0 })
    expect(decoded(one!)).toMatchObject({ running: 1 })
    expect(decoded(two!)).toMatchObject({ running: 2 })
    expect(decoded(mixed!)).toMatchObject({ running: 1 })
    expect(decoded(flipped!)).toMatchObject({ running: 1 })
    expect(decoded(done!)).toMatchObject({ running: 0 })
  })

  it("shows the subagents running while the turn does, and after it, through a wake turn", () => {
    const reports = [
      report(idle!, 10),
      preInvocation(15),
      report(none!, 20),
      report(one!, 30),
      report(two!, 40),
      report(mixed!, 50),
      report(flipped!, 60),
      stop(65, false),
      report(rest!, 70),
      preInvocation(75),
      report(woken!, 80),
      report(wokenFlipped!, 90),
      report(done!, 100),
      stop(105, true),
      report(over!, 110),
    ]
    expect(counts(reports)).toEqual([
      ["idle", null],
      ["working", null],
      ["working", null],
      ["working", 1],
      ["working", 2],
      ["working", 1],
      ["working", 1],
      // The Stop says only that something runs on, until the idle line counts it.
      ["working", 0],
      ["working", 1],
      // The wake turn: what runs shows from its first working snapshot.
      ["working", null],
      ["working", 1],
      ["working", 1],
      ["working", null],
      ["idle", null],
      ["idle", null],
    ])
  })

  describe("listing them late (1.5)", () => {
    const { payloads: late } = JSON.parse(
      readFileSync(join(adapterFolder("agy"), "fixtures", "subagents.probe.1.5.2.json"), "utf8"),
    ) as { payloads: Report["payload"][] }
    const [bare, listed, ended, task, both] = late

    // What's remembered is each conversation's, so each test has its own, followed as
    // Novadeck follows a bound one.
    let conversations = 100
    const opened: AbortController[] = []
    const follow = (id: string, instance = "7") => {
      const told: HarnessEvent[] = []
      const following = new AbortController()
      opened.push(following)
      void harnesses.agy.watch!(
        { sessionId: id, instance, transcript: "/t" },
        following.signal,
        (event) => told.push(event),
      )
      return { told, following }
    }
    const conversation = ({ followed = true } = {}) => {
      conversations += 1
      const id = `00000000-0000-4000-8000-${String(conversations).padStart(12, "0")}`
      const bound = { agent: "agy", sessionId: id, instance: "7" } as const
      const at = (event: string, seq: number, payload: Report["payload"]) =>
        hook(event, seq, { conversationId: id, ...payload })
      return {
        id,
        bound,
        told: followed ? follow(id).told : [],
        invocation: (seq: number) => at("PreInvocation", seq, { invocationNum: 0 }),
        ended: (seq: number, fullyIdle: boolean) => at("Stop", seq, { fullyIdle }),
        called: (seq: number, name = "invoke_subagent") =>
          at("PreToolUse", seq, { toolCall: { name, args: {} } }),
        snapshot: (payload: Report["payload"], seq: number) =>
          report({ ...payload, conversation_id: id, session_id: id }, seq),
        counts: (reports: Report[]) => counts(reports, bound),
      }
    }
    afterEach(() => {
      for (const following of opened.splice(0)) following.abort()
      vi.useRealTimers()
    })

    // On Windows without PreToolUse (`cmdPrints`) no call is seen.
    for (const tells of [true, false])
      it(`stays working past snapshots that don't list it yet, its call ${tells ? "" : "not "}seen`, () => {
        const c = conversation()
        const start = [c.invocation(1), ...(tells ? [c.called(2)] : []), c.ended(3, false)]
        expect(
          c
            .counts([
              ...start,
              c.snapshot(bare!, 4),
              c.snapshot(bare!, 5),
              c.snapshot(listed!, 6),
              c.invocation(7),
              c.ended(8, true),
              c.snapshot(ended!, 9),
            ])
            .slice(start.length),
        ).toEqual([
          ["working", 0],
          ["working", 0],
          ["working", 1],
          ["working", null],
          ["idle", null],
          ["idle", null],
        ])
      })

    it("settles at the first snapshot that counts the command a turn left, calling no subagent", () => {
      const c = conversation()
      expect(
        c.counts([
          c.invocation(1),
          c.called(2, "run_command"),
          c.ended(3, false),
          c.snapshot(task!, 4),
        ]),
      ).toMatchObject([expect.anything(), expect.anything(), ["working", 0], ["idle", 0]])
    })

    it("counts the subagent of a turn that left a command too", () => {
      const c = conversation()
      expect(
        c.counts([c.invocation(1), c.called(2), c.ended(3, false), c.snapshot(both!, 4)]).at(-1),
      ).toEqual(["working", 1])
    })

    it("doesn't take a task for the subagent its turn called", () => {
      // A dev server an earlier turn left: a task counted, this turn's subagent not listed.
      const c = conversation()
      expect(
        c.counts([c.invocation(1), c.called(2), c.ended(3, false), c.snapshot(task!, 4)]).at(-1),
      ).toEqual(["working", 0])
    })

    it("minds the subagent a turn called, whatever it calls next", () => {
      const c = conversation()
      expect(
        c
          .counts([
            c.invocation(1),
            c.called(2),
            c.called(3, "read_file"),
            c.ended(4, false),
            c.snapshot(task!, 5),
          ])
          .at(-1),
      ).toEqual(["working", 0])
    })

    it("forgets a subagent that a Stop says no longer runs", () => {
      const c = conversation()
      expect(
        c
          .counts([
            c.invocation(1),
            c.called(2),
            c.ended(3, true),
            c.invocation(4),
            c.ended(5, false),
            c.snapshot(task!, 6),
          ])
          .at(-1),
      ).toEqual(["idle", 0])
    })

    it("keeps calling it the subagent's through a continuation of the turn that called it", () => {
      const c = conversation()
      expect(
        c
          .counts([
            c.invocation(1),
            c.called(2),
            c.ended(3, false),
            c.invocation(4),
            c.ended(5, false),
            c.snapshot(task!, 6),
          ])
          .at(-1),
      ).toEqual(["working", 0])
    })

    it("takes a task for what a later turn left, once its subagent has been listed", () => {
      const c = conversation()
      expect(
        c
          .counts([
            c.invocation(1),
            c.called(2),
            c.ended(3, false),
            c.snapshot(listed!, 4),
            c.invocation(5),
            c.ended(6, false),
            c.snapshot(task!, 7),
          ])
          .at(-1),
      ).toEqual(["idle", 0])
    })

    it("takes no task for what a turn left where no PreToolUse hook tells what it called", () => {
      const c = conversation()
      expect(
        c
          .counts([c.invocation(2), c.ended(3, false), c.snapshot(task!, 4), c.snapshot(both!, 5)])
          .slice(-2),
      ).toEqual([
        ["working", 0],
        ["working", 1],
      ])
    })

    it("holds nothing after a Stop that says nothing runs on", () => {
      const c = conversation()
      expect(c.counts([c.invocation(1), c.ended(3, true), c.snapshot(bare!, 4)]).at(-1)).toEqual([
        "idle",
        null,
      ])
    })

    it("holds nothing past a model call, so a later idle snapshot ends an Escaped turn", () => {
      const c = conversation()
      expect(
        c
          .counts([c.invocation(1), c.ended(3, false), c.invocation(4), c.snapshot(bare!, 5)])
          .at(-1),
      ).toEqual(["idle", null])
    })

    it("holds nothing after a turn seen to call no subagent, whatever a snapshot counts", () => {
      const c = conversation()
      expect(
        c
          .counts([
            c.invocation(1),
            c.called(2, "run_command"),
            c.ended(3, false),
            c.snapshot(bare!, 4),
          ])
          .at(-1),
      ).toEqual(["idle", 0])
    })

    it("takes nothing of a snapshot drawn before its Stop for what that Stop left", () => {
      vi.useFakeTimers()
      const c = conversation()
      for (const reported of [
        c.invocation(1),
        c.called(2),
        c.ended(4, false),
        c.snapshot(listed!, 3),
      ])
        activityOf(reported)
      // Its time still runs: activity would drop that snapshot, and nothing else may come.
      vi.advanceTimersByTime(5000)
      expect(c.told).toHaveLength(1)
    })

    it("stops holding once nothing follows it, and for its latest follower alone", () => {
      const c = conversation({ followed: false })
      const first = follow(c.id)
      const second = follow(c.id)
      first.following.abort()
      expect(c.counts([c.ended(1, false), c.snapshot(bare!, 2)]).at(-1)).toEqual(["working", 0])
      activityOf(c.invocation(3))
      second.following.abort()
      expect(c.counts([c.ended(4, false), c.snapshot(bare!, 5)]).at(-1)).toEqual(["idle", 0])
    })

    it("holds nothing nobody would hear the end of, so no terminal stays working", () => {
      const c = conversation({ followed: false })
      expect(c.counts([c.invocation(1), c.ended(3, false), c.snapshot(bare!, 4)]).at(-1)).toEqual([
        "idle",
        0,
      ])
    })

    describe("when nothing ever accounts for it", () => {
      beforeEach(() => {
        vi.useFakeTimers()
      })

      it("takes the latest idle snapshot's count once its time is up, on its own", () => {
        const c = conversation()
        const reports = [c.invocation(1), c.ended(3, false), c.snapshot(bare!, 4)]
        const held = reports
          .flatMap((reported) => activityOf(reported))
          .reduce((state, event) => applyActivity(state, c.bound, event) ?? state, started(0))
        expect(summary(held).state).toBe("working")
        vi.advanceTimersByTime(4999)
        expect(c.told).toEqual([])
        vi.advanceTimersByTime(1)
        expect(c.told).toMatchObject([
          { type: "turn-idle", sessionId: c.id, background: { agents: 0, tasks: 0 } },
        ])
        expect(summary(applyActivity(held, c.bound, c.told[0] as ActivityEvent)!).state).toBe(
          "idle",
        )
      })

      it("gives up on a subagent never listed once its time is up", () => {
        const c = conversation()
        activityOf(c.invocation(1))
        activityOf(c.called(2))
        activityOf(c.ended(3, false))
        vi.advanceTimersByTime(5000)
        expect(c.counts([c.invocation(4), c.ended(5, false), c.snapshot(task!, 6)]).at(-1)).toEqual(
          ["idle", 0],
        )
      })

      it("repeats the latest idle snapshot's count, as one listing may come before the Stop", () => {
        const c = conversation()
        for (const reported of [c.snapshot(listed!, 2), c.invocation(1), c.ended(3, false)])
          activityOf(reported)
        vi.advanceTimersByTime(5000)
        expect(c.told).toMatchObject([{ background: { agents: 1, tasks: 0 } }])
      })

      it("keeps each process's hold apart, as two may run one conversation", () => {
        const c = conversation()
        const other = follow(c.id, "8")
        const in8 = (reported: Report): Report => ({ ...reported, instance: "8" })
        activityOf(c.ended(3, false))
        activityOf(in8(c.ended(4, false)))
        activityOf(in8(c.invocation(5)))
        vi.advanceTimersByTime(5000)
        expect(c.told).toMatchObject([{ instance: "7" }])
        expect(other.told).toEqual([])
      })

      it("fails its follower, not the runner, when telling it throws", async () => {
        const c = conversation({ followed: false })
        const following = new AbortController()
        opened.push(following)
        const followed = harnesses.agy.watch!(
          { sessionId: c.id, instance: "7", transcript: "/t" },
          following.signal,
          () => {
            throw new Error("told")
          },
        )
        activityOf(c.ended(3, false))
        vi.advanceTimersByTime(5000)
        await expect(followed).rejects.toThrow("told")
        // Nothing hears any more, so nothing holds.
        expect(c.counts([c.ended(4, false), c.snapshot(bare!, 5)]).at(-1)).toEqual(["idle", 0])
      })

      it("runs out for no hold a snapshot, a turn or another Stop ended", () => {
        const c = conversation()
        for (const reported of [
          c.ended(3, false),
          c.snapshot(listed!, 4),
          c.ended(5, false),
          c.invocation(6),
          c.ended(7, false),
          c.ended(8, true),
        ])
          activityOf(reported)
        vi.advanceTimersByTime(60_000)
        expect(c.told).toEqual([])
      })
    })
  })

  it("lets no working snapshot of an earlier turn show a count, or a Stop's turn resume", () => {
    // Drawn after the Stop's hook started, it is stale: the turn stays over.
    expect(
      counts([preInvocation(1), report(none!, 2), stop(65, false), report(two!, 66)]).at(-1),
    ).toEqual(["working", 0])
    expect(seen([preInvocation(1), stop(2, true), report(two!, 3)]).at(-1)).toMatchObject({
      state: "idle",
      background: null,
      waiting: null,
    })
    // Drawn before the wake turn's first call, it counts nothing of it; the next
    // snapshot corrects one that arrives later.
    expect(
      counts([
        preInvocation(1),
        stop(2, false),
        report(rest!, 3),
        preInvocation(10),
        report(two!, 9),
        report(done!, 11),
      ]).slice(-2),
    ).toEqual([
      ["working", null],
      ["working", null],
    ])
  })
})

type Fixture = { root: string; install: Install; settings: string }

const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-agy-settings-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const home = join(root, ".gemini", "antigravity-cli")
    mkdirSync(home, { recursive: true })
    const plugin = join(root, "shell", "plugins", "agy")
    mkdirSync(plugin, { recursive: true })
    const install: Install = { env: {}, home: root, platform: "linux", plugin }
    await use({ root, install, settings: join(home, "settings.json") })
  },
})

const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>

describe("connecting Antigravity's status line", () => {
  it("puts Novadeck's in place beside Antigravity's own, and takes it out again", async ({
    fixture,
  }) => {
    writeFileSync(fixture.settings, JSON.stringify({ trustedWorkspaces: ["/w"] }))
    const { apply, revert } = statusLineSettings
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
    const { apply, revert } = statusLineSettings
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
    const { apply, revert } = statusLineSettings
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
    const { apply, revert } = statusLineSettings
    await expect(apply(fixture.install)).rejects.toThrow("not valid settings")
    await revert(fixture.install)
    expect(readFileSync(fixture.settings, "utf8")).toBe("{ not json")
  })

  it("on Windows, reports where the person has no line, and leaves theirs", async ({ fixture }) => {
    const { apply, revert } = statusLineSettings
    const windows = { ...fixture.install, platform: "win32" as const }
    await apply(windows)
    expect(read(fixture.settings).statusLine).toEqual({
      enabled: true,
      stack_with_default: true,
      type: "command",
      command: windowsStatusLine,
    })
    await apply(windows)
    await revert(windows)
    expect(read(fixture.settings)).toEqual({})
    // cmd can't hand one input to two commands, so the person's own line stays theirs.
    const own = JSON.stringify({ statusLine: { type: "command", command: "echo mine" } })
    writeFileSync(fixture.settings, own)
    await apply(windows)
    expect(readFileSync(fixture.settings, "utf8")).toBe(own)
    await revert(windows)
    expect(readFileSync(fixture.settings, "utf8")).toBe(own)
    // A line connected elsewhere still goes back as it was.
    await apply(fixture.install)
    await revert(windows)
    expect(read(fixture.settings).statusLine).toEqual({ type: "command", command: "echo mine" })
  })

  it("says messaging is limited on Windows only where the person's own line stays", async ({
    fixture,
  }) => {
    const { apply } = statusLineSettings
    const windows = { ...fixture.install, platform: "win32" as const }
    await apply(windows)
    expect(await statusLineLimit(windows)).toBeUndefined()
    writeFileSync(
      fixture.settings,
      JSON.stringify({ statusLine: { type: "command", command: "echo mine" } }),
    )
    await apply(windows)
    expect(await statusLineLimit(windows)).toBe("own-status-line")
    // Elsewhere Novadeck's line runs theirs after it.
    expect(await statusLineLimit(fixture.install)).toBeUndefined()
    // A line of theirs without a command shows Antigravity's own, and Novadeck's goes in.
    writeFileSync(fixture.settings, JSON.stringify({ statusLine: { enabled: true } }))
    await apply(windows)
    expect(await statusLineLimit(windows)).toBeUndefined()
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
