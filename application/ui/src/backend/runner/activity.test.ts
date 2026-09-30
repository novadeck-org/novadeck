import type { TerminalSummary } from "@novadeck/protocol"

import { context, describe, expect, it } from "../../test"
import { terminalActivity } from "./activity"

const summary = (change: Partial<TerminalSummary>): TerminalSummary => ({
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  cwd: "/home/alex",
  cols: 80,
  rows: 24,
  exit: null,
  run: 1,
  process: { name: "zsh", argv: null },
  agent: null,
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
      const idle = { state: "idle" as const, attention: { pending: 0, kind: null } }
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
      }
      expect(claude(asking).status).toEqual({
        state: "running",
        agent: { working: true, attention: { kind: "question", count: 2 } },
      })
    })

    it("carries the tokens and quotas its records name", () => {
      const idle = { state: "idle" as const, attention: { pending: 0, kind: null } }
      const telemetry = {
        context: { occupied: 1_000, capacity: 200_000 },
        limits: [{ minutes: 300, used: 0.4, resetsAt: null }],
      }
      const status = terminalActivity(
        summary({
          process: { name: "codex", argv: null },
          agent: "codex",
          activity: idle,
          telemetry,
        }),
      ).status
      expect(status).toEqual({ state: "running", agent: { working: false, usage: telemetry } })
    })

    it("runs as before for an agent whose hooks said nothing", () => {
      expect(claude(null).status).toEqual({ state: "running" })
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
  })
})
