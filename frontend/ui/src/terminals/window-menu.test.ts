import { MURMUR_NAME } from "@novadeck/core/murmur"
import { itemFixture, terminalFixture } from "@novadeck/core/testing"

import { context, describe, expect, it } from "../test"
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

  it("offers to ask an agent's window for feedback, above Close", () => {
    const asked: string[] = []
    const items = windowMenu({
      terminal: terminalFixture(4, "~/p"),
      onRename: ignore,
      askFeedback: { handle: "moth", onAsk: () => asked.push("moth") },
      onClose: ignore,
    })
    expect(labels(items)).toEqual(["Rename", "Ask @moth to write feedback…", "Close"])
    items.find((item) => item.value === "ask-feedback")!.onSelect()
    expect(asked).toEqual(["moth"])
  })

  it("offers to release a led terminal from its lead, above Close", () => {
    const released: string[] = []
    const items = windowMenu({
      terminal: terminalFixture(4, "~/p"),
      onRename: ignore,
      releaseLead: { lead: "moth", onRelease: () => released.push("moth") },
      onClose: ignore,
    })
    expect(labels(items)).toEqual(["Rename", "Release from @moth", "Close"])
    items.find((item) => item.value === "release-lead")!.onSelect()
    expect(released).toEqual(["moth"])
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

  context("for the project window", () => {
    it("offers Close alone: its file names it and there's no terminal to dock in", () => {
      const terminal = {
        id: "w1",
        home: "project" as const,
        itemId: itemFixture("readme", "01").id,
        name: "README.md",
        titleSource: { kind: "default" as const },
      }
      expect(
        labels(
          windowMenu({
            terminal,
            onRename: ignore,
            onResetTitle: ignore,
            dockIn: { name: "Build Studio", onDock: ignore },
            onClose: ignore,
          }),
        ),
      ).toEqual(["Close"])
    })
  })
})
