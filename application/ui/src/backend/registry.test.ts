import { createTerminalState, workspaceReducer, type WorkspaceAction } from "../model/state"
import type { TerminalMetadata, Workspace } from "../model/types"
import { context, describe, expect, it } from "../test"
import { itemFixture, terminalFixture } from "../test/fixtures"
import type { TerminalKey } from "./port"
import { createTerminalRegistry } from "./registry"

const target = { projectId: "project", workspaceSessionId: "initial" }
const first = { ...target, terminalId: "01" }
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
          [terminalFixture(1, "~/project"), terminalFixture(2, "~/project")],
          "grid",
          "grid",
        ),
      })),
    },
  ],
})

const recording = () => {
  const opened: { key: TerminalKey; created: boolean }[] = []
  const closed: string[] = []
  const registry = createTerminalRegistry({
    open: (key: TerminalKey, terminal: TerminalMetadata, created: boolean) => {
      opened.push({ key, created })
      return { name: terminal.name, key }
    },
    close: (entry) => closed.push(entry.key.terminalId),
  })
  return { registry, opened, closed }
}

const apply = (workspace: Workspace, actions: WorkspaceAction[]): Workspace =>
  actions.reduce(workspaceReducer, workspace)

describe("terminal registry", () => {
  context("when a session holds a window undocked from a terminal's companion", () => {
    it("opens nothing on the backend for it, and closes nothing when it goes", () => {
      const { registry, opened, closed } = recording()
      const workspace = fixture()
      registry.reconcile(workspace, [])
      const hero = itemFixture("hero", "01")
      const window = {
        id: "w1",
        itemId: hero.id,
        name: "hero.ts",
        titleSource: { kind: "default" },
      } as const
      const undock: WorkspaceAction[] = [
        { type: "item/upsert", target, item: hero },
        { type: "item/undock", target, itemId: hero.id, window },
      ]
      const withWindow = apply(workspace, undock)
      registry.reconcile(withWindow, undock)
      expect(opened.map(({ key }) => key.terminalId)).not.toContain("w1")
      expect(registry.get({ ...target, terminalId: "w1" })).toBeUndefined()
      const close: WorkspaceAction = { type: "item/close", target, itemId: hero.id }
      registry.reconcile(apply(withWindow, [close]), [close])
      expect(closed).toEqual([])
    })
  })

  context("when it first sees a workspace", () => {
    it("opens one entry per terminal in every session, none of them created", () => {
      const { registry, opened } = recording()
      registry.reconcile(fixture(), [])
      expect(opened).toHaveLength(4)
      expect(opened.every((item) => !item.created)).toBe(true)
      expect(registry.get(first)?.terminal.name).toBe("Terminal 01")
    })
  })

  context("when a commit adds a terminal", () => {
    it("opens only that terminal and marks it as created", () => {
      const { registry, opened } = recording()
      const workspace = fixture()
      registry.reconcile(workspace, [])
      const actions: WorkspaceAction[] = [
        { type: "terminal/add", target, terminal: terminalFixture(3, "~/project") },
      ]
      registry.reconcile(apply(workspace, actions), actions)
      expect(opened.slice(4)).toEqual([{ key: { ...target, terminalId: "03" }, created: true }])
    })
  })

  context("when views, visibility, sessions, names or status change", () => {
    it("keeps the same entry and follows the latest metadata", () => {
      const { registry, opened, closed } = recording()
      const workspace = fixture()
      registry.reconcile(workspace, [])
      const entry = registry.get(first)?.entry
      const actions: WorkspaceAction[] = [
        { type: "terminal/visibility", target, terminalId: "01", hidden: true },
        { type: "view/change", target, view: "canvas", enabledViews: ["grid", "canvas"] },
        { type: "session/select", projectId: "project", workspaceSessionId: "other", now: 1 },
        { type: "terminal/rename", target, terminalId: "01", name: "Server" },
        { type: "terminal/status", target, terminalId: "01", status: { state: "finished" } },
      ]
      registry.reconcile(apply(workspace, actions), actions)
      expect(registry.get(first)?.entry).toBe(entry)
      expect(registry.get(first)?.terminal).toMatchObject({ name: "Server", state: "finished" })
      expect(opened).toHaveLength(4)
      expect(closed).toEqual([])
    })
  })

  context("when a commit closes a terminal", () => {
    it("closes its entry once and forgets it for late callers", () => {
      const { registry, closed } = recording()
      const workspace = fixture()
      registry.reconcile(workspace, [])
      const actions: WorkspaceAction[] = [{ type: "terminal/close", target, terminalId: "01" }]
      const next = apply(workspace, actions)
      registry.reconcile(next, actions)
      registry.reconcile(next, [])
      expect(closed).toEqual(["01"])
      expect(registry.get(first)).toBeUndefined()
      expect(registry.get({ ...first, workspaceSessionId: "other" })).toBeDefined()
    })
  })
})
