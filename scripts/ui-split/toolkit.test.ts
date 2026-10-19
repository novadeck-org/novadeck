import { describe, expect, it } from "vitest"

import { destinationOf, insertAfter, insertBefore, originOf, rewriteSpecifiers } from "./toolkit.ts"

const ui = "frontend/ui/src"
const tk = "frontend/toolkit/src"
const tracked = new Set([
  `${ui}/test.ts`,
  `${ui}/class-name.ts`,
  `${ui}/ui-toolkit/Tooltip.tsx`,
  `${ui}/ui-toolkit/icons/ClaudeIcon.ts`,
  `${ui}/ui-toolkit/button.css`,
  `${ui}/sidebar/SidebarItem.tsx`,
  `${ui}/sidebar/SessionsPanel.tsx`,
  `${ui}/terminals/TerminalTab.tsx`,
  `${ui}/core-free.ts`,
])

describe("where the toolkit's files go", () => {
  it("takes the folder, the class names and the sidebar item, and nothing else", () => {
    expect(destinationOf(`${ui}/ui-toolkit/icons/ClaudeIcon.ts`)).toBe(`${tk}/icons/ClaudeIcon.ts`)
    expect(destinationOf(`${ui}/class-name.test.ts`)).toBe(`${tk}/class-name.test.ts`)
    expect(destinationOf(`${ui}/sidebar/SidebarItem.tsx`)).toBe(`${tk}/SidebarItem.tsx`)
    expect(destinationOf(`${ui}/sidebar/SidebarPanel.tsx`)).toBeUndefined()
    expect(destinationOf(`${ui}/test.ts`)).toBeUndefined()
  })

  it("names where a file came from, but not the package's own test.ts", () => {
    expect(originOf(`${tk}/SidebarItem.tsx`)).toBe(`${ui}/sidebar/SidebarItem.tsx`)
    expect(originOf(`${tk}/button.css`)).toBe(`${ui}/ui-toolkit/button.css`)
    expect(originOf(`${tk}/test.ts`)).toBeUndefined()
  })
})

describe("the specifiers that name a moved file", () => {
  it("point an importer at the package, with no extension on code and one on a stylesheet", () => {
    const code = rewriteSpecifiers(
      `${ui}/terminals/TerminalTab.tsx`,
      `import { SidebarItem } from "../sidebar/SidebarItem"\nimport { Tooltip } from "../ui-toolkit/Tooltip"\nimport { ClaudeIcon } from "../ui-toolkit/icons/ClaudeIcon"\n`,
      tracked,
    )
    expect(code.problems).toEqual([])
    expect(code.text).toBe(
      `import { SidebarItem } from "@novadeck/toolkit/SidebarItem"\nimport { Tooltip } from "@novadeck/toolkit/Tooltip"\nimport { ClaudeIcon } from "@novadeck/toolkit/icons/ClaudeIcon"\n`,
    )
    expect(
      rewriteSpecifiers(
        `${ui}/styles.css`,
        `@import "./ui-toolkit/button.css" layer(components);`,
        tracked,
      ).text,
    ).toBe(`@import "@novadeck/toolkit/button.css" layer(components);`)
  })

  it("leave a sibling's import alone and give a moved file the package's own test.ts", () => {
    expect(
      rewriteSpecifiers(
        `${ui}/sidebar/SessionsPanel.tsx`,
        `import { x } from "./other"\n`,
        new Set([...tracked, `${ui}/sidebar/other.ts`]),
      ).text,
    ).toBe(`import { x } from "./other"\n`)
    const moved = rewriteSpecifiers(
      `${ui}/ui-toolkit/Tooltip.tsx`,
      `import { cn } from "../class-name"\nimport { it } from "../test"\nimport { Icon } from "./icons/ClaudeIcon"\n`,
      tracked,
    )
    expect(moved.problems).toEqual([])
    expect(moved.text).toBe(
      `import { cn } from "./class-name"\nimport { it } from "./test"\nimport { Icon } from "./icons/ClaudeIcon"\n`,
    )
  })

  it("stop a moved file that reaches what stayed behind, and an import of nothing", () => {
    expect(
      rewriteSpecifiers(
        `${ui}/ui-toolkit/Tooltip.tsx`,
        `import { x } from "../core-free"\n`,
        tracked,
      ).problems,
    ).toHaveLength(1)
    expect(
      rewriteSpecifiers(`${ui}/terminals/TerminalTab.tsx`, `import "../ui-toolkit/Gone"\n`, tracked)
        .problems,
    ).toHaveLength(1)
  })

  it("find nothing to do on a tree the move has made, and still resolve a late importer", () => {
    const made = new Set([
      `${tk}/Tooltip.tsx`,
      `${tk}/class-name.ts`,
      `${tk}/test.ts`,
      `${ui}/terminals/TerminalTab.tsx`,
    ])
    const text = `import { Tooltip } from "@novadeck/toolkit/Tooltip"\n`
    expect(rewriteSpecifiers(`${ui}/terminals/TerminalTab.tsx`, text, made)).toEqual({
      text,
      problems: [],
    })
    expect(
      rewriteSpecifiers(`${tk}/Tooltip.tsx`, `import { cn } from "./class-name"\n`, made).text,
    ).toBe(`import { cn } from "./class-name"\n`)
    // A branch that added an import of the old place, after the file moved on main.
    expect(
      rewriteSpecifiers(
        `${ui}/terminals/TerminalTab.tsx`,
        `import { Tooltip } from "../ui-toolkit/Tooltip"\n`,
        made,
      ).text,
    ).toBe(text)
  })
})

describe("the lines it adds to a stylesheet", () => {
  const css = `@a;\n@import "./b.css";\n@c;\n`
  it("go once, before or after the anchor", () => {
    const before = insertBefore(css, `@import "./b.css"`, "@new;")
    expect(before).toBe(`@a;\n@new;\n@import "./b.css";\n@c;\n`)
    expect(insertBefore(before!, `@import "./b.css"`, "@new;")).toBe(before)
    expect(insertAfter(css, "@a;", "@new;")).toBe(`@a;\n@new;\n@import "./b.css";\n@c;\n`)
    expect(insertAfter(css, "@missing", "@new;")).toBeUndefined()
  })
})
