import { describe, expect, it } from "vitest"

import { createTerminalState, workspaceReducer } from "../../model/state"
import type { Workspace } from "../../model/types"
import { createDemoEngine } from "./engine"
import { createMockTerminal } from "./samples"

const target = { projectId: "project", workspaceSessionId: "initial" }
const first = { ...target, terminalId: "01" }
const second = { ...target, terminalId: "02" }
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
          [createMockTerminal(1, "~/project"), createMockTerminal(2, "~/project")],
          "grid",
          "grid",
        ),
      })),
    },
  ],
})

describe("demo terminal engine", () => {
  it("publishes draft, output and scroll changes only to their terminal", () => {
    const runtime = createDemoEngine()
    runtime.reconcile(fixture(), [])
    let firstUpdates = 0
    let secondUpdates = 0
    runtime.subscribe(first, () => firstUpdates++)
    runtime.subscribe(second, () => secondUpdates++)
    const untouched = runtime.getSnapshot(second)
    runtime.setDraft(first, "echo hello")
    runtime.setScrollOffset(first, 42)
    runtime.run(first, "echo hello")
    expect(firstUpdates).toBe(3)
    expect(secondUpdates).toBe(0)
    expect(runtime.getSnapshot(second)).toBe(untouched)
    expect(runtime.getSnapshot(first)).toMatchObject({
      draft: "",
      scrollOffset: 42,
      entries: [{ command: "echo hello", reply: "hello" }],
    })
  })

  it("retains inactive and hidden terminals across view changes and presentation remounts", () => {
    let workspace = fixture()
    const runtime = createDemoEngine()
    runtime.reconcile(workspace, [])
    const unsubscribe = runtime.subscribe(first, () => {})
    runtime.setDraft(first, "unfinished")
    runtime.run(first, "pwd")
    runtime.setDraft(first, "next command")
    unsubscribe()
    const snapshot = runtime.getSnapshot(first)
    workspace = workspaceReducer(workspace, {
      type: "terminal/visibility",
      target,
      terminalId: "01",
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
    expect(runtime.getSnapshot(first).draft).toBe("next command")
    expect(runtime.getSnapshot({ ...first, workspaceSessionId: "other" }).entries).toEqual([])
  })

  it("destroys a closed terminal and ignores its delayed callbacks", () => {
    const workspace = fixture()
    const runtime = createDemoEngine()
    runtime.reconcile(workspace, [])
    runtime.run(first, "echo before close")
    runtime.reconcile(
      workspaceReducer(workspace, { type: "terminal/close", target, terminalId: "01" }),
      [],
    )
    const removed = runtime.getSnapshot(first)
    runtime.setDraft(first, "stale")
    runtime.setScrollOffset(first, 100)
    runtime.run(first, "echo stale")
    expect(runtime.getSnapshot(first)).toBe(removed)
    expect(removed).toMatchObject({ draft: "", entries: [] })
  })

  it("starts created terminals blank and preserves the demo clear command", () => {
    const workspace = fixture()
    const runtime = createDemoEngine()
    runtime.reconcile(workspace, [])
    const third = { ...target, terminalId: "03" }
    const add = {
      type: "terminal/add",
      target,
      terminal: createMockTerminal(3, "~/project"),
    } as const
    runtime.reconcile(workspaceReducer(workspace, add), [add])
    expect(runtime.getSnapshot(third).cleared).toBe(true)
    runtime.run(third, "help")
    expect(runtime.getSnapshot(third).entries[0]!.reply).toContain("Local demo commands")
    runtime.run(third, "clear")
    expect(runtime.getSnapshot(third)).toMatchObject({ draft: "", cleared: true, entries: [] })
  })
})
