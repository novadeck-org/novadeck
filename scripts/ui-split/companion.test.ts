import { describe, expect, it } from "vitest"

import {
  destinationOf,
  importedKeys,
  missingExports,
  originOf,
  rewriteSpecifiers,
} from "./companion.ts"

const ui = "frontend/ui/src"
const cp = "frontend/companion/src"
const tracked = new Set([
  `${ui}/test.ts`,
  `${ui}/terminals/drag-session.ts`,
  `${ui}/terminals/WindowShell.tsx`,
  `${ui}/terminals/companion/bar.ts`,
  `${ui}/terminals/companion/state.ts`,
  `${ui}/terminals/companion/taskbar.css`,
  `${ui}/terminals/companion/plan-editor/notes.ts`,
  `${ui}/terminals/companion/plan-editor/notes.test.ts`,
  `${ui}/terminals/processes/profiles.ts`,
  `${ui}/layouts/grid/Grid.tsx`,
  `${ui}/app/WorkspaceTab.tsx`,
])

describe("where the companion's files go", () => {
  it("takes the folder and the bar drag, and nothing beside them", () => {
    expect(destinationOf(`${ui}/terminals/companion/plan-editor/notes.ts`)).toBe(
      `${cp}/plan-editor/notes.ts`,
    )
    expect(destinationOf(`${ui}/terminals/drag-session.test.ts`)).toBe(`${cp}/drag-session.test.ts`)
    expect(destinationOf(`${ui}/terminals/WindowShell.tsx`)).toBeUndefined()
    expect(destinationOf(`${ui}/terminals/drag-session-other.ts`)).toBeUndefined()
  })

  it("names where a file came from, but not the package's own test.ts", () => {
    expect(originOf(`${cp}/drag-session.ts`)).toBe(`${ui}/terminals/drag-session.ts`)
    expect(originOf(`${cp}/bar.ts`)).toBe(`${ui}/terminals/companion/bar.ts`)
    expect(originOf(`${cp}/test.ts`)).toBeUndefined()
  })
})

describe("the specifiers that name a moved file", () => {
  it("point an importer at the package, a stylesheet with its extension", () => {
    const done = rewriteSpecifiers(
      `${ui}/app/WorkspaceTab.tsx`,
      `import { barMembers } from "../terminals/companion/bar"\nimport type { DragSession } from "../terminals/drag-session"\n`,
      tracked,
    )
    expect(done.problems).toEqual([])
    expect(done.text).toBe(
      `import { barMembers } from "@novadeck/companion/bar"\nimport type { DragSession } from "@novadeck/companion/drag-session"\n`,
    )
    expect(
      rewriteSpecifiers(
        `${ui}/styles.css`,
        `@import "./terminals/companion/taskbar.css" layer(components);`,
        tracked,
      ).text,
    ).toBe(`@import "@novadeck/companion/taskbar.css" layer(components);`)
    expect(
      rewriteSpecifiers(
        `${ui}/layouts/grid/Grid.tsx`,
        `import { useDrag } from "../../terminals/drag-session"\n`,
        tracked,
      ).text,
    ).toBe(`import { useDrag } from "@novadeck/companion/drag-session"\n`)
  })

  it("leave what stays alone, and give a moved file relative paths and the package's test.ts", () => {
    expect(
      rewriteSpecifiers(
        `${ui}/terminals/processes/profiles.ts`,
        `import { x } from "../WindowShell"\n`,
        tracked,
      ).text,
    ).toBe(`import { x } from "../WindowShell"\n`)
    const moved = rewriteSpecifiers(
      `${ui}/terminals/companion/plan-editor/notes.test.ts`,
      `import { it } from "../../../test"\nimport { x } from "../state"\nimport { y } from "../../drag-session"\n`,
      tracked,
    )
    expect(moved.problems).toEqual([])
    expect(moved.text).toBe(
      `import { it } from "../test"\nimport { x } from "../state"\nimport { y } from "../drag-session"\n`,
    )
    expect(
      rewriteSpecifiers(
        `${ui}/terminals/companion/bar.ts`,
        `import type { BarDrag } from "../drag-session"\n`,
        tracked,
      ).text,
    ).toBe(`import type { BarDrag } from "./drag-session"\n`)
  })

  it("stop a moved file that reaches what stayed behind, and an import of nothing", () => {
    expect(
      rewriteSpecifiers(
        `${ui}/terminals/companion/bar.ts`,
        `import type { X } from "../WindowShell"\n`,
        tracked,
      ).problems,
    ).toHaveLength(1)
    expect(
      rewriteSpecifiers(
        `${ui}/app/WorkspaceTab.tsx`,
        `import "../terminals/companion/Gone"\n`,
        tracked,
      ).problems,
    ).toHaveLength(1)
  })

  it("find nothing to do on a tree the move has made, and still resolve a late importer", () => {
    const made = new Set([
      `${cp}/bar.ts`,
      `${cp}/drag-session.ts`,
      `${cp}/test.ts`,
      `${ui}/app/WorkspaceTab.tsx`,
    ])
    const text = `import { barMembers } from "@novadeck/companion/bar"\n`
    expect(rewriteSpecifiers(`${ui}/app/WorkspaceTab.tsx`, text, made)).toEqual({
      text,
      problems: [],
    })
    expect(
      rewriteSpecifiers(`${cp}/bar.ts`, `import type { B } from "./drag-session"\n`, made).problems,
    ).toEqual([])
    expect(
      rewriteSpecifiers(
        `${ui}/app/WorkspaceTab.tsx`,
        `import { barMembers } from "../terminals/companion/bar"\n`,
        made,
      ).text,
    ).toBe(text)
  })
})

describe("a branch that merged main before the script ran", () => {
  // Git's directory rename took the branch's new file into the package, specifiers as written.
  const merged = new Set([
    `${ui}/test.ts`,
    `${ui}/terminals/WindowShell.tsx`,
    `${cp}/drag-session.ts`,
    `${cp}/bar.ts`,
    `${cp}/NewThing.tsx`,
  ])

  it("resolves a moved file's old-place specifiers, though test.ts isn't written yet", () => {
    const done = rewriteSpecifiers(
      `${cp}/NewThing.tsx`,
      `import { b } from "./bar"\nimport { d } from "../drag-session"\nimport { it } from "../../test"\n`,
      merged,
    )
    expect(done.problems).toEqual([])
    expect(done.text).toBe(
      `import { b } from "./bar"\nimport { d } from "./drag-session"\nimport { it } from "./test"\n`,
    )
  })

  it("still stops on what the package can't reach", () => {
    expect(
      rewriteSpecifiers(`${cp}/NewThing.tsx`, `import { x } from "../WindowShell"\n`, merged)
        .problems,
    ).toHaveLength(1)
  })
})

describe("the exports an outsider's import needs", () => {
  it("lists each module imported from outside, once, without a query", () => {
    expect(
      importedKeys([
        `import a from "@novadeck/companion/bar"\nimport b from "@novadeck/companion/bar"\n`,
        `@import "@novadeck/companion/taskbar.css" layer(components);\nimport("@novadeck/companion/plan-editor/notes")\n`,
        `import c from "@novadeck/chat-contract/x"\n`,
      ]),
    ).toEqual(["./bar", "./plan-editor/notes", "./taskbar.css"])
  })

  it("reports a module the manifest lacks", () => {
    expect(missingExports(["./bar", "./nope"], new Set(["./bar"]))).toEqual([
      `@novadeck/companion has no "./nope" export`,
    ])
  })
})
