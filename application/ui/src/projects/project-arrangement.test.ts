import { context, describe, expect, it } from "../test"
import {
  arrangeProjects,
  moveProject,
  noArrangement,
  pinLimit,
  stepProject,
  togglePin,
  type ProjectArrangement,
} from "./project-arrangement"

const projects = ["a", "b", "c", "d", "e"].map((id) => ({ id }))

// More projects than can be pinned, the first `pinLimit` of them pinned.
const crowd = Array.from({ length: pinLimit + 1 }, (_, index) => ({
  id: `p${index}`,
}))
const crowdIds = crowd.map(({ id }) => id)
const full: ProjectArrangement = {
  order: crowdIds,
  pinned: crowdIds.slice(0, pinLimit),
}
const last = crowdIds[pinLimit]!

// The switcher's list as ids, the pinned ones before the bar.
const listed = (arrangement: ProjectArrangement): string => {
  const { pinned, rest } = arrangeProjects(projects, arrangement)
  return `${pinned.map((each) => each.id).join("")}|${rest.map((each) => each.id).join("")}`
}

describe("Arranging projects", () => {
  it("lists them in the runner's order until the person arranges them", () => {
    expect(listed(noArrangement)).toBe("|abcde")
  })

  it("puts the person's order first, then projects it doesn't name, in the runner's order", () => {
    expect(listed({ order: ["d", "gone", "b"], pinned: [] })).toBe("|dbace")
  })

  it("lists the pinned ones first, at most nine", () => {
    expect(listed({ order: ["a", "b", "c", "d"], pinned: ["d", "b", "c", "a"] })).toBe("abcd|e")
    const many = Array.from({ length: 11 }, (_, index) => ({
      id: `p${index}`,
    }))
    const ids = many.map(({ id }) => id)
    const { pinned, rest } = arrangeProjects(many, { order: ids, pinned: ids })
    expect(pinned).toHaveLength(pinLimit)
    expect(rest.map(({ id }) => id)).toEqual(["p9", "p10"])
  })

  context("when pinning", () => {
    it("adds the project at the end of the pinned ones", () => {
      const one = togglePin(projects, noArrangement, "c")
      expect(listed(one)).toBe("c|abde")
      expect(listed(togglePin(projects, one, "e"))).toBe("ce|abd")
    })

    it("unpins to the top of the rest", () => {
      const two = { order: ["c", "e", "a", "b", "d"], pinned: ["c", "e"] }
      expect(listed(togglePin(projects, two, "c"))).toBe("e|cabd")
    })

    it("pins no more than the limit", () => {
      expect(togglePin(crowd, full, last)).toBe(full)
    })
  })

  context("when moving", () => {
    const two: ProjectArrangement = { order: ["a", "b", "c", "d", "e"], pinned: ["a", "b"] }

    it("reorders within the rest", () => {
      expect(listed(moveProject(projects, two, "e", 2))).toBe("ab|ecd")
    })

    it("reorders within the pinned ones", () => {
      expect(listed(moveProject(projects, two, "b", 0))).toBe("ba|cde")
    })

    it("pins a project dropped among the pinned ones, and unpins one dropped among the rest", () => {
      expect(listed(moveProject(projects, two, "d", 1))).toBe("adb|ce")
      expect(listed(moveProject(projects, two, "a", 3))).toBe("b|cdae")
    })

    it("keeps what it was on the edge between them", () => {
      // Between b and c: index 2 of the list without the moved project.
      expect(listed(moveProject(projects, two, "e", 2))).toBe("ab|ecd")
      expect(listed(moveProject(projects, two, "a", 1))).toBe("ba|cde")
    })

    it("refuses to pin past the limit", () => {
      expect(moveProject(crowd, full, last, 1)).toBe(full)
    })

    it("leaves things as they are for a project it doesn't list, or a move in place", () => {
      expect(moveProject(projects, two, "zz", 0)).toBe(two)
      expect(moveProject(projects, two, "c", 2)).toBe(two)
    })
  })

  context("when stepping", () => {
    const two: ProjectArrangement = { order: ["a", "b", "c", "d", "e"], pinned: ["a", "b"] }

    it("moves a place within its group", () => {
      expect(listed(stepProject(projects, two, "d", 1))).toBe("ab|ced")
      expect(listed(stepProject(projects, two, "d", -1))).toBe("ab|dce")
      expect(listed(stepProject(projects, two, "a", 1))).toBe("ba|cde")
      expect(listed(stepProject(projects, two, "b", -1))).toBe("ba|cde")
    })

    it("unpins the last pinned one in place going down, and pins the first of the rest going up", () => {
      expect(listed(stepProject(projects, two, "b", 1))).toBe("a|bcde")
      expect(listed(stepProject(projects, two, "c", -1))).toBe("abc|de")
    })

    it("pins the top row going up when nothing is pinned", () => {
      expect(listed(stepProject(projects, noArrangement, "a", -1))).toBe("a|bcde")
    })

    it("refuses to pin past the limit", () => {
      expect(stepProject(crowd, full, last, -1)).toBe(full)
    })

    it("stops at the ends of the list", () => {
      expect(stepProject(projects, two, "e", 1)).toBe(two)
      expect(stepProject(projects, { order: two.order, pinned: ["a"] }, "a", -1)).toEqual({
        order: two.order,
        pinned: ["a"],
      })
    })

    it("leaves things as they are for a project it doesn't list", () => {
      expect(stepProject(projects, two, "zz", 1)).toBe(two)
    })
  })
})
