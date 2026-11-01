import { describe, expect, it } from "vitest"

import { refusesCommand } from "./commands.js"
import { lex, lexWindows } from "./lexer.js"
import { runsOtherCode } from "./runners.js"

// By class, as the design names them: each is refused as a grant and as a leading word, in
// both dialects, by the one list.
const classes: Record<string, string[]> = {
  interpreters: ["irb", "ipython", "ipython3", "pypy3", "php", "lua", "Rscript", "java", "go"],
  "remote shells": ["ssh", "mosh", "telnet", "socat", "expect", "tmux", "screen"],
  launchers: [
    "osascript",
    "open",
    "xdg-open",
    "start-process",
    "explorer",
    "ipmo",
    "import-module",
  ],
  schedulers: ["at", "crontab", "schtasks", "systemd-run", "launchctl", "forfiles", "sajb"],
  wrappers: [
    "setsid",
    "nohup",
    "watch",
    "xargs",
    "stdbuf",
    "flock",
    "script",
    "icm",
    "invoke-command",
  ],
  "database shells": ["sqlite3", "psql", "mysql"],
}

describe("programs that run other code", () => {
  describe.each(Object.entries(classes))("%s", (_class, programs) => {
    it.each(programs)("%s is never granted, exact or followed by anything", (program) => {
      for (const rest of [false, true])
        expect(refusesCommand({ argv: [program, "x"], rest })).toEqual(expect.any(String))
    })

    it.each(programs)("%s is refused as a leading word in both dialects", (program) => {
      expect(lex(`${program} x`).ok).toBe(false)
      expect(lexWindows(`${program} x`).ok).toBe(false)
    })

    it.each(programs)("%s is found in any case, with a path or an executable suffix", (program) => {
      for (const word of [
        program.toUpperCase(),
        `${program}.exe`,
        `C:\\tools\\${program}.cmd`,
        `/usr/bin/${program}`,
      ])
        expect(runsOtherCode(word), word).toBe(true)
    })
  })

  it("leaves programs that only read or build alone", () => {
    for (const program of [
      "git",
      "gh",
      "ls",
      "grep",
      "cat",
      "uberepo",
      "ndmarker",
      "atom",
      "opener",
    ])
      expect(runsOtherCode(program), program).toBe(false)
  })
})
