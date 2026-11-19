import { itemIdOf, type Item, type ItemContent } from "@novadeck/core/items"
import type { BackendAction } from "@novadeck/core/port"
import type { TerminalKey } from "@novadeck/core/types"

import { describe, expect, it } from "../test"
import { renderMedia } from "./folder-samples"
import { createFolder, folderItem, renderFiles } from "./folders"
import { createShowcase } from "./simulation"

const session = { projectId: "p", workspaceSessionId: "s" }
const fox: TerminalKey = { ...session, terminalId: "02" }
const render = folderItem(
  "dev-render",
  "render",
  createFolder("~/render", renderFiles(0, renderMedia)),
)

// The showcase's dev server terminal, holding the render folder, reporting to a session that
// keeps what it reports, removals too.
const opened = () => {
  const showcase = createShowcase(
    { agents: [], shown: [{ key: fox, handle: "fox", artifacts: [render] }] },
    (_delay, run) => run(),
    () => 100,
  )
  let items: readonly Item[] = showcase.items
  const reported: BackendAction[] = []
  showcase.start(
    (actions) => {
      reported.push(...actions)
      for (const action of actions) {
        if (action.type === "item/upsert")
          items = [...items.filter((item) => item.id !== action.item.id), action.item]
        if (action.type === "item/remove") items = items.filter((item) => item.id !== action.itemId)
      }
    },
    () => items,
  )
  reported.splice(0)
  return { showcase, reported, items: () => items }
}

const contentOf = (showcase: ReturnType<typeof opened>["showcase"], id: Item["id"]) => {
  let content: ItemContent | undefined
  showcase.follow(session, id, { reveal: undefined }, (next) => (content = next))()
  return content
}

describe("a file of the render folder, opened from it", () => {
  it("names its place in the folder it came from, a nested one under its own folder", async () => {
    const { showcase } = opened()
    expect(await showcase.attach?.(session, "02", "~/render/checkout-desktop.svg")).toMatchObject({
      kind: "image",
      path: "~/render/checkout-desktop.svg",
      by: "person",
    })
    expect(
      await showcase.attach?.(session, "02", "~/render/old-runs/run-1-home.svg"),
    ).toMatchObject({
      path: "~/render/old-runs/run-1-home.svg",
    })
  })

  it("is pointed at another file of its kind, keeping its id and its holder, a version on", async () => {
    const { showcase, reported, items } = opened()
    const first = await showcase.attach?.(session, "02", "~/render/checkout-desktop.svg")
    reported.splice(0)
    const next = await showcase.repoint?.(session, first!.id, "~/render/checkout-mobile.svg")
    expect(next).toMatchObject({
      id: first!.id,
      holder: { terminalId: "02" },
      name: "checkout-mobile.svg",
      path: "~/render/checkout-mobile.svg",
      by: "person",
      version: first!.version + 1,
      openAsked: true,
    })
    expect(reported).toEqual([{ type: "item/upsert", target: session, item: next }])
    expect(items().filter((item) => item.path?.endsWith(".svg"))).toHaveLength(1)
    expect(contentOf(showcase, first!.id)).toMatchObject({
      state: "ready",
      content: { kind: "image" },
    })
  })

  it("replaces what the bar held of the file it is pointed at", async () => {
    const { showcase, reported, items } = opened()
    const first = await showcase.attach?.(session, "02", "~/render/checkout-desktop.svg")
    const second = await showcase.attach?.(session, "02", "~/render/checkout-mobile.svg")
    reported.splice(0)
    await showcase.repoint?.(session, first!.id, "~/render/checkout-mobile.svg")
    expect(reported[0]).toEqual({ type: "item/remove", target: session, itemId: second!.id })
    expect(items().map(({ id }) => id)).toContain(first!.id)
    expect(items().map(({ id }) => id)).not.toContain(second!.id)
  })

  it("is not pointed at a file of another kind, a folder, or one that is none", async () => {
    const { showcase } = opened()
    const image = await showcase.attach?.(session, "02", "~/render/checkout-desktop.svg")
    await expect(showcase.repoint?.(session, image!.id, "~/render/render.log")).rejects.toThrow()
    await expect(showcase.repoint?.(session, image!.id, "~/render/old-runs")).rejects.toThrow()
    await expect(showcase.repoint?.(session, image!.id, "~/render/gone.svg")).rejects.toThrow()
    await expect(
      showcase.repoint?.(session, itemIdOf("no-such-item"), "~/render/checkout-mobile.svg"),
    ).rejects.toThrow()
  })

  it("opens a file again as the one item the bar has of it, whatever it was opened as", async () => {
    const { showcase, items } = opened()
    const first = await showcase.attach?.(session, "02", "~/render/checkout-desktop.svg")
    await showcase.repoint?.(session, first!.id, "~/render/checkout-mobile.svg")
    const again = await showcase.attach?.(session, "02", "~/render/checkout-mobile.svg")
    expect(again?.id).toBe(first!.id)
    expect(items().filter((item) => item.path === "~/render/checkout-mobile.svg")).toHaveLength(1)
  })

  it("opens on the bar it was asked on, whatever another bar holds of the file", async () => {
    const { showcase, items } = opened()
    const there = await showcase.attach?.(session, "03", "~/render/checkout-desktop.svg")
    const here = await showcase.attach?.(session, "02", "~/render/checkout-desktop.svg")
    expect(here?.id).not.toBe(there?.id)
    expect(items().find((item) => item.id === there?.id)?.holder).toEqual({ terminalId: "03" })
    expect(items().find((item) => item.id === here?.id)?.holder).toEqual({ terminalId: "02" })
  })

  it("leaves the project window's file to its window", async () => {
    const { showcase } = opened()
    const { item } = await showcase.openInProject!(session, "README.md", "pw")
    await expect(
      showcase.repoint?.(session, item.id, "~/render/checkout-mobile.svg"),
    ).rejects.toThrow("stays in its window")
  })
})
