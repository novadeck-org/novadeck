import { describe, expect, it } from "vitest"

import { destinationOf, importedKeys, missingExports, originOf, rewriteSpecifiers } from "./chat.ts"

const ui = "frontend/ui/src"
const ch = "frontend/chat/src"
const tracked = new Set([
  `${ui}/test.ts`,
  `${ui}/terminals/WindowShell.tsx`,
  `${ui}/terminals/chat/ChatView.tsx`,
  `${ui}/terminals/chat/ChatView.test.ts`,
  `${ui}/terminals/chat/state.ts`,
  `${ui}/terminals/chat/commands.ts`,
  `${ui}/terminals/chat/chat.css`,
  `${ui}/terminals/chat/use-chat.ts`,
  `${ui}/app/WorkspaceTerminal.tsx`,
  `${ui}/app/commands/chat.ts`,
  `${ui}/test/commands.ts`,
  `${ui}/styles.css`,
])

describe("where the chat's files go", () => {
  it("takes the folder, and nothing beside it", () => {
    expect(destinationOf(`${ui}/terminals/chat/ChatView.tsx`)).toBe(`${ch}/ChatView.tsx`)
    expect(destinationOf(`${ui}/terminals/chat/chat.css`)).toBe(`${ch}/chat.css`)
    expect(destinationOf(`${ui}/terminals/chat-other/x.ts`)).toBeUndefined()
    expect(destinationOf(`${ui}/terminals/WindowShell.tsx`)).toBeUndefined()
  })

  it("names where a file came from, but not the package's own test.ts", () => {
    expect(originOf(`${ch}/state.ts`)).toBe(`${ui}/terminals/chat/state.ts`)
    expect(originOf(`${ch}/test.ts`)).toBeUndefined()
  })
})

describe("the specifiers that name a moved file", () => {
  it("point an importer at the package, a stylesheet with its extension", () => {
    const done = rewriteSpecifiers(
      `${ui}/app/commands/chat.ts`,
      `import { chatDraftOf } from "../../terminals/chat/state"\nimport type { X } from "../../terminals/chat/commands"\n`,
      tracked,
    )
    expect(done.problems).toEqual([])
    expect(done.text).toBe(
      `import { chatDraftOf } from "@novadeck/chat/state"\nimport type { X } from "@novadeck/chat/commands"\n`,
    )
    expect(
      rewriteSpecifiers(
        `${ui}/styles.css`,
        `@import "./terminals/chat/chat.css" layer(components);`,
        tracked,
      ).text,
    ).toBe(`@import "@novadeck/chat/chat.css" layer(components);`)
  })

  it("leave what stays alone, and give a moved file relative paths and the package's test.ts", () => {
    expect(
      rewriteSpecifiers(
        `${ui}/app/WorkspaceTerminal.tsx`,
        `import { x } from "../terminals/WindowShell"\n`,
        tracked,
      ).text,
    ).toBe(`import { x } from "../terminals/WindowShell"\n`)
    const moved = rewriteSpecifiers(
      `${ui}/terminals/chat/ChatView.test.ts`,
      `import { it } from "../../test"\nimport { x } from "./state"\n`,
      tracked,
    )
    expect(moved.problems).toEqual([])
    expect(moved.text).toBe(`import { it } from "./test"\nimport { x } from "./state"\n`)
  })

  it("stop a moved file that reaches what stayed behind, and an import of nothing", () => {
    expect(
      rewriteSpecifiers(
        `${ui}/terminals/chat/ChatView.tsx`,
        `import type { X } from "../WindowShell"\n`,
        tracked,
      ).problems,
    ).toHaveLength(1)
    expect(
      rewriteSpecifiers(
        `${ui}/app/WorkspaceTerminal.tsx`,
        `import "../terminals/chat/Gone"\n`,
        tracked,
      ).problems,
    ).toHaveLength(1)
  })

  it("find nothing to do on a tree the move has made, and still resolve a late importer", () => {
    const made = new Set([`${ch}/state.ts`, `${ch}/test.ts`, `${ui}/app/commands/chat.ts`])
    const text = `import { chatDraftOf } from "@novadeck/chat/state"\n`
    expect(rewriteSpecifiers(`${ui}/app/commands/chat.ts`, text, made)).toEqual({
      text,
      problems: [],
    })
    expect(
      rewriteSpecifiers(
        `${ui}/app/commands/chat.ts`,
        `import { chatDraftOf } from "../../terminals/chat/state"\n`,
        made,
      ).text,
    ).toBe(text)
  })
})

