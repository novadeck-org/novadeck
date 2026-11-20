import {
  attachmentsHold,
  chatAttachmentsOf,
  droppedImages,
  noChatAttachments,
  setChatAttachments,
  withAttachment,
  type Attachment,
} from "./attachments"
import { describe, expect, it } from "./test"

const image = (id: string, state: Attachment["state"] = "ready"): Attachment => ({
  id,
  n: 1,
  name: `${id}.png`,
  preview: "",
  state,
  path: state === "ready" ? `/runner/${id}.png` : null,
  error: state === "failed" ? "No." : null,
})

describe("a terminal's pasted images", () => {
  it("are let go once no terminal holds them, not as they move with their terminal", () => {
    const before = { "p/s": { t: [image("a"), image("b")], u: [image("c")] } }
    const after = { "p/other": { t: [image("a")] }, "p/s": { u: [image("c")] } }
    expect(droppedImages(before, after)).toEqual([image("b")])
    expect(droppedImages(before, {})).toEqual([image("a"), image("b"), image("c")])
  })

  it("are kept by terminal, and an empty list is not kept", () => {
    const some = setChatAttachments(noChatAttachments, "c", "t", [image("a")])
    expect(chatAttachmentsOf(some, "c", "t")).toEqual([image("a")])
    expect(chatAttachmentsOf(some, "c", "other")).toEqual([])
    expect(setChatAttachments(some, "c", "t", [])).toEqual({})
  })

  it("change one by its id, or leave the same attachments where it is gone", () => {
    const some = setChatAttachments(noChatAttachments, "c", "t", [
      image("a", "uploading"),
      image("b"),
    ])
    const done = withAttachment(some, "c", "t", "a", (each) => ({ ...each, state: "ready" }))
    expect(chatAttachmentsOf(done, "c", "t").map(({ state }) => state)).toEqual(["ready", "ready"])
    expect(withAttachment(some, "c", "t", "gone", () => null)).toBe(some)
    expect(
      chatAttachmentsOf(
        withAttachment(some, "c", "t", "a", () => null),
        "c",
        "t",
      ),
    ).toEqual([image("b")])
  })

  it("hold the message back while one uploads or after one failed", () => {
    expect(attachmentsHold([image("a"), image("b")])).toBeNull()
    expect(attachmentsHold([image("a"), image("b", "uploading")])).toContain("still uploading")
    expect(attachmentsHold([image("a"), image("b", "failed")])).toContain("Remove it")
  })
})
