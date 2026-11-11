import type { FileFacts } from "@novadeck/viewers/facts"
import { describe, expect, it } from "vitest"

import { headParts, placeParts, summaryParts, type Part } from "./labels"

const said = (parts: readonly Part[]): string => parts.map((part) => part.text).join("")
const kinds = (parts: readonly Part[]): string[] => parts.map((part) => `${part.kind}:${part.text}`)

const declaration = (kind: string, name: string, key = `${kind} ${name}`, from = 1, to = 1) =>
  ({ kind, name, key, from, to, body: name }) as never

const facts = (rest: Partial<FileFacts>): FileFacts => ({
  changes: [],
  imports: { added: [], removed: [] },
  declarations: { added: [], removed: [], changed: [] },
  headings: [],
  ...rest,
})

describe("where a change sits, in words", () => {
  it("says the declaration around it, with a kind word and the name", () => {
    const parts = placeParts(
      [{ kind: "in", declaration: "function", name: "requireUser()" }],
      undefined,
    )
    expect(kinds(parts)).toEqual(["word:in", "plain: ", "code:requireUser()"])
  })

  it("says a new or removed declaration, and a test by its title", () => {
    expect(
      said(
        placeParts([{ kind: "new", declaration: "function", name: "refreshSession()" }], undefined),
      ),
    ).toBe("new refreshSession()")
    expect(
      said(placeParts([{ kind: "removed", declaration: "method", name: "gone()" }], undefined)),
    ).toBe("removed gone()")
    expect(
      said(placeParts([{ kind: "new", declaration: "test", name: "keeps a login" }], undefined)),
    ).toBe("new test keeps a login")
  })

  it("says the exact tokens of a small edit after the name", () => {
    const parts = placeParts([{ kind: "in", declaration: "const", name: "cookieMaxAge" }], {
      from: "7",
      to: "30",
    })
    expect(said(parts)).toBe("in cookieMaxAge 7 → 30")
    expect(
      parts.filter((part) => part.kind === "was" || part.kind === "now").map((part) => part.text),
    ).toEqual(["7", "30"])
  })

  it("says an insertion or a deletion of a token as such", () => {
    expect(said(placeParts([], { from: "", to: "export" }))).toBe("adds export")
    expect(said(placeParts([], { from: "async", to: "" }))).toBe("drops async")
  })

  it("says the imports that came and went by name", () => {
    expect(
      said(
        placeParts(
          [{ kind: "imports", added: ["useSession"], removed: ["signOut", "useUser"] }],
          undefined,
        ),
      ),
    ).toBe("imports signOut, useUser → useSession")
    expect(said(placeParts([{ kind: "imports", added: ["a", "b"], removed: [] }], undefined))).toBe(
      "imports a, b",
    )
    expect(said(placeParts([{ kind: "imports", added: [], removed: ["a"] }], undefined))).toBe(
      "imports removed a",
    )
  })

  it("says the heading above a change in Markdown", () => {
    expect(said(placeParts([{ kind: "under", heading: "Debug panel" }], undefined))).toBe(
      "under Debug panel",
    )
  })

  it("says each place a change sits in, one after the other", () => {
    expect(
      said(
        placeParts(
          [
            { kind: "imports", added: ["useSession"], removed: ["signOut"] },
            { kind: "in", declaration: "function", name: "Header()" },
          ],
          undefined,
        ),
      ),
    ).toBe("imports signOut → useSession · in Header()")
  })

  it("says nothing where there is nothing to say", () => {
    expect(placeParts([], undefined)).toEqual([])
  })
})

describe("what heads a change", () => {
  it("is its place among the changes, what it sits in, and the lines it spans", () => {
    const head = headParts(
      1,
      4,
      {
        places: [{ kind: "in", declaration: "function", name: "requireUser()" }],
        edit: undefined,
        lines: { from: 12, to: 22 },
      },
      { from: 12, to: 22 },
    )
    expect(head.n).toBe("2/4")
    expect(said(head.place)).toBe("in requireUser()")
    expect(head.where).toBe("lines 12–22")
  })

  it("has no number for a file's only change, and says a line alone", () => {
    expect(headParts(0, 1, undefined, { from: 7, to: 7 }).n).toBe("")
    expect(headParts(0, 1, undefined, { from: 7, to: 7 }).where).toBe("line 7")
  })

  it("says a change that only removes by the old lines it spanned", () => {
    expect(headParts(0, 1, undefined, { from: 3, to: 5 }, true).where).toBe("was lines 3–5")
  })
})

describe("what a file's change came to", () => {
  it("lists the declarations changed and new, then the imports", () => {
    const parts = summaryParts(
      facts({
        declarations: {
          added: [declaration("function", "refreshSession()")],
          removed: [],
          changed: [declaration("function", "requireUser()"), declaration("const", "cookieMaxAge")],
        },
        imports: { added: ["verifySession"], removed: ["signOut"] },
      }),
      { status: "modified" },
      4,
    )
    expect(said(parts)).toBe(
      "changed requireUser(), cookieMaxAge · new refreshSession() · imports verifySession, signOut",
    )
  })

  it("says a new file by what it declares", () => {
    const parts = summaryParts(
      facts({
        declarations: {
          added: [declaration("type", "Session"), declaration("function", "verifySession()")],
          removed: [],
          changed: [],
        },
      }),
      { status: "added" },
      1,
    )
    expect(said(parts)).toBe("new Session, verifySession()")
  })

  it("counts tests added, and does not list a class's members beside the class", () => {
    const parts = summaryParts(
      facts({
        declarations: {
          added: [
            declaration("class", "Store"),
            declaration("method", "put()", "Store.put"),
            declaration("test", "keeps a login"),
            declaration("test", "expires"),
          ],
          removed: [],
          changed: [],
        },
      }),
      { status: "modified" },
      3,
    )
    expect(said(parts)).toBe("new Store · tests +2")
  })

  it("says only the tokens of a lone small edit", () => {
    const parts = summaryParts(
      facts({
        changes: [
          {
            places: [{ kind: "in", declaration: "const", name: "cookieMaxAge" }],
            edit: { from: "7", to: "30" },
            lines: { from: 4, to: 4 },
          },
        ],
        declarations: { added: [], removed: [], changed: [declaration("const", "cookieMaxAge")] },
      }),
      { status: "modified" },
      1,
    )
    expect(said(parts)).toBe("in cookieMaxAge 7 → 30")
  })

  it("says the headings a Markdown change sits under", () => {
    expect(
      said(summaryParts(facts({ headings: ["Debug panel", "Other"] }), { status: "modified" }, 2)),
    ).toBe("under Debug panel, Other")
  })

  it("counts the changes of a file without facts", () => {
    expect(said(summaryParts(null, { status: "modified" }, 3))).toBe("3 changes")
    expect(said(summaryParts(null, { status: "modified" }, 1))).toBe("1 change")
  })
})