describe("a branch that predates the toolkit and companion moves too", () => {
  const toolkitText = `import { Tooltip } from "../../ui-toolkit/Tooltip"\n`
  const companionText = `import { barMembers } from "../companion/bar"\n`
  const wanted = `import { Tooltip } from "@novadeck/toolkit/Tooltip"\n`
  const wantedCompanion = `import { barMembers } from "@novadeck/companion/bar"\n`

  it("names the other packages' files from their packages, still at their old places", () => {
    const old = new Set([
      `${ui}/test.ts`,
      `${ui}/ui-toolkit/Tooltip.tsx`,
      `${ui}/terminals/companion/bar.ts`,
      `${ui}/terminals/chat/Composer.tsx`,
    ])
    const file = `${ui}/terminals/chat/Composer.tsx`
    expect(rewriteSpecifiers(file, toolkitText, old)).toEqual({ text: wanted, problems: [] })
    expect(rewriteSpecifiers(file, companionText, old)).toEqual({
      text: wantedCompanion,
      problems: [],
    })
  })

  it("and once they moved, from the old specifier of a file the merge took in", () => {
    const moved = new Set([
      `${ui}/test.ts`,
      `frontend/toolkit/src/Tooltip.tsx`,
      `frontend/companion/src/bar.ts`,
      `${ch}/Composer.tsx`,
    ])
    expect(rewriteSpecifiers(`${ch}/Composer.tsx`, toolkitText, moved)).toEqual({
      text: wanted,
      problems: [],
    })
    expect(rewriteSpecifiers(`${ch}/Composer.tsx`, companionText, moved)).toEqual({
      text: wantedCompanion,
      problems: [],
    })
  })
})

describe("a branch that merged main before the script ran", () => {
  // Git's directory rename took the branch's new file into the package, specifiers as written.
  const merged = new Set([
    `${ui}/test.ts`,
    `${ui}/terminals/WindowShell.tsx`,
    `${ch}/state.ts`,
    `${ch}/NewThing.tsx`,
  ])

  it("resolves a moved file's old-place specifiers, though test.ts isn't written yet", () => {
    const done = rewriteSpecifiers(
      `${ch}/NewThing.tsx`,
      `import { s } from "./state"\nimport { it } from "../../test"\n`,
      merged,
    )
    expect(done.problems).toEqual([])
    expect(done.text).toBe(`import { s } from "./state"\nimport { it } from "./test"\n`)
  })

  it("still stops on what the package can't reach", () => {
    expect(
      rewriteSpecifiers(`${ch}/NewThing.tsx`, `import { x } from "../WindowShell"\n`, merged)
        .problems,
    ).toHaveLength(1)
  })
})

describe("the exports an outsider's import needs", () => {
  it("lists each module imported from outside, once, and not the chat contract's", () => {
    expect(
      importedKeys([
        `import a from "@novadeck/chat/state"\nimport b from "@novadeck/chat/state"\n`,
        `@import "@novadeck/chat/chat.css" layer(components);\nimport("@novadeck/chat/ChatView")\n`,
        `import c from "@novadeck/chat-contract/x"\n`,
      ]),
    ).toEqual(["./ChatView", "./chat.css", "./state"])
  })

  it("reports a module the manifest lacks", () => {
    expect(missingExports(["./state", "./nope"], new Set(["./state"]))).toEqual([
      `@novadeck/chat has no "./nope" export`,
    ])
  })
})
