import { context, describe, expect, it } from "../../test"
import {
  chatAvailable,
  chatDraftOf,
  chatModeOn,
  keepChatDrafts,
  keepChatModes,
  noChatDrafts,
  noChatModes,
  setChatDraft,
  setChatMode,
} from "./mode-state"

describe("chat modes", () => {
  it("turn on and off by session and terminal", () => {
    const on = setChatMode(noChatModes, "p/s", "01", true)
    expect(chatModeOn(on, "p/s", "01")).toBe(true)
    expect(chatModeOn(on, "p/s", "02")).toBe(false)
    expect(chatModeOn(on, "p/other", "01")).toBe(false)
    expect(setChatMode(on, "p/s", "01", false)).toEqual(noChatModes)
  })

  it("change nothing when already as asked", () => {
    expect(setChatMode(noChatModes, "p/s", "01", false)).toBe(noChatModes)
    const on = setChatMode(noChatModes, "p/s", "01", true)
    expect(setChatMode(on, "p/s", "01", true)).toBe(on)
  })

  it("keep only the terminals that still qualify", () => {
    let modes = setChatMode(noChatModes, "p/s", "01", true)
    modes = setChatMode(modes, "p/s", "02", true)
    expect(keepChatModes(modes, (_, id) => id === "02")).toEqual({ "p/s": { "02": true } })
    expect(keepChatModes(modes, () => true)).toBe(modes)
  })

  context("for a terminal", () => {
    const terminal = { id: "01", name: "t", directory: "/", command: "zsh", process: "claude" }
    it("is available while an agent runs in it", () => {
      expect(chatAvailable({ ...terminal, state: "running", agent: { working: false } })).toBe(true)
      expect(chatAvailable({ ...terminal, process: "zsh", state: "running" })).toBe(false)
      // Antigravity reports nothing, but its program says an agent runs.
      expect(chatAvailable({ ...terminal, process: "agy", state: "running" })).toBe(true)
      expect(chatAvailable({ ...terminal, state: "idle" })).toBe(false)
    })
  })
})

describe("chat drafts", () => {
  it("are kept by session and terminal, and an empty one is dropped", () => {
    const kept = setChatDraft(noChatDrafts, "p/s", "01", "half a thought")
    expect(chatDraftOf(kept, "p/s", "01")).toBe("half a thought")
    expect(chatDraftOf(kept, "p/s", "02")).toBe("")
    expect(setChatDraft(kept, "p/s", "01", "")).toEqual({})
    expect(setChatDraft(noChatDrafts, "p/s", "01", "")).toBe(noChatDrafts)
  })

  it("go with the terminals that no longer show a chat", () => {
    const kept = setChatDraft(setChatDraft(noChatDrafts, "p/s", "01", "a"), "p/s", "02", "b")
    expect(keepChatDrafts(kept, (_, id) => id === "02")).toEqual({ "p/s": { "02": "b" } })
  })
})
