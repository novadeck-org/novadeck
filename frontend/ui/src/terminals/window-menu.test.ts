import { MURMUR_NAME } from "@novadeck/core/addons/murmur"
import { itemFixture, terminalFixture } from "@novadeck/core/testing"
import type { ContextMenuAction, ContextMenuItem } from "@novadeck/toolkit/ContextMenu"

import { context, describe, expect, it } from "../test"
import { windowMenu, type MoveTo } from "./window-menu"

const ignore = (): void => {}
const labels = (items: readonly ContextMenuItem[]) =>
  items.map((item) => `${item.label}${"disabled" in item && item.disabled ? " (disabled)" : ""}`)
// The action of `value`, which a test chooses.
const action = (items: readonly ContextMenuItem[], value: string): ContextMenuAction => {
  const found = items.find((item) => item.value === value)
  if (!found || "items" in found) throw new Error(`No action ${value}`)
  return found
}

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
    action(items, "ask-feedback").onSelect()
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
    action(items, "release-lead").onSelect()
    expect(released).toEqual(["moth"])
  })

  it("names no handle for a lead the session no longer has", () => {
    const items = windowMenu({
      terminal: terminalFixture(4, "~/p"),
      onRename: ignore,
      releaseLead: { lead: null, onRelease: ignore },
      onClose: ignore,
    })
    expect(labels(items)).toEqual(["Rename", "Release from its lead", "Close"])
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
      action(items, "dock").onSelect()
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

  it("offers a lead to fold its teammates, or show them again, above Close", () => {
    const toggled: string[] = []
    const menu = (count: number, folded: boolean) =>
      windowMenu({
        terminal: terminalFixture(4, "~/p"),
        onRename: ignore,
        foldTeam: { count, folded, onToggle: () => toggled.push(`${count}`) },
        onClose: ignore,
      })
    expect(labels(menu(3, false))).toEqual(["Rename", "Fold 3 teammates", "Close"])
    expect(labels(menu(3, true))).toEqual(["Rename", "Show 3 teammates", "Close"])
    expect(labels(menu(1, false))).toEqual(["Rename", "Fold 1 teammate", "Close"])
    action(menu(2, false), "fold-team").onSelect()
    expect(toggled).toEqual(["2"])
  })

  context("where the terminal can move to another session", () => {
    const moves: string[] = []
    const moveTo = (team: number, more: boolean): MoveTo => ({
      sessions: [
        { id: "s2", name: "Nov 6, 22:11", count: 7 },
        { id: "s3", name: "Payments", count: 4 },
      ],
      more,
      team,
      onMove: (to) => moves.push("fresh" in to ? "new" : to.sessionId),
      onPick: () => moves.push("pick"),
    })
    const submenu = (items: readonly ContextMenuItem[]) => {
      const found = items.find((item) => item.value === "move")
      if (!found || !("items" in found)) throw new Error("No move submenu")
      return found
    }

    it("lists a new session, then the sessions, above Close", () => {
      const items = windowMenu({
        terminal: terminalFixture(2, "~/p"),
        onRename: ignore,
        moveTo: moveTo(0, false),
        onClose: ignore,
      })
      expect(labels(items)).toEqual(["Rename", "Move to session", "Close"])
      const move = submenu(items)
      expect(labels(move.items)).toEqual(["New session", "Nov 6, 22:11", "Payments"])
      action(move.items, "move-new").onSelect()
      action(move.items, "move-to-s3").onSelect()
      expect(moves.splice(0)).toEqual(["new", "s3"])
    })

    it("ends with All sessions… where there are more than it lists", () => {
      const move = submenu(
        windowMenu({
          terminal: terminalFixture(2, "~/p"),
          onRename: ignore,
          moveTo: moveTo(0, true),
          onClose: ignore,
        }),
      )
      expect(labels(move.items).at(-1)).toBe("All sessions…")
      action(move.items, "move-all").onSelect()
      expect(moves.splice(0)).toEqual(["pick"])
    })

    it("moves a lead's team, naming how many come along", () => {
      const items = windowMenu({
        terminal: terminalFixture(2, "~/p"),
        onRename: ignore,
        moveTo: moveTo(3, false),
        onClose: ignore,
      })
      const move = submenu(items)
      expect(move.label).toBe("Move team to session")
      expect(labels(move.items)[0]).toBe("With 3 teammates (disabled)")
    })
  })
})
