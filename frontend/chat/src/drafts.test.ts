import {
  chatDraftOf,
  joinDraft,
  mixes,
  noChatDrafts,
  setChatDraft,
  takenDraft,
  toldDraft,
} from "./drafts"
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

describe("words a pane tells", () => {
  it("are the draft when there is none, and a paragraph after one that is there", () => {
    expect(toldDraft("", "`ls` exited 1.")).toBe("`ls` exited 1.")
    expect(toldDraft("why did", "`ls` exited 1.")).toBe("why did\n\n`ls` exited 1.")
  })

  it("are not added twice", () => {
    expect(toldDraft("why\n\n`ls` exited 1.", "`ls` exited 1.")).toBe("why\n\n`ls` exited 1.")
  })

  it("are not drafted into a shell command, which they would only be more lines of", () => {
    expect(toldDraft("!npm test", "`ls` exited 1.")).toBeNull()
  })
})

describe("takenDraft", () => {
  it("puts the box's words first, then a blank line, then the chat's", () => {
    expect(takenDraft("from the box", "")).toBe("from the box")
    expect(takenDraft("from the box", "from the chat")).toBe("from the box\n\nfrom the chat")
  })

  it("adds no words the draft holds, whole or as its first or last paragraph", () => {
    expect(takenDraft("the words", "the  words\n")).toBe("the  words\n")
    expect(takenDraft("the words", "the words\n\nand more")).toBe("the words\n\nand more")
    expect(takenDraft("the words", "more first\n\nthe words")).toBe("more first\n\nthe words")
    expect(takenDraft("the words", "in the words here")).toBe("the words\n\nin the words here")
  })

  it("never lets a message run as a command, nor a command go as words unseen", () => {
    expect(takenDraft("!ls", "hello")).toBe("hello\n!ls")
    expect(takenDraft("hi", "!pwd")).toBe("hi\n!pwd")
    expect(takenDraft("!ls", "!pwd")).toBe("!ls\npwd")
  })
})

describe("mixes", () => {
  it("is true unless one is a shell command and the other is not", () => {
    expect(mixes("words", "")).toBe(true)
    expect(mixes("!ls", "  ")).toBe(true)
    expect(mixes("words", "more")).toBe(true)
    expect(mixes("!ls", "!pwd")).toBe(true)
    expect(mixes("!ls", "more")).toBe(false)
    expect(mixes("words", "!pwd")).toBe(false)
  })
})
