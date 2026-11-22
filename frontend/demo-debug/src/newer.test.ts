import { noConversation, type Conversation, type Conversations } from "@novadeck/core/conversation"
import { itemIdOf, type Item, type ItemContent } from "@novadeck/core/items"
import type { BackendAction } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { TerminalKey } from "@novadeck/core/types"
import { createShowcase } from "@novadeck/demo/showcase/simulation"
import { vi } from "vitest"

import { createNewerChat, newerItemGroups } from "./newer"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

describe("the debug panel's chat actions for a newer Novadeck", () => {
  const setup = () => {
    const base = createStore<Conversation>(noConversation)
    const newer = createNewerChat()
    const chat = newer.wrap({ conversation: () => base } as unknown as Conversations)
    const run = (label: string) =>
      void newer.actions
        .find((action) => action.label === label)!
        .run({ selected: () => key, note: vi.fn<(text: string) => void>() } as never)
    return { chat, run, actions: newer.actions }
  }

  it("hints what each action shows", () => {
    expect(setup().actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("adds a dialog of a type it doesn't know to the selected chat, and takes it away", () => {
    const { chat, run } = setup()
    const view = chat.conversation(key)
    expect(view.getSnapshot().requests).toEqual([])
    run("Dialog from a newer Novadeck")
    expect(view.getSnapshot().requests).toMatchObject([{ dialog: { type: "newer" } }])
    expect(view.getSnapshot()).toBe(view.getSnapshot())
    run("Back to normal")
    expect(view.getSnapshot().requests).toEqual([])
  })

  it("adds a note a newer Novadeck wrote, with its text", () => {
    const { chat, run } = setup()
    run("Part of the record from a newer Novadeck")
    expect(chat.conversation(key).getSnapshot().items).toMatchObject([
      { role: "note", note: { type: "newer" }, text: expect.stringContaining("Bundle report") },
    ])
  })

  it("says to select a terminal first", () => {
    const { actions } = setup()
    const note = vi.fn<(text: string) => void>()
    actions[0]!.run({ selected: () => undefined, note } as never)
    expect(note).toHaveBeenCalledWith("Select a terminal first.")
  })
})

describe("the debug panel's items from a newer Novadeck", () => {
  it("is absent where the demo has no showcase", () => {
    expect(newerItemGroups(undefined)).toEqual([])
  })

  it("shows an item of a newer kind and a file with content of one", () => {
    const showcase = createShowcase({ agents: [] })
    const reported: Item[] = []
    showcase.start(
      (actions: readonly BackendAction[]) => {
        for (const action of actions) if (action.type === "item/upsert") reported.push(action.item)
      },
      () => reported,
    )
    const [group] = newerItemGroups(showcase)
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
    for (const action of group!.actions)
      action.run({
        selected: () => key,
        workspace: () => undefined,
        note: () => undefined,
      } as unknown as DemoActionContext)
    expect(reported.map((item) => [item.kind, item.name])).toEqual([
      ["newer", "Timeline"],
      ["file", "scene.usdz"],
    ])
    const content = (id: string) => {
      let seen: ItemContent | undefined
      showcase.follow(key, itemIdOf(id), { reveal: undefined }, (next) => (seen = next))()
      return seen
    }
    expect(content("dev-timeline")).toMatchObject({ state: "unavailable", reason: "newer" })
    expect(content("dev-scene")).toMatchObject({ state: "unavailable", reason: "newer" })
  })
})
