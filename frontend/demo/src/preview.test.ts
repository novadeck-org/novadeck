import { createDemoFiles } from "./files"
import { plainDemo } from "./index"
import {
  addedPath,
  createDemoPreview,
  previewMain,
  previewPath,
  renamedPath,
  renamedTo,
} from "./preview"
import { demoTerminalId } from "./samples"
import { context, describe, expect, it } from "./test"
import { storefrontPlans } from "./work-plans"
import { createDemoWorks, worksFromPlans } from "./works"

const session = { projectId: "storefront", workspaceSessionId: "initial" }
const moth = demoTerminalId(session, 1)
const crow = demoTerminalId(session, 4)
const owl = demoTerminalId(session, 3)

const demo = () => {
  const now = 1_000_000_000
  const preview = createDemoPreview(now)
  const works = createDemoWorks(worksFromPlans(plainDemo("plain").seed, storefrontPlans, now), {
    now: () => now,
    preview,
  })
  const read = () => works.preview("storefront", previewPath)
  return { works, preview, read, now }
}

describe("the demo's file previews", () => {
  it("has moth and crow change src/checkout/Checkout.tsx, over main's copy, crow the last writer", async () => {
    const { read } = demo()
    const found = await read()
    expect(found.main).toBe(previewMain)
    const by = new Map(found.works.map((work) => [work.terminalId, work]))
    expect([...by.keys()].toSorted()).toEqual([crow, moth].toSorted())
    expect(by.get(crow)!.changedAt).toBeGreaterThan(by.get(moth)!.changedAt)
    // Both rewrite the line that submits the order.
    expect(by.get(moth)!.hunks.some((hunk) => hunk.at === 18)).toBe(true)
    expect(by.get(crow)!.hunks.some((hunk) => hunk.at === 18)).toBe(true)
  })

  it("previews nothing of any other file or project", async () => {
    const { works } = demo()
    expect(await works.preview("storefront", "src/App.tsx")).toEqual({
      main: null,
      works: [],
      renames: [],
    })
    expect(await works.preview("api-service", previewPath)).toEqual({
      main: null,
      works: [],
      renames: [],
    })
  })

  it("grows an agent's live change by a line with each write, and moves its time on", async () => {
    const { preview, read } = demo()
    const before = (await read()).works.find((work) => work.terminalId === moth)!
    preview.wrote(moth, 2_000_000_000)
    const after = (await read()).works.find((work) => work.terminalId === moth)!
    expect(after.hunks.at(-1)!.lines.length).toBe(before.hunks.at(-1)!.lines.length + 1)
    expect(after.changedAt).toBe(2_000_000_000)
  })

  context("with the third agent", () => {
    it("clashes with the others, or has a change that doesn't apply, until it leaves", async () => {
      const { works, read } = demo()
      works.previewOwl("clash")
      let found = (await read()).works.find((work) => work.terminalId === owl)
      expect(found?.hunks).toMatchObject([{ at: 18, applies: true }])
      expect(works.ownedBy(owl)!.files.map((file) => file.path)).toContain(previewPath)
      works.previewOwl("stale")
      found = (await read()).works.find((work) => work.terminalId === owl)
      expect(found?.hunks).toMatchObject([{ at: 25, applies: false }])
      works.previewOwl(undefined)
      expect((await read()).works.some((work) => work.terminalId === owl)).toBe(false)
    })
  })

  it("has moth add OrderSummary.tsx, which main lacks, and crow add it too on request", async () => {
    const { works } = demo()
    let found = await works.preview("storefront", addedPath)
    expect(found.main).toBeNull()
    expect(found.works.map((work) => [work.terminalId, work.status, work.hunks[0]!.at])).toEqual([
      [moth, "added", 1],
    ])
    works.previewScenario("added", true)
    found = await works.preview("storefront", addedPath)
    expect(found.works.map((work) => work.terminalId)).toEqual([moth, crow])
    works.previewScenario("added", false)
    expect((await works.preview("storefront", addedPath)).works).toHaveLength(1)
  })

  it("has crow rename PaymentStep.tsx while moth edits it, as the runner tells it", async () => {
    const { works } = demo()
    expect(await works.preview("storefront", renamedPath)).toEqual({
      main: null,
      works: [],
      renames: [],
    })
    works.previewScenario("rename", true)
    const old = await works.preview("storefront", renamedPath)
    expect(old.works.map((work) => work.terminalId)).toEqual([moth])
    expect(old.renames).toMatchObject([{ terminalId: crow, to: renamedTo }])
    const renamed = await works.preview("storefront", renamedTo)
    expect(renamed.main).toBe(old.main)
    expect(renamed.works.map((work) => [work.terminalId, work.renamedFrom])).toEqual([
      [moth, undefined],
      [crow, renamedPath],
    ])
    expect(renamed.renames).toEqual([])
    works.previewScenario("rename", false)
    expect((await works.preview("storefront", renamedTo)).works).toEqual([])
    // Only Crow's parts end: Moth's change to the old file stays.
    const after = await works.preview("storefront", renamedPath)
    expect(after.works.map((work) => work.terminalId)).toEqual([moth])
    expect(after.renames).toEqual([])
  })

  it("has the Files panel show Crow's add and rename as they come and go, Moth's change staying", async () => {
    const now = 1_000_000_000
    const source = createDemoFiles(now, undefined, [])
    const works = createDemoWorks(worksFromPlans(plainDemo("plain").seed, storefrontPlans, now), {
      now: () => now,
      preview: createDemoPreview(now),
      mark: source.mark,
    })
    const changes = () => source.state.getSnapshot().projects["storefront"]!.changes
    works.previewScenario("added", true)
    expect(Object.keys(changes()[addedPath]!.touched).toSorted()).toEqual(["crow", "moth"])
    works.previewScenario("rename", true)
    expect(changes()[renamedTo]).toMatchObject({
      kind: "added",
      touched: { crow: expect.any(Number) },
    })
    expect(changes()[renamedPath]).toMatchObject({ kind: "deleted" })
    works.previewScenario("added", false)
    works.previewScenario("rename", false)
    expect(Object.keys(changes()[addedPath]!.touched)).toEqual(["moth"])
    expect(changes()[renamedTo]).toBeUndefined()
    expect(changes()[renamedPath]).toMatchObject({
      kind: "modified",
      touched: { moth: expect.any(Number) },
    })
  })
})
