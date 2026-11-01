import {
  approvalSentence,
  commandText,
  lifetimeLabel,
  lifetimeWords,
  presetSentence,
  type GrantCommand,
} from "./grants"
import { describe, expect, it } from "./test"

const command = (...argv: string[]): GrantCommand => ({ argv, rest: false })

describe("commandText", () => {
  it("leaves plain words bare", () => {
    expect(commandText(command("git", "push", "origin", "a:b", "--no-verify=1"))).toBe(
      "git push origin a:b --no-verify=1",
    )
  })

  it("quotes a word with a space or a shell character, and an apostrophe in it", () => {
    expect(commandText(command("echo", "a b", "$HOME", "it's", "x;y", "*"))).toBe(
      "echo 'a b' '$HOME' 'it'\\''s' 'x;y' '*'",
    )
  })
})

describe("the card's sentences", () => {
  it("words each preset with the repo", () => {
    expect(presetSentence("push", "acme/shop")).toBe(
      "Push a named branch to acme/shop (no force, never to main/master or its default branch)",
    )
    expect(presetSentence("pr", "acme/shop")).toBe(
      "Open, edit, mark ready and comment on pull requests in acme/shop (no merge commands, close or reopen; no labels)",
    )
  })

  it("says the lifetime and what an approval lets the terminal do", () => {
    expect(lifetimeLabel("until-done")).toBe("Until it's done")
    expect(lifetimeLabel("hour")).toBe("1 hour")
    expect(lifetimeWords("until-done")).toBe("until it's done")
    expect(lifetimeWords("hour")).toBe("for 1 hour")
    expect(approvalSentence("fox")).toBe(
      "Lets @fox run, without asking again, until it reports done or for 1 hour:",
    )
  })
})
