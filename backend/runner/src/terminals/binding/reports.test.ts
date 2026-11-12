import type { HarnessEvent } from "@novadeck/harness-core/events"
import { vi } from "vitest"

import { harnesses } from "../../harnesses/registry.js"
import type { Answer } from "../../messaging/hook-answers.js"
import { describe, expect, it } from "../../test.js"
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
  const terminal = (agent: (typeof harnessNames)[number]) => {
    const record = {
      summary: { id: "T" },
      root: { agent, sessionId: "s", instance: "1", source: "status-line" },
      agents: { [agent]: { sessionId: "s", seq: 1 } },
      naming: { summary: "work", own: { title: "Work" } },
      nudges: noNudges,
    } as unknown as Record
    const setting = { on: false, since: 0 as number | null }
    const saved = vi.fn<() => void>()
    const reports = new Reports({
      worktrees: () => ({ enabled: () => setting.on, since: () => setting.since }),
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
    const turn = async (deadline = Date.now() + 60_000): Promise<string> =>
      (await reports.nudged(record, { agent } as never, events, answer, deadline)).stdout ?? ""
    /** The runner restarting: the record comes back from its saved row, the nudges' memory gone. */
    const restart = () => {
      record.nudges = { ...noNudges }
    }
    const compact = () => {
      record.agents = { [agent]: { sessionId: "s", seq: 1 } } as never
      record.nudges = fired(record.nudges, "compaction")
    }
    return { record, setting, reports, turn, restart, compact }
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

    it(`tells ${agent} it can't write in worktrees when its process started before the folder, until it restarts`, async () => {
      const t = terminal(agent)
      t.setting.on = true
      t.setting.since = 1_000
      t.reports.launches.set("T", { instance: "1", at: 500 })
      expect(await t.turn()).toBe(worktreesEarlyNotice)
      expect(await t.turn()).toBe(lasting ? "" : worktreesEarlyNotice)
      // A resume or a wake starts a new process, which got the folder as an added directory.
      t.reports.launches.set("T", { instance: "2", at: 2_000 })
      expect(await t.turn()).toBe(worktreesOnNotice)
      expect(await t.turn()).toBe(lasting ? "" : worktreesOnNotice)
    })

    it(`tells ${agent} it can't write in worktrees while the folder could not be made`, async () => {
      const t = terminal(agent)
      t.setting.on = true
      t.setting.since = null
      expect(await t.turn()).toBe(worktreesEarlyNotice)
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
    const late = await t.turn(Date.now())
    expect(late).toBe("")
    expect(await t.turn()).toBe(worktreesOnNotice)
  })
})
