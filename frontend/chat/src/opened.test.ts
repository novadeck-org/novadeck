import { chatOpenedOf, noChatOpened, withOpened } from "./opened"
import { describe, expect, it } from "./test"

const context = "project/initial"

describe("what the person opened in a chat", () => {
  it("keeps each key opened or shut, by terminal", () => {
    const opened = withOpened(
      withOpened(noChatOpened, context, "01", "peer:a", true),
      context,
      "02",
      "tool:b",
      false,
    )
    expect(chatOpenedOf(opened, context, "01")).toEqual({ "peer:a": true })
    expect(chatOpenedOf(opened, context, "02")).toEqual({ "tool:b": false })
    expect(chatOpenedOf(opened, context, "03")).toEqual({})
  })

  it("is the same map where nothing changes", () => {
    const opened = withOpened(noChatOpened, context, "01", "peer:a", true)
    expect(withOpened(opened, context, "01", "peer:a", true)).toBe(opened)
  })

  it("keeps only the latest 200 a terminal touched", () => {
    let opened = noChatOpened
    for (let at = 0; at < 201; at += 1) opened = withOpened(opened, context, "01", `k${at}`, true)
    // Touched again, the first-but-one is the latest.
    opened = withOpened(opened, context, "01", "k1", false)
    const kept = chatOpenedOf(opened, context, "01")
    expect(Object.keys(kept)).toHaveLength(200)
    expect(kept.k0).toBeUndefined()
    expect(kept.k1).toBe(false)
    expect(Object.keys(kept).at(-1)).toBe("k1")
  })
})
