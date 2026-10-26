import type { TerminalSummary } from "@novadeck/protocol"

import { exitStatus, sameStatus, terminalActivity } from "./activity"
import { context, describe, expect, it } from "./test"

const summary = (change: Partial<TerminalSummary>): TerminalSummary => ({
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  title: "Terminal",
  titleSource: { kind: "default" },
  handle: "moth",
  ledBy: null,
  openedBy: null,
  agentRan: false,
  started: true,
  command: null,
  lastProgram: null,
  cwd: "/home/alex",
  cols: 80,
  rows: 24,
  exit: null,
  run: 1,
  process: { name: "zsh", argv: null },
  agent: null,
  ready: null,
  activity: null,
  telemetry: null,
  ...change,
})
const named = (name: string, argv: string[] | null = null) => summary({ process: { name, argv } })

describe("terminal activity", () => {
  context("while a shell waits in the foreground", () => {
    it("is idle and shows a shell", () => {
      expect(terminalActivity(named("zsh"))).toEqual({
        status: { state: "idle" },
        process: "zsh",
      })
    })

    it("recognises login shells, paths and Windows executables", () => {
      const states = ["-bash", "/usr/bin/fish", "pwsh.exe", "C:\\Windows\\cmd.exe", "nu"].map(
        (name) => terminalActivity(named(name)).status,
      )
      expect(states).toEqual(Array.from({ length: 5 }, () => ({ state: "idle" })))
    })
  })

  context("while another program runs", () => {
    it("is running and names the program", () => {
      expect(terminalActivity(named("/opt/bin/Vim"))).toEqual({
        status: { state: "running" },
        process: "vim",
      })
    })

    it("names a Node CLI after the script it launched", () => {
      const codex = named("node", ["/usr/bin/node", "/lib/node_modules/@openai/codex/bin/codex.js"])
      expect(terminalActivity(codex)).toEqual({ status: { state: "running" }, process: "codex" })
    })
  })

  context("while an agent reports through its hooks", () => {
    const claude = (activity: TerminalSummary["activity"]) =>
      terminalActivity(
        summary({ process: { name: "claude", argv: null }, agent: "claude", activity }),
      )

    it("runs, working or idle as the agent says", () => {
      const idle = {
        state: "idle" as const,
        attention: { pending: 0, kind: null },
        subagents: [],
        planning: false,
        background: null,
        waiting: null,
        lastTurn: null,
      }
      expect(claude(idle).status).toEqual({ state: "running", agent: { working: false } })
      expect(claude({ ...idle, state: "unknown" }).status).toEqual({
        state: "running",
        agent: { working: true },
      })
    })

    it("carries the requests waiting on the person", () => {
      const asking = {
        state: "working" as const,
        attention: { pending: 2, kind: "question" as const },
        subagents: [],
        planning: false,
        background: null,
        waiting: null,
        lastTurn: null,
      }
      expect(claude(asking).status).toEqual({
        state: "running",
        agent: { working: true, attention: { kind: "question", count: 2 } },
      })
    })

    it("carries whether it plans", () => {
      expect(
        claude({
          state: "working",
          attention: { pending: 1, kind: "plan" },
          subagents: [],
          planning: true,
          background: null,
          waiting: null,
          lastTurn: null,
        }).status,
      ).toEqual({
        state: "running",
        agent: { working: true, planning: true, attention: { kind: "plan", count: 1 } },
      })
    })

    it("carries the subagents it runs", () => {
      const subagents = [{ id: "a1", type: "explorer" }]
      expect(
        claude({
          state: "working",
          attention: { pending: 0, kind: null },
          subagents,
          planning: false,
          background: null,
          waiting: null,
          lastTurn: null,
        }).status,
      ).toEqual({ state: "running", agent: { working: true, subagents } })
    })

    it("carries how its latest turn ended, with the start of its reply", () => {
      const ended = {
        state: "idle" as const,
        attention: { pending: 0, kind: null },
        subagents: [],
        planning: false,
        background: null,
        waiting: null,
        lastTurn: {
          outcome: "completed" as const,
          reply: "All green.",
          at: 7,
          error: null,
          limit: null,
          files: [],
        },
      }
      expect(claude(ended).status).toEqual({
        state: "running",
        agent: { working: false, lastTurn: { outcome: "completed", reply: "All green.", at: 7 } },
      })
      expect(
        claude({
          ...ended,
          lastTurn: {
            outcome: "interrupted",
            reply: null,
            at: 8,
            error: null,
            limit: null,
            files: [],
          },
        }).status,
      ).toEqual({
        state: "running",
        agent: { working: false, lastTurn: { outcome: "interrupted", at: 8 } },
      })
    })

    it("carries a failed turn's error, its usage limit and the files it wrote", () => {
      const ended = (change: object) =>
        claude({
          state: "idle",
          attention: { pending: 0, kind: null },
          subagents: [],
          planning: false,
          background: null,
          waiting: null,
          lastTurn: {
            outcome: "failed",
            reply: null,
            at: 7,
            error: "5-hour limit reached",
            limit: { minutes: 300, resetsAt: 9000 },
            files: ["/work/a.ts", "/work/b.ts"],
            ...change,
          },
        }).status
      expect(ended({})).toEqual({
        state: "running",
        agent: {
          working: false,
          lastTurn: {
            outcome: "failed",
            error: "5-hour limit reached",
            limit: { minutes: 300, resetsAt: 9000 },
            files: ["/work/a.ts", "/work/b.ts"],
            at: 7,
          },
        },
      })
      expect(ended({ error: null, limit: null, files: [] })).toEqual({
        state: "running",
        agent: { working: false, lastTurn: { outcome: "failed", at: 7 } },
      })
    })

    it("says an end ran into a usage limit, whether or not the window is known", () => {
      const ended = (limited: true | undefined) =>
        claude({
          state: "idle",
          attention: { pending: 0, kind: null },
          subagents: [],
          planning: false,
          background: null,
          waiting: null,
          lastTurn: {
            outcome: "failed",
            reply: null,
            at: 7,
            error: null,
            limit: null,
            files: [],
            ...(limited ? { limited } : {}),
          },
        }).status

      expect(ended(true)).toEqual({
        state: "running",
        agent: { working: false, lastTurn: { outcome: "failed", limited: true, at: 7 } },
      })
      expect(ended(undefined)).toEqual({
        state: "running",
        agent: { working: false, lastTurn: { outcome: "failed", at: 7 } },
      })
    })

    it("carries the tokens and quotas its records name apart from its status", () => {
      const idle = {
        state: "idle" as const,
        attention: { pending: 0, kind: null },
        subagents: [],
        planning: false,
        background: null,
        waiting: null,
        lastTurn: null,
      }
      const telemetry = {
        context: { occupied: 1_000, capacity: 200_000 },
        limits: [{ minutes: 300, used: 0.4, resetsAt: null }],
        model: "gpt-6-astra",
        effort: "high",
      }
      const { status, usage } = terminalActivity(
        summary({
          process: { name: "codex", argv: null },
          agent: "codex",
          activity: idle,
          telemetry,
        }),
      )
      expect(status).toEqual({ state: "running", agent: { working: false } })
      expect(usage).toEqual(telemetry)
    })

    it("carries no usage when its records name nothing", () => {
      const idle = {
        state: "idle" as const,
        attention: { pending: 0, kind: null },
        subagents: [],
        planning: false,
        background: null,
        waiting: null,
        lastTurn: null,
      }
      const empty = { context: null, limits: [], model: null, effort: null }
      const activity = (telemetry: typeof empty | null) =>
        terminalActivity(
          summary({
            process: { name: "codex", argv: null },
            agent: "codex",
            activity: idle,
            telemetry,
          }),
        )
      expect(activity(empty)).not.toHaveProperty("usage")
      expect(activity(null)).not.toHaveProperty("usage")
    })

    it("works on while what its turn left running runs, counting it", () => {
      const waiting = {
        state: "working" as const,
        attention: { pending: 0, kind: null },
        subagents: [{ id: "a1", type: "explorer" }],
        planning: false,
        background: { agents: 1, tasks: 2 },
        waiting: null,
        lastTurn: null,
      }
      expect(claude(waiting).status).toEqual({
        state: "running",
        agent: {
          working: true,
          background: { agents: 1, tasks: 2 },
          subagents: [{ id: "a1", type: "explorer" }],
        },
      })
    })

    it("carries what an idle agent waits on", () => {
      const waiting = {
        jobs: [
          {
            id: "b1",
            description: "Watch CI checks",
            command: "gh pr checks --watch",
            since: 1000,
            until: null,
          },
        ],
        wake: { at: 5000, reason: null },
      }
      const idle = {
        state: "idle" as const,
        attention: { pending: 0, kind: null },
        subagents: [],
        planning: false,
        background: null,
        waiting,
        lastTurn: null,
      }
      expect(claude(idle).status).toEqual({
        state: "running",
        agent: { working: false, waiting },
      })
    })

    it("runs as before for an agent whose hooks said nothing", () => {
      expect(claude(null).status).toEqual({ state: "running" })
    })
  })

  context("while an agent shows its own prompt before its first, its hooks running", () => {
    it("is idle at that prompt", () => {
      const ready = summary({ process: { name: "codex", argv: null }, ready: "codex" })
      expect(terminalActivity(ready).status).toEqual({
        state: "running",
        agent: { working: false },
      })
    })

    it("says nothing for another program that holds the foreground", () => {
      const other = summary({ process: { name: "vim", argv: null }, ready: "codex" })
      expect(terminalActivity(other).status).toEqual({ state: "running" })
    })
  })

  context("when the platform cannot tell what runs", () => {
    it("shows an idle shell", () => {
      expect(terminalActivity(summary({ process: null }))).toEqual({
        status: { state: "idle" },
        process: "",
      })
    })
  })

  context("once the process exited", () => {
    const exited = (code: number | null, signal: string | null, ranMs: number) =>
      terminalActivity(summary({ exit: { code, signal, ranMs }, process: null }))

    it("closes the terminal after a clean exit, however soon", () => {
      expect([exited(0, null, 60_000), exited(0, null, 10)]).toEqual([
        { status: "clean" },
        { status: "clean" },
      ])
    })

    it("reports a non-zero code or the killing signal and leaves the process as it was", () => {
      expect([exited(130, null, 60_000), exited(null, "SIGKILL", 60_000)]).toEqual([
        { status: { state: "exited", exitCode: 130, signal: null } },
        { status: { state: "exited", exitCode: null, signal: "SIGKILL" } },
      ])
    })

    it("counts a quick non-zero exit as failing to start", () => {
      expect(exited(1, null, 300)).toEqual({
        status: { state: "failed", message: "Exited right after starting" },
      })
    })

    it("names the signal however soon it came", () => {
      expect(exited(null, "SIGKILL", 100)).toEqual({
        status: { state: "exited", exitCode: null, signal: "SIGKILL" },
      })
    })

    it("says the shell was killed for memory where the runner says so", () => {
      const exit = { code: null, signal: "SIGKILL", cause: "out-of-memory" as const, ranMs: 100 }
      expect(exitStatus(exit)).toEqual({
        state: "exited",
        exitCode: null,
        signal: "SIGKILL",
        cause: "out-of-memory",
      })
    })

    it("tells a kill for memory from a plain kill, so the app hears of the change", () => {
      const killed = { state: "exited", exitCode: null, signal: "SIGKILL" } as const
      expect(sameStatus(killed, { ...killed })).toBe(true)
      expect(sameStatus(killed, { ...killed, cause: "out-of-memory" })).toBe(false)
    })

    it("counts a non-zero exit as failing to start within the threshold it is given", () => {
      const exit = { code: 1, signal: null, ranMs: 9_000 }
      expect([exitStatus(exit, 60_000), exitStatus(exit, 5_000)]).toEqual([
        { state: "failed", message: "Exited right after starting" },
        { state: "exited", exitCode: 1, signal: null },
      ])
    })
  })
})
