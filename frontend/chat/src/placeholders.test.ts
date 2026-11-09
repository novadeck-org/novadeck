import type { Attachment } from "./attachments"
import { joinDraft } from "./drafts"
import {
  comeBack,
  gathered,
  heldImages,
  insertMarks,
  nextMark,
  splitDraft,
  withMarks,
  withMissingMarks,
  withoutMark,
} from "./placeholders"
import { describe, expect, it } from "./test"

const image = (n: number, path: string | null = `/runner/${n}.png`): Attachment => ({
  id: `id${n}`,
  n,
  name: `${n}.png`,
  preview: "",
  state: "ready",
  path,
  error: null,
})

describe("a draft's image placeholders", () => {
  it("number the next image one past the highest in use, and from 1 where none is", () => {
    expect(nextMark("", [])).toBe(1)
    expect(nextMark("hello", [])).toBe(1)
    expect(nextMark("[Image #1] and [Image #3]", [image(1)])).toBe(4)
    expect(nextMark("", [image(2)])).toBe(3)
  })

  it("go in over the selection, spaced from the words around them", () => {
    expect(insertMarks("", 0, 0, [1])).toEqual({ text: "[Image #1] ", caret: 11 })
    expect(insertMarks("see this:", 9, 9, [1])).toEqual({
      text: "see this: [Image #1] ",
      caret: 21,
    })
    expect(insertMarks("see this: and fix it", 10, 10, [1])).toEqual({
      text: "see this: [Image #1] and fix it",
      caret: 21,
    })
    expect(insertMarks("see XX here", 4, 6, [2, 3])).toEqual({
      text: "see [Image #2] [Image #3] here",
      caret: 25,
    })
    expect(insertMarks("ab", 1, 1, [1])).toEqual({ text: "a [Image #1] b", caret: 13 })
    // A caret past the end, or a backwards selection, stays in the draft.
    expect(insertMarks("ab", 9, 9, [1]).text).toBe("ab [Image #1] ")
    expect(insertMarks("abcd", 3, 1, [1]).text).toBe("a [Image #1] d")
  })

  it("come out one at a time with one of the spaces that held them", () => {
    expect(withoutMark("see [Image #1] this", 1)).toBe("see this")
    expect(withoutMark("[Image #1] this", 1)).toBe("this")
    expect(withoutMark("see [Image #1]", 1)).toBe("see ")
    expect(withoutMark("a[Image #1]b", 1)).toBe("ab")
    expect(withoutMark("see [Image #2]", 1)).toBe("see [Image #2]")
  })

  it("keep an image only while the draft holds its placeholder", () => {
    const { kept, gone } = heldImages("a [Image #2] b", [image(1), image(2)])
    expect(kept.map(({ n }) => n)).toEqual([2])
    expect(gone.map(({ n }) => n)).toEqual([1])
    // A broken placeholder is no placeholder.
    expect(heldImages("a [Image #2 b", [image(2)]).gone).toHaveLength(1)
  })

  it("leave the words as written when they are sent, with each image's place in them", () => {
    const sent = splitDraft("See this: [Image #2] and fix it", [image(1), image(2)])
    expect(sent.text).toBe("See this:  and fix it")
    expect(sent.at).toEqual([10])
    expect(sent.images.map(({ n }) => n)).toEqual([2])
    // Placeholders in the order they stand, not the order the images were pasted.
    const two = splitDraft("[Image #2] one [Image #1] two", [image(1), image(2)])
    expect(two.images.map(({ n }) => n)).toEqual([2, 1])
    expect(two.text).toBe("one  two")
    expect(two.at).toEqual([0, 4])
    // A repeated placeholder is words, not another place.
    const repeated = splitDraft("[Image #1] and [Image #1]", [image(1)])
    expect(repeated.text).toBe("and [Image #1]")
    expect(repeated.at).toEqual([0])
    // Placeholders with no image are words too.
    expect(splitDraft("[Image #4] hi", [image(1)]).images).toEqual([])
  })

  it("keep their places true as the ends of the words are trimmed", () => {
    const lead = splitDraft("  [Image #1] hello", [image(1)])
    expect(lead.text).toBe("hello")
    expect(lead.at).toEqual([0])
    const tail = splitDraft("hello [Image #1] ", [image(1)])
    expect(tail.text).toBe("hello")
    expect(tail.at).toEqual([5])
    const alone = splitDraft("[Image #1] [Image #2]\n", [image(1), image(2)])
    expect(alone.text).toBe("")
    expect(alone.at).toEqual([0, 0])
    const middle = splitDraft(" a [Image #1] b ", [image(1)])
    expect(middle.text).toBe("a  b")
    expect(middle.at).toEqual([2])
  })

  it("count a character outside the Basic Multilingual Plane as the two units a string has", () => {
    const sent = splitDraft("😀 [Image #1] x", [image(1)])
    expect(sent.text).toBe("😀  x")
    expect(sent.at).toEqual(["😀 ".length])
  })

  it("come back into the words where they stood, in the order given, leading where no place is", () => {
    expect(withMarks("See this:  and fix it", [image(9)], [10])).toEqual({
      text: "See this: [Image #1] and fix it",
      images: [image(9)].map((each) => ({ ...each, n: 1 })),
    })
    expect(withMarks("fix it", [image(5), image(6)], undefined).text).toBe(
      "[Image #1] [Image #2] fix it",
    )
    expect(withMarks("", [image(5)], undefined).text).toBe("[Image #1]")
    expect(withMarks("ab", [image(5), image(6)], [1, 1]).text).toBe("a [Image #1] [Image #2] b")
    expect(withMarks("ab", [image(5)], [2]).text).toBe("ab [Image #1]")
    // An offset past the words, or back, is clamped.
    expect(withMarks("ab", [image(5), image(6)], [9, 0]).text).toBe("ab [Image #1] [Image #2]")
  })

  it("are added at the start for an image the words don't hold", () => {
    expect(withMissingMarks("hi", [image(1)], joinDraft)).toBe("[Image #1]\nhi")
    expect(withMissingMarks("[Image #1] hi", [image(1)], joinDraft)).toBe("[Image #1] hi")
    expect(withMissingMarks("", [image(1)], joinDraft)).toBe("[Image #1]")
  })

  it("renumber, as drafts that come back together, after the box's own numbers", () => {
    const back = gathered(
      [
        { text: "a [Image #1] b", images: [image(1, "/x/1.png")] },
        { text: "[Image #1] c", images: [image(1, "/x/2.png")] },
      ],
      0,
      joinDraft,
    )
    expect(back.text).toBe("a [Image #1] b\n[Image #2] c")
    expect(back.images.map(({ n, path }) => [n, path])).toEqual([
      [1, "/x/1.png"],
      [2, "/x/2.png"],
    ])
    // The same file twice is one image, in its first place.
    const twice = gathered(
      [
        { text: "[Image #1] a", images: [image(1, "/x/1.png")] },
        { text: "b [Image #1]", images: [image(1, "/x/1.png")] },
      ],
      0,
      joinDraft,
    )
    expect(twice.text).toBe("[Image #1] a\nb ")
    expect(twice.images).toHaveLength(1)
  })

  it("join a draft that comes back ahead of the box's own, which keeps its numbers", () => {
    const back = { text: "old [Image #1]", images: [image(1, "/x/old.png")] }
    const joined = comeBack(back, "now [Image #1]", [image(1, "/x/now.png")], 8, joinDraft)
    expect(joined.draft).toBe("old [Image #2]\nnow [Image #1]")
    expect(joined.images.map(({ n, path }) => [n, path])).toEqual([
      [2, "/x/old.png"],
      [1, "/x/now.png"],
    ])
    expect(joined.over).toEqual([])
  })

  it("let go the images over what a message takes, from the end, their placeholders with them", () => {
    const back = { text: "[Image #1] [Image #2] words", images: [image(1), image(2)] }
    const joined = comeBack(back, "[Image #1] mine", [image(1, "/x/mine.png")], 2, joinDraft)
    expect(joined.images.map(({ path }) => path)).toEqual(["/runner/1.png", "/runner/2.png"])
    expect(joined.over.map(({ path }) => path)).toEqual(["/x/mine.png"])
    expect(joined.draft).toBe("[Image #2] [Image #3] words\nmine")
  })
})
