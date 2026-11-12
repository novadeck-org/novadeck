import type { HarnessEvent } from "@novadeck/harness-core/events"
import { vi } from "vitest"

import { harnesses } from "../../harnesses/registry.js"
import type { Answer } from "../../messaging/hook-answers.js"
import { describe, expect, it } from "../../test.js"
import { RootFolder } from "../../worktrees/root-folder.js"
import {
  fired,
  noNudges,
  sessionBegan,
  worktreesEarlyNotice,
  worktreesOffNotice,
  worktreesOnNotice,
} from "../nudges.js"
import type { Record } from "../record.js"
import { Reports, type ReportsHost } from "./reports.js"

describe("a root turn's prompt told from the transcript", () => {
  // Their hooks name the prompt (UserPromptSubmit), so a session bound at its prompt, as a
  // resumed one, takes its first prompt as any other: nothing is read or changed.
  for (const agent of ["claude", "codex"] as const)
    it(`leaves ${agent}'s turns as its hooks told them`, async () => {
      expect(harnesses[agent].messaging.typedEntry).toBeUndefined()
      const record = {
        summary: { id: "T" },
        root: { agent, sessionId: "s", instance: "1", source: "status-line" },
        transcript: "/t.jsonl",
        seenEntry: undefined,
      } as unknown as Record
      const events: HarnessEvent[] = [
        {
          type: "turn-started",
          agent,
          sessionId: "s",
          instance: "1",
          startedAt: 1,
          cause: "prompt",
        },
      ]
      // A host that fails any use: none is needed.
      const reports = new Reports(new Proxy({}, { get: () => () => expect.fail() }) as ReportsHost)
      expect(await reports.attributed(record, events)).toBe(events)
      expect(record.seenEntry).toBeUndefined()
    })
})

describe("the screen an agent says it is at before its first session", () => {
  const saying = async (
    agent: "agy" | "claude",
    expecting: string,
    ...states: readonly (string | readonly [state: string, seq: number])[]
  ) => {
    const record = {
      token: "tok",
      expecting,
      startupScreen: undefined,
      terminal: { exiting: false },
      bound: null,
    } as unknown as Record
    const reports = new Reports({
      records: () => new Map([["T", record]]),
      bindings: () => ({}),
    } as unknown as ReportsHost)
    for (const said of states) {
      const [state, seq] = typeof said === "string" ? [said, 1] : said
      // oxlint-disable-next-line no-await-in-loop -- Reports arrive in turn.
      await reports.report({
        terminalId: "T",
        token: "tok",
        agent,
        event: "StatusLine",
        seq,
        instance: null,
        env: { cursor: false },
        payload: { agent_state: state, conversation_id: "" },
      })
    }
    return record.startupScreen?.screen
  }

  it("is kept from the agent expected there", async () => {
    expect(await saying("agy", "agy", "authenticating")).toBe("sign-in")
  })

  it("is the newest report's, however they arrive", async () => {
    expect(await saying("agy", "agy", ["initializing", 2], ["authenticating", 1])).toBe("startup")
    expect(await saying("agy", "agy", ["authenticating", 1], ["initializing", 2])).toBe("startup")
  })

  it("isn't taken from any other agent, as a job its shell runs first", async () => {
    expect(await saying("agy", "claude", "authenticating")).toBeUndefined()
  })
})

describe("the bound session's transcript, named by a later hook", () => {
  const hook = (agent: "claude" | "codex", sessionId: string) => ({
    terminalId: "T",
    token: "tok",
    agent,
    event: "Nothing", // A hook the harness decodes to no event.
    seq: 1,
    instance: null,
    env: { cursor: false },
    payload: { session_id: sessionId, transcript_path: "/new.jsonl" },
  })
  const reportTo = async (report: ReturnType<typeof hook>) => {
    const learned = vi.fn<(...args: unknown[]) => void>()
    const record = {
      token: "tok",
      terminal: { exiting: false },
      bound: { binding: { agent: "claude", sessionId: "s1", instance: null } },
    } as unknown as Record
    const reports = new Reports({
      records: () => new Map([["T", record]]),
      bindings: () => ({ learnTranscript: learned }),
    } as unknown as ReportsHost)
    await reports.report(report)
    return learned
  }

  it("is told to the bindings for the agent bound", async () => {
    expect(await reportTo(hook("claude", "s1"))).toHaveBeenCalledWith(
      expect.anything(),
      "s1",
      "/new.jsonl",
    )
  })

  it("is not told for another agent's hook", async () => {
    expect(await reportTo(hook("codex", "s1"))).not.toHaveBeenCalled()
  })
})

