import { describe, expect, it } from "vitest"

import { projectFolder } from "./project-window"

describe("projectFolder", () => {
  it("names the folder from the project's", () => {
    expect(projectFolder("/shop/src/checkout/Address.tsx", "/shop")).toBe("src/checkout")
  })

  it("says nothing for a file at the project's root", () => {
    expect(projectFolder("/shop/README.md", "/shop")).toBe("")
    expect(projectFolder("/shop/README.md", "/shop/")).toBe("")
  })

  it("names the whole folder of a file outside the project", () => {
    expect(projectFolder("/shopping/list.md", "/shop")).toBe("/shopping")
    expect(projectFolder("/etc/hosts", "/shop")).toBe("/etc")
  })

  it("reads a Windows path alike", () => {
    expect(projectFolder("C:\\shop\\src\\cart\\Cart.tsx", "C:\\shop")).toBe("src\\cart")
    expect(projectFolder("C:\\shop\\.env", "C:\\shop")).toBe("")
  })

  it("says nothing for an item with no path", () => {
    expect(projectFolder(null, "/shop")).toBe("")
  })
})
