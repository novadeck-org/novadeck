import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { rootRows, sideFocused, sideToggle } from "./panes.js"

// Probed on 0.170.0 and 0.171.0 (`e2e/probes/codex-side-dialog.e2e.ts`): the root's turn asks an
// approval with a `/side` conversation open. `permissionSide`: the side opened mid-turn, in focus
// when the approval comes, then Ctrl-/ three times and `y`. `permissionRoot`: the side opened
// after a first turn, Ctrl-/ back to the root before the prompt. `permissionNarrow`: as
// `permissionSide`, on 99 columns, where the side takes the whole screen. `sideBusy`: the root's
// approval up and in focus while the side's turn runs, with the cursor of 60 frames
// (`sideBusyFrames`). `sideApproval120`/`99`: the side's own turn asks, with the terminal's
// pending requests (`…Requests`).
type Cursor = { readonly row: number; readonly column: number }
type States = { readonly [state: string]: ScreenText } & {
  readonly sideBusyFrames: readonly { readonly cursor: Cursor; readonly row: string }[]
} & { readonly [requests: `${string}Requests`]: readonly unknown[] }
const { versions } = loadProbe<{ readonly versions: { readonly [version: string]: States } }>(
  import.meta.dirname,
  "side-dialog.probe.json",
)
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
    expect(revealed(held)).toBe(sideToggle())
    // The sidebar's focus hint says so without the cursor, the root's pane drawing none.
    expect(dialogs.reveal?.(held.rows)).toBe(sideToggle())
    expect(held.rows.at(-1)).toMatch(/│ {2}← for agents · \? for shortcuts/)
  })

  it("is told by the cursor in the sidebar's composer where a draft takes the hint away", () => {
    const { versions: drawn } = loadProbe<{
      readonly versions: { readonly [version: string]: { readonly [label: string]: ScreenText } }
    }>(import.meta.dirname, "side.probe.json")
    const draft = drawn["0.171.0"]!["side draft"]!
    expect(draft.rows.join("\n")).not.toMatch(/← for agents/)
    expect(sideFocused(draft.rows, draft.cursor)).toBe(true)
    expect(sideFocused(draft.rows, undefined)).toBe(false)
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
      expect(revealed(screen), version).toBe(sideToggle())
      // The footer alone says it, without the cursor.
      expect(dialogs.reveal?.(screen.rows), version).toBe(sideToggle())
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

describe("where Codex leaves a hidden cursor", () => {
  it("tells the sidebar in focus only by its composer, never a cursor parked after a cell drawn there", () => {
    const held = wide.sideBusyHeld!
    // The root's approval is up and in focus, the side's turn ticking beside it.
    expect(dialogs.read(held.rows, approval)?.dialog).toMatchObject({ type: "choices" })
    const parked = wide.sideBusyFrames.filter(({ cursor }) => cursor.column > 79)
    expect(parked.length).toBeGreaterThan(0)
    for (const { cursor } of wide.sideBusyFrames) {
      expect(sideFocused(held.rows, cursor), JSON.stringify(cursor)).toBe(false)
      expect(dialogs.reveal?.(held.rows, cursor)).toBeUndefined()
    }
    // The side in focus, its turn running: the cursor in its composer.
    expect(sideFocused(wide.sideBusySideWorking!.rows, wide.sideBusySideWorking!.cursor)).toBe(true)
  })

  it("presses Ctrl-/ at most once for a request, a second press undoing it", () => {
    expect(dialogs.revealToggles).toEqual([sideToggle()])
  })
})

describe("a side conversation's own approval", () => {
  it("puts no request on the terminal, so none is read or revealed (both versions, both widths)", () => {
    for (const [version, states] of [
      ["0.171.0", wide],
      ["0.170.0", whole],
    ] as const) {
      for (const width of ["120", "99"]) {
        const held = states[`sideApproval${width}Held`]!
        expect(held.rows.join("\n"), `${version} ${width}`).toContain("Would you like to run")
        expect(states[`sideApproval${width}HeldRequests`], `${version} ${width}`).toEqual([])
        expect(revealed(held), `${version} ${width}`).toBeUndefined()
      }
    }
  })
})

describe("Ctrl-/ as each platform's terminal sends it", () => {
  it("is 0x1F, which Codex reads as Ctrl-7, its alias for Ctrl-/, on Linux and macOS", () => {
    expect(sideToggle("linux")).toBe("\x1f")
    expect(sideToggle("darwin")).toBe("\x1f")
  })

  it("is a win32-input-mode record of the 7 key with Ctrl, down and up, on Windows", () => {
    // ConPTY makes a bare 0x1F the - key with Ctrl and Shift, which Codex reads as neither.
    expect(sideToggle("win32")).toBe("\x1b[55;8;0;1;8;1_\x1b[55;8;0;0;8;1_")
  })
})
