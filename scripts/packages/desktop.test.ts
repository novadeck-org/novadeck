import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  destinationOf,
  edits,
  hashOf,
  host,
  leftovers,
  onTheMove,
  rewrite,
  templates,
} from "./desktop.ts"
import { applyEdit } from "./move.ts"

describe("where 5.3c moves a file", () => {
  it("takes the host whole, and the pages with their entries from the UI", () => {
    expect(destinationOf("application/host/src/main/index.ts")).toBe(
      "apps/desktop/src/main/index.ts",
    )
    expect(destinationOf("frontend/ui/index.html")).toBe("apps/desktop/renderer/index.html")
    expect(destinationOf("frontend/ui/src/entries/desktop.tsx")).toBe(
      "apps/desktop/renderer/main.tsx",
    )
    expect(destinationOf("frontend/ui/src/entries/web.tsx")).toBe(
      "apps/desktop/renderer/web/main.tsx",
    )
    expect(destinationOf("frontend/ui/entries/web/main.tsx")).toBeNull()
    expect(destinationOf("frontend/ui/vite.config.ts")).toBeNull()
    expect(destinationOf("frontend/ui/src/entries/start.tsx")).toBeUndefined()
    expect(destinationOf("application/hostess/a.ts")).toBeUndefined()
  })
})

describe("the rewrite", () => {
  it("points the host's folder at the app's, in each way it is written, once", () => {
    const text = [
      "      - application/host/release/*.AppImage",
      "npm --prefix application/host pkg set version=1",
      "working-directory: application/host",
      'new URL("../../../application/host/x", import.meta.url)',
      String.raw`/\/application\/host\//`,
    ].join("\n")
    const once = rewrite(text)
    expect(once).not.toMatch(/application[\\/]+host/)
    expect(rewrite(once)).toBe(once)
  })

  it("points a page that moved on its own at its new place, and nothing that starts like it", () => {
    expect(rewrite('"frontend/ui/index.html", "frontend/ui/entries/web/index.html"')).toBe(
      '"apps/desktop/renderer/index.html", "apps/desktop/renderer/web/index.html"',
    )
    expect(rewrite("frontend/ui/index.html.bak")).toBe("frontend/ui/index.html.bak")
  })

  it("leaves another folder that starts with its name", () => {
    expect(rewrite("application/hostess/a.ts and /w/repo/application/host")).toBe(
      "application/hostess/a.ts and /w/repo/application/host",
    )
  })
})

describe("the handwritten edits", () => {
  it("each leave nothing of their old text behind, and a second run finds them there", () => {
    for (const edit of [...edits, ...onTheMove]) {
      const made = applyEdit(edit.before, edit)
      expect("text" in made && made.text.includes(edit.before), edit.why).toBe(false)
      expect("text" in made && applyEdit(made.text, edit), edit.why).toMatchObject({
        state: "there",
      })
    }
  })
})

describe("the files the move writes whole", () => {
  it("hash a file the same whichever line ends its checkout has", () => {
    expect(hashOf("a\r\nb\r\n")).toBe(hashOf("a\nb\n"))
    expect(hashOf("a\nb\n")).not.toBe(hashOf("a\nc\n"))
  })

  // Until the move runs, a change to a file it replaces is a change to its template too.
  it("replace only the text they were written for, as it stands at the old place", () => {
    const root = join(import.meta.dirname, "..", "..")
    const replaced = templates.flatMap(({ place, was }) => {
      const old = join(root, host.from, place.slice(host.to.length))
      return was !== undefined && existsSync(old) ? [{ place, was, old }] : []
    })
    expect(
      replaced.filter(({ was, old }) => hashOf(readFileSync(old, "utf8")) !== was),
      "redo the template and its hash",
    ).toEqual([])
    // As a checkout with the other line ends has it.
    const crlf = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")
    expect(
      replaced.filter(({ was, old }) => hashOf(crlf(readFileSync(old, "utf8"))) !== was),
    ).toEqual([])
  })
})

describe("what the move leaves", () => {
  it("finds the host's old folder and the UI's old pages, however written", () => {
    const text = [
      'join(root, "application", "host")',
      "pnpm --filter @novadeck/ui dev --mode web",
      "frontend/ui/entries/web/index.html",
      "fine: apps/desktop and frontend/ui/src/entries/start.tsx",
    ].join("\n")
    expect(leftovers("docs/x.md", text)).toHaveLength(3)
    expect(leftovers("application/ui/x.ts", 'import "../host/src/bridge.ts"')).toHaveLength(1)
  })
})
