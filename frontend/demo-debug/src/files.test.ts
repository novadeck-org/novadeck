import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { createDemoFiles, demoPaths } from "@novadeck/demo/files"

import { filesGroups } from "./files"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const context = (selected?: DemoActionContext["selected"]): DemoActionContext => ({
  target: "selected",
  harness: "claude",
  selected: selected ?? (() => undefined),
  select: () => {},
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
  crash: () => undefined,
})

const run = (
  files: ReturnType<typeof createDemoFiles>,
  label: string,
  selected?: DemoActionContext["selected"],
  workspace?: Workspace,
) => {
  const [group] = filesGroups(files)
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

const project = (files: ReturnType<typeof createDemoFiles>) =>
  files.state.getSnapshot().projects.storefront!

describe("the debug panel's Files group", () => {
  it("is absent where the demo has no files", () => {
    expect(filesGroups(undefined)).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = filesGroups(createDemoFiles(1))
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("has Crow write a file now", () => {
    const files = createDemoFiles(1)
    run(files, "Agent writes a file")
    expect(Object.values(project(files).changes).some((each) => each.touched.crow! > 1)).toBe(true)
  })

  it("stops Crow's cursor and keeps its changes, as a Files-only fixture", () => {
    const files = createDemoFiles(1)
    const [group] = filesGroups(files)
    expect(group!.actions.some((action) => action.label === "Agent ends its turn")).toBe(false)
    run(files, "Agent stops writing (Files only)")
    expect(project(files).writing.crow).toBeUndefined()
    expect(project(files).changes[demoPaths.checkoutTest]).toBeDefined()
  })

  const workspace = storefront([
    { id: "t1", handle: "moth", state: "running", process: "claude" },
    { id: "t2", handle: "fox", state: "running", process: "pnpm" },
  ])

  it("writes as the selected terminal's agent", () => {
    const files = createDemoFiles(1)
    run(files, "Agent writes a file", () => key("t1"), workspace)
    expect(project(files).writing.moth).toBeDefined()
  })

  it("writes as Crow where the selected terminal is no agent", () => {
    const files = createDemoFiles(1)
    run(files, "Agent writes a file", () => key("t2"), workspace)
    expect(project(files).writing.fox).toBeUndefined()
    expect(Object.values(project(files).changes).some((each) => each.touched.crow! > 1)).toBe(true)
  })

  it("has a third agent change Checkout.tsx, so it has three", () => {
    const files = createDemoFiles(1)
    run(files, "Third agent edits Checkout.tsx")
    const touched = project(files).changes[demoPaths.checkout]!.touched
    expect(Object.keys(touched)).toHaveLength(3)
    expect(touched.owl).toBeDefined()
    expect(touched.fox).toBeUndefined()
    expect(project(files).writing.owl).toBeUndefined()
  })

  it("has an agent create a file in a folder the project lacks a change in", () => {
    const files = createDemoFiles(1)
    run(files, "Agent creates a file in a folder")
    expect(project(files).changes[demoPaths.payments]?.kind).toBe("added")
  })

  it("has a folder fail, list only part, and the root fail, until the files reads normally again", async () => {
    const files = createDemoFiles(1)
    run(files, "A folder can't be read")
    run(files, "A folder lists only part")
    await expect(files.list("storefront", "src/cart")).rejects.toThrow()
    expect((await files.list("storefront", "src/components")).truncated).toBe(true)
    run(files, "The project's files can't be read")
    await expect(files.list("storefront", "")).rejects.toThrow()
    run(files, "The project's folder is empty")
    expect((await files.list("storefront", "")).entries).toEqual([])
    run(files, "The project lists only part")
    expect((await files.list("storefront", "")).truncated).toBe(true)
    run(files, "Files read normally again")
    expect((await files.list("storefront", "src/cart")).entries.length).toBeGreaterThan(0)
    expect((await files.list("storefront", "src/components")).truncated).toBe(false)
    expect((await files.list("storefront", "")).entries.length).toBeGreaterThan(0)
  })

  it("has the checkout behind main, refuse an update, and main move it", async () => {
    const files = createDemoFiles(1)
    expect((await files.checkout!("storefront")).behind).toBeNull()
    run(files, "Checkout is behind main")
    expect((await files.checkout!("storefront")).behind).toMatchObject({ count: 3 })
    run(files, "Checkout can't update")
    expect(await files.update!("storefront")).toMatchObject({ ok: false })
    expect((await files.checkout!("storefront")).behind).not.toBeNull()
    run(files, "Checkout is behind main")
    expect(await files.update!("storefront")).toEqual({ ok: true })
    expect(await files.checkout!("storefront")).toEqual({ behind: null, moved: 1 })
    run(files, "Main moves the checkout")
    expect((await files.checkout!("storefront")).moved).toBe(2)
    const names = (await files.list("storefront", "src/checkout")).entries.map(({ name }) => name)
    expect(names).toContain("Receipt.tsx")
    const components = await files.list("storefront", "src/components")
    expect(components.entries.map(({ name }) => name)).not.toContain("Price.tsx")
    run(files, "Checkout is up to date")
    expect((await files.checkout!("storefront")).behind).toBeNull()
  })
})
