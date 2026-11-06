import type { ScreenText } from "@novadeck/emulator/headless"
import { box as agy } from "@novadeck/harness-agy/box"
import { box as claude } from "@novadeck/harness-claude/box"
import { box as codex } from "@novadeck/harness-codex/box"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { cursorAtEnd, leftoverOf, toEnd, unwrapped, type BoxProfile } from "@novadeck/tui-input/box"

import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"

// What each harness's box holds, read off the screens real runs drew
// (fixtures/leftover.probe.json, from e2e/probes/box-leftover.e2e.ts), the same on every harness
// but where a case says.
type Fixture = {
  readonly version: string
  readonly states: { readonly [state: string]: ScreenText }
}

const harnesses: readonly (readonly [string, BoxProfile])[] = [
  ["claude", claude],
  ["codex", codex],
  ["agy", agy],
]

describe.each(harnesses)("what %s's box holds", (harness, profile) => {
  const { states } = loadProbe<Fixture>(adapterFolder(harness), "leftover.probe.json")
  const state = (name: string): ScreenText => states[name]!
  const box = (name: string) => {
    const read = profile.read(state(name))
    if (!read) throw new Error(`No box in ${name}`)
    return read
  }

  it("reads an empty box as empty, and a shell mode as that", () => {
    expect(leftoverOf(profile, state("empty")).kind).toBe("empty")
    expect(leftoverOf(profile, state("cleared")).kind).toBe("empty")
    expect(leftoverOf(profile, state("left shell")).kind).toBe("empty")
    expect(leftoverOf(profile, state("shell empty")).kind).toBe("shell")
    expect(leftoverOf(profile, state("shell command"))).toMatchObject({
      kind: "shell",
      box: { text: "ls -la" },
    })
  })

  it.each(["draft", "three lines", "wrapped", "placeholder", "picker", "mid-turn draft"])(
    "reads %s as text that can go along",
    (name) => {
      expect(leftoverOf(profile, state(name)).kind).toBe("text")
    },
  )

  it("reads a leading / as a command", () => {
    expect(leftoverOf(profile, state("command")).kind).toBe("command")
  })

  it.each(["menu model", "menu permissions", "menu config"])(
    "never reads %s as a box to type into",
    (name) => {
      const read = leftoverOf(profile, state(name))
      expect(read.kind === "text" || read.kind === "shell" || read.kind === "command").toBe(false)
    },
  )

  it("tells where the cursor stands, whatever column the harness draws it on", () => {
    for (const name of ["draft", "three lines", "wrapped", "placeholder", "cursor end"])
      expect(cursorAtEnd(profile, box(name), state(name)), name).toBe(true)
    for (const name of ["cursor mid", "three lines, cursor up", "three lines, cursor down"])
      expect(cursorAtEnd(profile, box(name), state(name)), name).toBe(false)
  })

  it("takes the cursor down to the box's last row, exactly, then End", () => {
    expect(toEnd(box("three lines, cursor up"), state("three lines, cursor up"))).toBe(
      "\x1b[B\x1b[B\x1b[F",
    )
    expect(toEnd(box("cursor mid"), state("cursor mid"))).toBe("\x1b[F")
  })

  it("erases row by row, with no key that would stop a turn, and leaves its shell mode so", () => {
    const three = box("three lines")
    const keys = profile.erase?.(three)
    expect(keys).toBe("\x15\x7f\x15\x7f\x15")
    expect(profile.shell.leave?.(box("shell empty"))).toBe("\x7f")
    expect(profile.shell.leave?.(box("shell command"))).toBe("\x15\x7f")
  })

  it("reads wrapped rows back as what was typed, wherever a word ends on them", () => {
    const fits = harness === "codex" ? 117 : 116
    const typed = (width: number) => `${"a".repeat(width - 5)} word next words`
    const read = (name: string) => unwrapped(box(name).text, profile.textWidth(state(name).columns))
    expect(read("word at the width")).toBe(typed(fits))
    expect(read("word a cell past")).toBe(typed(fits + 1))
    expect(read("narrow, word at the width")).toBe(typed(fits - 40))
    expect(read("narrow, word a cell short")).toBe(typed(fits - 41))
    expect(read("narrow, long word")).toBe(`${"x".repeat(100)} and after`)
    // Claude Code fills the row a word too long for one starts on, which can't be told from a
    // row of words that ends there: the word gets a space, where words would run together.
    const after = harness === "claude" ? 104 : 150
    const rest = "x".repeat(150 - after)
    expect(read("long word after words")).toBe(
      `short words ${"x".repeat(after)}${rest && ` ${rest}`} and after`,
    )
  })

  it("takes a paste as keys only where it reads the console's: Codex on Windows", () => {
    for (const platform of ["linux", "darwin", "win32"] as const)
      expect(profile.pastesAsKeys?.(platform) ?? false).toBe(
        harness === "codex" && platform === "win32",
      )
  })

  it("reads the merged text whole, with what was pasted after a placeholder", () => {
    expect(box("merged").text).toMatch(/half typed\n+the message/)
    expect(box("placeholder merged").text).toMatch(/the message$/)
    expect(profile.collapsed({ ...box("placeholder") })).toBe(true)
    expect(box("long message merged").text).toMatch(/^half typed\[Pasted/)
  })
})
