import { describe, expect, it } from "vitest"

import { cmdShim, makeCmdShim } from "./shim.js"

describe("the Windows shim", () => {
  it("looks for the real agy on PATH only, never in the current folder where cmd looks first", () => {
    expect(cmdShim).toContain("('where $PATH:agy 2^>nul')")
    expect(cmdShim).not.toMatch(/where agy/)
  })

  it("puts no folder on PATH without a verified cmd.exe pass-through", () => {
    expect(cmdShim).not.toMatch(/set "PATH=/)
  })

  it("puts the pass-through's folder first on PATH, inside Novadeck's terminals, for agy alone", () => {
    const shim = makeCmdShim("C:\\NOVADE~1\\shell\\agy-cmd")
    const lines = shim.split("\n")
    const prepend = lines.findIndex(
      (line) => line === 'set "PATH=C:\\NOVADE~1\\shell\\agy-cmd;%PATH%"',
    )
    expect(prepend).toBeGreaterThan(-1)
    // After the checks that this is a Novadeck terminal running the shim, and after the real
    // agy was found on the person's own PATH; under setlocal, so the shell keeps its PATH.
    expect(prepend).toBeGreaterThan(
      lines.findIndex((line) => line.includes("NOVADECK_TERMINAL_ID=[A-Za-z0-9_-]")),
    )
    expect(prepend).toBeGreaterThan(lines.findIndex((line) => line.includes("where $PATH:agy")))
    expect(prepend).toBeGreaterThan(lines.indexOf("setlocal"))
  })
})
