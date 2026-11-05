import { describe, expect, it } from "vitest"

import { composerShown } from "./dialog-screen.js"

// The bottom of Codex's screen with its composer, its footer naming the session's folder.
const screen = (folder: string) => ["› Ask Codex", "", `  fake-model default · ${folder}`, ""]

describe("Codex's composer footer", () => {
  it("is drawn for a session in any folder: POSIX, home, a drive or a UNC share", () => {
    for (const folder of [
      "/tmp/sandbox/project",
      "~/work",
      "C:\\Work\\app",
      "\\\\server\\share\\app",
      "\\\\wsl$\\Ubuntu\\home\\me",
    ])
      expect(composerShown(screen(folder)), folder).toBe(true)
  })

  it("is not drawn where no footer shows", () => {
    expect(composerShown(["  Allow this command?", "› 1. Yes", "  2. No"])).toBe(false)
  })
})
