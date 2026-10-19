import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { plan } from "./frontend.ts"
import { isText } from "./move.ts"

// The plan over the repository itself: 5.3b's move and the steps after it have landed, so a
// run (the catch-up recipe's last one among them) has nothing to do. It reads every tracked
// file, which takes a while on Windows: a minute, beside the default 5 s.
vi.setConfig({ testTimeout: 60_000 })

const root = join(import.meta.dirname, "..", "..")

describe("5.3b's move on the repository as it stands", () => {
  it("has nothing to do, though 5.3c moved a file it edits", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\0")
      .filter(Boolean)
    const planned = plan({
      tracked,
      read: (file) => readFileSync(join(root, file), "utf8"),
      isTextual: isText,
      template: (file) =>
        readFileSync(join(import.meta.dirname, "frontend", `${file}.tmpl`), "utf8"),
    })
    expect(planned.problems).toEqual([])
    expect(planned.moves).toEqual([])
    expect(planned.removes).toEqual([])
    expect([...planned.writes.keys()]).toEqual([])
  })
})
