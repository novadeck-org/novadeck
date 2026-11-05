import { describe, expect, it } from "vitest"

import { pluginEnabled } from "./plugin.js"

const enabled = (...lines: string[]) => pluginEnabled(lines.join("\n"))

describe("whether Codex's configuration enables Novadeck's plugin", () => {
  it("reads the table Codex writes, beside other tables and keys", () => {
    expect(
      enabled(
        'model = "gpt-5"',
        "",
        '[plugins."other@market"]',
        "enabled = true",
        "",
        '[plugins."novadeck@novadeck"]',
        "enabled = true",
        "",
        '[hooks.state."novadeck@novadeck:stop"]',
        'hash = "abc"',
      ),
    ).toBe(true)
    expect(enabled('[plugins."novadeck@novadeck"]', "enabled = false")).toBe(false)
    expect(enabled('[plugins."other@market"]', "enabled = true")).toBe(false)
    expect(enabled("")).toBe(false)
  })

  it("takes only the key, never a comment or another key's value", () => {
    expect(enabled('[plugins."novadeck@novadeck"]', "# enabled = true", "enabled = false")).toBe(
      false,
    )
    expect(enabled('[plugins."novadeck@novadeck"]', "enabled = false # was enabled = true")).toBe(
      false,
    )
    expect(enabled('[plugins."novadeck@novadeck"]', 'note = "enabled = true"')).toBe(false)
    expect(enabled('[plugins."novadeck@novadeck"]', "enabled = trueish")).toBe(false)
    expect(enabled('[plugins."novadeck@novadeck"]', "enabled = true # on")).toBe(true)
    // The table ends where the next begins.
    expect(enabled('[plugins."novadeck@novadeck"]', "[other]", "enabled = true")).toBe(false)
  })

  it("reads past an array, a comment and Windows line ends in the table", () => {
    expect(
      enabled(
        '[plugins."novadeck@novadeck"] # Novadeck',
        'skills = ["a", "b"]',
        "# its hooks",
        "enabled = true\r",
      ),
    ).toBe(true)
  })

  it("reads the key as a hand-edited file may write it: dotted, or in an inline table", () => {
    expect(enabled('plugins."novadeck@novadeck".enabled = true')).toBe(true)
    expect(enabled("[plugins]", '"novadeck@novadeck".enabled = true')).toBe(true)
    expect(enabled("[plugins]", '"novadeck@novadeck" = { enabled = true }')).toBe(true)
    expect(enabled("[plugins]", '"novadeck@novadeck" = { other = 1, enabled = false }')).toBe(false)
    expect(enabled("[ plugins . 'novadeck@novadeck' ]", "enabled = true")).toBe(true)
  })
})
