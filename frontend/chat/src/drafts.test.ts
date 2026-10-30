import { chatDraftOf, joinDraft, keepChatDrafts, noChatDrafts, setChatDraft } from "./drafts"
import { describe, expect, it } from "./test"

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

describe("words joined to a draft", () => {
  it("go on a line after it, or are all there is", () => {
    expect(joinDraft("meanwhile", "use pnpm")).toBe("meanwhile\nuse pnpm")
    expect(joinDraft("  ", "use pnpm")).toBe("use pnpm")
    expect(joinDraft("go", "")).toBe("go")
  })

  it("go before a shell command, never becoming more of its lines", () => {
    expect(joinDraft("!npm test", "also the changelog")).toBe("also the changelog\n!npm test")
  })

  it("make one command of two shell commands, the second without its !", () => {
    expect(joinDraft("!npm test", " ! ls")).toBe("!npm test\nls")
  })
})
