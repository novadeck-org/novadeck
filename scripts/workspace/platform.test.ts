import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  declaredPlatform,
  platformOf,
  systemImport,
  systemProperty,
  workspacePackages,
  workspaceTrees,
} from "./platform.ts"

const root = join(import.meta.dirname, "..", "..")
const packages = workspacePackages(root)

describe("the packages' platform declarations", () => {
  it("finds every workspace package", () => {
    const folders = packages.map(({ folder }) => folder)
    expect(folders).toEqual(
      expect.arrayContaining(["apps/desktop", "backend/runner", "frontend/ui", "tools/atlas"]),
    )
    expect(folders.length).toBeGreaterThan(30)
  })

  // A missing one reads as `system`, which runs more; this keeps it from going unnoticed.
  it("has one, system or neutral, in every package", () => {
    expect(
      packages
        .filter(({ manifest }) => declaredPlatform(manifest) === undefined)
        .map(({ folder }) => folder),
    ).toEqual([])
  })
})

describe("a package's platform", () => {
  it("is what it declares", () => {
    expect(platformOf({ novadeck: { platform: "neutral" } })).toBe("neutral")
    expect(platformOf({ novadeck: { platform: "system" } })).toBe("system")
  })

  it("is system where it declares none, or none known", () => {
    expect(declaredPlatform({})).toBeUndefined()
    expect(platformOf({})).toBe("system")
    expect(platformOf({ novadeck: {} })).toBe("system")
    expect(platformOf({ novadeck: { platform: "Neutral" } })).toBe("system")
    expect(platformOf({ novadeck: { platform: true } })).toBe("system")
  })
})

describe("the workspace's folders of packages", () => {
  it("are read from pnpm-workspace.yaml's packages", () => {
    expect(
      workspaceTrees(
        'packages:\n  - backend/*\n  # a note\n\n  - "frontend/*"\n\ncatalog:\n  zod: 1.0.0\n',
      ),
    ).toEqual(["backend", "frontend"])
  })

  it("refuses a glob it can't tell the folders from", () => {
    expect(() => workspaceTrees("packages:\n  - backend/**\n")).toThrow(/backend\/\*\*/)
    expect(() => workspaceTrees("packages:\n  - '!frontend/x'\n")).toThrow(/!frontend\/x/)
    expect(() => workspaceTrees("catalog:\n  zod: 1.0.0\n")).toThrow(/has no packages/)
  })
})

describe("what makes a package system", () => {
  it.each([
    "node:child_process",
    "child_process",
    "node:os",
    "os",
    "node:net",
    "node:tty",
    "node:cluster",
    "electron",
    "electron/main",
    "node-pty",
    "koffi",
    "@novadeck/sandbox",
    "@novadeck/sandbox/processes",
    "@novadeck/terminal/pty",
    "@novadeck/terminal/host",
    "@novadeck/terminal/shell",
    "@novadeck/wire/electron",
    "@novadeck/viewers/browser/host",
  ])("is importing %s", (source) => {
    expect(systemImport(source)).toBeDefined()
  })

  it.each([
    "node:fs",
    "node:path",
    "node:url",
    "node:crypto",
    "node:timers/promises",
    "@novadeck/terminal",
    "@novadeck/terminal/view",
    "@novadeck/wire/client",
    "@novadeck/viewers/browser",
    "@novadeck/emulator/headless",
    "@xterm/xterm",
    "./os",
    "./pty",
  ])("isn't importing %s", (source) => {
    expect(systemImport(source)).toBeUndefined()
  })

  it("isn't taking the temporary folder alone from os", () => {
    expect(systemImport("node:os", ["tmpdir"])).toBeUndefined()
    expect(systemImport("os", ["tmpdir"])).toBeUndefined()
    expect(systemImport("node:os", ["tmpdir", "homedir"])).toBeDefined()
    expect(systemImport("node:os")).toBeDefined()
  })

  it("is reading what process says of the system", () => {
    expect(systemProperty("platform")).toBeDefined()
    expect(systemProperty("kill")).toBeDefined()
    expect(systemProperty("env")).toBeUndefined()
    expect(systemProperty("cwd")).toBeUndefined()
  })
})