describe("the worktrees notice at a root turn's start", () => {
  const harnessNames = ["claude", "codex", "agy"] as const

  /** A terminal with a root session of `agent`, whose turns the host answers as the setting says. */
  const terminal = (
    agent: (typeof harnessNames)[number],
    // Whether the worktrees folder was there when the runner started.
    folderExisted = true,
    // Whether the folder can be made.
    makes = true,
  ) => {
    const record = {
      summary: { id: "T" },
      root: { agent, sessionId: "s", instance: "1", source: "status-line" },
      agents: { [agent]: { sessionId: "s", seq: 1 } },
      naming: { summary: "work", own: { title: "Work" } },
      nudges: noNudges,
    } as unknown as Record
    // The runner's folder and clock, as `runner.ts` wires them: the setting saved calls `ensure`.
    const clock = { now: 0 }
    const state = { on: false }
    const root = new RootFolder({
      enabled: () => state.on,
      path: "/w",
      now: () => clock.now,
      exists: () => folderExisted,
      make: () => {
        if (!makes) throw new Error("EACCES")
      },
    })
    const setting = {
      get on() {
        return state.on
      },
      set on(on: boolean) {
        state.on = on
        root.ensure()
      },
    }
    const saved = vi.fn<() => void>()
    const reports = new Reports({
      worktrees: () => ({
        enabled: () => state.on,
        ready: (startedAt: number | undefined, relists: boolean) => root.ready(startedAt, relists),
      }),
      save: saved,
      peers: () => ({ facts: () => Promise.resolve(undefined) }),
    } as unknown as ReportsHost)
    const events: HarnessEvent[] = [
      {
        type: "turn-started",
        agent,
        sessionId: "s",
        instance: "1",
        startedAt: 1,
        cause: "doorbell",
      },
    ]
    const answer: Answer = { leaseId: null, stdout: "", adding: (extra) => extra }
    /** What the next prompt's hook prints. */
    const turn = async (
      processStart: number | null = 10,
      deadline = Date.now() + 60_000,
    ): Promise<string> =>
      (
        await reports.nudged(
          record,
          { agent, ...(processStart !== null && { processStart }) } as never,
          events,
          answer,
          deadline,
        )
      ).stdout ?? ""
    /** The runner restarting: the record comes back from its saved row, the nudges' memory gone. */
    const restart = () => {
      record.nudges = { ...noNudges }
    }
    const compact = () => {
      record.agents = { [agent]: { sessionId: "s", seq: 1 } } as never
      record.nudges = fired(record.nudges, "compaction")
    }
    return { record, setting, clock, turn, restart, compact }
  }

  for (const agent of harnessNames) {
    const lasting = harnesses[agent].messaging.lasting.includes("prompt")

    it(`tells ${agent}'s new session while the setting is on, and nothing while it is off`, async () => {
      const off = terminal(agent)
      off.record.nudges = sessionBegan(off.record.nudges, 0)
      expect(await off.turn()).not.toContain("worktree")
      const on = terminal(agent)
      on.setting.on = true
      on.record.nudges = sessionBegan(on.record.nudges, 0)
      const printed = await on.turn()
      expect(printed).toContain(worktreesOnNotice)
      expect(printed).not.toContain(worktreesOffNotice)
    })

    it(`tells ${agent} once when the setting flips on, then once when it flips off`, async () => {
      const t = terminal(agent)
      expect(await t.turn()).toBe("")
      t.setting.on = true
      expect(await t.turn()).toBe(worktreesOnNotice)
      t.setting.on = false
      expect(await t.turn()).toBe(worktreesOffNotice)
      expect(await t.turn()).toBe("")
      expect(await t.turn()).toBe("")
      // And on again: told again.
      t.setting.on = true
      expect(await t.turn()).toBe(worktreesOnNotice)
    })

    it(
      lasting
        ? `does not repeat ${agent}'s notice within a session, across a runner restart either`
        : `repeats ${agent}'s notice at each turn, as an injection lasts one model call`,
      async () => {
        const t = terminal(agent)
        t.setting.on = true
        expect(await t.turn()).toBe(worktreesOnNotice)
        expect(await t.turn()).toBe(lasting ? "" : worktreesOnNotice)
        t.restart()
        expect(await t.turn()).toBe(lasting ? "" : worktreesOnNotice)
        // A flip off while the runner was down is noticed after it.
        t.restart()
        t.setting.on = false
        expect(await t.turn()).toBe(worktreesOffNotice)
        expect(await t.turn()).toBe("")
      },
    )

    it(`tells ${agent} again after a compaction${lasting ? "" : " (it is told at every turn)"}`, async () => {
      const t = terminal(agent)
      t.setting.on = true
      await t.turn()
      t.compact()
      expect(await t.turn()).toContain(worktreesOnNotice)
      expect(await t.turn()).toBe(lasting ? "" : worktreesOnNotice)
    })

    it(`tells ${agent} it can't use worktrees when its process started before the folder, until it restarts`, async () => {
      // The folder is made when the setting is saved on, at 1000.
      const t = terminal(agent, false)
      t.clock.now = 1_000
      t.setting.on = true
      // Its first report comes later, as Codex's SessionStart does at its first prompt,
      // but the process began at 500.
      t.clock.now = 5_000
      expect(await t.turn(500)).toBe(worktreesEarlyNotice)
      expect(await t.turn(500)).toBe(lasting ? "" : worktreesEarlyNotice)
      // A resume or a wake starts a new process, which got the folder as an added directory.
      expect(await t.turn(2_000)).toBe(worktreesOnNotice)
      expect(await t.turn(2_000)).toBe(lasting ? "" : worktreesOnNotice)
    })

    it(`takes ${agent}'s process of unknown start for early, and judges its resume anew`, async () => {
      const t = terminal(agent)
      t.setting.on = true
      expect(await t.turn(null)).toBe(worktreesEarlyNotice)
      expect(await t.turn(null)).toBe(lasting ? "" : worktreesEarlyNotice)
      // The resume reports where its process started is read, and is told the on notice.
      expect(await t.turn(10)).toBe(worktreesOnNotice)
    })

    it(`tells ${agent} it can't use worktrees while the folder could not be made`, async () => {
      const t = terminal(agent, false, false)
      t.setting.on = true
      expect(await t.turn()).toBe(worktreesEarlyNotice)
    })

    it(`judges ${agent}'s session started while the setting was off, after on, off and on again`, async () => {
      const t = terminal(agent, false)
      t.clock.now = 100
      t.setting.on = true
      // A process that started while it was on can use them.
      expect(await t.turn(150)).toBe(worktreesOnNotice)
      t.clock.now = 200
      t.setting.on = false
      t.clock.now = 300
      t.setting.on = true
      // One that started while it was off has the folder, but no worktree tools, which
      // Claude Code and Codex list once; Antigravity lists them at each turn.
      const started = 250
      const tools = harnesses[agent].messaging.toolsAtTurnStart
      expect(await t.turn(started)).toBe(tools ? worktreesOnNotice : worktreesEarlyNotice)
    })

    it(`judges ${agent}'s session started while off, with a folder left from before`, async () => {
      const t = terminal(agent, true)
      t.clock.now = 300
      t.setting.on = true
      const tools = harnesses[agent].messaging.toolsAtTurnStart
      expect(await t.turn(250)).toBe(tools ? worktreesOnNotice : worktreesEarlyNotice)
      expect(await t.turn(350)).toBe(worktreesOnNotice)
    })

    it(`tells ${agent}'s next session, which holds nothing of the last`, async () => {
      const t = terminal(agent)
      t.setting.on = true
      await t.turn()
      t.record.agents = {}
      expect(await t.turn()).toBe(worktreesOnNotice)
    })
  }

  it("is not spent by an answer too late to print it", async () => {
    const t = terminal("claude")
    t.setting.on = true
    const late = await t.turn(10, Date.now())
    expect(late).toBe("")
    expect(await t.turn()).toBe(worktreesOnNotice)
  })
})
