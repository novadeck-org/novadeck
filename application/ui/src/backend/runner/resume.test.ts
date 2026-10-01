import type { TerminalSummary } from "@novadeck/protocol"
import { RunnerError } from "@novadeck/protocol/client"
import { vi } from "vitest"

import { describe, expect, it } from "../../test"
import { id, scripted } from "./scripted"

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

const exited = (terminalId: string): TerminalSummary => ({
  id: terminalId,
  sessionId: id(8),
  title: "Terminal 01",
  titleSource: { kind: "default" },
  handle: "t1",
  started: true,
  command: null,
  lastProgram: "claude",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  run: 1,
  exit: { code: null, signal: "SIGKILL", ranMs: 9_000 },
  process: null,
  agent: null,
  activity: null,
  telemetry: null,
})

describe("resuming a restored terminal", () => {
  it("asks the runner to resume the agent it lost, where it left off", async () => {
    const app = scripted({ shown: [{ id: id(1), lastProcess: "claude" }] })
    await vi.waitFor(() => expect(app.of("create")).toHaveLength(1))
    expect(app.of("create")[0]).toEqual({
      id: id(1),
      sessionId: id(8),
      cols: 80,
      rows: 24,
      restore: true,
      resume: "claude",
    })
    expect(JSON.stringify(app.calls)).not.toContain("continue")
    app.stop()
  })

  it("resumes Codex the same way", async () => {
    const app = scripted({ shown: [{ id: id(1), lastProcess: "codex" }] })
    await vi.waitFor(() => expect(app.of("create")).toHaveLength(1))
    expect(app.of("create")[0]).toMatchObject({ resume: "codex" })
    app.stop()
  })

  it("starts a plain shell, showing its transcript, for a program that cannot resume", async () => {
    const app = scripted({ shown: [{ id: id(1), lastProcess: "vim" }] })
    await vi.waitFor(() => expect(app.of("create")).toHaveLength(1))
    expect(app.of("create")[0]).not.toHaveProperty("resume")
    expect(app.of("create")[0]).toMatchObject({ restore: true })
    app.stop()
  })

  it("resumes agents in background sessions at once, while plain shells wait to be shown", async () => {
    const app = scripted({
      shown: [],
      background: [
        { id: id(1), lastProcess: "claude" },
        { id: id(2), lastProcess: "" },
      ],
    })
    await vi.waitFor(() => expect(app.of("create")).toHaveLength(1))
    await flush()
    expect(app.of("create")).toEqual([expect.objectContaining({ id: id(1), resume: "claude" })])
    app.stop()
  })

  it("sends the resume with the restart after the shell was killed", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [exited(id(1))],
    })
    await flush()
    // An exited terminal waits for Enter.
    expect(app.of("restart")).toEqual([])
    app.restart(app.key(id(1)))
    await vi.waitFor(() => expect(app.of("restart")).toHaveLength(1))
    expect(app.of("restart")[0]).toEqual([id(1), { cols: 80, rows: 24, resume: "claude" }])
    app.stop()
  })

  it("resumes nothing into a shell that still runs", async () => {
    // Another window still holds the old shell: the runner refuses the restart, and the
    // resume with it.
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [exited(id(1))],
      restart: () => Promise.reject(new RunnerError("CONFLICT")),
    })
    await flush()
    app.restart(app.key(id(1)))
    await app.idle()
    expect(app.of("restart")).toHaveLength(1)
    expect(app.of("create")).toEqual([])
    app.stop()
  })
})
