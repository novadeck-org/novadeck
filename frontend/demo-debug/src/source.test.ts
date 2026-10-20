import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { createDemoSource, sourcePaths } from "@novadeck/demo/source"

import { sourceGroups } from "./source"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const context = (selected?: DemoActionContext["selected"]): DemoActionContext => ({
  target: "selected",
  selected: selected ?? (() => undefined),
  addTerminal: () => {
    throw new Error("unused")
  },
  addInBackground: () => {
    throw new Error("unused")
  },
  startFresh: () => undefined,
  dispatch: undefined,
  workspace: () => undefined,
  note: () => undefined,
})

const run = (
  source: ReturnType<typeof createDemoSource>,
  label: string,
  selected?: DemoActionContext["selected"],
  workspace?: Workspace,
) => {
  const [group] = sourceGroups(source)
  void group!.actions
    .find((action) => action.label === label)!
    .run({ ...context(selected), workspace: () => workspace })
}

// A workspace whose storefront has the terminals given, in its initial session.
const storefront = (terminals: Partial<TerminalMetadata>[]): Workspace =>
  ({
    projects: [
      {
        id: "storefront",
        history: [{ id: "initial", state: { roster: { terminals } } }],
      },
    ],
  }) as unknown as Workspace

const key = (terminalId: string) => ({
  projectId: "storefront",
  workspaceSessionId: "initial",
  terminalId,
})

const project = (source: ReturnType<typeof createDemoSource>) =>
  source.state.getSnapshot().projects.storefront!

describe("the debug panel's Source group", () => {
  it("is absent where the demo has no source", () => {
    expect(sourceGroups(undefined)).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = sourceGroups(createDemoSource(1))
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("has Crow write a file now", () => {
    const source = createDemoSource(1)
    run(source, "Agent writes a file")
    expect(Object.values(project(source).changes).some((each) => each.touched.crow! > 1)).toBe(true)
  })

  it("stops Crow's cursor and keeps its changes, as a Source-only fixture", () => {
    const source = createDemoSource(1)
    const [group] = sourceGroups(source)
    expect(group!.actions.some((action) => action.label === "Agent ends its turn")).toBe(false)
    run(source, "Agent stops writing (Source only)")
    expect(project(source).writing.crow).toBeUndefined()
    expect(project(source).changes[sourcePaths.checkoutTest]).toBeDefined()
  })

  const workspace = storefront([
    { id: "t1", handle: "moth", state: "running", process: "claude" },
    { id: "t2", handle: "fox", state: "running", process: "pnpm" },
  ])

  it("writes as the selected terminal's agent", () => {
    const source = createDemoSource(1)
    run(source, "Agent writes a file", () => key("t1"), workspace)
    expect(project(source).writing.moth).toBeDefined()
  })

  it("writes as Crow where the selected terminal is no agent", () => {
    const source = createDemoSource(1)
    run(source, "Agent writes a file", () => key("t2"), workspace)
    expect(project(source).writing.fox).toBeUndefined()
    expect(Object.values(project(source).changes).some((each) => each.touched.crow! > 1)).toBe(true)
  })

  it("has a third agent change Checkout.tsx, so it has three", () => {
    const source = createDemoSource(1)
    run(source, "Third agent edits Checkout.tsx")
    const touched = project(source).changes[sourcePaths.checkout]!.touched
    expect(Object.keys(touched)).toHaveLength(3)
    expect(touched.owl).toBeDefined()
    expect(touched.fox).toBeUndefined()
    expect(project(source).writing.owl).toBeUndefined()
  })

  it("has an agent create a file in a folder the project lacks a change in", () => {
    const source = createDemoSource(1)
    run(source, "Agent creates a file in a folder")
    expect(project(source).changes[sourcePaths.payments]?.kind).toBe("added")
  })
})
