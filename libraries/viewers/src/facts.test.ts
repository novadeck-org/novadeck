import { describe, expect, it } from "vitest"

import { factsOf, outlineOf, tokenDiff, type FactHunk } from "./facts.js"

// A hunk made of two texts by their lines, the way git would print it with no context.
const hunk = (
  oldStart: number,
  removed: readonly string[],
  newStart: number,
  added: readonly string[],
): FactHunk => ({
  oldStart,
  oldCount: removed.length,
  newStart,
  newCount: added.length,
  lines: [
    ...removed.map((text) => ({ kind: "remove" as const, text })),
    ...added.map((text) => ({ kind: "add" as const, text })),
  ],
})

describe("the tokens a line's replacement changed", () => {
  it("marks the token that differs on each side", () => {
    const marks = tokenDiff(
      "export const cookieMaxAge = 7 * day",
      "export const cookieMaxAge = 30 * day",
    )
    expect(marks).toEqual({ before: [[28, 29]], after: [[28, 30]] })
  })

  it("marks each run of changed tokens apart", () => {
    const marks = tokenDiff("return add(a, b, c)", "return add(xx, yy, c)")
    expect(marks).toEqual({
      before: [
        [11, 12],
        [14, 15],
      ],
      after: [
        [11, 13],
        [15, 17],
      ],
    })
  })

  it("marks a run of changed tokens as one, with the blanks between them", () => {
    const marks = tokenDiff("const total = first + second", "const total = first * third")
    expect(marks?.before).toEqual([[20, 28]])
    expect(marks?.after).toEqual([[20, 27]])
  })

  it("marks nothing on lines with little in common", () => {
    expect(tokenDiff("return null", "const something = await fetchTheThing(argument)")).toBeNull()
  })
})

describe("a file side outlined", () => {
  it("has top-level, exported and class-member declarations, and no inner locals", async () => {
    const outline = await outlineOf(
      "a.ts",
      [
        'import { a as b, type C } from "./x"',
        "export const f = (x: number) => x",
        "const n = 1",
        "export class K {",
        "  m() { const inner = 1 }",
        "  p = 2",
        "}",
        "function g() { const local = () => 1 }",
        "type T = string",
        "interface I {}",
      ].join("\n"),
    )

    expect(outline.declarations.map(({ kind, name }) => `${kind} ${name}`)).toEqual([
      "function f()",
      "const n",
      "class K",
      "method m()",
      "property p",
      "function g()",
      "type T",
      "interface I",
    ])
    expect(outline.imports).toEqual([{ names: ["b", "C"], from: 1, to: 1 }])
  })

  it("has the tests, nested ones too, by their titles", async () => {
    const outline = await outlineOf(
      "a.test.ts",
      'describe("verify", () => {\n  it("turns away", () => {})\n  test.skip("keeps", () => {})\n})\n',
    )
    expect(
      outline.declarations.filter((each) => each.kind === "test").map((each) => each.name),
    ).toEqual(["verify", "turns away", "keeps"])
  })

  it("has no declarations in a language it does not read", async () => {
    expect(await outlineOf("a.py", "def f(): pass")).toEqual({
      declarations: [],
      imports: [],
      headings: [],
    })
  })
})

const before = [
  'import { signOut, useUser } from "../auth"',
  "",
  "export const cookieMaxAge = 7 * day",
  "",
  "export const requireUser = (req: Request) => {",
  '  const raw = req.headers.get("cookie")',
  "  return raw",
  "}",
  "",
  "export class Store {",
  "  get() {",
  "    return 1",
  "  }",
  "}",
  "",
  'describe("session", () => {',
  '  it("expires", () => {})',
  "})",
].join("\n")
const after = [
  'import { useSession } from "../auth/session"',
  "",
  "export const cookieMaxAge = 30 * day",
  "",
  "export const requireUser = (req: Request) => {",
  "  const result = verifySession(readSession(req))",
  "  return result",
  "}",
  "",
  "export const refreshSession = (req: Request) => {",
  "  return null",
  "}",
  "",
  "export class Store {",
  "  get() {",
  "    return 1",
  "  }",
  "  put() {}",
  "}",
  "",
  'describe("session", () => {',
  '  it("expires", () => {})',
  '  it("keeps a month-old login", () => {})',
  "})",
].join("\n")

