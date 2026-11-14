import { plainDemo } from "./index"
import { createDemoPreview, previewMain, previewPath } from "./preview"
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
    expect(await works.preview("storefront", "src/App.tsx")).toEqual({ main: null, works: [] })
    expect(await works.preview("api-service", previewPath)).toEqual({ main: null, works: [] })
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
})
