import { noConversation, type Conversation, type Conversations } from "@novadeck/core/conversation"
import { createStore } from "@novadeck/core/store"
import { describe, expect, it, vi } from "vitest"

import { createStaleMentions, regiven, restored, staleMention } from "./mentions"
import type { DemoActionContext } from "./types"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

const terminal = (id: string, handle: string, extra = {}) => ({
  id,
  name: id,
  directory: "/",
  command: "",
  process: "bash",
  state: "idle" as const,
  handle,
  ...extra,
})

const workspace = (...terminals: ReturnType<typeof terminal>[]) =>
  ({
    projects: [
      {
        id: "p",
        history: [{ id: "s", state: { roster: { terminals } } }],
      },
    ],
  }) as never

describe("the debug panel's handle given again", () => {
  it("gives the first other terminal with a handle its handle just now", () => {
    const space = workspace(terminal("01", "moth"), terminal("02", "fox"))
    expect(regiven(space, key, 5_000)).toEqual({
      handle: "fox",
      action: {
        type: "terminal/update",
        target: { projectId: "p", workspaceSessionId: "s" },
        terminalId: "02",
        handleGivenAt: 5_000,
      },
    })
    expect(regiven(workspace(terminal("01", "moth")), key, 5_000)).toBeUndefined()
  })

  it("undoes it for the terminals given a handle since", () => {
    const space = workspace(
      terminal("01", "moth"),
      terminal("02", "fox", { handleGivenAt: 5_000 }),
      terminal("03", "owl"),
    )
    expect(restored(space, key)).toEqual([
      {
        type: "terminal/update",
        target: { projectId: "p", workspaceSessionId: "s" },
        terminalId: "02",
        handleGivenAt: 0,
      },
    ])
  })

  it("writes one entry from well before the handle was given and one from just after", () => {
    const { items } = staleMention("fox", 10_000_000)
    expect(items.map((item) => item.at! < 10_000_000)).toEqual([true, false])
    expect(items.every((item) => item.text.includes("@fox"))).toBe(true)
  })

  it("adds the entries to the selected terminal's chat, and takes them away", async () => {
    const base = createStore<Conversation>(noConversation)
    const conversations = { conversation: () => base } as unknown as Conversations
    const mentions = createStaleMentions()
    const chat = mentions.wrap(conversations)
    const view = chat.conversation(key)
    expect(chat.conversation(key)).toBe(view)
    expect(view.getSnapshot().items).toEqual([])
    const changed = vi.fn<() => void>()
    view.subscribe(changed)
    const dispatch = vi.fn<(actions: unknown) => void>()
    const context = {
      selected: () => key,
      workspace: () => workspace(terminal("01", "moth"), terminal("02", "fox")),
      dispatch,
      note: vi.fn<(text: string) => void>(),
    } as unknown as DemoActionContext
    await mentions.actions[0]!.run(context)
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({ terminalId: "02", handleGivenAt: expect.any(Number) }),
    ])
    expect(changed).toHaveBeenCalled()
    const items = view.getSnapshot().items
    expect(items.map((item) => item.id)).toEqual(["stale-mention-old", "stale-mention-new"])
    expect(items[0]!.text).toContain("@fox")
    // The same snapshot until something changes, as a store must give.
    expect(view.getSnapshot()).toBe(view.getSnapshot())
    await mentions.actions[1]!.run(context)
    expect(view.getSnapshot().items).toEqual([])
  })

  it("says what to do first where nothing is selected or no other terminal has a handle", async () => {
    const mentions = createStaleMentions()
    const note = vi.fn<(text: string) => void>()
    await mentions.actions[0]!.run({ selected: () => undefined, note } as never)
    expect(note).toHaveBeenLastCalledWith("Select a terminal first.")
    await mentions.actions[0]!.run({
      selected: () => key,
      workspace: () => workspace(terminal("01", "moth")),
      note,
    } as never)
    expect(note).toHaveBeenLastCalledWith("Add another terminal with a handle first.")
  })
})