describe("the facts of a change", () => {
  const hunks: FactHunk[] = [
    hunk(1, ['import { signOut, useUser } from "../auth"'], 1, [
      'import { useSession } from "../auth/session"',
    ]),
    hunk(3, ["export const cookieMaxAge = 7 * day"], 3, ["export const cookieMaxAge = 30 * day"]),
    hunk(6, ['  const raw = req.headers.get("cookie")', "  return raw"], 6, [
      "  const result = verifySession(readSession(req))",
      "  return result",
    ]),
    hunk(9, [], 10, [
      "export const refreshSession = (req: Request) => {",
      "  return null",
      "}",
      "",
    ]),
    hunk(12, [], 18, ["  put() {}"]),
    hunk(17, [], 23, ['  it("keeps a month-old login", () => {})']),
  ]

  it("tells imports by the names added and removed", async () => {
    const facts = await factsOf({ path: "routes.ts", before, after, hunks })
    expect(facts?.changes[0]?.places).toEqual([
      {
        kind: "imports",
        added: ["useSession"],
        removed: ["signOut", "useUser"],
      },
    ])
    expect(facts?.imports).toEqual({ added: ["useSession"], removed: ["signOut", "useUser"] })
  })

  it("tells the exact tokens of a small edit, and the declaration it sits in", async () => {
    const facts = await factsOf({ path: "routes.ts", before, after, hunks })
    expect(facts?.changes[1]).toMatchObject({
      places: [{ kind: "in", declaration: "const", name: "cookieMaxAge" }],
      edit: { from: "7", to: "30" },
    })
  })

  it("tells the declaration around a change, and that it is the same one on both sides", async () => {
    const facts = await factsOf({ path: "routes.ts", before, after, hunks })
    expect(facts?.changes[2]?.places).toEqual([
      { kind: "in", declaration: "function", name: "requireUser()" },
    ])
    expect(facts?.changes[2]?.edit).toBeUndefined()
  })

  it("tells a declaration that is new, a class member that is new, and a test that is new", async () => {
    const facts = await factsOf({ path: "routes.ts", before, after, hunks })
    expect(facts?.changes[3]?.places[0]).toMatchObject({ kind: "new", name: "refreshSession()" })
    expect(facts?.changes[4]?.places[0]).toMatchObject({
      kind: "new",
      declaration: "method",
      name: "put()",
    })
    expect(facts?.changes[5]?.places[0]).toMatchObject({
      kind: "new",
      declaration: "test",
      name: "keeps a month-old login",
    })
  })

  it("lists the declarations added, removed and changed in the file", async () => {
    const facts = await factsOf({ path: "routes.ts", before, after, hunks })
    expect(facts?.declarations.added.map((each) => each.name)).toEqual([
      "refreshSession()",
      "put()",
      "keeps a month-old login",
    ])
    expect(facts?.declarations.removed).toEqual([])
    expect(facts?.declarations.changed.map((each) => each.name)).toEqual([
      "cookieMaxAge",
      "requireUser()",
      "Store",
      "session",
    ])
  })

  it("tells a removed declaration", async () => {
    const facts = await factsOf({
      path: "a.ts",
      before: "export const a = 1\nexport function gone() {\n  return 2\n}\nexport const z = 3\n",
      after: "export const a = 1\nexport const z = 3\n",
      hunks: [hunk(2, ["export function gone() {", "  return 2", "}"], 1, [])],
    })
    expect(facts?.changes[0]?.places[0]).toMatchObject({ kind: "removed", name: "gone()" })
    expect(facts?.declarations.removed.map((each) => each.name)).toEqual(["gone()"])
  })

  it("tells each place a hunk sits in when git joined stretches a few lines apart", async () => {
    const was = [
      'import { signOut } from "../auth"',
      "",
      "const DAY = 1",
      "",
      "export const Header = () => {",
      "  const user = signOut()",
      "  return user",
      "}",
    ].join("\n")
    const now = [
      'import { useSession } from "../auth/session"',
      "",
      "const DAY = 1",
      "",
      "export const Header = () => {",
      "  const session = useSession()",
      "  return session",
      "}",
    ].join("\n")
    const lines = (text: string) => text.split("\n")
    const joined: FactHunk = {
      oldStart: 1,
      oldCount: 8,
      newStart: 1,
      newCount: 8,
      lines: [
        { kind: "remove", text: lines(was)[0]! },
        { kind: "add", text: lines(now)[0]! },
        ...lines(was)
          .slice(1, 5)
          .map((text) => ({ kind: "context" as const, text })),
        { kind: "remove", text: lines(was)[5]! },
        { kind: "remove", text: lines(was)[6]! },
        { kind: "add", text: lines(now)[5]! },
        { kind: "add", text: lines(now)[6]! },
        { kind: "context", text: "}" },
      ],
    }
    const facts = await factsOf({ path: "Header.tsx", before: was, after: now, hunks: [joined] })
    expect(facts?.changes[0]?.places).toEqual([
      { kind: "imports", added: ["useSession"], removed: ["signOut"] },
      { kind: "in", declaration: "function", name: "Header()" },
    ])
    expect(facts?.changes[0]?.lines).toEqual({ from: 1, to: 7 })
  })

  it("gives no place to a change at the top of a file outside any declaration", async () => {
    const facts = await factsOf({
      path: "a.ts",
      before: "// one\nexport const a = 1\n",
      after: "// two\nexport const a = 1\n",
      hunks: [hunk(1, ["// one"], 1, ["// two"])],
    })
    expect(facts?.changes[0]?.places).toEqual([])
    expect(facts?.changes[0]?.lines).toEqual({ from: 1, to: 1 })
  })

  it("tells the heading above a change in Markdown, and not a '#' in a code block", async () => {
    const md = (middle: string) =>
      ["# Guide", "", "## Debug panel", "", middle, "", "```sh", "# not a heading", "```", ""].join(
        "\n",
      )
    const facts = await factsOf({
      path: "docs.md",
      before: md("Old text."),
      after: md("New text."),
      hunks: [hunk(5, ["Old text."], 5, ["New text."])],
    })
    expect(facts?.changes[0]?.places).toEqual([{ kind: "under", heading: "Debug panel" }])
    expect(facts?.headings).toEqual(["Debug panel"])
  })

  it("has no facts for a language it does not read", async () => {
    expect(await factsOf({ path: "a.py", before: "x", after: "y", hunks: [] })).toBeNull()
  })
})
