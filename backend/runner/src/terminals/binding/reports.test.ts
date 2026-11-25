import type { HarnessEvent, SessionObserved } from "@novadeck/harness-core/events"
import { vi } from "vitest"

import { harnesses } from "../../harnesses/registry.js"
import type { Answer } from "../../messaging/hook-answers.js"
import { Cards } from "../../shipping/cards.js"
import { declare, type DeclareDeps } from "../../shipping/declare.js"
import { Declines, Permits, Quotes } from "../../shipping/permits.js"
import { describe, expect, it } from "../../test.js"
import { RootFolder } from "../../worktrees/root-folder.js"
import {
  fired,
  noNudges,
  sessionBegan,
  worktreesEarlyNotice,
  worktreesGitlessNotice,
  worktreesOffNotice,
  worktreesOnNotice,
} from "../nudges.js"
import type { Record } from "../record.js"
import { namesHeldConversation, Reports, withoutAside, type ReportsHost } from "./reports.js"

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

describe("a session its harness keeps beside its root", () => {
  const base = { agent: "codex", instance: "1", startedAt: 1 } as const
  const side: HarnessEvent = {
    ...base,
    type: "session-observed",
    sessionId: "side",
    evidence: "native-switch",
    transcript: "/side.jsonl",
  }
  const root: HarnessEvent = { ...side, sessionId: "root", transcript: "/root.jsonl" }
  const turn: HarnessEvent = { ...base, type: "turn-started", sessionId: "side", cause: "prompt" }

  it("is left out of what its report tells, as its harness says, and nothing else", async () => {
    const aside = vi.fn<(event: SessionObserved) => Promise<boolean>>(
      async (event) => event.sessionId === "side",
    )
    expect(await withoutAside([side, root, turn], aside)).toEqual([root, turn])
    expect(aside).toHaveBeenCalledTimes(2)
  })

  it("is never asked about where the harness keeps none, or the report names no session", async () => {
    const aside = vi.fn<(event: SessionObserved) => Promise<boolean>>(async () => true)
    expect(await withoutAside([side], undefined)).toEqual([side])
    expect(await withoutAside([turn], aside)).toEqual([turn])
    expect(aside).not.toHaveBeenCalled()
  })
})

