import { workLimits } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { attribute, conflictsOf, listFiles, mayConflict, type Lines } from "./lines.js"

const lines = (added: number, removed: number): Lines => ({ added, removed })

describe("the files of a work", () => {
  const changed = new Map([
    ["b.ts", lines(2, 0)],
    ["a.ts", lines(5, 3)],
  ])

  it("lists them in path order with every line unread before a first look", () => {
    const listed = listFiles(changed, undefined, new Set())
    expect(listed.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"])
    expect(listed.files[0]).toEqual({
      path: "a.ts",
      added: 5,
      removed: 3,
      unreadAdded: 5,
      unreadRemoved: 3,
      conflict: false,
    })
    expect(listed.total).toEqual(lines(7, 3))
    expect(listed.totalUnread).toEqual(lines(7, 3))
  })

  it("counts as unread only what changed since the last look, none for a file that didn't", () => {
    const listed = listFiles(changed, new Map([["b.ts", lines(1, 0)]]), new Set(["b.ts"]))
    expect(listed.files.map((file) => [file.path, file.unreadAdded, file.conflict])).toEqual([
      ["a.ts", 0, false],
      ["b.ts", 1, true],
    ])
    expect(listed.totalUnread).toEqual(lines(1, 0))
  })

  it("cuts the list at the limit but adds up every file", () => {
    const many = new Map(
      Array.from({ length: workLimits.files + 5 }, (_, at) => [`f${at}`, lines(1, 1)] as const),
    )
    const listed = listFiles(many, undefined, new Set())
    expect(listed.files).toHaveLength(workLimits.files)
    expect(listed.truncated).toBe(true)
    expect(listed.total).toEqual(lines(workLimits.files + 5, workLimits.files + 5))
  })

  it("keeps the conflicting files, then the biggest, when it must cut", () => {
    const many = new Map<string, Lines>(
      Array.from({ length: workLimits.files + 2 }, (_, at) => [`f${at}`, lines(1, 0)] as const),
    )
    many.set("z-huge", lines(900, 100))
    many.set("zz-conflict", lines(1, 0))
    const listed = listFiles(many, undefined, new Set(["zz-conflict"]))
    const paths = listed.files.map((file) => file.path)
    expect(paths).toHaveLength(workLimits.files)
    expect(paths).toContain("zz-conflict")
    expect(paths).toContain("z-huge")
    expect(paths).toEqual(paths.toSorted())
    expect(listed.truncated).toBe(true)
  })
})

describe("which works could conflict", () => {
  const side = (...paths: string[]) => ({ paths: new Set(paths), truncated: false })

  it("needs a file changed in common", () => {
    expect(mayConflict(side("a", "b"), side("b", "c"))).toBe(true)
    expect(mayConflict(side("a"), side("b"))).toBe(false)
  })

  it("can't rule out a pair when a list was cut", () => {
    expect(mayConflict({ paths: new Set(["a"]), truncated: true }, side("b"))).toBe(true)
  })
})

describe("whose a checkout's work is", () => {
  const claim = (terminalId: string, root: string, since: number) => ({ terminalId, root, since })

  it("is the terminal that has been in the checkout the longest", () => {
    const owners = attribute(
      [claim("b", "/x", 5), claim("a", "/x", 9), claim("c", "/y", 1)],
      new Map(),
    )
    expect(owners).toEqual(
      new Map([
        ["/x", "b"],
        ["/y", "c"],
      ]),
    )
  })

  it("goes by the earlier id when they came together", () => {
    expect(attribute([claim("b", "/x", 5), claim("a", "/x", 5)], new Map())).toEqual(
      new Map([["/x", "a"]]),
    )
  })

  it("stays with an owner that is still there, whoever has been there longer", () => {
    expect(attribute([claim("a", "/x", 1), claim("b", "/x", 9)], new Map([["/x", "b"]]))).toEqual(
      new Map([["/x", "b"]]),
    )
  })

  it("passes to the longest-standing terminal once the owner has left", () => {
    expect(attribute([claim("a", "/x", 3), claim("c", "/x", 2)], new Map([["/x", "b"]]))).toEqual(
      new Map([["/x", "c"]]),
    )
  })
})

describe("the conflicts of a work", () => {
  it("names main first, then the other works in a stable order", () => {
    expect(conflictsOf(true, ["z", "a"])).toEqual([
      { with: "main" },
      { with: "work", terminalId: "a" },
      { with: "work", terminalId: "z" },
    ])
    expect(conflictsOf(false, [])).toEqual([])
  })
})
