import { describe, expect, it } from "vitest"

import { novaStartup } from "./startup.js"

describe("starting Nova by its word", () => {
  it("runs its launcher in the form each shell runs a quoted path", () => {
    const launcher = "/Users/a b/Library/Application Support/novadeck/shell/bundled/pi"
    expect(novaStartup("novadeck-pi --model x", "/bin/zsh", launcher)).toBe(
      `'${launcher}' --model x`,
    )
    expect(novaStartup("novadeck-pi", "/bin/bash", launcher)).toBe(`'${launcher}'`)
    expect(novaStartup("novadeck-pi --thinking medium", "pwsh.exe", "C:\\a b\\pi.cmd")).toBe(
      "& 'C:\\a b\\pi.cmd' --thinking medium",
    )
  })

  it("leaves any other command as it is, another program named nova's too", () => {
    const launcher = "/home/a/.config/novadeck/shell/bundled/pi"
    expect(novaStartup("pi --model x", "/bin/bash", launcher)).toBe("pi --model x")
    expect(novaStartup("novadeck-pie", "/bin/bash", launcher)).toBe("novadeck-pie")
    expect(novaStartup("nova open notes.txt", "/bin/bash", launcher)).toBe("nova open notes.txt")
  })
})
