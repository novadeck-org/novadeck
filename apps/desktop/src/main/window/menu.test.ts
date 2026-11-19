import type { MenuItemConstructorOptions } from "electron"

import { describe, expect, it } from "../../test"
import { linuxMenu, macMenu, viewMenu, windowsMenu } from "./menu"

describe("the Linux application menu", () => {
  it("keeps the default menus, Edit, View and Window, by their roles", () => {
    const menu = linuxMenu(() => {})
    expect(menu.map((item) => item.role ?? item.label)).toEqual([
      "File",
      "editMenu",
      "View",
      "windowMenu",
    ])
  })

  it("quits with Ctrl+Q through the app's own handler, and has no other Quit", () => {
    const quits: string[] = []
    const [file] = linuxMenu(() => void quits.push("quit"))
    const items = file!.submenu as MenuItemConstructorOptions[]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ label: "Quit", accelerator: "CommandOrControl+Q" })
    expect(items[0]!.role).toBeUndefined()
    ;(items[0]!.click as () => void)()
    expect(quits).toEqual(["quit"])
  })
})

describe("the View menu", () => {
  it("has no zoom item, role or accelerator, which would zoom the page apart from Preferences' scale", () => {
    const items = viewMenu.submenu as MenuItemConstructorOptions[]
    expect(items.map((item) => item.role ?? item.type)).toEqual([
      "reload",
      "forceReload",
      "toggleDevTools",
      "separator",
      "togglefullscreen",
    ])
    expect(items.some((item) => item.accelerator !== undefined)).toBe(false)
  })

  it("serves Windows and macOS too, in place of Electron's default View", () => {
    expect(windowsMenu.map((item) => item.role ?? item.label)).toEqual([
      "fileMenu",
      "editMenu",
      "View",
      "windowMenu",
    ])
  })
})

describe("the macOS application menu", () => {
  it("keeps the default menus by their roles", () => {
    expect(macMenu(() => {}).map((item) => item.role ?? item.label)).toEqual([
      "appMenu",
      "fileMenu",
      "editMenu",
      "View",
      "windowMenu",
      "help",
    ])
  })

  it("holds only Open Logs Folder in Help, which opens the logs folder", () => {
    const opened: string[] = []
    const help = macMenu(() => void opened.push("logs")).at(-1)!
    const items = help.submenu as MenuItemConstructorOptions[]
    expect(items.map((item) => item.label)).toEqual(["Open Logs Folder"])
    ;(items[0]!.click as () => void)()
    expect(opened).toEqual(["logs"])
  })
})
