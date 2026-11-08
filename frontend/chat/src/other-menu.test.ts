import { otherMenu } from "./other-menu"
import { describe, expect, it } from "./test"

describe("the key of a harness's other menu", () => {
  it("says where Codex keeps what isn't under the key typed", () => {
    expect(otherMenu("codex", "/")).toBe("skills are under $")
    expect(otherMenu("codex", "$im")).toBe("commands are under /")
    expect(otherMenu("codex", "run $im")).toBe("commands are under /")
  })

  it("says nothing over a menu of another kind", () => {
    expect(otherMenu("codex", "look at @src")).toBeNull()
  })

  it("says nothing for a harness with one menu, or none known", () => {
    expect(otherMenu("claude", "/")).toBeNull()
    expect(otherMenu("agy", "/")).toBeNull()
    expect(otherMenu(null, "/")).toBeNull()
  })
})
