import { describe, expect, it } from "../test"
import type { TerminalMetadata } from "../types"
import { closeReasons } from "./closing"

const running = { state: "running" } as const
const agent = (working: boolean) => ({ ...running, agent: { working } })
const terminalFixture = (parts: Partial<TerminalMetadata> & Pick<TerminalMetadata, "state">) =>
  ({
    id: "01",
    name: "Terminal",
    directory: "~/project",
    command: "zsh",
    process: "zsh",
    ...parts,
  }) as TerminalMetadata

describe("what closing a terminal asks about", () => {
  describe("where the backend keeps no History", () => {
    it("asks of a lead too, though nothing runs in it", () => {
      expect(closeReasons(terminalFixture({ state: "idle" }), false, true)).toEqual(["leads"])
    })

    it("asks while anything runs in it, as it always has", () => {
      expect(closeReasons(terminalFixture({ ...running }), false)).toEqual(["program"])
      expect(closeReasons(terminalFixture({ ...agent(true) }), false)).toEqual(["program"])
      expect(closeReasons(terminalFixture({ state: "idle" }), false)).toEqual([])
    })
  })

  describe("a sleeper or a waking agent", () => {
    const sleeping = { state: "sleeping", agent: "claude" } as const
    const waking = { state: "starting", restoredProcess: "claude", busy: true } as const

    it("asks while nothing keeps closed terminals, since its session would be lost", () => {
      expect(closeReasons(terminalFixture({ ...sleeping }), false)).toEqual(["asleep"])
      expect(closeReasons(terminalFixture({ ...waking }), false)).toEqual(["asleep"])
      expect(closeReasons(terminalFixture({ state: "starting" }), false)).toEqual([])
    })

    it("closes without asking where its session can be restored, like an idle agent", () => {
      expect(closeReasons(terminalFixture({ ...sleeping, restorable: true }), true)).toEqual([])
      expect(closeReasons(terminalFixture({ ...waking, restorable: true }), true)).toEqual([])
    })

    it("does not count the resume it runs, or a sleeper, as a program to lose", () => {
      expect(closeReasons(terminalFixture({ ...waking, restorable: true }), true)).toEqual([])
      expect(
        closeReasons(terminalFixture({ ...sleeping, busy: true, restorable: true }), true),
      ).toEqual([])
      expect(closeReasons(terminalFixture({ ...waking }), true)).toEqual(["unrestorable"])
    })

    it("asks where its session can't be restored", () => {
      expect(closeReasons(terminalFixture({ ...sleeping }), true)).toEqual(["unrestorable"])
      expect(closeReasons(terminalFixture({ ...waking }), true)).toEqual(["unrestorable"])
    })

    it("still asks when it leads anyone", () => {
      const lead = terminalFixture({ ...sleeping, restorable: true, handle: "moth" as never })
      expect(closeReasons(lead, true, true)).toEqual(["leads"])
    })
  })

  describe("where closing can be undone", () => {
    it("asks when a program runs in the shell, whether or not the OS tells", () => {
      expect(closeReasons(terminalFixture({ state: "idle", busy: true }), true)).toEqual([
        "program",
      ])
    })

    it("asks when an agent is mid-turn", () => {
      expect(closeReasons(terminalFixture({ ...agent(true), restorable: true }), true)).toEqual([
        "working",
      ])
    })

    it("asks when a running agent can't be restored, and says both when it works too", () => {
      expect(closeReasons(terminalFixture({ ...agent(false) }), true)).toEqual(["unrestorable"])
      expect(closeReasons(terminalFixture({ ...agent(true) }), true)).toEqual([
        "working",
        "unrestorable",
      ])
    })

    it("lets an idle agent that can restore close without asking, though the runner counts it busy", () => {
      expect(
        closeReasons(terminalFixture({ ...agent(false), restorable: true, busy: true }), true),
      ).toEqual([])
    })

    it("asks about a mid-turn agent and a plain busy program, as the runner reports them", () => {
      expect(
        closeReasons(terminalFixture({ ...agent(true), restorable: true, busy: true }), true),
      ).toEqual(["working"])
      expect(closeReasons(terminalFixture({ ...running, busy: true }), true)).toEqual(["program"])
    })

    it("asks when an idle agent waits on a job, a wake-up or background tasks", () => {
      const idle = { ...running, restorable: true }
      const waiting = { jobs: [], wake: { at: Date.now() + 60_000, reason: null } }
      expect(
        closeReasons(
          terminalFixture({ ...idle, agent: { working: false, waiting } } as never),
          true,
        ),
      ).toEqual(["background"])
      expect(
        closeReasons(
          terminalFixture({
            ...idle,
            agent: { working: false, background: { agents: 0, tasks: 2 } },
          } as never),
          true,
        ),
      ).toEqual(["background"])
    })

    it("doesn't ask about a wake-up or a monitor that has passed", () => {
      const now = 10 * 60 * 60_000
      const hourAgo = now - 60 * 60_000
      const waiting = {
        jobs: [{ id: "1", description: "a monitor", command: "", since: 0, until: hourAgo }],
        wake: { at: hourAgo, reason: null },
      }
      const terminal = terminalFixture({
        ...running,
        restorable: true,
        agent: { working: false, waiting },
      } as never)
      expect(closeReasons(terminal, true, false, now)).toEqual([])
      expect(closeReasons(terminal, true, false, hourAgo)).toEqual(["background"])
    })

    it("asks when an idle agent leads anyone, whether or not they still run", () => {
      const lead = terminalFixture({ ...agent(false), restorable: true, handle: "moth" })
      expect(closeReasons(lead, true, true)).toEqual(["leads"])
      expect(closeReasons(lead, true, false)).toEqual([])
    })

    it("asks about a lead first, then about what is its own", () => {
      const lead = terminalFixture({ ...agent(true), restorable: true, handle: "moth" })
      expect(closeReasons(lead, true, true)).toEqual(["leads", "working"])
    })

    it("lets a terminal with nothing running in it close", () => {
      expect(closeReasons(terminalFixture({ state: "idle" }), true)).toEqual([])
      expect(
        closeReasons(terminalFixture({ state: "exited", exitCode: 0, signal: null }), true),
      ).toEqual([])
    })

    it("does not take an agent that ran and left for one that runs", () => {
      expect(closeReasons(terminalFixture({ state: "idle", agentRan: true }), true)).toEqual([])
    })
  })
})
