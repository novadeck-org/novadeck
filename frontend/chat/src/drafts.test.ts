import { chatDraftOf, joinDraft, noChatDrafts, setChatDraft } from "./drafts"
import { describe, expect, it } from "./test"

describe("chat drafts", () => {
  it("are kept by session and terminal, and an empty one is dropped", () => {
    const kept = setChatDraft(noChatDrafts, "p/s", "01", "half a thought")
    expect(chatDraftOf(kept, "p/s", "01")).toBe("half a thought")
    expect(chatDraftOf(kept, "p/s", "02")).toBe("")
    expect(setChatDraft(kept, "p/s", "01", "")).toEqual({})
    expect(setChatDraft(noChatDrafts, "p/s", "01", "")).toBe(noChatDrafts)
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
