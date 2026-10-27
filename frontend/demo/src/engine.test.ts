import { createTerminalState, workspaceReducer } from "@novadeck/core/state"
import type { AgentStatus, Workspace } from "@novadeck/core/types"
import { describe, expect, it } from "vitest"

import { createDemoEngine } from "./engine"
import { emptyLine } from "./line-editor"
import { createMockTerminal, demoTerminalId } from "./samples"

const target = { projectId: "project", workspaceSessionId: "initial" }
const first = { ...target, terminalId: demoTerminalId(target, 1) }
const second = { ...target, terminalId: demoTerminalId(target, 2) }
const fixture = (): Workspace => ({
  activeProjectId: "project",
  projects: [
    {
      id: "project",
      name: "Project",
      directory: "~/project",
      activeSessionId: "initial",
      history: ["initial", "other"].map((id) => ({
        id,
        name: id,
        visitedAt: 0,
        state: createTerminalState(
          [1, 2].map((number) =>
            createMockTerminal(
              { projectId: "project", workspaceSessionId: id },
              number,
              "~/project",
            ),
          ),
          "grid",
          "grid",
        ),
      })),
    },
  ],
})

describe("demo terminal engine", () => {
  it("publishes command line and output changes only to their terminal", () => {
    const runtime = createDemoEngine()
    runtime.reconcile(fixture(), [])
    let firstUpdates = 0
    let secondUpdates = 0
    runtime.subscribe(first, () => firstUpdates++)
    runtime.subscribe(second, () => secondUpdates++)
    const untouched = runtime.getSnapshot(second)
    runtime.setLine(first, { ...emptyLine(), draft: "echo hello", cursor: 10 })
    runtime.run(first, "echo hello")
    expect(firstUpdates).toBe(2)
    expect(secondUpdates).toBe(0)
    expect(runtime.getSnapshot(second)).toBe(untouched)
    expect(runtime.getSnapshot(first)).toMatchObject({
      line: { draft: "echo hello" },
      entries: [{ command: "echo hello", reply: "hello" }],
    })
  })

  it("retains inactive and hidden terminals across view changes and presentation remounts", () => {
    let workspace = fixture()
    const runtime = createDemoEngine()
    runtime.reconcile(workspace, [])
    const unsubscribe = runtime.subscribe(first, () => {})
    runtime.setLine(first, { ...emptyLine(), draft: "unfinished" })
    runtime.run(first, "pwd")
    runtime.setLine(first, { ...emptyLine(), draft: "next command" })
    unsubscribe()
    const snapshot = runtime.getSnapshot(first)
    workspace = workspaceReducer(workspace, {
      type: "terminal/visibility",
      target,
      terminalId: first.terminalId,
      hidden: true,
    })
    workspace = workspaceReducer(workspace, {
      type: "view/change",
      target,
      view: "canvas",
      enabledViews: ["focus", "grid", "canvas"],
    })
    workspace = workspaceReducer(workspace, {
      type: "session/select",
      projectId: "project",
      workspaceSessionId: "other",
      now: 1,
    })
    runtime.reconcile(workspace, [])
    expect(runtime.getSnapshot(first)).toBe(snapshot)
    expect(runtime.getSnapshot(first).line.draft).toBe("next command")
    expect(
      runtime.getSnapshot({
        ...first,
        workspaceSessionId: "other",
        terminalId: demoTerminalId({ ...target, workspaceSessionId: "other" }, 1),
      }).entries,
    ).toEqual([])
  })

  it("destroys a closed terminal and ignores its delayed callbacks", () => {
    const workspace = fixture()
    const runtime = createDemoEngine()
    runtime.reconcile(workspace, [])
    runtime.run(first, "echo before close")
    runtime.reconcile(
      workspaceReducer(workspace, { type: "terminal/close", target, terminalId: first.terminalId }),
      [],
    )
    const removed = runtime.getSnapshot(first)
    runtime.setLine(first, { ...emptyLine(), draft: "stale" })
    runtime.run(first, "echo stale")
    expect(runtime.getSnapshot(first)).toBe(removed)
    expect(removed).toMatchObject({ line: { draft: "" }, entries: [] })
  })

  it("starts created terminals blank and preserves the demo clear command", () => {
    const workspace = fixture()
    const runtime = createDemoEngine()
    runtime.reconcile(workspace, [])
    const third = { ...target, terminalId: demoTerminalId(target, 3) }
    const add = {
      type: "terminal/add",
      target,
      terminal: createMockTerminal(target, 3, "~/project"),
    } as const
    runtime.reconcile(workspaceReducer(workspace, add), [add])
    expect(runtime.getSnapshot(third).cleared).toBe(true)
    runtime.run(third, "help")
    expect(runtime.getSnapshot(third).entries[0]!.reply).toContain("Local demo commands")
    runtime.run(third, "clear")
    expect(runtime.getSnapshot(third)).toMatchObject({ cleared: true, entries: [] })
  })

  it("opens a terminal an agent opened on its own opening, not blank", () => {
    const workspace = fixture()
    const runtime = createDemoEngine()
    runtime.reconcile(workspace, [])
    const third = { ...target, terminalId: demoTerminalId(target, 3) }
    const add = {
      type: "terminal/add",
      target,
      terminal: { ...createMockTerminal(target, 3, "~/project"), openedBy: "moth" },
    } as const
    runtime.reconcile(workspaceReducer(workspace, add), [add])
    expect(runtime.getSnapshot(third).cleared).toBe(false)
  })

  it("tells a terminal's listeners when its metadata changes, with its project's name", () => {
    let workspace = fixture()
    const runtime = createDemoEngine()
    runtime.reconcile(workspace, [])
    let updates = 0
    runtime.subscribe(first, () => updates++)
    workspace = workspaceReducer(workspace, {
      type: "terminal/status",
      target,
      terminalId: first.terminalId,
      status: { state: "exited", exitCode: 1, signal: null },
    })
    runtime.reconcile(workspace, [])
    expect(updates).toBe(1)
    expect(runtime.terminal(first)?.state).toBe("exited")
    runtime.reconcile(workspace, [])
    expect(updates).toBe(1)
    expect(runtime.projectName(first)).toBe(workspace.projects[0]!.name)
  })

  // The terminal's program and agent status, as a status report sets them.
  const running = (workspace: Workspace, process: string, agent: AgentStatus) =>
    workspaceReducer(
      workspaceReducer(workspace, {
        type: "terminal/process",
        target,
        terminalId: first.terminalId,
        process,
      }),
      {
        type: "terminal/status",
        target,
        terminalId: first.terminalId,
        status: { state: "running", agent },
      },
    )

  it("keeps what an agent opened with as plan mode comes and goes", () => {
    const runtime = createDemoEngine()
    let workspace = running(fixture(), "claude", { working: true, planning: true })
    runtime.reconcile(workspace, [])
    const opened = runtime.getSnapshot(first).opening
    expect(opened).toMatchObject({ agent: "claude", planned: true })
    workspace = running(workspace, "claude", { working: true })
    runtime.reconcile(workspace, [])
    expect(runtime.getSnapshot(first).opening).toBe(opened)
  })

  it("opens afresh for the agent a terminal becomes", () => {
    const runtime = createDemoEngine()
    let workspace = running(fixture(), "claude", { working: true })
    runtime.reconcile(workspace, [])
    expect(runtime.getSnapshot(first).opening.agent).toBe("claude")
    workspace = running(workspace, "codex", { working: true })
    runtime.reconcile(workspace, [])
    expect(runtime.getSnapshot(first).opening).toMatchObject({ agent: "codex", reviewing: true })
  })
})
