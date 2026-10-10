import type { MenuItemConstructorOptions } from "electron"

import { describe, expect, it } from "../test"
import { linuxMenu } from "./menu"

describe("the Linux application menu", () => {
  it("keeps the default menus, Edit, View and Window, by their roles", () => {
    const menu = linuxMenu(() => {})
    expect(menu.map((item) => item.role ?? item.label)).toEqual([
      "File",
      "editMenu",
      "viewMenu",
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