describe("a conversation another terminal's agent holds", () => {
  const turn = (sessionId: string): HarnessEvent => ({
    type: "turn-started",
    agent: "agy",
    sessionId,
    instance: "2",
    startedAt: 1,
    cause: "harness",
  })
  const holding = (id: string, sessionId: string): Record =>
    ({
      summary: { id },
      bound: { binding: { agent: "agy", sessionId, instance: "1" } },
    }) as unknown as Record
  const records = new Map([
    ["first", holding("first", "held")],
    ["second", { summary: { id: "second" }, bound: null } as unknown as Record],
  ])

  const live = () => true
  const dead = () => false
  const held = (
    terminals: ReadonlyMap<string, Record>,
    id: string,
    sessionId: string,
    lives = live,
  ): boolean => namesHeldConversation(terminals, id, [turn(sessionId)], lives)

  it("is named by a report of a terminal that never bound it, as a process that resumed it", () => {
    expect(held(records, "second", "held")).toBe(true)
  })

  it("is the holder's own to name, and another conversation any terminal's", () => {
    expect(held(records, "first", "held")).toBe(false)
    expect(held(records, "second", "new")).toBe(false)
    expect(namesHeldConversation(records, "second", [], live)).toBe(false)
  })

  // A process that crashed with nothing to tell the runner leaves its binding behind.
  it("is no longer held once the process bound to it is gone, or its terminal rests", () => {
    expect(held(records, "second", "held", dead)).toBe(false)
    const resting = new Map(records)
    resting.set("first", { ...holding("first", "held"), hibernating: true } as Record)
    expect(held(resting, "second", "held")).toBe(false)
  })

  // After a runner restart every terminal resumes at once: another's process may name a
  // conversation before the terminal resuming it binds it.
  it("is the terminal's whose own resume claims it, bound or not yet", () => {
    const claiming = (id: string, ended = false): Record =>
      ({
        summary: { id },
        bound: null,
        resumeClaim: "agy:held",
        ...(ended && { resumeEnded: true }),
      }) as unknown as Record
    const restored = new Map([
      ["first", claiming("first")],
      ["second", { summary: { id: "second" }, bound: null } as unknown as Record],
    ])
    expect(held(restored, "second", "held")).toBe(true)
    expect(held(restored, "first", "held")).toBe(false)
    // Its own claim, even where another terminal bound the conversation first.
    const raced = new Map([
      ["first", claiming("first")],
      ["second", holding("second", "held")],
    ])
    expect(held(raced, "first", "held")).toBe(false)
    // A resume whose binding has since ended claims nothing.
    const ended = new Map([
      ["first", claiming("first", true)],
      ["second", { summary: { id: "second" }, bound: null } as unknown as Record],
    ])
    expect(held(ended, "second", "held")).toBe(false)
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
      shipping: () => undefined,
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

describe("Antigravity's mode, as its status line says it, for the shipping gate", () => {
  it("is taken from the bound process's own status line, never a nested one's", async () => {
    const statusLine = vi.fn<(terminalId: string, payload: unknown) => void>()
    const record = {
      token: "tok",
      terminal: { exiting: false },
      bound: null,
    } as unknown as Record
    const reports = new Reports({
      records: () => new Map([["T", record]]),
      bindings: () => ({}),
      shipping: () => ({ statusLine }),
    } as unknown as ReportsHost)
    const say = (instance: string, cycle_mode: string) =>
      reports.report({
        terminalId: "T",
        token: "tok",
        agent: "agy",
        event: "StatusLine",
        seq: 1,
        instance,
        env: { cursor: false },
        payload: { cycle_mode, conversation_id: "" },
      })
    // Nothing bound yet: the first status line says.
    await say("9", "accept-edits")
    expect(statusLine).toHaveBeenCalledTimes(1)
    ;(record as { bound: unknown }).bound = { binding: { instance: "9" } }
    await say("8", "auto").catch(() => {})
    expect(statusLine).toHaveBeenCalledTimes(1)
    await say("9", "plan").catch(() => {})
    expect(statusLine).toHaveBeenCalledTimes(2)
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
      summary: { id: "T", cwd: "/projects/root" },
      root: { agent, sessionId: "s", instance: "1", source: "status-line" },
      agents: { [agent]: { sessionId: "s", seq: 1 } },
      naming: { summary: "work", own: { title: "Work" } },
      nudges: noNudges,
    } as unknown as Record
    // The runner's folder and clock, as `runner.ts` wires them: the setting saved calls `ensure`.
    const clock = { now: 0 }
    const state = { on: false, repo: true as boolean | undefined }
    // The folders and waits the host was asked about.
    const asked: { folder: string; wait: boolean }[] = []
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
        inRepository: (folder: string, wait: boolean) => {
          asked.push({ folder, wait })
          return Promise.resolve(state.repo)
        },
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
    return { record, setting, state, asked, clock, turn, restart, compact }
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

    it(`tells ${agent} there is no repository here, the on notice whole with that fact, and the on notice when its folder is in one`, async () => {
      const t = terminal(agent)
      t.state.repo = false
      t.setting.on = true
      expect(await t.turn()).toBe(worktreesGitlessNotice)
      expect(await t.turn()).toBe(lasting ? "" : worktreesGitlessNotice)
      // The folder its reports last said is what is asked about, and a turn that delivers
      // nothing may wait for the answer.
      expect(t.asked.at(-1)).toEqual({ folder: "/projects/root", wait: true })
      // Its reported folder moves into a repository: told the on notice, once where it holds it.
      t.record.summary = { ...t.record.summary, cwd: "/projects/root/source/api" }
      t.state.repo = true
      expect(await t.turn()).toBe(worktreesOnNotice)
      expect(t.asked.at(-1)?.folder).toBe("/projects/root/source/api")
      expect(await t.turn()).toBe(lasting ? "" : worktreesOnNotice)
      // And out of it again.
      t.record.summary = { ...t.record.summary, cwd: "/projects/root" }
      t.state.repo = false
      expect(await t.turn()).toBe(worktreesGitlessNotice)
      // A folder that can't be told keeps what it was told.
      t.state.repo = undefined
      expect(await t.turn()).toBe(lasting ? "" : worktreesGitlessNotice)
      // Off: the gitless notice offered the tools too, so it is taken back.
      t.setting.on = false
      expect(await t.turn()).toBe(worktreesOffNotice)
      expect(await t.turn()).toBe("")
    })

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

describe("the shipping gate's answer to a shell command", () => {
  const hook = (event: string, agent: "claude" | "codex" | "agy" = "claude", token = "tok") => ({
    terminalId: "T",
    token,
    agent,
    event,
    seq: 1,
    instance: null,
    env: { cursor: false },
    payload: { tool_name: "Bash", tool_input: { command: "gh pr merge 5" } },
  })
  const call = { event: "PreToolUse", command: "gh pr merge 5", cwd: "/w" } as const
  const setup = (answer: unknown, enabled = true) => {
    const shipping = {
      enabled: () => enabled,
      answer: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => answer),
    }
    // A host that fails any use but the records and the gate: a gated report touches nothing else.
    const host = new Proxy(
      {
        records: () => new Map([["T", { token: "tok", terminal: { exiting: false } }]]),
        shipping: () => shipping,
      },
      { get: (known, name) => (name in known ? known[name as "records"] : () => expect.fail()) },
    ) as unknown as ReportsHost
    const reports = new Reports(host)
    const queued = vi.spyOn(reports, "queueReport").mockImplementation(() => {})
    return { reports, shipping, queued }
  }

  it("is the hook's answer, with its lease, and the report is skipped", async () => {
    const given = { stdout: '{"deny":true}\n', leaseId: "lease-1" }
    const { reports, shipping, queued } = setup(given)
    expect(await reports.queueAsk(hook("PreToolUse"), 5_000, call)).toEqual(given)
    // Raced against the hook's own deadline.
    expect(shipping.answer).toHaveBeenCalledWith("T", "claude", call, 5_000)
    expect(queued).not.toHaveBeenCalled()
  })

  it("is no answer where the gate has no opinion: the event is reported as any hook is", async () => {
    const { reports, queued } = setup(undefined)
    expect(await reports.queueAsk(hook("PreToolUse", "codex"), 5_000, call)).toEqual({
      leaseId: null,
      stdout: "",
    })
    expect(queued).toHaveBeenCalledOnce()
  })

  it("leaves Antigravity to its own dialog, its ask answer, where the gate has no opinion", async () => {
    const { reports, queued } = setup(undefined)
    expect(await reports.queueAsk(hook("PreToolUse", "agy"), 5_000, call)).toEqual({
      leaseId: null,
      stdout: '{"decision":"ask"}\n',
    })
    expect(queued).toHaveBeenCalledOnce()
  })

  it("asks the gate nothing of a terminal that isn't the caller's", async () => {
    const { reports, shipping, queued } = setup({ stdout: "x", leaseId: null })
    const answer = await reports.queueAsk(hook("PreToolUse", "claude", "other"), 5_000, call)
    expect(answer).toEqual({ leaseId: null, stdout: "" })
    expect(shipping.answer).not.toHaveBeenCalled()
    expect(queued).toHaveBeenCalledOnce()
  })

  for (const agent of ["claude", "codex"] as const)
    it(`ignores ${agent}'s shell PreToolUse once the gate is off, as before it existed`, async () => {
      const { reports } = setup(undefined, false)
      // The host fails any use beyond the gate's: nothing is bound, learned or scheduled.
      expect(await reports.report(hook("PreToolUse", agent))).toEqual({ leaseId: null, stdout: "" })
    })
})

describe("what the shipping gate takes as the person's words", () => {
  const events = (sessionId = "root", cause = "prompt"): HarnessEvent[] => [
    {
      type: "turn-started",
      agent: "claude",
      sessionId,
      instance: "1",
      startedAt: 1,
      cause,
    } as HarnessEvent,
  ]
  const setup = (typed: string | undefined, over: object = {}, enabled = true) => {
    const rings: [string, string, string, boolean, number | undefined, number | undefined][] = []
    const reports = new Reports({
      shipping: () => ({
        enabled: () => enabled,
        quotes: { record: (...ring: (typeof rings)[number]) => rings.push(ring) },
      }),
      messaging: () => ({ personSaid: () => typed }),
      records: () => new Map([["T", { bound: { binding: { sessionId: "root" } } }]]),
    } as unknown as ReportsHost)
    const record = {
      summary: { id: "T" },
      root: { agent: "claude", sessionId: "root", instance: "1", source: "status-line" },
      work: undefined,
      openerCommand: null,
      ...over,
    } as unknown as Record
    return { reports, record, rings }
  }

  it("is a root turn the person began, with their own words", () => {
    const { reports, record, rings } = setup("merge it please")
    reports.quoted(record, events())
    expect(rings).toEqual([["T", "root", "merge it please", false, undefined, 1]])
    // A prompt that answered one of the agent's open asks is a reply.
    reports.quoted(record, events("root", "prompt"), {
      submittedAt: 0,
      fixed: false,
      answers: () => true,
    })
    // It is kept with when the person submitted it, not when it was reported.
    expect(rings.at(-1)).toEqual(["T", "root", "merge it please", true, 0, 1])
  })

  it("is never an Inbox button's fixed line, an option label and not the person's words", () => {
    const { reports, record, rings } = setup("continue")
    reports.quoted(record, events(), { submittedAt: 0, fixed: true, answers: () => false })
    expect(rings).toEqual([])
  })

  it("is never a doorbell's or a delivery's turn, which the delivery doesn't call the person's", () => {
    const { reports, record, rings } = setup(undefined)
    reports.quoted(record, events())
    expect(rings).toEqual([])
  })

  it("is never the command-line prompt an agent was opened with", () => {
    const { reports, record, rings } = setup("merge it", {
      work: { first: true, firstByPerson: undefined, opened: true },
      openerCommand: "claude 'merge it'",
    })
    reports.quoted(record, events())
    expect(rings).toEqual([])
  })

  it("is never a nested session's, nor a turn that isn't a prompt, nor anything while the gate is off", () => {
    const { reports, record, rings } = setup("merge it")
    reports.quoted(record, events("nested"))
    reports.quoted(record, events("root", "continuation"))
    expect(rings).toEqual([])
    const off = setup("merge it", {}, false)
    off.reports.quoted(off.record, events())
    expect(off.rings).toEqual([])
  })

  it("takes an Inbox reply from the person's own record of it, never from an option label", () => {
    const { reports, rings } = setup(undefined)
    reports.quotedReply("T", "yes, merge it now")
    expect(rings).toEqual([["T", "root", "yes, merge it now", true]])
    // A choice with no words of their own says nothing: its label is the agent's.
    reports.quotedReply("T", "")
    expect(rings).toHaveLength(1)
    // Nothing while the gate is off, nor for a terminal with no session.
    const off = setup(undefined, {}, false)
    off.reports.quotedReply("T", "merge it now")
    expect(off.rings).toEqual([])
  })

  it("takes the person's typed reply to an ask whole, so request_permit's `said` gives the permit", async () => {
    const quotes = new Quotes()
    const permits = new Permits()
    const reports = new Reports({
      shipping: () => ({ enabled: () => true, quotes }),
      messaging: () => ({ personSaid: () => "Yes." }),
      records: () => new Map([["T", { bound: { binding: { sessionId: "root" } } }]]),
    } as unknown as ReportsHost)
    const record = {
      summary: { id: "T" },
      root: { agent: "claude", sessionId: "root", instance: "1", source: "status-line" },
      work: undefined,
      openerCommand: null,
    } as unknown as Record
    // The agent asked "Push to release?"; the person's prompt answers it, as delivery reads it.
    reports.quoted(record, events(), { submittedAt: Date.now(), fixed: false, answers: () => true })
    const deps: DeclareDeps = {
      lookups: () => ({
        branch: async () => "feat/x",
        upstream: async () => undefined,
        repo: async () => "r/app",
        ghRepo: async () => "r/app",
        remoteRepo: async () => "r/app",
        tag: async () => false,
        own: async () => false,
      }),
      permits,
      quotes,
      declines: new Declines(quotes),
      cards: new Cards(),
      pull: async () => undefined,
      valid: async () => true,
      defaultBranch: async () => "main",
      agentOf: () => "claude",
    }
    const answer = await declare(deps, "T", "/w", {
      action: "push",
      target: "release",
      said: "yes",
    })
    expect(answer).toMatchObject({ ok: true, state: "permitted" })
    expect(permits.covering("T", "push:r/app:origin/release")?.source).toEqual({
      type: "quote",
      quote: "Yes.",
    })
    // The same word typed with no ask open needs two words.
    const bare = new Quotes()
    const alone = new Reports({
      shipping: () => ({ enabled: () => true, quotes: bare }),
      messaging: () => ({ personSaid: () => "yes" }),
      records: () => new Map([["T", { bound: { binding: { sessionId: "root" } } }]]),
    } as unknown as ReportsHost)
    alone.quoted(record, events(), { submittedAt: Date.now(), fixed: false, answers: () => false })
    expect(bare.said("T", "yes")).toBeUndefined()
  })
})
