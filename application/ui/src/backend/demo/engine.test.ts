import { describe, expect, it } from "vitest"

import { createTerminalState, workspaceReducer } from "../../model/state"
import type { Workspace } from "../../model/types"
import { createDemoEngine } from "./engine"
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
    expect(runtime.getSnapshot(first).draft).toBe("next command")
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
    expect(runtime.getSnapshot(third)).toMatchObject({ draft: "", cleared: true, entries: [] })
  })
})
