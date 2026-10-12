import { MURMUR_NAME } from "../model/murmur"
import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { windowMenu } from "./window-menu"

const ignore = (): void => {}
const labels = (items: ReturnType<typeof windowMenu>) =>
  items.map((item) => `${item.label}${item.disabled ? " (disabled)" : ""}`)

describe("a window's menu", () => {
  it("offers a terminal Rename and Close, and Reset only for a name the person gave", () => {
    const terminal = terminalFixture(1, "~/p")
    expect(labels(windowMenu({ terminal, onRename: ignore, onClose: ignore }))).toEqual([
      "Rename",
      "Close",
    ])
    const named = { ...terminal, titleSource: { kind: "person" as const } }
    expect(
      labels(
        windowMenu({ terminal: named, onRename: ignore, onResetTitle: ignore, onClose: ignore }),
      ),
    ).toEqual(["Named by you (disabled)", "Rename", "Reset to automatic", "Close"])
  })

  it("says murmur named a terminal, which Reset leaves alone", () => {
    const terminal = { ...terminalFixture(2, "~/p"), titleSource: { kind: "murmur" as const } }
    expect(
      labels(windowMenu({ terminal, onRename: ignore, onResetTitle: ignore, onClose: ignore })),
    ).toEqual([`Named by ${MURMUR_NAME} (disabled)`, "Rename", "Close"])
  })

  context("for a window undocked from a terminal's companion", () => {
    const terminal = terminalFixture(3, "~/p")

    it("docks it back in its terminal by name", () => {
      const returned: string[] = []
      const items = windowMenu({
        terminal,
        onRename: ignore,
        dockIn: { name: "Build Studio", onDock: () => returned.push("01") },
        onClose: ignore,
      })
      expect(labels(items)).toEqual(["Rename", "Dock in Build Studio", "Close"])
      items.find((item) => item.value === "dock")!.onSelect()
      expect(returned).toEqual(["01"])
    })

    it("shows Dock disabled once its terminal has closed", () => {
      const items = windowMenu({
        terminal,
        onRename: ignore,
        dockIn: { name: undefined, onDock: undefined },
        onClose: ignore,
      })
      expect(labels(items)).toEqual(["Rename", "Dock in its terminal (closed) (disabled)", "Close"])
    })
  })
})
