import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { rootRows, sideFocused } from "./panes.js"

// Probed on 0.170.0 and 0.171.0 (`e2e/probes/codex-side-dialog.e2e.ts`): the root's turn asks an
// approval with a `/side` conversation open. `permissionSide`: the side opened mid-turn, in focus
// when the approval comes, then Ctrl-/ three times and `y`. `permissionRoot`: the side opened
// after a first turn, Ctrl-/ back to the root before the prompt. `permissionNarrow`: as
// `permissionSide`, on 99 columns, where the side takes the whole screen.
const { versions } = loadProbe<{
  readonly versions: {
    readonly [version: string]: { readonly [state: string]: ScreenText }
  }
}>(import.meta.dirname, "side-dialog.probe.json")
const wide = versions["0.171.0"]!
const whole = versions["0.170.0"]!

const approval: RequestFacts = {
  kind: "permission",
  tool: "Bash",
  input: { command: "echo approved > probe-out.txt", description: "Echo outside the sandbox" },
  cwd: null,
}

const revealed = (screen: ScreenText) => dialogs.reveal?.(screen.rows, screen.cursor)

describe("the root's approval beside a /side conversation (0.171.0)", () => {
  it("is held out of view while the side has the focus, and Ctrl-/ brings it", () => {
    const held = wide.permissionSideHeld!
    expect(dialogs.read(held.rows, approval)).toBeUndefined()
    expect(sideFocused(held.rows, held.cursor)).toBe(true)
    expect(revealed(held)).toBe("\x1f")
    // Nothing on the screen alone says so: the cursor does.
    expect(dialogs.reveal?.(held.rows)).toBeUndefined()
  })

  it("reads in the root's pane alone, each row going on past the divider into the sidebar", () => {
    for (const name of [
      "permissionSideSwitched",
      "permissionSideSwitchedAgain",
      "permissionRootHeld",
      "permissionRootSwitchedThird",
    ]) {
      const screen = wide[name]!
      expect(
        screen.rows.every((row) => row.includes("│")),
        name,
      ).toBe(true)
      const read = dialogs.read(screen.rows, approval)
      expect(read?.dialog, name).toMatchObject({ type: "choices" })
      // In view, the root in focus: nothing more to press, Ctrl-/ doing nothing there.
      expect(revealed(screen), name).toBeUndefined()
    }
    expect(rootRows(wide.permissionRootHeld!.rows).join("\n")).not.toContain("│")
  })

  it("is answered once its line shows in the root's pane", () => {
    const read = dialogs.read(wide.permissionSideSwitched!.rows, approval)!
    expect(read.answered(wide.permissionSideSwitched!.rows)).toBe(false)
    expect(read.answered(wide.permissionSideAnswered!.rows)).toBe(true)
  })

  it("isn't revealed with the root in focus before it comes", () => {
    expect(revealed(wide.permissionRootRootBack!)).toBeUndefined()
    expect(revealed(wide.permissionRootAnswered!)).toBeUndefined()
  })
})

describe("the root's approval behind a /side conversation over the whole screen", () => {
  it("is told by the side's footer, and Ctrl-/ brings it (0.170.0, and 0.171.0 under 100 columns)", () => {
    for (const [version, screen] of [
      ["0.170.0", whole.permissionSideHeld!],
      ["0.170.0", whole.permissionNarrowHeld!],
      ["0.171.0", wide.permissionNarrowHeld!],
    ] as const) {
      expect(screen.rows.join("\n"), version).toMatch(/main needs approval/)
      expect(dialogs.read(screen.rows, approval), version).toBeUndefined()
      expect(revealed(screen), version).toBe("\x1f")
      // The footer alone says it, without the cursor.
      expect(dialogs.reveal?.(screen.rows), version).toBe("\x1f")
    }
  })

  it("isn't revealed while the side shows and the root waits on nothing", () => {
    expect(revealed(wide.permissionNarrowSideOpen!)).toBeUndefined()
    expect(revealed(whole.permissionSideSideOpen!)).toBeUndefined()
  })

  it("reads once in view, the whole screen the root's", () => {
    for (const screen of [whole.permissionSideSwitched!, wide.permissionNarrowSwitched!]) {
      expect(dialogs.read(screen.rows, approval)?.dialog).toMatchObject({ type: "choices" })
      expect(rootRows(screen.rows)).toBe(screen.rows)
      expect(revealed(screen)).toBeUndefined()
    }
  })
})
